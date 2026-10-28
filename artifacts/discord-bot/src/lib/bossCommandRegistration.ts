import { ApplicationCommandType, type Client } from "discord.js";
import { bossCommands } from "../commands/boss";
import { logger } from "./logger";

/** ボス用の日本語コマンドだけ個別登録し、銀行の他の定義を全件置換しない。 */
export async function syncBossCommandRegistration(client: Client) {
  if (!client.application) throw new Error("Discord application is unavailable");
  const manager = client.application.commands;
  const existing = await manager.fetch({});
  for (const command of bossCommands) {
    const definition = command.data.toJSON();
    const previous = existing.find(row => row.name === definition.name && row.type === ApplicationCommandType.ChatInput);
    const saved = previous ? await manager.edit(previous.id, definition) : await manager.create(definition);
    const verified = await manager.fetch(saved.id, { force: true });
    if (verified.name !== definition.name) throw new Error(`Boss command verification failed: ${definition.name}`);
  }
  logger.info(`[boss] Synchronized ${bossCommands.length} Japanese commands without replacing other registrations`);
}
