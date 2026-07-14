import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { logger } from "./lib/logger.js";

const token = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token) throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
if (!clientId) throw new Error("DISCORD_CLIENT_ID environment variable is required.");

const guildId = process.env["DEPLOY_GUILD_ID"];

const rest = new REST().setToken(token);

async function main() {
  const body = commands.map((c) => c.data.toJSON());
  if (guildId) {
    logger.info(`Registering ${body.length} guild slash command(s) to guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId!, guildId), { body });
    logger.info("Guild slash commands registered (instant propagation).");
  } else {
    logger.info(`Registering ${body.length} global slash command(s)...`);
    await rest.put(Routes.applicationCommands(clientId!), { body });
    logger.info("Slash commands registered. Global commands can take up to an hour to propagate.");
  }
}

main().catch((err) => {
  logger.error("Failed to register slash commands", err);
  process.exit(1);
});
