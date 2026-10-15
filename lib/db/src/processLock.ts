import { spawn } from "node:child_process";
import { sqliteUrl } from "./sqliteClient";

/**
 * OS flock survives neither parent death nor a stopped process tree.
 * Unlike a long-lived SQLite transaction it does not block normal writes.
 */
export async function acquireProcessLock(name: "discord-bot" | "community-bot"): Promise<{ release(): void } | null> {
  sqliteUrl(); // validates the persistent absolute path
  const child = spawn("flock", ["--exclusive", "--nonblock", `${process.env.SQLITE_PATH}.${name}.lock`,
    "sh", "-c", "printf locked; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { child.kill(); if (!settled) reject(new Error("flock startup timed out")); }, 5_000);
    child.once("error", (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (code === 1) resolve(null);
        else reject(new Error("flock could not acquire the process lock"));
      } else if (!released) {
        // Losing the OS lock must never leave an unprotected gateway alive.
        process.exit(1);
      }
    });
    let released = false;
    child.stdout.once("data", () => {
      clearTimeout(timer);
      settled = true;
      resolve({ release() { released = true; child.stdin.end(); } });
    });
    child.stderr.resume();
  });
}
