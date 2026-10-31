import { ApplicationCommandType, type Client } from "discord.js";
import { forgeCommands } from "../commands/forge";
import { logger } from "./logger";

/** 鍛冶屋の日本語コマンドのみ個別更新。他のコマンドやギルド登録は上書きしない。 */
export async function syncForgeCommandRegistration(client: Client) {
  if (!client.application) throw new Error("Discord application is unavailable");
  const manager = client.application.commands;
  const existing = await manager.fetch({});
  for (const command of forgeCommands) {
    const definition = command.data.toJSON();
    const previous = existing.find(row => row.name === definition.name && row.type === ApplicationCommandType.ChatInput);
    const saved = previous ? await manager.edit(previous.id, definition) : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    if (verified.name !== definition.name) throw new Error(`Forge command verification failed: ${definition.name}`);
  }
  logger.info(`[forge] Synchronized ${forgeCommands.length} Japanese commands without replacing other registrations`);
}
