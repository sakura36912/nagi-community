import { ApplicationCommandType, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { backupCommand } from "../commands/backup";
import { logger } from "./logger";

export async function syncBackupCommandRegistration(client: Client): Promise<void> {
  if (!client.application) throw new Error("Discord application is unavailable");
  const manager = client.application.commands;
  const definition = backupCommand.data.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody;
  const existing = (await manager.fetch()).find((command) =>
    command.name === "backup" && command.type === ApplicationCommandType.ChatInput);
  const saved = existing ? await manager.edit(existing.id, definition) : await manager.create(definition);
  const verified = await manager.fetch(saved.id, { force: true });
  if (!verified.options.some((option) => option.name === "export")) throw new Error("/backup export verification failed");
  logger.info("[backup] Owner-only command synchronized (global)");
}
