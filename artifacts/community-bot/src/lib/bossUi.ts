import { EmbedBuilder, escapeMarkdown } from "discord.js";
import { BOSS_NAMES, bossCooldownSeconds, type BossConfig, type BossEvent, type BossNoticeBundle, type BossActionResult } from "@workspace/db";

export const bossMoney = (value: number | null) => value === null ? "未設定（新規参加不可）" : `$${value.toLocaleString("ja-JP")}`;
export function bossDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  return [hours ? `${hours}時間` : "", minutes ? `${minutes}分` : "", remainder || !value ? `${remainder}秒` : ""].filter(Boolean).join("");
}
export function bossDeadline(date: Date) {
  const absolute = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
  return `**${absolute}（日本時間）**\n<t:${Math.floor(date.getTime() / 1000)}:R>`;
}
export function bossHp(current: number, maximum: number) {
  const ratio = maximum > 0 ? Math.max(0, Math.min(1, current / maximum)) : 0;
  const filled = Math.round(ratio * 10);
  const percent = ratio > 0 && ratio < 0.0001 ? "0.01%未満" :
    `${(Math.floor(ratio * 10000) / 100).toLocaleString("ja-JP", { maximumFractionDigits: 2 })}%`;
  return `\`${"■".repeat(filled)}${"□".repeat(10 - filled)}\` **${percent}**\nHP **${current.toLocaleString("ja-JP")}** / ${maximum.toLocaleString("ja-JP")}`;
}
export function bossSpecialName(special: BossConfig["special"]) {
  return { none: "なし", double_attack: "ボス攻撃力2倍", double_reward: "財宝報酬2倍",
    damage_boost: "与ダメージ1.5倍", double_heal: "回復量2倍" }[special];
}
export function bossEventEmbed(event: BossEvent) {
  return new EmbedBuilder().setTitle(`ボス討伐：${BOSS_NAMES[event.bossType]}`).setColor(0x447bb8)
    .setDescription("**本船員・武器所持者向けの討伐イベント**\n`/参加` でソロ／パーティを選択 → 条件を確認して参加確定\n攻撃は無料、回復は有料です。")
    .addFields(
      { name: "ボスHP", value: `ソロ **${event.config.soloHp.toLocaleString("ja-JP")}** ／ パーティ **${event.config.partyHp.toLocaleString("ja-JP")}**` },
      { name: "報酬総額 / 1討伐", value: `**${bossMoney(event.config.reward * (event.config.special === "double_reward" ? 2 : 1))}**\n参加者で均等分配`, inline: true },
      { name: "パーティ受付", value: `**2〜4人 / ${bossDuration(event.config.lobbySeconds)}**\n4人で即開始`, inline: true },
      { name: "開催終了予定", value: bossDeadline(event.endsAt) },
      { name: "個別クールタイム", value: `攻撃 **${bossCooldownSeconds(event.config, "attack")}秒** ／ 回復 **${bossCooldownSeconds(event.config, "heal")}秒**` },
      ...(event.config.playerHpSource === "wallet" ? [{ name: "プレイヤーHP", value: "参加確定時の所持金で固定（所持金1以上）。被ダメージで残高は減りません。" }] : []),
      ...(event.config.healingMode === "max_hp_10_percent" ? [{ name: "有料回復", value: "最大HPの10%（端数切り捨て、最低1、最大HPまで）。回復料金を支払っても最大HPは変わりません。" }] : []),
      ...(event.config.special !== "none" ? [{ name: "特殊イベント", value: `**${bossSpecialName(event.config.special)}**` }] : []),
    ).setFooter({ text: "武器強化は次の攻撃から反映。最大HP・ロール補正・回復料金は参加時に固定。" });
}
/** 戦闘中の表示はHPと参加者だけ。ダメージ順位は終了通知だけに表示する。 */
export function bossBattleNotice(bundle: BossNoticeBundle) {
  const { battle, event, members } = bundle;
  const ended = !["waiting", "active"].includes(battle.status);
  const names = members.map(p => ended ? escapeMarkdown(p.displayName) :
    `**${escapeMarkdown(p.displayName)}**\nHP ${p.hp.toLocaleString("ja-JP")} / ${p.maxHp.toLocaleString("ja-JP")}${p.hp === 0 ? "（戦闘不能）" : ""}`).join("\n") || "参加者なし";
  const mode = battle.mode === "solo" ? "ソロ" : "パーティ";
  const title = battle.status === "waiting" ? "パーティ受付開始" : battle.status === "active" ? "討伐開始"
    : battle.status === "won" ? "討伐成功" : battle.status === "cancelled" ? "受付キャンセル" : "討伐失敗";
  const embed = new EmbedBuilder().setTitle(`${title} — ${BOSS_NAMES[event.bossType]}（${mode}）`)
    .setColor(battle.status === "won" ? 0x42b883 : battle.status === "failed" ? 0xc84c4c : battle.status === "cancelled" ? 0x747f8d : battle.status === "waiting" ? 0xd6a34a : 0x447bb8)
    .setDescription(battle.status === "won" ? "**討伐達成。報酬を加算しました。**" :
      battle.status === "failed" ? "**討伐未達成。今回の報酬はありません。**" :
      battle.status === "cancelled" ? "今回の受付は終了しました。" :
      battle.status === "waiting" ? `**${members.length} / 4人が参加中** — 2人以上で開始できます。` :
      "`/攻撃` で攻撃　`/回復` で自分のHPを回復")
    .addFields({ name: "ボス残りHP", value: bossHp(battle.currentHp, battle.maxHp) },
      { name: `参加者（${members.length}人）`, value: names.slice(0, 1024) });
  if (battle.status === "waiting") embed.addFields(
    { name: "受付終了予定", value: bossDeadline(battle.lobbyEndsAt!) },
    { name: "参加方法", value: "`/参加 モード:パーティ`\n4人で即開始。受付終了時に2〜3人なら開始、1人ならキャンセル。" },
  );
  if (["waiting", "active"].includes(battle.status)) embed.addFields(
    { name: "攻撃 / 1回", value: "**無料（$0）**", inline: true },
    { name: "回復 / 1回", value: battle.healCost > 0 ? `**${bossMoney(battle.healCost)}**` : "未設定（回復不可）", inline: true },
    { name: "個別クールタイム", value: `攻撃 ${bossCooldownSeconds(event.config, "attack")}秒 ／ 回復 ${bossCooldownSeconds(event.config, "heal")}秒` },
    { name: "戦闘終了予定", value: bossDeadline(battle.endsAt) },
  );
  if (["won", "failed"].includes(battle.status)) {
    const ranking = [...members].sort((a, b) => b.damage - a.damage || a.userId.localeCompare(b.userId));
    const total = members.reduce((sum, p) => sum + p.damage, 0);
    const seconds = battle.startedAt && battle.finishedAt ? Math.max(0, Math.floor((battle.finishedAt.getTime() - battle.startedAt.getTime()) / 1000)) : 0;
    embed.addFields(
      { name: "戦闘記録", value: `経過時間 **${bossDuration(seconds)}**\n総ダメージ **${total.toLocaleString("ja-JP")}**` },
      { name: "終了時ダメージランキング", value: ranking.slice(0, 3).map((p, i) => `**${i + 1}位** ${escapeMarkdown(p.displayName)} — **${p.damage.toLocaleString("ja-JP")}**`).join("\n") || "なし" },
    );
    if (battle.status === "won") embed.addFields(
      { name: "MVP", value: ranking[0] ? escapeMarkdown(ranking[0].displayName) : "なし" },
      { name: "獲得報酬（加算済み）", value: battle.rewards.map(r =>
        `${escapeMarkdown(members.find(p => p.userId === r.userId)?.displayName ?? r.userId)}：${bossMoney(r.amount)}`).join("\n").slice(0, 1024) || "$0" },
    );
  }
  if (battle.reason) embed.addFields({ name: "終了理由", value: battle.reason });
  return embed.setFooter({ text: `${ended ? "終了時の記録" : "投稿時点の記録 / 最新は /ボス情報"} | 討伐ID：${battle.id}` });
}
export function bossActionText(result: BossActionResult) {
  return [
    result.repeated ? "処理済みの操作結果です。再課金・再抽選はしていません。" : "",
    ...(result.presentation?.lines ?? (result.damage ? [`${result.critical ? "クリティカル！ " : ""}${result.damage.toLocaleString()}ダメージ`] : [])),
    result.healed ? `HPが${result.healed.toLocaleString()}回復` : "",
    result.skill ? `固有スキル：${result.skill}` : "",
    ...result.messages,
    `ボス残りHP：${result.bossHp.toLocaleString()}`,
    result.userHp !== undefined ? `自分のHP：${result.userHp.toLocaleString()}` : "",
    result.paid !== undefined ? `消費：${bossMoney(result.paid)}／処理後残高：${bossMoney(result.balance ?? 0)}` : "",
  ].filter(Boolean).join("\n").slice(0, 2000);
}
