import {
  ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
  type ButtonInteraction, type ChatInputCommandInteraction, type Guild,
} from "discord.js";
import {
  ZombieError, ZOMBIE_REWARDS, beginZombieGame, changeZombieSettingList, decideZombieRequest, endZombieGame,
  getZombieConfig, getZombieGame, requestZombieAction, setZombieReward, setZombieRole, startZombieGame,
  updateZombieConfig, zombieDeliveryFailures, type ZombieConfig,
} from "@workspace/db";
import { isVcTrackingOptedOut } from "../lib/community.js";
import { flushZombieJobs, observeZombieGuild, zombieRoleName, zombieTextChannel } from "../lib/zombieRuntime.js";
import { logger } from "../lib/logger.js";
const labels = {
  humanSurvival: "人間：生存報酬", humanVictory: "人間：勝利報酬", neverInfected: "人間：未感染ボーナス",
  zombieVictory: "ゾンビ：勝利報酬", mostInfections: "ゾンビ：最多感染ボーナス",
  healerCoop: "治療班：協力報酬", perHeal: "治療班：治療人数1人あたり",
};
export async function requireZombieAdmin(guild: Guild, userId: string) {
  await guild.roles.fetch();
  const member = await guild.members.fetch({ user: userId, force: true });
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) throw new ZombieError("管理者のみ操作できます。");
}
async function validateChannels(guild: Guild, config: ZombieConfig) {
  if (new Set([config.adminId, config.infectionLogId, config.roleLogId]).size !== 3)
    throw new ZombieError("管理・感染ログ・役職管理は別々のチャンネルを指定してください。");
  for (const id of [config.announceId, config.rulesId, config.resultId]) {
    if ([config.adminId, config.infectionLogId, config.roleLogId].includes(id)) throw new ZombieError("公開用と管理用チャンネルを共用できません。");
    await zombieTextChannel(guild, id, false);
  }
  for (const id of [config.adminId, config.infectionLogId, config.roleLogId]) await zombieTextChannel(guild, id, true);
}
async function executeZombie(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!i.guild) throw new ZombieError("サーバー内で使用してください。");
    const guild = i.guild, sub = i.options.getSubcommand(), uid = i.user.id;
    if (i.commandName !== "zombie" || sub !== "me") {
      if (!["infect", "heal"].includes(i.commandName) || sub !== "request") await requireZombieAdmin(guild, uid);
    }
    if (i.commandName === "infect" || i.commandName === "heal") {
      if (sub === "request") {
        await observeZombieGuild(guild);
        await requestZombieAction(i.id, guild.id, uid, i.options.getUser("対象", true).id, i.commandName);
        await i.editReply("申請を管理者へ送信しました。同席時間だけでは成立せず、会話の確認と管理承認が必要です。対象の役職は開示しません。");
      } else {
        const game = await getZombieGame(guild.id);
        if (!game) throw new ZombieError("イベントがありません。");
        const rid = i.options.getString("申請", true);
        if (game.requests[rid]?.type !== i.commandName) throw new ZombieError("この種類の申請が見つかりません。");
        const result = await decideZombieRequest(guild.id, game.id, rid, uid, sub === "accept");
        await i.editReply(`申請 ${result.request.id}：${result.request.status}（処理済みの場合は再処理しません）`);
      }
    } else if (sub === "config") {
      const old = await getZombieConfig(guild.id);
      const patch = {
        announceId: i.options.getChannel("告知", true).id, rulesId: i.options.getChannel("ルール", true).id,
        resultId: i.options.getChannel("結果", true).id, adminId: i.options.getChannel("管理", true).id,
        infectionLogId: i.options.getChannel("感染ログ", true).id, roleLogId: i.options.getChannel("役職管理", true).id,
      };
      await validateChannels(guild, { ...old, ...patch } as ZombieConfig);
      await updateZombieConfig(guild.id, patch);
      await i.editReply("チャンネル設定を保存しました。次に /zombie vc と /zombie rewards を設定してください。設定変更は次回イベントへ適用されます。");
    } else if (sub === "vc") {
      const channel = await guild.channels.fetch(i.options.getChannel("対象", true).id);
      if (!channel || channel.type !== ChannelType.GuildVoice) throw new ZombieError("通常のボイスチャンネルを指定してください。");
      await changeZombieSettingList(guild.id, "vcIds", channel.id, i.options.getBoolean("有効", true));
      await i.editReply("対象酒場VCを更新しました。次回イベントへ適用されます。");
    } else if (sub === "exclude") {
      const user = i.options.getUser("ユーザー"), role = i.options.getRole("ロール");
      if ((!user && !role) || (user && role)) throw new ZombieError("ユーザーかロールのどちらか1つだけ指定してください。");
      await changeZombieSettingList(guild.id, user ? "excludedUsers" : "excludedRoles", (user ?? role)!.id, i.options.getBoolean("除外", true));
      await i.editReply("開始時の除外対象を更新しました。開催済みの参加者は変更しません。");
    } else if (sub === "rewards") {
      const key = i.options.getString("項目");
      if (key) {
        const amount = i.options.getInteger("金額");
        if (amount === null) throw new ZombieError("金額も指定してください（無料は0）。");
        await setZombieReward(guild.id, key as typeof ZOMBIE_REWARDS[number], amount);
      } else if (i.options.getInteger("金額") !== null) throw new ZombieError("報酬項目を指定してください。");
      const config = await getZombieConfig(guild.id);
      await i.editReply(ZOMBIE_REWARDS.map(k => `${labels[k]}：${config?.rewards[k] == null ? "未設定" : `$${config.rewards[k]!.toLocaleString("ja-JP")}`}`).join("\n") +
        "\n7項目すべての設定後に開始できます。開催中の報酬は固定です。");
    } else if (sub === "start") {
      const config = await getZombieConfig(guild.id);
      if (!config) throw new ZombieError("先に /zombie config を設定してください。");
      await validateChannels(guild, config);
      for (const id of config.vcIds) {
        const vc = await guild.channels.fetch(id);
        if (!vc || vc.type !== ChannelType.GuildVoice) throw new ZombieError("対象VCが存在しません。/zombie vc で修正してください。");
      }
      const participants: { id: string; name: string }[] = [];
      for (const voice of guild.voiceStates.cache.values()) {
        if (!voice.channelId || !config.vcIds.includes(voice.channelId)) continue;
        const member = await guild.members.fetch({ user: voice.id, force: true });
        if (member.user.bot || config.excludedUsers.includes(member.id) || config.excludedRoles.some(r => member.roles.cache.has(r))
          || await isVcTrackingOptedOut(guild.id, member.id)) continue;
        participants.push({ id: member.id, name: member.displayName });
      }
      const game = await startZombieGame(i.id, guild.id, participants);
      await i.editReply(`${Object.keys(game.players).length}人を登録しました（役職設定待ち）。\n/zombie set_zombie・set_healer で秘密の役職を指定し、/zombie begin でゲームを開始してください。`);
    } else if (["set_zombie", "set_healer", "set_human"].includes(sub)) {
      await setZombieRole(guild.id, i.options.getUser("対象", true).id, sub === "set_zombie" ? "zombie" : sub === "set_healer" ? "healer" : "human");
      await i.editReply("秘密の役職を保存しました。本人DMと管理用ログを送信します。DM失敗は /zombie status で確認できます。");
    } else if (sub === "begin") {
      const game = await getZombieGame(guild.id);
      if (!game) throw new ZombieError("準備中のイベントがありません。");
      await validateChannels(guild, game.config);
      await beginZombieGame(guild.id); await observeZombieGuild(guild);
      await i.editReply("ゲームを開始しました。公開の告知・ルールを送信します。参加者や報酬設定はここから固定です。");
    } else {
      const game = await getZombieGame(guild.id);
      if (!game) throw new ZombieError("イベントがありません。");
      if (sub === "me") {
        const p = game.players[uid];
        if (!p) throw new ZombieError("今回のイベントの参加者ではありません。");
        await i.editReply(`あなたの役職：**${zombieRoleName(p.role)}**\nイベント状態：${game.phase}\n役職・感染者情報は公開しないでください。`);
      } else if (sub === "end" || sub === "cancel") {
        if (!i.options.getBoolean("確認", true)) throw new ZombieError("終了／中止する場合は確認をTrueにしてください。");
        const result = await endZombieGame(guild.id, game.id, sub === "cancel", Date.now(), { id: i.id, actor: uid });
        await i.editReply(result.phase === "cancelled" ? "イベントを中止しました。報酬配布はありません。" : "終了と銀行残高への報酬加算が完了しました。再実行しても二重配布しません。");
      } else if (sub === "requests") {
        const requests = Object.values(game.requests).filter(r => r.status === "pending" && Date.now() - r.createdAt < 900000);
        const page = i.options.getInteger("ページ") ?? 1;
        await i.editReply(`承認待ち ${requests.length}件 / ${page}ページ\n` + (requests.slice((page - 1) * 8, page * 8).map(r =>
          `${r.id} / ${r.type} / ${escapeMarkdown(game.players[r.actor]!.name)} → ${escapeMarkdown(game.players[r.target]!.name)} / 同席${r.seconds}秒`).join("\n") || "該当なし"));
      } else if (sub === "status") {
        const players = Object.values(game.players), page = i.options.getInteger("ページ") ?? 1;
        const list = players.slice((page - 1) * 5, page * 5);
        const embed = new EmbedBuilder().setTitle("ゾンビイベント — 管理者限定")
          .setDescription(`状態：${game.phase}\nゾンビ ${players.filter(p => p.role === "zombie").length}人 / 人間 ${players.filter(p => p.role === "human").length}人 / 治療班 ${players.filter(p => p.role === "healer").length}人\n感染成立 ${Object.values(game.requests).filter(r => r.type === "infect" && r.status === "accepted").length}件 / 治療成立 ${Object.values(game.requests).filter(r => r.type === "heal" && r.status === "accepted").length}件`)
          .addFields({ name: `参加者 ${page}/${Math.max(1, Math.ceil(players.length / 5))}ページ`, value: list.map(p =>
            `${escapeMarkdown(p.name)} (${p.id}) — **${zombieRoleName(p.role)}**\n感染${p.infectedUsers.length}人 / 治療${p.healedUsers.length}人`).join("\n").slice(0, 1024) || "該当なし" });
        const failures = await zombieDeliveryFailures(guild.id);
        if (failures.length) embed.addFields({ name: "未送信通知（自動再試行中）", value: failures.map(f => f.id).join("\n").slice(0, 1024) });
        await i.editReply({ embeds: [embed] });
      }
    }
    void flushZombieJobs(i.client);
  } catch (error) {
    if (!(error instanceof ZombieError)) logger.warn("[zombie] 操作を完了できませんでした。権限・接続・チャンネル設定を確認してください。");
    await i.editReply({ content: error instanceof ZombieError ? error.message : "処理を完了できませんでした。設定・権限・接続を確認してください。", allowedMentions: { parse: [] } });
  }
}
export async function handleZombieButton(i: ButtonInteraction) {
  if (!i.customId.startsWith("zmb:")) return false;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!i.guild) throw new ZombieError("サーバー内で使用してください。");
    await requireZombieAdmin(i.guild, i.user.id);
    const [, action, gameId, requestId] = i.customId.split(":");
    if (!gameId || !requestId || !["accept", "reject"].includes(action!)) throw new ZombieError("申請ボタンが無効です。");
    const result = await decideZombieRequest(i.guild.id, gameId, requestId, i.user.id, action === "accept");
    await i.editReply(`申請結果：${result.request.status}（処理済みの場合は再処理しません）`);
    await i.message.edit({ components: [] }).catch(() => undefined);
    void flushZombieJobs(i.client);
  } catch (error) { await i.editReply(error instanceof ZombieError ? error.message : "処理を完了できませんでした。管理用設定をご確認ください。"); }
  return true;
}
const zombie = new SlashCommandBuilder().setName("zombie").setDescription("秘密役職のハロウィン感染イベント").setDMPermission(false);
zombie.addSubcommand(s => {
  s.setName("config").setDescription("管理者：公開3・非公開3チャンネルを設定");
  for (const name of ["告知", "ルール", "結果", "管理", "感染ログ", "役職管理"])
    s.addChannelOption(o => o.setName(name).setDescription(`${name}用テキストチャンネル`).addChannelTypes(ChannelType.GuildText).setRequired(true));
  return s;
});
zombie.addSubcommand(s => s.setName("vc").setDescription("管理者：対象酒場VCを追加・解除")
  .addChannelOption(o => o.setName("対象").setDescription("酒場VC").addChannelTypes(ChannelType.GuildVoice).setRequired(true))
  .addBooleanOption(o => o.setName("有効").setDescription("Trueで追加、Falseで解除").setRequired(true)));
zombie.addSubcommand(s => s.setName("exclude").setDescription("管理者：開始時の除外ユーザー・ロール")
  .addBooleanOption(o => o.setName("除外").setDescription("Trueで除外、Falseで解除").setRequired(true))
  .addUserOption(o => o.setName("ユーザー").setDescription("除外するユーザー"))
  .addRoleOption(o => o.setName("ロール").setDescription("除外するロール")));
zombie.addSubcommand(s => s.setName("rewards").setDescription("管理者：報酬7項目の設定・確認")
  .addStringOption(o => o.setName("項目").setDescription("報酬項目").addChoices(...Object.entries(labels).map(([value, name]) => ({ name, value }))))
  .addIntegerOption(o => o.setName("金額").setDescription("銀行残高への加算額（無料は0）").setMinValue(0).setMaxValue(2147483647)));
for (const [name, description] of [["start", "管理者：現在の酒場VC参加者を登録し役職設定待ちへ"], ["begin", "管理者：役職設定後にゲーム開始"], ["me", "自分の秘密役職を本人限定で確認"]] as const)
  zombie.addSubcommand(s => s.setName(name).setDescription(description));
for (const name of ["set_zombie", "set_healer", "set_human"])
  zombie.addSubcommand(s => s.setName(name).setDescription("管理者：準備中の参加者の秘密役職を設定")
    .addUserOption(o => o.setName("対象").setDescription("開始時に登録された参加者").setRequired(true)));
for (const name of ["status", "requests"])
  zombie.addSubcommand(s => s.setName(name).setDescription("管理者：非公開の状態・申請一覧")
    .addIntegerOption(o => o.setName("ページ").setDescription("一覧ページ").setMinValue(1)));
for (const name of ["end", "cancel"])
  zombie.addSubcommand(s => s.setName(name).setDescription(name === "end" ? "管理者：勝敗確定と報酬配布" : "管理者：報酬なしでイベント中止")
    .addBooleanOption(o => o.setName("確認").setDescription("終了／中止に同意する場合True").setRequired(true)));
export const zombieCommands = [
  { data: zombie, execute: executeZombie },
  ...(["infect", "heal"] as const).map(name => ({
    data: new SlashCommandBuilder().setName(name).setDescription(name === "infect" ? "ゾンビ感染の申請・管理承認" : "治療班による治療の申請・管理承認").setDMPermission(false)
      .addSubcommand(s => s.setName("request").setDescription("対象者と連続3分会話した後に申請")
        .addUserOption(o => o.setName("対象").setDescription("同じ酒場VCの参加者").setRequired(true)))
      .addSubcommand(s => s.setName("accept").setDescription("管理者：会話を確認した感染・治療申請を承認")
        .addStringOption(o => o.setName("申請").setDescription("申請ID").setRequired(true)))
      .addSubcommand(s => s.setName("reject").setDescription("管理者：感染・治療申請を却下")
        .addStringOption(o => o.setName("申請").setDescription("申請ID").setRequired(true))),
    execute: executeZombie,
  })),
];
