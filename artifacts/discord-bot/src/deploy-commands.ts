import { ApplicationCommandType, REST, Routes, type APIApplicationCommand, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { commands } from "./commands/index.js";
import { logger } from "./lib/logger.js";

const token = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token) throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
if (!clientId) throw new Error("DISCORD_CLIENT_ID environment variable is required.");

const guildId = process.env["DEPLOY_GUILD_ID"];

const rest = new REST().setToken(token);

async function main() {
  const body = commands.map((c) => c.data.toJSON() as RESTPostAPIApplicationCommandsJSONBody);
  // PUT replaces the entire scope and can erase separately managed guild-only commands.
  // Update each command by name/type instead, leaving unrelated registrations untouched.
  const collectionRoute = guildId
    ? Routes.applicationGuildCommands(clientId!, guildId)
    : Routes.applicationCommands(clientId!);
  const registered = await rest.get(collectionRoute) as APIApplicationCommand[];
  if (guildId) {
    logger.info(`Upserting ${body.length} guild slash command(s) to guild ${guildId} individually...`);
  } else {
    logger.info(`Upserting ${body.length} global slash command(s) individually...`);
  }
  for (const definition of body) {
    const existing = registered.find((command) =>
      command.name === definition.name && command.type === ApplicationCommandType.ChatInput);
    const itemRoute = existing
      ? guildId
        ? Routes.applicationGuildCommand(clientId!, guildId, existing.id)
        : Routes.applicationCommand(clientId!, existing.id)
      : collectionRoute;
    try {
      if (existing) await rest.patch(itemRoute, { body: definition });
      else await rest.post(itemRoute, { body: definition });
    } catch (error) {
      logger.error(`Failed to upsert /${definition.name} (${guildId ? `guild=${guildId}` : "global"})`, error);
      throw error;
    }
  }
  logger.info(`${body.length} slash command(s) upserted without replacing unrelated commands (${guildId ? `guild=${guildId}` : "global"}).`);
}

main().catch((err) => {
  logger.error("Failed to register slash commands", err);
  process.exit(1);
});
