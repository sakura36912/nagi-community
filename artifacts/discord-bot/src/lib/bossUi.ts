import { EmbedBuilder, escapeMarkdown } from "discord.js";
import { BOSS_NAMES, type BossConfig, type BossEvent, type BossNoticeBundle, type BossActionResult } from "@workspace/db";

export const bossMoney = (value: number | null) => value === null ? "未設定（新規参加不可）" : `$${value.toLocaleString()}`;
export function bossSpecialName(special: BossConfig["special"]) {
  return { none: "なし", double_attack: "ボス攻撃力2倍", double_reward: "財宝報酬2倍",
    damage_boost: "与ダメージ1.5倍", double_heal: "回復量2倍" }[special];
}
export function bossEventEmbed(event: BossEvent) {
  return new EmbedBuilder().setTitle(`ボス討伐：${BOSS_NAMES[event.bossType]}`).setColor(0x447bb8)
    .setDescription("本船員・武器所持者が参加できます。\n/参加 モード:ソロ または パーティ\n攻撃・回復の料金を確認してから参加を確定してください。")
    .addFields(
      { name: "ソロHP", value: event.config.soloHp.toLocaleString(), inline: true },
      { name: "パーティHP", value: event.config.partyHp.toLocaleString(), inline: true },
      { name: "イベント終了", value: `<t:${Math.floor(event.endsAt.getTime() / 1000)}:R>` },
      { name: "パーティ受付", value: `${event.config.lobbySeconds}秒／2〜4人` },
      { name: "1討伐の報酬総額", value: `${bossMoney(event.config.reward * (event.config.special === "double_reward" ? 2 : 1))}（参加者で均等分配）` },
      { name: "特殊イベント", value: bossSpecialName(event.config.special) },
    ).setFooter({ text: "武器・ロール補正と料金は参加時に固定。イベント共通の終了時刻まで戦います。" });
}
/** 戦闘中の表示はHPと参加者だけ。ダメージ順位は終了通知だけに表示する。 */
export function bossBattleNotice(bundle: BossNoticeBundle) {
  const { battle, event, members } = bundle;
  const names = members.map(p => `${escapeMarkdown(p.displayName)}：HP ${p.hp.toLocaleString()}/${p.maxHp.toLocaleString()}`).join("\n") || "参加者なし";
  const mode = battle.mode === "solo" ? "ソロ" : "パーティ";
  const title = battle.status === "waiting" ? "パーティ受付開始" : battle.status === "active" ? "討伐開始"
    : battle.status === "won" ? "討伐成功" : battle.status === "cancelled" ? "受付キャンセル" : "討伐失敗";
  const embed = new EmbedBuilder().setTitle(`${title} — ${BOSS_NAMES[event.bossType]}（${mode}）`)
    .setColor(battle.status === "won" ? 0x42b883 : battle.status === "failed" ? 0xc84c4c : 0x447bb8)
    .addFields({ name: "ボス残りHP", value: `${battle.currentHp.toLocaleString()}/${battle.maxHp.toLocaleString()}` },
      { name: `参加者（${members.length}人）`, value: names.slice(0, 1024) });
  if (battle.status === "waiting") embed.addFields(
    { name: "受付期限", value: `<t:${Math.floor(battle.lobbyEndsAt!.getTime() / 1000)}:R>` },
    { name: "参加方法", value: "/参加 モード:パーティ\n4人で即開始。受付終了時に2〜3人なら開始、1人ならキャンセル。" },
  );
  if (["waiting", "active"].includes(battle.status)) embed.addFields(
    { name: "1操作の料金", value: `攻撃 ${bossMoney(battle.attackCost)}／回復 ${bossMoney(battle.healCost)}` },
    { name: "戦闘期限", value: `<t:${Math.floor(battle.endsAt.getTime() / 1000)}:R>` },
  );
  if (["won", "failed"].includes(battle.status)) {
    const ranking = [...members].sort((a, b) => b.damage - a.damage || a.userId.localeCompare(b.userId));
    const total = members.reduce((sum, p) => sum + p.damage, 0);
    const seconds = battle.startedAt && battle.finishedAt ? Math.max(0, Math.floor((battle.finishedAt.getTime() - battle.startedAt.getTime()) / 1000)) : 0;
    embed.addFields(
      { name: "討伐時間", value: `${seconds}秒`, inline: true },
      { name: "総ダメージ", value: total.toLocaleString(), inline: true },
      { name: "終了時ダメージランキング", value: ranking.slice(0, 3).map((p, i) => `${i + 1}位 ${escapeMarkdown(p.displayName)}：${p.damage.toLocaleString()}`).join("\n") || "なし" },
    );
    if (battle.status === "won") embed.addFields(
      { name: "MVP", value: ranking[0] ? escapeMarkdown(ranking[0].displayName) : "なし" },
      { name: "獲得報酬（加算済み）", value: battle.rewards.map(r =>
        `${escapeMarkdown(members.find(p => p.userId === r.userId)?.displayName ?? r.userId)}：${bossMoney(r.amount)}`).join("\n").slice(0, 1024) || "$0" },
    );
  }
  if (battle.reason) embed.addFields({ name: "終了理由", value: battle.reason });
  return embed.setFooter({ text: `討伐ID：${battle.id}` });
}
export function bossActionText(result: BossActionResult) {
  return [
    result.repeated ? "処理済みの操作結果です。再課金・再抽選はしていません。" : "",
    result.damage ? `${result.critical ? "クリティカル！ " : ""}${result.damage.toLocaleString()}ダメージ` : "",
    result.healed ? `HPが${result.healed.toLocaleString()}回復` : "",
    result.skill ? `固有スキル：${result.skill}` : "",
    ...result.messages,
    `ボス残りHP：${result.bossHp.toLocaleString()}`,
    result.userHp !== undefined ? `自分のHP：${result.userHp.toLocaleString()}` : "",
    result.paid !== undefined ? `消費：${bossMoney(result.paid)}／処理後残高：${bossMoney(result.balance ?? 0)}` : "",
  ].filter(Boolean).join("\n").slice(0, 2000);
}
