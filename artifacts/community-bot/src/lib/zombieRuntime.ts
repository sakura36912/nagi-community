import { createHash, randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits, escapeMarkdown,
  type Client, type Guild, type TextChannel,
} from "discord.js";
import { ZombieError, deliverZombieJob, enrollZombieParticipants, getZombieGame, getZombieGameById, pendingZombieJobs, syncZombiePresence, type ZombieJob, type ZombieGame } from "@workspace/db";
import { isVcTrackingOptedOut } from "./community.js";
import { logger } from "./logger.js";
let epoch = randomUUID();
let connected = false;
let delivering = false;
let observing = false;
/** Reset after gateway loss/resume. Never credit unobserved time during outages. */
export function resetZombieConnection(ready: boolean) { epoch = randomUUID(); connected = ready; }
export async function observeZombieGuild(guild: Guild) {
  if (!connected || guild.available === false || !guild.client.isReady()) throw new ZombieError("BotのVC接続を確認中です。少し待って再実行してください。");
  const observedEpoch = epoch;
  try {
    const now = Date.now(), snapshot: Record<string, string> = {};
    const voices = [...guild.voiceStates.cache.values()].map(v => ({
      id: v.id, channel: v.channelId, muted: v.mute || v.deaf, bot: v.member?.user.bot,
    }));
    const game = await getZombieGame(guild.id);
    if (!game || !["preparing", "running"].includes(game.phase)) return;
    const candidates: { id: string; name: string; channel: string }[] = [];
    for (const voice of voices) {
      if (!voice.channel || voice.bot || !game.config.vcIds.includes(voice.channel)) continue;
      if (await isVcTrackingOptedOut(guild.id, voice.id)) continue;
      if (!Object.hasOwn(game.players, voice.id)) {
        if (game.config.excludedUsers.includes(voice.id)) continue;
        let member;
        try { member = await guild.members.fetch({ user: voice.id, force: true }); }
        catch (error) {
          if ((error as { code?: number }).code === 10007) continue; // Left the guild during observation.
          throw error;
        }
        if (member.user.bot || game.config.excludedRoles.some(id => member.roles.cache.has(id))) continue;
        candidates.push({ id: member.id, name: member.displayName, channel: voice.channel });
      }
      if (!voice.muted) snapshot[voice.id] = voice.channel;
    }
    if (!connected || !guild.client.isReady() || observedEpoch !== epoch) throw new ZombieError("VC接続が切り替わりました。");
    if (candidates.length) await enrollZombieParticipants(guild.id, game.id, candidates, now);
    if (!connected || !guild.client.isReady() || observedEpoch !== epoch) throw new ZombieError("VC接続が切り替わりました。");
    await syncZombiePresence(guild.id, observedEpoch, snapshot, now, game.id);
    if (!connected || !guild.client.isReady() || observedEpoch !== epoch) throw new ZombieError("VC接続が切り替わりました。");
  } catch {
    // A failed write may have missed a leave/rejoin. Do not retain old continuity.
    epoch = randomUUID();
    throw new ZombieError("VC観測を確認できませんでした。同席時間を数え直すため、接続復旧後に再度交流してください。");
  }
}
export async function zombieTextChannel(guild: Guild, id: string, privateOnly: boolean): Promise<TextChannel> {
  const channel = await guild.channels.fetch(id, { force: true });
  if (!channel || channel.type !== ChannelType.GuildText) throw new ZombieError("通常のテキストチャンネルを指定してください。");
  const me = guild.members.me ?? await guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
    throw new ZombieError("Botに閲覧・送信・埋め込み権限が必要です。");
  if (privateOnly) {
    const roles = await guild.roles.fetch();
    for (const role of roles.values()) {
      if (role.permissions.has(PermissionFlagsBits.Administrator) || role.tags?.botId === me.id) continue;
      if (channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel))
        throw new ZombieError("管理チャンネルは管理者とこのBotだけが閲覧できるようにしてください。");
    }
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== 1 || overwrite.id === me.id) continue;
      const member = await guild.members.fetch({ user: overwrite.id, force: true });
      if (!member.permissions.has(PermissionFlagsBits.Administrator) && channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
        throw new ZombieError("管理チャンネルに一般メンバーの閲覧許可があります。");
    }
  }
  return channel;
}
export const zombieRoleName = (role: string) => ({ human: "人間", zombie: "ゾンビ", healer: "治療班" })[role] ?? role;
export function zombiePublicResult(game: ZombieGame) {
  return new EmbedBuilder().setColor(game.winner === "human" ? 0x49a979 : 0x9870bb)
    .setTitle("Halloween ゾンビ感染ゲーム — 結果")
    .setDescription(`**${game.winner === "human" ? "人間陣営" : "ゾンビ陣営"}の勝利**\n参加者 ${Object.keys(game.players).length}人\n銀行Botへ報酬を加算しました。個人の報酬はDMで通知します。\n役職・感染者・治療班の一覧は公開しません。`)
    .setFooter({ text: `イベントID：${game.id}` });
}
async function sendJob(client: Client, id: string, payload: ZombieJob) {
  const game = await getZombieGameById(payload.gameId);
  if (!game) throw new Error("Event missing");
  const nonce = createHash("sha256").update(id).digest("hex").slice(0, 24);
  if (payload.kind === "dm") {
    if (payload.version !== undefined && (game.players[payload.userId!]?.version !== payload.version || game.phase === "cancelled")) return;
    const prefix = payload.version === undefined ? "" : game.phase === "ended" ? "【終了済みイベントの通知】\n" :
      game.phase === "preparing" ? "【役職設定中：開始告知をお待ちください】\n" : "";
    await (await client.users.fetch(payload.userId!)).send({ content: `${prefix}${payload.text}`, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
    return;
  }
  const guild = client.guilds.cache.get(game.guildId) ?? await client.guilds.fetch(game.guildId);
  const privateOnly = ["request", "audit"].includes(payload.kind);
  const channelId = payload.kind === "request" ? game.config.adminId : payload.kind === "result" ? game.config.resultId :
    payload.kind === "rules" ? game.config.rulesId : payload.kind === "announce" ? game.config.announceId : payload.channelId!;
  const channel = await zombieTextChannel(guild, channelId, privateOnly);
  if (payload.kind === "request") {
    const r = game.requests[payload.requestId!];
    if (!r || r.status !== "pending" || game.phase !== "running" || Date.now() - r.createdAt >= 900000) return;
    const actor = game.players[r.actor]!, target = game.players[r.target]!;
    const embed = new EmbedBuilder().setTitle(`${r.type === "infect" ? "感染" : "治療"}申請 — 管理者確認`)
      .setDescription(`申請者：${escapeMarkdown(actor.name)} (${actor.id})\n対象：${escapeMarkdown(target.name)} (${target.id})\n対象役職：${zombieRoleName(target.role)}\nVC：<#${r.channel}>\n連続同席：${r.seconds}秒\n\n**実際に3分以上会話したことを確認して承認してください。**\n無言・挨拶だけ・テキスト交流は承認しないでください。`)
      .setFooter({ text: `申請ID：${r.id} / 有効期限15分` });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`zmb:accept:${game.id}:${r.id}`).setLabel("会話を確認して承認").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`zmb:reject:${game.id}:${r.id}`).setLabel("却下").setStyle(ButtonStyle.Danger),
    );
    await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] }, nonce, enforceNonce: true });
  } else if (payload.kind === "result") {
    await channel.send({ embeds: [zombiePublicResult(game)], allowedMentions: { parse: [] }, nonce, enforceNonce: true });
  } else {
    if (["announce", "rules"].includes(payload.kind) && game.phase !== "running") return;
    const text = payload.kind === "announce" ? `Halloween ゾンビ感染ゲームを開始しました。現在${Object.keys(game.players).length}人が参加対象です。\n対象の酒場VCに途中入室した方も、除外対象でなければ人間として自動参加します。役職は秘密です。DMとルールを確認してください。` :
      payload.kind === "rules" ? "**ゾンビ感染ゲームのルール**\n・対象酒場VCへの途中入室も人間として自動参加します（Bot・除外対象・VC記録拒否者を除く）。\n・指定酒場VCで連続3分以上会話し、管理者の承認を受けます。\n・感染：`/infect request 対象:ユーザー`\n・治療：`/heal request 対象:ユーザー`\n・自分の役職：`/zombie me`（本人限定表示）\n・役職、治療班、感染者情報の公開は禁止です。\n・無言滞在、挨拶だけ、チャット、リアクションは感染・治療の対象外です。\n・ミュート・退出・移動・Bot再接続後は同席時間を数え直します。\n・治療班以外が全員ゾンビになるとゾンビ勝利。管理終了時に人間が残れば人間勝利。\n・録音や会話内容の保存はしません。迷惑行為・無理な感染は禁止です。" : payload.text!;
    // Audit text contains private nicknames: disable mentions; send only in verified private channels.
    await channel.send({ content: text.slice(0, 1950), allowedMentions: { parse: [] }, nonce, enforceNonce: true });
  }
}
export async function flushZombieJobs(client: Client) {
  if (delivering) return;
  delivering = true;
  try {
    for (const row of await pendingZombieJobs()) await deliverZombieJob(row.id, payload => sendJob(client, row.id, payload));
  } catch { logger.warn("[zombie] 通知キューの処理に失敗しました。次回再試行します。"); }
  finally { delivering = false; }
}
export function startZombieRuntime(client: Client) {
  resetZombieConnection(true);
  const tick = async () => {
    if (observing) return;
    observing = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        try { await observeZombieGuild(guild); }
        catch { logger.warn("[zombie] 自動参加・VC観測を更新できませんでした。次回再試行します。"); }
      }
    } finally { observing = false; }
    await flushZombieJobs(client);
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
