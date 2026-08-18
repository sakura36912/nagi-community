/**
 * ボットが参加している全ギルドのギルドコマンドを削除するスクリプト。
 * グローバルコマンドへ移行する際などに実行する。
 *
 * 実行: pnpm --filter @workspace/discord-bot exec tsx src/clear-guild-commands.ts
 */
import { REST, Routes } from "discord.js";
import { logger } from "./lib/logger.js";

const token    = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token)    throw new Error("DISCORD_BOT_TOKEN が設定されていません。");
if (!clientId) throw new Error("DISCORD_CLIENT_ID が設定されていません。");

const rest = new REST().setToken(token);

async function main(): Promise<void> {
  // ボットが参加しているギルド一覧を取得
  const guilds = await rest.get(Routes.userGuilds()) as Array<{ id: string; name: string }>;
  logger.info(`参加ギルド数: ${guilds.length}`);

  let total = 0;
  for (const guild of guilds) {
    const existing = await rest.get(
      Routes.applicationGuildCommands(clientId!, guild.id),
    ) as Array<{ id: string; name: string }>;

    if (existing.length === 0) {
      logger.info(`[${guild.name}] ギルドコマンドなし、スキップ`);
      continue;
    }

    logger.info(`[${guild.name}] ${existing.length} 件のギルドコマンドを削除中...`);
    await rest.put(Routes.applicationGuildCommands(clientId!, guild.id), { body: [] });
    logger.info(`[${guild.name}] 削除完了`);
    total += existing.length;
  }

  logger.info(`完了: 合計 ${total} 件のギルドコマンドを削除しました。`);
}

main().catch((err) => {
  logger.error("ギルドコマンドの削除に失敗しました", err);
  process.exit(1);
});
