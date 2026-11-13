import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import {
  createPvpDuel, getPvpDuel, performPvpAction, pvpPublicCard, advancePvpGuild,
  setPvpBounty, PvpError, ForgeError,
} from "@workspace/db";
import { requireForgeAccess } from "./forge";
import { assertRpgCardChannel, rpgCardMessage, runRpgCards } from "../lib/rpgCards";
import { logger } from "../lib/logger";

type Interaction = ChatInputCommandInteraction | ButtonInteraction;
/** Both people must still be eligible when accepting, not just when invited. */
async function eligibleOpponent(interaction: Interaction, userId: string) {
  const member = await interaction.guild!.members.fetch({ user: userId, force: true });
  if (member.user.bot) throw new PvpError("Botとは対戦できません。");
  const roles = (await interaction.guild!.roles.fetch()).filter(role => role.name === "本船員");
  if (roles.size !== 1 || !member.roles.cache.has(roles.first()!.id)) throw new PvpError("対戦者は両者とも本船員ロールが必要です。");
}
async function errorReply(interaction: Interaction, error: unknown) {
  if (!(error instanceof PvpError || error instanceof ForgeError)) logger.error("[pvp] Operation failed", error);
  await interaction.editReply({
    content: error instanceof PvpError || error instanceof ForgeError ? error.message
      : "PvP処理に失敗しました。/pvp 情報 で確認してください。再操作で二重に賞金を引き落とすことはありません。",
    embeds: [], components: [], allowedMentions: { parse: [] },
  });
}
const subActions = { 攻撃: "attack", 回復: "heal", 取消: "cancel", 降参: "surrender" } as const;
export async function executePvpCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const sub = interaction.options.getSubcommand();
    if (!interaction.guild) throw new PvpError("サーバー内で使用してください。");
    const userId = interaction.user.id;
    if (sub === "懸賞金設定") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new PvpError("懸賞金の設定・変更は管理者のみ可能です。");
      const target = interaction.options.getUser("対象", true);
      await eligibleOpponent(interaction, target.id);
      const amount = interaction.options.getInteger("懸賞額", true);
      await setPvpBounty(interaction.guild.id, target.id, amount, userId);
      await interaction.editReply(`本船員 <@${target.id}> の固定懸賞額を **$${amount.toLocaleString("ja-JP")}** に設定しました。0にすると懸賞報酬はなくなります。変更は新しい募集から適用されます。`);
      return;
    }
    // A user who lost the crew role can still cancel or surrender; never strand their escrow.
    const guildId = ["取消", "降参"].includes(sub) ? interaction.guild.id : await requireForgeAccess(interaction);
    if (sub === "募集") {
      const target = interaction.options.getUser("相手", true);
      await eligibleOpponent(interaction, target.id);
      const channelId = await assertRpgCardChannel(interaction);
      const duel = await createPvpDuel({ id: interaction.id, guildId, channelId, hostId: userId, opponentId: target.id,
        durationMinutes: interaction.options.getInteger("制限分") ?? 30 });
      await interaction.editReply(`公開カードを送信しました。相手は2分以内に承諾してください。\n挑戦者の懸賞額：$${duel.state.bounties?.challenger.toLocaleString("ja-JP") ?? "0"} ／ 対象者の懸賞額：$${duel.state.bounties?.target.toLocaleString("ja-JP") ?? "0"}\n銀行残高からの差し引きはありません。`);
    } else {
      await advancePvpGuild(guildId);
      const duel = await getPvpDuel(guildId, userId);
      if (sub === "情報") {
        await interaction.editReply(rpgCardMessage(pvpPublicCard(duel)));
        return;
      }
      if (sub === "降参" && !interaction.options.getBoolean("確認", true)) throw new PvpError("降参は相手の勝利となります。実行する場合は確認をTrueにしてください。");
      const action = subActions[sub as keyof typeof subActions];
      if (!action) throw new PvpError("未対応の操作です。");
      const result = await performPvpAction(interaction.id, guildId, userId, duel.id, action);
      await interaction.editReply(result.repeated ? "この操作は処理済みです。追加の課金・攻撃はしていません。" : "処理しました。結果は募集したチャンネルの公開カードに表示します。");
    }
    void runRpgCards(interaction.client);
  } catch (error) { await errorReply(interaction, error); }
}
export async function handlePvpButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith("pvp:")) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const [, action, duelId] = interaction.customId.split(":");
    if (!interaction.guild || !duelId || !["accept", "decline", "cancel", "attack", "heal", "surrender", "surrender-confirm"].includes(action!)) {
      throw new PvpError("無効な対戦ボタンです。");
    }
    const guildId = ["cancel", "decline", "surrender", "surrender-confirm"].includes(action!)
      ? interaction.guild.id : await requireForgeAccess(interaction);
    if (action === "surrender-confirm") {
      const duel = await getPvpDuel(guildId, interaction.user.id);
      if (duel.id !== duelId || duel.status !== "active") throw new PvpError("この対戦は操作できません。");
      await interaction.editReply({
        content: "降参すると相手の勝利となり、賞金を精算します。降参しますか？",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
          .setCustomId(`pvp:surrender:${duelId}`).setLabel("降参を確定する").setStyle(ButtonStyle.Danger))],
      });
      return true;
    }
    if (action === "accept") {
      const duel = await getPvpDuel(guildId, interaction.user.id);
      if (duel.id !== duelId) throw new PvpError("この対戦は操作できません。");
      await eligibleOpponent(interaction, duel.hostId);
      await assertRpgCardChannel(interaction);
    }
    const result = await performPvpAction(interaction.id, guildId, interaction.user.id, duelId,
      action as "accept" | "decline" | "cancel" | "attack" | "heal" | "surrender");
    await interaction.editReply(result.repeated ? "この操作は処理済みです。" : "処理しました。結果は募集したチャンネルの公開カードに表示します。");
    void runRpgCards(interaction.client);
  } catch (error) { await errorReply(interaction, error); }
  return true;
}
const data = new SlashCommandBuilder().setName("pvp").setDescription("本船員の固定懸賞額による1対1対戦").setDMPermission(false)
  .addSubcommand(sub => sub.setName("募集").setDescription("相手へ懸賞金付きの対戦を申し込む")
    .addUserOption(o => o.setName("相手").setDescription("対戦する本船員").setRequired(true))
    .addIntegerOption(o => o.setName("制限分").setDescription("承諾後の制限時間。省略時30分").setMinValue(1).setMaxValue(180)))
  .addSubcommand(sub => sub.setName("懸賞金設定").setDescription("管理者専用：本船員の固定懸賞額を設定")
    .addUserOption(o => o.setName("対象").setDescription("懸賞額を設定する本船員").setRequired(true))
    .addIntegerOption(o => o.setName("懸賞額").setDescription("0で報酬なし。勝敗で金額は変わらない").setRequired(true).setMinValue(0).setMaxValue(2147483647)))
  .addSubcommand(sub => sub.setName("情報").setDescription("自分の受付・対戦状況を確認"))
  .addSubcommand(sub => sub.setName("攻撃").setDescription("対戦相手へ無料で攻撃（5秒間隔）"))
  .addSubcommand(sub => sub.setName("回復").setDescription("ボスの設定料金で最大HPの10%を回復（30秒間隔）"))
  .addSubcommand(sub => sub.setName("取消").setDescription("承諾前の募集を取り消して賞金を返却"))
  .addSubcommand(sub => sub.setName("降参").setDescription("相手の勝利で対戦を終了")
    .addBooleanOption(o => o.setName("確認").setDescription("相手の勝利で賞金を精算します。実行時True").setRequired(true)));
export const pvpCommands = [{ data, execute: executePvpCommand }];
