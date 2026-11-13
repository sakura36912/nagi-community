import { ApplicationCommandType, type Client } from "discord.js";
import { pvpCommands } from "../commands/pvp";
import { logger } from "./logger";

/** Update only the PvP command so option changes do not create duplicate global commands. */
export async function syncPvpCommandRegistration(client: Client) {
  if (!client.application) throw new Error("Discord application is unavailable");
  const manager = client.application.commands;
  const existing = await manager.fetch({});
  for (const command of pvpCommands) {
    const definition = command.data.toJSON();
    const previous = existing.find(row => row.name === definition.name && row.type === ApplicationCommandType.ChatInput);
    const saved = previous ? await manager.edit(previous.id, definition) : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    if (verified.name !== definition.name) throw new Error(`PvP command verification failed: ${definition.name}`);
  }
  logger.info?.(`[pvp] Synchronized ${pvpCommands.length} command(s) without replacing unrelated registrations`);
}
