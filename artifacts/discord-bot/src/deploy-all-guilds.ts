/**
 * ボットが参加している全ギルドにギルドコマンドを登録するスクリプト。
 * 実行: pnpm --filter @workspace/discord-bot exec tsx src/deploy-all-guilds.ts
 */
import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { logger } from "./lib/logger.js";

const token    = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];

if (!token)    throw new Error("DISCORD_BOT_TOKEN が設定されていません。");
if (!clientId) throw new Error("DISCORD_CLIENT_ID が設定されていません。");

const rest = new REST().setToken(token);
const body = commands.map((c) => c.data.toJSON());

async function main(): Promise<void> {
  const guilds = await rest.get(Routes.userGuilds()) as Array<{ id: string; name: string }>;
  logger.info(`参加ギルド数: ${guilds.length}、登録コマンド数: ${body.length}`);

  for (const guild of guilds) {
    logger.info(`[${guild.name}] ${body.length} 件のギルドコマンドを登録中...`);
    await rest.put(Routes.applicationGuildCommands(clientId!, guild.id), { body });
    logger.info(`[${guild.name}] 登録完了（即時反映）`);
  }

  logger.info("全ギルドへの登録が完了しました。");
}

main().catch((err) => {
  logger.error("コマンド登録に失敗しました", err);
  process.exit(1);
});
