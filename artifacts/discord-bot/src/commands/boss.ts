import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags,
  PermissionFlagsBits, SlashCommandBuilder,
  type ChatInputCommandInteraction, type ButtonInteraction,
} from "discord.js";
import {
  BossError, ForgeError, getBossFees, configureBossFees, createBossEvent, endBossEvent, getBossInfo,
  createBossJoinRequest, confirmBossJoin, cancelBossJoinRequest, performBossAction, type BossConfig, type BossType, type BossMode,
} from "@workspace/db";
import { requireForgeAccess } from "./forge";
import { bossActionText, bossEventEmbed, bossMoney, bossSpecialName } from "../lib/bossUi";
import { runBossRecovery } from "../lib/bossRecovery";
import { logger } from "../lib/logger";

const ADMIN = new Set(["ボス開催", "ボス終了", "ボス料金設定"]);
const types = [{ name: "クラーケン", value: "kraken" }, { name: "メガロドン", value: "megalodon" }, { name: "リヴァイアサン", value: "leviathan" }];
const specials = [
  { name: "なし", value: "none" }, { name: "ボス攻撃力2倍", value: "double_attack" },
  { name: "財宝報酬2倍", value: "double_reward" }, { name: "与ダメージ1.5倍", value: "damage_boost" },
  { name: "回復量2倍", value: "double_heal" },
];
type Interaction = ChatInputCommandInteraction | ButtonInteraction;
async function bossError(interaction: Interaction, error: unknown) {
  const known = error instanceof BossError || error instanceof ForgeError;
  if (!known) logger.error("[boss] Command failed", error);
  await interaction.editReply({ content: known ? error.message :
    "処理中にエラーが発生しました。/ボス情報・/残高確認 で状態を確認してください。同じ操作の再受信で二重課金・二重報酬は発生しません。",
    components: [], embeds: [], allowedMentions: { parse: [] } });
}
async function assertAnnouncementChannel(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;
  if (!interaction.guild || !channel || !(channel.type === ChannelType.GuildText
    || channel.type === ChannelType.GuildAnnouncement || channel.isThread())) throw new BossError("テキストチャンネルまたはスレッドで開催してください。");
  if (channel.isThread() && (channel.archived || channel.locked)) throw new BossError("アーカイブ・ロック中のスレッドでは開催できません。");
  const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages])) {
    throw new BossError("Botにこのチャンネルの閲覧・送信・埋め込みリンクの権限が必要です。");
  }
  return channel;
}
export async function executeBossCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const name = interaction.commandName;
    // 情報・料金確認は管理者にも開放。戦闘操作は本船員を必須とする。
    const infoAdmin = ["ボス情報", "ボス料金確認"].includes(name)
      && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    const guildId = await requireForgeAccess(interaction, ADMIN.has(name) || Boolean(infoAdmin));
    const userId = interaction.user.id;
    if (name === "ボス料金設定" || name === "ボス料金確認") {
      const attackCost = name === "ボス料金設定" ? interaction.options.getInteger("攻撃料金") : null;
      const healCost = name === "ボス料金設定" ? interaction.options.getInteger("回復料金") : null;
      const fees = attackCost !== null || healCost !== null
        ? await configureBossFees(guildId, { ...(attackCost !== null ? { attackCost } : {}), ...(healCost !== null ? { healCost } : {}) })
        : await getBossFees(guildId);
      await interaction.editReply(`攻撃：${bossMoney(fees.attackCost)}／回復：${bossMoney(fees.healCost)}\n両方の設定が必要です。0は明示的な無料です。\n変更は新しい討伐に適用され、受付済みパーティ・戦闘中の料金は変わりません。`);
      return;
    }
    if (name === "ボス開催") {
      const channel = await assertAnnouncementChannel(interaction);
      const integer = (name: string) => interaction.options.getInteger(name, true);
      const role = interaction.options.getRole("補正ロール");
      const multiplier = interaction.options.getNumber("ロール倍率");
      if (Boolean(role) !== (multiplier !== null)) throw new BossError("補正ロールとロール倍率は両方指定してください。");
      if (role?.id === guildId) throw new BossError("@everyoneを補正ロールに指定することはできません。");
      if (role && !await interaction.guild!.roles.fetch(role.id)) throw new BossError("指定した補正ロールが見つかりません。");
      const config: BossConfig = {
        soloHp: integer("ソロhp"), partyHp: integer("パーティhp"), durationSeconds: integer("制限秒"),
        lobbySeconds: integer("受付秒"), reward: integer("報酬"), attack: integer("攻撃力"), defense: integer("防御力"),
        playerHp: integer("プレイヤーhp"), healAmount: integer("回復量"), counterEvery: integer("反撃間隔"),
        cooldownSeconds: integer("行動間隔秒"), criticalPercent: integer("会心率"),
        criticalMultiplier: interaction.options.getNumber("会心倍率", true), levelBonusPercent: integer("レベル補正率"),
        special: (interaction.options.getString("特殊イベント") ?? "none") as BossConfig["special"],
        bonusRoleId: role?.id ?? null, roleMultiplier: multiplier ?? 1,
      };
      const event = await createBossEvent(interaction.id, guildId, channel.id,
        interaction.options.getString("ボス", true) as BossType, config);
      const fees = await getBossFees(guildId);
      let announcement = "開催告知を投稿しました。";
      try { await channel.send({ embeds: [bossEventEmbed(event)], allowedMentions: { parse: [] }, nonce: interaction.id, enforceNonce: true }); }
      catch (error) { logger.error("[boss] Event created but announcement failed", error); announcement = "開催は保存済みですが告知に失敗しました。/ボス情報 で確認できます。"; }
      await interaction.editReply(`${announcement}\n特殊イベント：${bossSpecialName(config.special)}\n攻撃 ${bossMoney(fees.attackCost)}／回復 ${bossMoney(fees.healCost)}${fees.attackCost === null || fees.healCost === null ? "\n料金設定まで参加は停止しています。" : ""}`);
      return;
    }
    if (name === "ボス終了") {
      if (!interaction.options.getBoolean("確認", true)) throw new BossError("全ての討伐を強制終了するには「確認」をTrueにしてください。");
      await endBossEvent(guildId, new Date(), { id: interaction.id, actorId: userId });
      await interaction.editReply("イベントを終了しました。受付はキャンセル、戦闘中の討伐は失敗扱いとなります。報酬・過去の行動料金の返金はありません。");
      void runBossRecovery(interaction.client);
      return;
    }
    if (name === "ボス情報") {
      const info = await getBossInfo(guildId);
      if (!info) throw new BossError("開催中のイベントがありません。");
      const pages = Math.max(1, Math.ceil(info.battles.length / 8));
      const page = interaction.options.getInteger("ページ") ?? 1;
      if (page > pages) throw new BossError(`ページは1〜${pages}で指定してください。`);
      const embed = bossEventEmbed(info.event).addFields(
        { name: "ソロ参加者", value: String(info.members.filter(p => info.battles.find(b => b.id === p.battleId)?.mode === "solo").length), inline: true },
        { name: "パーティ参加者", value: String(info.members.filter(p => info.battles.find(b => b.id === p.battleId)?.mode === "party").length), inline: true },
      );
      for (const battle of info.battles.slice((page - 1) * 8, page * 8)) {
        const players = info.members.filter(p => p.battleId === battle.id);
        embed.addFields({ name: `${battle.mode === "solo" ? "ソロ" : "パーティ"} ${battle.status === "waiting" ? "受付中" : "戦闘中"}／${battle.id}`,
          value: `ボスHP ${battle.currentHp.toLocaleString()}/${battle.maxHp.toLocaleString()}\n${players.map(p => `${p.displayName}：HP ${p.hp}/${p.maxHp}`).join("\n")}`.slice(0, 1024) });
      }
      await interaction.editReply({ embeds: [embed.setFooter({ text: `討伐一覧 ${page}/${pages}ページ。ランキングは討伐終了時のみ表示。` })], allowedMentions: { parse: [] } });
      return;
    }
    if (name === "参加") {
      const { request, event } = await createBossJoinRequest(interaction.id, guildId, userId, interaction.options.getString("モード", true) as BossMode);
      const embed = bossEventEmbed(event).setTitle("ボス参加 — 料金確認")
        .setDescription(`モード：${request.mode === "solo" ? "ソロ" : "パーティ（2〜4人）"}\n攻撃1回：${bossMoney(request.attackCost)}\n回復1回：${bossMoney(request.healCost)}\n参加確定だけでは課金しません。/攻撃・/回復 を実行した際に消費します。\n戦闘中の料金は固定。確認は最長2分間、イベント終了まで有効です。`);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`boss:join:${request.id}`).setLabel("料金を確認して参加").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`boss:cancel:${request.id}`).setLabel("キャンセル").setStyle(ButtonStyle.Secondary));
      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }
    if (name === "攻撃" || name === "回復") {
      const result = await performBossAction(interaction.id, guildId, userId, name === "攻撃" ? "attack" : "heal");
      await interaction.editReply({ content: bossActionText(result), allowedMentions: { parse: [] } });
      void runBossRecovery(interaction.client);
      return;
    }
    throw new BossError("未対応のボスコマンドです。");
  } catch (error) { await bossError(interaction, error); }
}
export async function handleBossButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("boss:")) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const [, action, id] = interaction.customId.split(":");
    if (!id || !["join", "cancel"].includes(action!)) throw new BossError("無効な参加ボタンです。");
    const guildId = await requireForgeAccess(interaction);
    if (action === "cancel") {
      await cancelBossJoinRequest(id, guildId, interaction.user.id);
      await interaction.editReply("参加確認をキャンセルしました。料金は消費していません。");
    } else {
      const member = await interaction.guild!.members.fetch({ user: interaction.user.id, force: true });
      const result = await confirmBossJoin(id, guildId, interaction.user.id, member.displayName, [...member.roles.cache.keys()]);
      await interaction.editReply({ content: bossActionText(result), allowedMentions: { parse: [] } });
      void runBossRecovery(interaction.client);
    }
    try { await interaction.message.edit({ components: [] }); }
    catch (error) { logger.warn("[boss] Could not disable participation confirmation", error); }
  } catch (error) { await bossError(interaction, error); }
  return true;
}
function base(name: string, description: string) {
  const cmd = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
  if (ADMIN.has(name)) cmd.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  return cmd;
}
const host = base("ボス開催", "管理者専用：ボスイベントをこのチャンネルで開催（数値は開催時に指定）")
  .addStringOption(o => o.setName("ボス").setDescription("開催するボス").setRequired(true).addChoices(...types));
for (const [name, description, min, max] of [
  ["ソロhp", "ソロ1戦ごとのボスHP", 1, 2147483647],
  ["パーティhp", "パーティ1組ごとのボスHP", 1, 2147483647],
  ["制限秒", "イベント全体の制限時間（秒）", 1, 604800],
  ["受付秒", "パーティ1組の受付時間（秒、制限秒以下）", 1, 604800],
  ["報酬", "1討伐の報酬総額（パーティは均等分配）", 0, 2147483647],
  ["攻撃力", "ボスの内部攻撃力", 1, 2147483647],
  ["防御力", "ボスの内部防御力", 0, 2147483647],
  ["プレイヤーhp", "参加者1人の最大HP", 1, 2147483647],
  ["回復量", "回復1回の基本回復量", 1, 2147483647],
  ["反撃間隔", "参加者合計何回の行動ごとにボスが反撃するか", 1, 100],
  ["行動間隔秒", "1人の行動クールダウン（秒）", 1, 3600],
  ["会心率", "プレイヤーのクリティカル率（%）", 0, 100],
  ["レベル補正率", "武器Lvが1上がるごとの追加ダメージ補正（%）", 0, 100],
] as const) host.addIntegerOption(o => o.setName(name).setDescription(description).setRequired(true).setMinValue(min).setMaxValue(max));
host.addNumberOption(o => o.setName("会心倍率").setDescription("クリティカル倍率（1〜10）").setRequired(true).setMinValue(1).setMaxValue(10))
  .addStringOption(o => o.setName("特殊イベント").setDescription("全ての討伐へ適用する特殊イベント").addChoices(...specials))
  .addRoleOption(o => o.setName("補正ロール").setDescription("追加ダメージ補正を受けるロール"))
  .addNumberOption(o => o.setName("ロール倍率").setDescription("補正ロールのダメージ倍率（1〜10）").setMinValue(1).setMaxValue(10));
export const bossCommands = [
  host,
  base("ボス終了", "管理者専用：受付・戦闘を強制終了（報酬・返金なし）")
    .addBooleanOption(o => o.setName("確認").setDescription("全討伐を終了する場合はTrue").setRequired(true)),
  base("ボス情報", "現在開催中のボス・残りHP・時間・参加者を確認")
    .addIntegerOption(o => o.setName("ページ").setDescription("討伐一覧ページ").setMinValue(1)),
  base("参加", "本船員専用：料金を確認してソロまたはパーティで参加")
    .addStringOption(o => o.setName("モード").setDescription("参加方法").setRequired(true)
      .addChoices({ name: "ソロ", value: "solo" }, { name: "パーティ", value: "party" })),
  base("攻撃", "参加中のボスへ攻撃（参加時に確認した料金を消費）"),
  base("回復", "自分のHPを回復（参加時に確認した料金を消費）"),
  base("ボス料金設定", "管理者専用：新規討伐の攻撃・回復料金を設定。省略時は確認")
    .addIntegerOption(o => o.setName("攻撃料金").setDescription("攻撃1回の料金。0は無料").setMinValue(0).setMaxValue(2147483647))
    .addIntegerOption(o => o.setName("回復料金").setDescription("回復1回の料金。0は無料").setMinValue(0).setMaxValue(2147483647)),
  base("ボス料金確認", "新規討伐の攻撃・回復料金を確認（戦闘中は参加時の料金）"),
].map(data => ({ data, execute: executeBossCommand }));
