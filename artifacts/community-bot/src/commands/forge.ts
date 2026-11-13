import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction, type StringSelectMenuInteraction,
} from "discord.js";
import {
  ForgeError, FORGE_WEAPONS, publicForgeWeapon, getForgeWeapon, getForgeSetting,
  selectForgeWeapon, createForgeUpgradeRequest, settleForgeUpgrade, cancelForgeUpgrade,
  adminForgeWeapon, adminSetForgeLevel, configureForgeSetting, listForgeSettings, resetForgeSettings,
  isForgeWeaponType, type ForgeActionResult,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { assertRpgCardChannel, runRpgCards } from "../lib/rpgCards";

// モジュール読込時にはDBへ接続せず、コマンド定義だけを生成する。
const choices = [
  { name: "大剣", value: "greatsword" }, { name: "片手剣", value: "sword" },
  { name: "槍", value: "spear" }, { name: "弓", value: "bow" },
  { name: "双剣", value: "dual" }, { name: "杖", value: "staff" },
];
type Interaction = ChatInputCommandInteraction | ButtonInteraction;
type ForgeAccessInteraction = Interaction | StringSelectMenuInteraction;
const ADMIN_COMMANDS = new Set(["武器変更", "武器リセット", "武器レベル設定", "武器確認",
  "強化費用設定", "強化費用リセット", "強化成功率設定", "強化成功率リセット"]);

export async function requireForgeAccess(interaction: ForgeAccessInteraction, admin = false) {
  if (!interaction.guild) throw new ForgeError("サーバー内で使用してください。");
  // ロール剥奪直後でも古いメンバーキャッシュで許可しない。
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (admin) {
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) throw new ForgeError("この操作は管理者のみ使用できます。");
  } else {
    const roles = await interaction.guild.roles.fetch();
    const crew = roles.filter(role => role.name === "本船員");
    if (crew.size !== 1) throw new ForgeError("「本船員」ロールを1つに設定してください。現在は利用できません。");
    if (!member.roles.cache.has(crew.first()!.id)) throw new ForgeError("この機能は「本船員」ロールの所持者のみ使用できます。");
  }
  return interaction.guild.id;
}
function money(value: number | null) {
  return value === null ? "未設定（強化不可）" : `$${value.toLocaleString()}`;
}
export function forgePublicEmbed(
  weapon: { weaponType: string; weaponLevel: number },
  setting: { cost: number | null; successRate: number },
) {
  const view = publicForgeWeapon(weapon, setting);
  return new EmbedBuilder().setTitle("鍛冶屋 — 武器").setColor(0xd49b43).addFields(
    { name: "武器", value: view.name, inline: true },
    { name: "レベル", value: `Lv${view.level}`, inline: true },
    { name: "固有スキル", value: view.skill, inline: true },
    { name: "次回強化費用", value: money(view.nextCost), inline: true },
    { name: "強化成功率", value: `${view.successRate}%`, inline: true },
  );
}
function resultText(result: ForgeActionResult & { repeated?: boolean }) {
  const name = choices.find(choice => choice.value === result.weaponType)?.name ?? "武器";
  return [
    result.repeated ? "この操作は処理済みです。再度の引き落としはありません。" : "",
    result.success ? `強化成功！ ${name} Lv${result.level}` : `強化失敗。${name}はLv${result.level}のままです。レベル低下・破壊はありません。`,
    `消費：${money(result.cost ?? 0)}`, `決済後残高：${money(result.balance ?? 0)}`,
  ].filter(Boolean).join("\n");
}
function nextUpgradeControls(userId: string) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`forge:upgrade:${userId}`).setLabel("次の強化の費用を確認").setStyle(ButtonStyle.Primary),
  )];
}
async function showUpgradeConfirmation(interaction: Interaction, guildId: string) {
  await assertRpgCardChannel(interaction);
  const request = await createForgeUpgradeRequest(interaction.id, guildId, interaction.user.id);
  const embed = forgePublicEmbed({ weaponType: request.weaponType, weaponLevel: request.weaponLevel },
    { cost: request.cost, successRate: request.successRate })
    .setTitle("武器強化 — 支払い確認")
    .setDescription("失敗した場合も費用を消費します。レベル低下・武器破壊はありません。\nこの確認は2分間有効です。");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`forge:confirm:${request.id}`).setLabel("支払って強化").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`forge:cancel:${request.id}`).setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}
async function showForgeError(interaction: Interaction, error: unknown) {
  const known = error instanceof ForgeError;
  if (!known) logger.error("[forge] Operation failed", error);
  const content = known ? error.message : "処理中にエラーが発生しました。支払い確認後のエラーの場合は /武器 と /残高確認 で状態を確認してください。同じ確認ボタンで二重課金はされません。";
  await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
}
export async function executeForgeCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const name = interaction.commandName;
    const guildId = await requireForgeAccess(interaction, ADMIN_COMMANDS.has(name));
    const userId = interaction.user.id;
    if (name === "武器選択") {
      const type = interaction.options.getString("種類", true);
      if (!isForgeWeaponType(type)) throw new ForgeError("未対応の武器です。");
      const channelId = await assertRpgCardChannel(interaction);
      await selectForgeWeapon(interaction.id, guildId, userId, type, channelId);
      await interaction.editReply(`${FORGE_WEAPONS[type].name}を選択しました（Lv1）。以後の変更・リセットは管理者のみ行えます。`);
      void runRpgCards(interaction.client);
      return;
    }
    if (name === "武器" || name === "武器確認") {
      const target = name === "武器確認" ? interaction.options.getUser("ユーザー", true) : interaction.user;
      const weapon = await getForgeWeapon(guildId, target.id);
      if (!weapon) throw new ForgeError("武器が未選択です。/武器選択 で選択してください。");
      const embed = forgePublicEmbed(weapon, await getForgeSetting(guildId, weapon.weaponLevel));
      if (name === "武器確認") embed.setTitle("管理者用 — 武器確認").addFields(
        { name: "対象ユーザーID", value: target.id },
        { name: "内部攻撃力", value: String(weapon.attack), inline: true },
        { name: "内部防御力", value: String(weapon.defense), inline: true },
      );
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    if (name === "強化") {
      await showUpgradeConfirmation(interaction, guildId);
      return;
    }
    if (name === "武器変更" || name === "武器リセット") {
      const target = interaction.options.getUser("ユーザー", true);
      const type = name === "武器変更" ? interaction.options.getString("種類", true) : null;
      if (type !== null && !isForgeWeaponType(type)) throw new ForgeError("未対応の武器です。");
      if (!interaction.options.getBoolean("確認", true)) throw new ForgeError("実行するには「確認」をTrueにしてください。");
      const result = await adminForgeWeapon(interaction.id, guildId, target.id, userId, type);
      await interaction.editReply({
        content: name === "武器リセット"
          ? `${target.id} の武器をリセットしました。残高は変更していません。再度 /武器選択 が可能です。`
          : `${target.id} の武器を${type ? FORGE_WEAPONS[type].name : ""}へ変更しました。Lv${result.level}を維持し、内部能力を再計算しました。`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (name === "武器レベル設定") {
      const target = interaction.options.getUser("ユーザー", true);
      const level = interaction.options.getInteger("レベル", true);
      if (!interaction.options.getBoolean("確認", true)) throw new ForgeError("実行するには「確認」をTrueにしてください。");
      const result = await adminSetForgeLevel(interaction.id, guildId, target.id, userId, level);
      await interaction.editReply({
        content: `${target.id} の武器をLv${result.level}に設定しました。武器能力を再計算し、残高は変更していません。保留中の強化確認は無効になりました。`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (name === "強化費用設定" || name === "強化成功率設定") {
      const level = interaction.options.getInteger("レベル", true);
      const patch = name === "強化費用設定"
        ? { cost: interaction.options.getInteger("金額", true) }
        : { successRate: interaction.options.getInteger("確率", true) };
      await configureForgeSetting(interaction.id, guildId, userId, level, patch);
      const setting = await getForgeSetting(guildId, level);
      await interaction.editReply(`Lv${level}→${level + 1}：費用 ${money(setting.cost)} / 成功率 ${setting.successRate}%\n確認中の古い費用・成功率では決済されません。`);
      return;
    }
    if (name === "強化費用リセット" || name === "強化成功率リセット") {
      if (!interaction.options.getBoolean("確認", true)) throw new ForgeError("実行するには「確認」をTrueにしてください。");
      await resetForgeSettings(interaction.id, guildId, userId, name === "強化費用リセット" ? "cost" : "successRate");
      await interaction.editReply(name === "強化費用リセット"
        ? "強化費用を初期値へ戻しました。Lv1：$1,000 / Lv2：$3,000 / Lv3：$5,000。Lv4以降は未設定です。成功率は変更していません。"
        : "成功率を初期値（100%からレベルごとに5ポイント低下、最低30%）へ戻しました。費用は変更していません。");
      return;
    }
    if (name === "強化費用確認") {
      const all = await listForgeSettings(guildId);
      const pages = Math.max(1, Math.ceil(all.length / 20));
      const page = interaction.options.getInteger("ページ") ?? 1;
      if (page > pages) throw new ForgeError(`ページは1〜${pages}で指定してください。`);
      const lines = all.slice((page - 1) * 20, page * 20).map(s =>
        `Lv${s.level}→${s.level + 1}：${money(s.cost)} / ${s.successRate}%`);
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`強化費用一覧 ${page}/${pages}`)
        .setDescription(lines.join("\n")).setFooter({ text: "一覧にないレベルの費用は未設定です。成功率は初期計算式を使用します。" })] });
      return;
    }
    throw new ForgeError("未対応の鍛冶屋コマンドです。");
  } catch (error) { await showForgeError(interaction, error); }
}
export async function handleForgeButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("forge:")) return false;
  // 自分以外の確認画面を書き換えないため、結果は別の非公開応答へ返す。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const [, action, id] = interaction.customId.split(":");
    if (!id || !["confirm", "cancel", "upgrade"].includes(action!)) throw new ForgeError("無効な確認ボタンです。");
    const guildId = await requireForgeAccess(interaction);
    if (action === "upgrade") {
      if (id !== interaction.user.id) throw new ForgeError("この強化ボタンは武器の所有者本人のみ使用できます。");
      await showUpgradeConfirmation(interaction, guildId);
      return true;
    }
    if (action === "cancel") {
      await cancelForgeUpgrade(id, guildId, interaction.user.id);
      await interaction.editReply("強化をキャンセルしました。費用は消費していません。");
    } else {
      const channelId = await assertRpgCardChannel(interaction);
      const result = await settleForgeUpgrade(id, guildId, interaction.user.id, undefined, channelId);
      await interaction.editReply({ content: resultText(result), components: nextUpgradeControls(interaction.user.id) });
      void runRpgCards(interaction.client);
    }
    // 返信失敗でも決済記録は維持する。古いボタンの再押下にも重複防止が効く。
    try { await interaction.message.edit({ components: [] }); }
    catch (error) { logger.warn("[forge] Could not disable completed confirmation buttons", error); }
  } catch (error) { await showForgeError(interaction, error); }
  return true;
}
function base(name: string, description: string) {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
  if (ADMIN_COMMANDS.has(name)) builder.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  return builder;
}
export const forgeCommands = [
  base("武器選択", "本船員専用：1種類の武器を選択（選択後は管理者のみ変更可能）")
    .addStringOption(o => o.setName("種類").setDescription("選ぶ武器").setRequired(true).addChoices(...choices)),
  base("武器", "自分の武器・Lv・スキル・次回強化費用・成功率を確認"),
  base("強化", "費用と成功率を確認して武器を強化（失敗時も費用消費）"),
  base("強化費用確認", "サーバーの強化費用と成功率の一覧")
    .addIntegerOption(o => o.setName("ページ").setDescription("一覧ページ").setMinValue(1)),
  base("強化費用設定", "管理者専用：強化前レベルごとの費用を設定")
    .addIntegerOption(o => o.setName("レベル").setDescription("強化前のレベル").setRequired(true).setMinValue(1).setMaxValue(2147483646))
    .addIntegerOption(o => o.setName("金額").setDescription("0は無料。失敗時も消費").setRequired(true).setMinValue(0).setMaxValue(2147483647)),
  base("強化成功率設定", "管理者専用：強化前レベルごとの成功率を設定")
    .addIntegerOption(o => o.setName("レベル").setDescription("強化前のレベル").setRequired(true).setMinValue(1).setMaxValue(2147483646))
    .addIntegerOption(o => o.setName("確率").setDescription("成功率30〜100%").setRequired(true).setMinValue(30).setMaxValue(100)),
  ...(["強化費用リセット", "強化成功率リセット"] as const).map(name =>
    base(name, "管理者専用：サーバーの設定を初期値に戻す")
      .addBooleanOption(o => o.setName("確認").setDescription("全レベルを初期値に戻す場合はTrue").setRequired(true))),
  base("武器変更", "管理者専用：ユーザーの武器を変更（レベル維持）")
    .addUserOption(o => o.setName("ユーザー").setDescription("対象ユーザー").setRequired(true))
    .addStringOption(o => o.setName("種類").setDescription("変更後の武器").setRequired(true).addChoices(...choices))
    .addBooleanOption(o => o.setName("確認").setDescription("実行する場合はTrue").setRequired(true)),
  base("武器レベル設定", "管理者専用：指定ユーザーの武器Lvを設定")
    .addUserOption(o => o.setName("ユーザー").setDescription("対象ユーザー").setRequired(true))
    .addIntegerOption(o => o.setName("レベル").setDescription("設定する武器レベル").setRequired(true).setMinValue(1).setMaxValue(2147483647))
    .addBooleanOption(o => o.setName("確認").setDescription("実行する場合はTrue").setRequired(true)),
  base("武器リセット", "管理者専用：武器を削除し再選択可能にする（返金なし）")
    .addUserOption(o => o.setName("ユーザー").setDescription("対象ユーザー").setRequired(true))
    .addBooleanOption(o => o.setName("確認").setDescription("武器データを削除する場合はTrue").setRequired(true)),
  base("武器確認", "管理者専用：対象ユーザーの内部攻撃力・防御力も確認")
    .addUserOption(o => o.setName("ユーザー").setDescription("対象ユーザー").setRequired(true)),
].map(data => ({ data, execute: executeForgeCommand }));
