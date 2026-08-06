/**
 * 定期メッセージを追加・確認するスクリプト
 *
 * 使い方:
 *   1. 下の MESSAGES 配列にメッセージを追加・編集する
 *   2. ターミナルで実行:
 *      artifacts/discord-bot/node_modules/.bin/tsx lib/db/seed-periodic-messages.ts
 */

import { db, periodicMessagesTable } from "./src/index.js";

// ─── ここを編集 ───────────────────────────────────────────────────────────────
const MESSAGES = [
  {
    guildId: "サーバーID",
    channelId: "チャンネルID",
    message: "投稿したいメッセージ内容",
    intervalHours: 24,
    enabled: true,
  },
  // 追加したい場合はここにコピペして増やす
];
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (MESSAGES.some((m) => m.guildId === "サーバーID")) {
    console.error("❌ guildId / channelId をちゃんと書き換えてから実行してください。");
    process.exit(1);
  }

  for (const msg of MESSAGES) {
    const [row] = await db
      .insert(periodicMessagesTable)
      .values(msg)
      .returning();
    console.log(`✅ 追加しました: id=${row!.id} | channel=${row!.channelId} | interval=${row!.intervalHours}h`);
  }

  // 現在の登録一覧を表示
  const all = await db.select().from(periodicMessagesTable);
  console.log("\n現在の定期メッセージ一覧:");
  for (const r of all) {
    console.log(
      `  id=${r.id} | guild=${r.guildId} | channel=${r.channelId} | ${r.intervalHours}h | enabled=${r.enabled} | last=${r.lastPostedAt ?? "未投稿"}`,
    );
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
