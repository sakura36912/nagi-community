/**
 * 指定したコマンド名のギルドコマンドのみを全ギルドから削除するスクリプト。
 * 実行: pnpm --filter @workspace/discord-bot exec tsx src/delete-specific-guild-commands.ts
 */
import { REST, Routes } from "discord.js";
import { logger } from "./lib/logger.js";

const TARGETS = new Set(["送金", "残高確認", "アドバイス終了", "説明会通過"]);

const token    = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token)    throw new Error("DISCORD_BOT_TOKEN が設定されていません。");
if (!clientId) throw new Error("DISCORD_CLIENT_ID が設定されていません。");

const rest = new REST().setToken(token);

async function main(): Promise<void> {
  const guilds = await rest.get(Routes.userGuilds()) as Array<{ id: string; name: string }>;
  logger.info(`参加ギルド数: ${guilds.length}`);

  for (const guild of guilds) {
    const cmds = await rest.get(
      Routes.applicationGuildCommands(clientId!, guild.id),
    ) as Array<{ id: string; name: string }>;

    const toDelete = cmds.filter((c) => TARGETS.has(c.name));
    if (toDelete.length === 0) {
      logger.info(`[${guild.name}] 対象コマンドなし、スキップ`);
      continue;
    }

    for (const cmd of toDelete) {
      await rest.delete(Routes.applicationGuildCommand(clientId!, guild.id, cmd.id));
      logger.info(`[${guild.name}] /${cmd.name} を削除しました`);
    }
  }

  logger.info("完了");
}

main().catch((err) => {
  logger.error("削除に失敗しました", err);
  process.exit(1);
});
