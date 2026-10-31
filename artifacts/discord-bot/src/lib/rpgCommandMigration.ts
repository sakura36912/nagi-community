import { ApplicationCommandType, Events, REST, Routes, type Client, type Interaction } from "discord.js";
import { RPG_COMMAND_NAMES, isRetiredBankRpgCommand } from "@workspace/db";
import { logger } from "./logger";
interface DestinationApi { get(path: `/${string}`): Promise<unknown> }
export async function handleRetiredBankRpgInteraction(interaction: Interaction) {
  if (!((interaction.isButton() && /^(boss|forge):/.test(interaction.customId)) ||
    (interaction.isChatInputCommand() && isRetiredBankRpgCommand(interaction.commandName)))) return false;
  await interaction.reply({ content: "武器・鍛冶屋・ボス討伐は多機能Botへ移動しました。多機能Botの同名コマンドを実行してください。データと銀行残高は共通です。この操作では課金しません。", ephemeral: true });
  return true;
}
/** Verify the destination before deleting only the explicitly retired source definitions. */
export async function removeBankRpgCommands(bank: Client, destination: DestinationApi, expectedId?: string) {
  if (!bank.application) throw new Error("Bank application unavailable");
  const app = await destination.get(Routes.oauth2CurrentApplication()) as { id: string };
  if (!app.id || app.id === bank.application.id || (expectedId && app.id !== expectedId))
    throw new Error("Destination application identity mismatch");
  const target = await destination.get(Routes.applicationCommands(app.id)) as { name: string; type: number }[];
  if (!RPG_COMMAND_NAMES.every(name => target.some(c => c.name === name && c.type === ApplicationCommandType.ChatInput)))
    throw new Error("Community RPG commands are not ready");
  const guilds = [...bank.guilds.cache.values()];
  const managers = [bank.application.commands, ...guilds.map(g => g.commands)];
  let removed = 0;
  for (const manager of managers) {
    const definitions = await manager.fetch({});
    for (const command of definitions.values()) {
      if (command.type !== ApplicationCommandType.ChatInput || !isRetiredBankRpgCommand(command.name)) continue;
      await manager.delete(command.id); removed++;
    }
  }
  return removed;
}
/** The two production processes can become ready in either order. Retry without logging tokens. */
export function startBankRpgCleanup(client: Client) {
  const token = process.env.COMMUNITY_BOT_TOKEN;
  if (!token) {
    logger.warn("[rpg-move] 多機能Botの接続設定がないため旧コマンド削除は保留しました。");
    return;
  }
  const destination = new REST({ version: "10" }).setToken(token);
  let running = false, complete = false, guildRevision = 0;
  const run = async () => {
    if (running || complete) return;
    running = true;
    const revision = guildRevision;
    try {
      const count = await removeBankRpgCommands(client, destination, process.env.COMMUNITY_CLIENT_ID);
      logger.info(`[rpg-move] 多機能Botを確認し、銀行Botの旧RPGコマンド${count}件を削除しました。`);
      complete = revision === guildRevision;
    } catch {
      logger.warn("[rpg-move] 移行先の登録確認または旧定義の削除に失敗しました。60秒後に再試行します。");
    } finally { running = false; }
  };
  client.on(Events.GuildCreate, () => { guildRevision++; complete = false; void run(); });
  void run();
  const timer = setInterval(() => { void run(); }, 60000);
  timer.unref();
}
