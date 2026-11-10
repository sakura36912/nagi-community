import {
  ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction, type Guild,
} from "discord.js";
import {
  ZombieError, ZOMBIE_REWARDS, beginZombieGame, changeZombieSettingList, decideZombieRequest, endZombieGame,
  getZombieConfig, getZombieGame, performZombieAction, setZombieReward, setZombieRole, startZombieGame,
  updateZombieConfig, zombieDeliveryFailures, getZombieVoiceIds, type ZombieConfig,
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
        const result = await performZombieAction(i.id, guild.id, uid, i.options.getUser("対象", true).id, i.commandName);
        if (result.status !== "accepted") throw new ZombieError("この操作は成立していません。参加状態・同席時間などの条件を確認してください。");
        await i.editReply("条件を満たしたため、管理者の承認なしで処理が成立しました。対象の役職は開示しません。");
      } else {
        if (sub === "accept") await observeZombieGuild(guild);
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
      const target = i.options.getChannel("対象"), enabled = i.options.getBoolean("有効");
      if (!target && enabled === null) {
        const config = await getZombieConfig(guild.id);
        const current = config?.vcIds ?? [], defaults: string[] = [];
        for (const id of current.slice(0, 25)) {
          let channel;
          try { channel = await guild.channels.fetch(id); }
          catch (error) {
            if ((error as { code?: number }).code === 10003) continue;
            throw error;
          }
          if (channel?.type === ChannelType.GuildVoice && channel.guildId === guild.id) defaults.push(id);
        }
        const menu = new ChannelSelectMenuBuilder()
          .setCustomId(`zmbvc:${guild.id}:${uid}:${Date.now()}`)
          .setPlaceholder("対象の酒場VCをまとめて選択（最大25件）")
          .setChannelTypes(ChannelType.GuildVoice).setMinValues(0).setMaxValues(25);
        if (defaults.length) menu.setDefaultChannels(...defaults);
        await i.editReply({
          content: `現在の設定：${current.length}件。対象の酒場VCを複数選択してください。\n` +
            "選択を確定すると、選んだVCで設定全体を置き換えます。0件で全解除。次回イベントから適用され、開催中の設定は変わりません。\n" +
            "指定したHubの転送先VCも、同じサーバーの対応記録がある場合は自動で対象になります。別々のVCの同席時間は合算しません。\n" +
            (current.length > 25 ? "現在は25件を超えています。メニューで保存すると最大25件になります。26件以上を維持する場合は従来の「対象」「有効」オプションで追加・解除してください。\n" : "") +
            "このメニューは操作した管理者専用で、15分間有効です。",
          components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu)],
          allowedMentions: { parse: [] },
        });
      } else {
        if (!target || enabled === null) throw new ZombieError("「対象」と「有効」を両方指定するか、両方省略して複数選択してください。");
        const channel = await guild.channels.fetch(target.id);
        if (!channel || channel.type !== ChannelType.GuildVoice) throw new ZombieError("通常のボイスチャンネルを指定してください。");
        await changeZombieSettingList(guild.id, "vcIds", channel.id, enabled);
        await i.editReply("対象酒場VCを更新しました。次回イベントへ適用されます。");
      }
    } else if (sub === "exclude") {
      const user = i.options.getUser("ユーザー"), role = i.options.getRole("ロール");
      if ((!user && !role) || (user && role)) throw new ZombieError("ユーザーかロールのどちらか1つだけ指定してください。");
      await changeZombieSettingList(guild.id, user ? "excludedUsers" : "excludedRoles", (user ?? role)!.id, i.options.getBoolean("除外", true));
      await i.editReply("次回イベントの参加除外設定を更新しました。開催中の参加者・途中参加の条件は変更しません。");
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
      const allowedVoices = await getZombieVoiceIds(guild.id, config.vcIds);
      for (const voice of guild.voiceStates.cache.values()) {
        if (!voice.channelId || !allowedVoices.includes(voice.channelId)) continue;
        const member = await guild.members.fetch({ user: voice.id, force: true });
        if (member.user.bot || config.excludedUsers.includes(member.id) || config.excludedRoles.some(r => member.roles.cache.has(r))
          || await isVcTrackingOptedOut(guild.id, member.id)) continue;
        participants.push({ id: member.id, name: member.displayName });
      }
      const counts = { zombies: i.options.getInteger("ゾンビ数") ?? 1, healers: i.options.getInteger("治療班数") ?? 2 };
      const game = await startZombieGame(i.id, guild.id, participants, Date.now(), counts);
      const players = Object.values(game.players);
      await i.editReply(`${players.length}人を登録しました。初期役職は重複なしのランダム抽選です。\nゾンビ${players.filter(p => p.role === "zombie").length}人・治療班${players.filter(p => p.role === "healer").length}人・人間${players.filter(p => p.role === "human").length}人。\n本人DMと管理用ログを送信します。/zombie status で確認し、/zombie begin でゲームを開始してください。再実行による再抽選はしません。`);
    } else if (["set_zombie", "set_healer", "set_human"].includes(sub)) {
      await setZombieRole(guild.id, i.options.getUser("対象", true).id, sub === "set_zombie" ? "zombie" : sub === "set_healer" ? "healer" : "human");
      await i.editReply("秘密の役職を保存しました。本人DMと管理用ログを送信します。DM失敗は /zombie status で確認できます。");
    } else if (sub === "begin") {
      const game = await getZombieGame(guild.id);
      if (!game) throw new ZombieError("準備中のイベントがありません。");
      await validateChannels(guild, game.config);
      await observeZombieGuild(guild);
      const started = await beginZombieGame(guild.id, Date.now(), i.options.getInteger("開催時間", true));
      await observeZombieGuild(guild);
      if (started.scheduledEndAt === undefined) {
        await i.editReply("既に開催中のイベントです。このイベントは終了予定未設定のため、従来どおり手動終了です。再実行では予定を変更しません。");
        return;
      }
      await i.editReply(`ゲームを開始しました。公開の告知・ルールを送信します。\n新規参加受付は終了予定の10分前までです。登録済み参加者は終了までプレイできます。\n受付終了：<t:${Math.floor((started.scheduledEndAt! - 600_000) / 1000)}:F>\n自動終了：<t:${Math.floor(started.scheduledEndAt! / 1000)}:F>\n報酬・対象VC・除外条件は固定です。`);
    } else {
      const game = await getZombieGame(guild.id);
      if (!game) throw new ZombieError("イベントがありません。");
      if (sub === "me") {
        const p = game.players[uid];
        if (!p) throw new ZombieError("今回のイベントの参加者ではありません。");
        await i.editReply(`あなたの役職：**${zombieRoleName(p.role)}**\nイベント状態：${game.phase}${p.role === "healer" ? `\n治療クールタイム：残り${Math.max(0, Math.ceil(((p.healCooldownUntil ?? 0) - Date.now()) / 1000))}秒` : ""}\n役職・感染者情報は公開しないでください。`);
      } else if (sub === "end" || sub === "cancel") {
        if (!i.options.getBoolean("確認", true)) throw new ZombieError("終了／中止する場合は確認をTrueにしてください。");
        if (sub === "end" && game.phase === "running") await observeZombieGuild(guild);
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
        if (game.scheduledEndAt !== undefined) embed.addFields({ name: "予定時刻", value:
          `新規参加受付終了：<t:${Math.floor((game.scheduledEndAt - 600_000) / 1000)}:F>\nイベント終了：<t:${Math.floor(game.scheduledEndAt / 1000)}:F>` });
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
    if (action === "accept") await observeZombieGuild(i.guild);
    const result = await decideZombieRequest(i.guild.id, gameId, requestId, i.user.id, action === "accept");
    await i.editReply(`申請結果：${result.request.status}（処理済みの場合は再処理しません）`);
    await i.message.edit({ components: [] }).catch(() => undefined);
    void flushZombieJobs(i.client);
  } catch (error) { await i.editReply(error instanceof ZombieError ? error.message : "処理を完了できませんでした。管理用設定をご確認ください。"); }
  return true;
}
export async function handleZombieVcSelection(i: ChannelSelectMenuInteraction) {
  if (!i.customId.startsWith("zmbvc:")) return false;
  await i.deferUpdate();
  try {
    if (!i.guild) throw new ZombieError("サーバー内で使用してください。");
    await requireZombieAdmin(i.guild, i.user.id);
    const parts = i.customId.split(":"), issuedAt = Number(parts[3]);
    if (parts.length !== 4 || parts[1] !== i.guild.id || parts[2] !== i.user.id)
      throw new ZombieError("このメニューを開いた管理者本人のみ操作できます。");
    if (!Number.isSafeInteger(issuedAt) || issuedAt > Date.now() || Date.now() - issuedAt > 15 * 60000)
      throw new ZombieError("メニューの期限が切れています。/zombie vc を実行し直してください。");
    const ids = [...new Set(i.values)];
    if (ids.length > 25 || ids.length !== i.values.length) throw new ZombieError("VCは重複なしで最大25件まで選択してください。");
    for (const id of ids) {
      const channel = await i.guild.channels.fetch(id, { force: true });
      if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== i.guild.id)
        throw new ZombieError("選択したVCが存在しないか、通常のボイスチャンネルではありません。設定は保存していません。");
    }
    await updateZombieConfig(i.guild.id, { vcIds: ids });
    await i.editReply({
      content: `対象酒場VCを${ids.length}件保存しました。${ids.length ? ids.map(id => `<#${id}>`).join(" ") : "対象VCはすべて解除されました。"}\n次回イベントから適用されます。開催中の設定・参加者・同席時間は変わりません。`,
      components: [], allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (!(error instanceof ZombieError)) logger.warn("[zombie] VC選択の処理結果を確認できませんでした。");
    await i.followUp({
      content: error instanceof ZombieError ? error.message : "処理結果を確認できませんでした。/zombie vc で保存内容を確認してください。",
      flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
    });
  }
  return true;
}
const zombie = new SlashCommandBuilder().setName("zombie").setDescription("秘密役職のハロウィン感染イベント").setDMPermission(false);
zombie.addSubcommand(s => {
  s.setName("config").setDescription("管理者：公開3・非公開3チャンネルを設定");
  for (const name of ["告知", "ルール", "結果", "管理", "感染ログ", "役職管理"])
    s.addChannelOption(o => o.setName(name).setDescription(`${name}用テキストチャンネル`).addChannelTypes(ChannelType.GuildText).setRequired(true));
  return s;
});
zombie.addSubcommand(s => s.setName("vc").setDescription("管理者：省略で酒場VCを複数選択。個別追加・解除も可能")
  .addChannelOption(o => o.setName("対象").setDescription("個別変更時の酒場VC").addChannelTypes(ChannelType.GuildVoice))
  .addBooleanOption(o => o.setName("有効").setDescription("個別変更：Trueで追加、Falseで解除")));
zombie.addSubcommand(s => s.setName("exclude").setDescription("管理者：次回イベントの参加除外ユーザー・ロール")
  .addBooleanOption(o => o.setName("除外").setDescription("Trueで除外、Falseで解除").setRequired(true))
  .addUserOption(o => o.setName("ユーザー").setDescription("除外するユーザー"))
  .addRoleOption(o => o.setName("ロール").setDescription("除外するロール")));
zombie.addSubcommand(s => s.setName("rewards").setDescription("管理者：報酬7項目の設定・確認")
  .addStringOption(o => o.setName("項目").setDescription("報酬項目").addChoices(...Object.entries(labels).map(([value, name]) => ({ name, value }))))
  .addIntegerOption(o => o.setName("金額").setDescription("銀行残高への加算額（無料は0）").setMinValue(0).setMaxValue(2147483647)));
zombie.addSubcommand(s => s.setName("start").setDescription("管理者：酒場VC参加者を登録し秘密役職をランダム抽選")
  .addIntegerOption(o => o.setName("ゾンビ数").setDescription("初期ゾンビの人数（省略時1人）").setMinValue(1))
  .addIntegerOption(o => o.setName("治療班数").setDescription("治療班の人数（省略時2人）").setMinValue(1)));
zombie.addSubcommand(s => s.setName("begin").setDescription("管理者：開催分数を指定して開始（終了10分前に受付終了）")
  .addIntegerOption(o => o.setName("開催時間").setDescription("開始から自動終了までの分数（11〜10080分）")
    .setRequired(true).setMinValue(11).setMaxValue(10080)));
zombie.addSubcommand(s => s.setName("me").setDescription("自分の秘密役職を本人限定で確認"));
for (const name of ["set_zombie", "set_healer", "set_human"])
  zombie.addSubcommand(s => s.setName(name).setDescription("管理者：準備中の参加者の秘密役職を設定")
    .addUserOption(o => o.setName("対象").setDescription("登録済みの参加者（準備中の修正用）").setRequired(true)));
for (const name of ["status", "requests"])
  zombie.addSubcommand(s => s.setName(name).setDescription("管理者：非公開の状態・申請一覧")
    .addIntegerOption(o => o.setName("ページ").setDescription("一覧ページ").setMinValue(1)));
for (const name of ["end", "cancel"])
  zombie.addSubcommand(s => s.setName(name).setDescription(name === "end" ? "管理者：勝敗確定と報酬配布" : "管理者：報酬なしでイベント中止")
    .addBooleanOption(o => o.setName("確認").setDescription("終了／中止に同意する場合True").setRequired(true)));
export const zombieCommands = [
  { data: zombie, execute: executeZombie },
  ...(["infect", "heal"] as const).map(name => ({
    data: new SlashCommandBuilder().setName(name).setDescription(name === "infect" ? "連続3分同席後の感染（管理承認不要）" : "連続3分同席後の治療（管理承認不要）").setDMPermission(false)
      .addSubcommand(s => s.setName("request").setDescription("対象者と連続3分会話した後に実行（管理承認不要）")
        .addUserOption(o => o.setName("対象").setDescription("同じ酒場VCの参加者").setRequired(true)))
      .addSubcommand(s => s.setName("accept").setDescription("管理者：変更前の承認待ち申請を承認")
        .addStringOption(o => o.setName("申請").setDescription("申請ID").setRequired(true)))
      .addSubcommand(s => s.setName("reject").setDescription("管理者：変更前の承認待ち申請を却下")
        .addStringOption(o => o.setName("申請").setDescription("申請ID").setRequired(true))),
    execute: executeZombie,
  })),
];
