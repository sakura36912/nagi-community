import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const supervisorUrl = new URL("./supervise-production.mjs", import.meta.url).href;

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return await readFile(path, "utf8"); } catch {}
    await delay(10);
  }
  throw new Error(`Fixture did not create ${path}`);
}

for (const exitCode of [0, 7]) {
  test(`essential bot exit ${exitCode} stops the other services and reports failure`, { timeout: 10000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "production-supervisor-"));
    const fixture = join(dir, "service.mjs");
    await writeFile(fixture, `
      import { writeFileSync, existsSync } from "node:fs";
      const [dir, name] = process.argv.slice(2);
      writeFileSync(dir + "/" + name + ".ready", "ready");
      if (name === "bot") {
        setInterval(() => {
          if (existsSync(dir + "/community.ready") && existsSync(dir + "/api.ready")) process.exit(${exitCode});
        }, 10);
      } else {
        process.on("SIGTERM", () => {
          writeFileSync(dir + "/" + name + ".stopped", "stopped");
          process.exit(0);
        });
        setInterval(() => {}, 1000);
      }
    `);
    const services = ["bot", "community", "api"].map((name) => ({
      name, command: process.execPath, args: [fixture, dir, name],
    }));
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { superviseServices } from ${JSON.stringify(supervisorUrl)};
       process.exitCode = await superviseServices(${JSON.stringify(services)}, {shutdownTimeoutMs: 300});`,
    ], { stdio: "ignore" });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", reject);
      });
      assert.equal(result, 1);
      assert.equal(await waitForFile(join(dir, "community.stopped")), "stopped");
      assert.equal(await waitForFile(join(dir, "api.stopped")), "stopped");
    } finally {
      child.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("SIGTERM reaches wrapped descendants and leaves no duplicate bot running", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "production-supervisor-"));
  const descendant = join(dir, "descendant.mjs");
  const wrapper = join(dir, "wrapper.mjs");
  await writeFile(descendant, `
    import { writeFileSync } from "node:fs";
    const dir = process.argv[2];
    process.on("SIGTERM", () => { writeFileSync(dir + "/stopped", "stopped"); process.exit(0); });
    writeFileSync(dir + "/ready", "ready");
    setInterval(() => {}, 1000);
  `);
  await writeFile(wrapper, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, [${JSON.stringify(descendant)}, ${JSON.stringify(dir)}], {stdio: "ignore"});
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { superviseServices } from ${JSON.stringify(supervisorUrl)};
     process.exitCode = await superviseServices([{name:"wrapped bot", command:process.execPath,args:[${JSON.stringify(wrapper)}]}],{shutdownTimeoutMs:300});`,
  ], { stdio: "ignore" });
  try {
    await waitForFile(join(dir, "ready"));
    const ended = new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    assert.equal(await ended, 0);
    assert.equal(await waitForFile(join(dir, "stopped")), "stopped");
  } finally {
    child.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
});
