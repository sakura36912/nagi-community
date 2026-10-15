import { superviseServices } from "./supervise-production.mjs";
import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 12) {
  throw new Error("Use Node.js 24.12+ LTS for the VPS SQLite runtime.");
}
if (!process.env.SQLITE_PATH || !isAbsolute(process.env.SQLITE_PATH) || !existsSync(process.env.SQLITE_PATH)) {
  throw new Error("SQLITE_PATH must point to a verified, persistent SQLite database.");
}
for (const name of ["DISCORD_BOT_TOKEN", "COMMUNITY_BOT_TOKEN"]) {
  if (!process.env[name]) throw new Error(`${name} is required (set it in the private VPS environment file).`);
}
process.exitCode = await superviseServices([
  { name: "Discord Bot", command: "pnpm", args: ["--filter", "@workspace/discord-bot", "run", "dev"] },
  { name: "Community Bot", command: "pnpm", args: ["--filter", "@workspace/community-bot", "run", "dev"] },
]);
