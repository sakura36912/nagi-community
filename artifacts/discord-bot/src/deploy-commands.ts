import { REST, Routes } from "discord.js";
import { commands } from "./commands";
import { logger } from "./lib/logger";

const token = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
}
if (!clientId) {
  throw new Error("DISCORD_CLIENT_ID environment variable is required.");
}

const rest = new REST().setToken(token);

async function main() {
  const body = commands.map((c) => c.data.toJSON());
  logger.info(`Registering ${body.length} global slash command(s)...`);
  await rest.put(Routes.applicationCommands(clientId as string), { body });
  logger.info("Slash commands registered. Global commands can take up to an hour to propagate.");
}

main().catch((err) => {
  logger.error("Failed to register slash commands", err);
  process.exit(1);
});
