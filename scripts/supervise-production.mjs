import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/** An essential service exiting, even with code 0, means this stack is down. */
export async function superviseServices(services, { shutdownTimeoutMs = 5000 } = {}) {
  if (!services.length) throw new Error("At least one production service is required");
  const children = [];
  let stopping = false;
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });

  function signalGroup(child, signal) {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") console.error(`[stop] Could not signal service group: ${error.message}`);
      return false;
    }
  }

  async function stop(code, reason) {
    if (stopping) return;
    stopping = true;
    console.error(`[stop] ${reason}; stopping all production services`);
    for (const child of children) signalGroup(child, "SIGTERM");
    const deadline = Date.now() + shutdownTimeoutMs;
    // A pnpm wrapper can exit before its actual bot. Monitor the whole process
    // group so descendants cannot survive and duplicate events on restart.
    while (children.some((child) => signalGroup(child, 0)) && Date.now() < deadline) {
      await delay(25);
    }
    for (const child of children) signalGroup(child, "SIGKILL");
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    finish(code);
  }
  const onTerm = () => { void stop(0, "Received SIGTERM"); };
  const onInt = () => { void stop(0, "Received SIGINT"); };
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);

  for (const service of services) {
    if (stopping) break;
    console.log(`[start] Starting ${service.name}...`);
    const child = spawn(service.command, service.args, {
      stdio: "inherit",
      detached: true,
    });
    children.push(child);
    child.once("error", (error) => {
      void stop(1, `${service.name} failed to start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      void stop(1, `${service.name} exited code=${code} signal=${signal ?? "none"}`);
    });
  }
  return stopped;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await superviseServices([
    { name: "Discord Bot", command: "pnpm", args: ["--filter", "@workspace/discord-bot", "run", "dev"] },
    { name: "Community Bot", command: "pnpm", args: ["--filter", "@workspace/community-bot", "run", "dev"] },
    { name: "API Server", command: process.execPath, args: ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"] },
  ]);
}
