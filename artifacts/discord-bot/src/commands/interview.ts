import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { getGuildSettings, giveCurrency } from "../lib/economy";
import { logger } from "../lib/logger";

interface Command {
  data: SlashCommandBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/** ロール名で許可制御するロール（いずれかを持っていれば実行可） */
const ALLOWED_ROLE_NAMES = ["守門卿", "門番", "門番見習い", "見習い門番"];
/** 面接通過時に外すロール名 */
const REMOVE_ROLE_NAME = "入島待ち";
/** 面接通過時に付与するロール名 */
const ADD_ROLE_NAMES = ["島民", "新入り"];
/** 初期配布ベリー枚数 */
const INITIAL_BERRY = 150_000;

export const interviewCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("説明会通過")
    .setDescription("説明会通過者にロールを付与し初期ベリーを配布する")
    .addUserOption((opt) =>
      opt
        .setName("メンバー")
        .setDescription("面接を通過したメンバー")
        .setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 実行者のロールチェック
    const executor = interaction.member as GuildMember | null;
    if (!executor || !executor.roles.cache.some((r) => ALLOWED_ROLE_NAMES.includes(r.name))) {
      await interaction.reply({
        content: `❌ このコマンドは ${ALLOWED_ROLE_NAMES.join("・")} ロールを持つメンバーのみ使用できます。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getMember("メンバー") as GuildMember | null;
    if (!target) {
      await interaction.editReply({ content: "❌ 対象メンバーが見つかりませんでした。" });
      return;
    }

    const guild = interaction.guild;
    const guildRoles = guild.roles.cache;
    const results: string[] = [];
    const errors: string[] = [];

    // ─── ロール削除 ──────────────────────────────────────────────────────────
    const removeRole = guildRoles.find((r) => r.name === REMOVE_ROLE_NAME);
    if (removeRole) {
      if (target.roles.cache.has(removeRole.id)) {
        try {
          await target.roles.remove(removeRole, "面接通過処理");
          results.push(`✅ ロール「${REMOVE_ROLE_NAME}」を外しました`);
        } catch (err) {
          logger.error(`[interview] Failed to remove role ${REMOVE_ROLE_NAME}`, err);
          errors.push(`⚠️ ロール「${REMOVE_ROLE_NAME}」の削除に失敗しました`);
        }
      } else {
        results.push(`ℹ️ ロール「${REMOVE_ROLE_NAME}」は元々持っていません`);
      }
    } else {
      errors.push(`⚠️ ロール「${REMOVE_ROLE_NAME}」がサーバーに見つかりません`);
    }

    // ─── ロール付与 ──────────────────────────────────────────────────────────
    for (const roleName of ADD_ROLE_NAMES) {
      const role = guildRoles.find((r) => r.name === roleName);
      if (!role) {
        errors.push(`⚠️ ロール「${roleName}」がサーバーに見つかりません`);
        continue;
      }
      if (target.roles.cache.has(role.id)) {
        results.push(`ℹ️ ロール「${roleName}」はすでに持っています`);
        continue;
      }
      try {
        await target.roles.add(role, "面接通過処理");
        results.push(`✅ ロール「${roleName}」を付与しました`);
      } catch (err) {
        logger.error(`[interview] Failed to add role ${roleName}`, err);
        errors.push(`⚠️ ロール「${roleName}」の付与に失敗しました`);
      }
    }

    // ─── ベリー配布 ──────────────────────────────────────────────────────────
    const settings = await getGuildSettings(interaction.guildId);
    const currencyName = settings.currencyName ?? "ベリー";
    const berryResult = await giveCurrency(
      interaction.guildId,
      target.id,
      INITIAL_BERRY,
      currencyName,
      "面接通過初期配布",
    );

    if (berryResult.ok) {
      results.push(
        `✅ ${INITIAL_BERRY.toLocaleString()}${currencyName} を配布しました（残高: ${berryResult.balance.toLocaleString()}${currencyName}）`,
      );
    } else {
      errors.push(`⚠️ ベリー配布に失敗しました: ${berryResult.reason}`);
    }

    // ─── 結果表示 ────────────────────────────────────────────────────────────
    const allLines = [...results, ...errors];
    const embed = new EmbedBuilder()
      .setTitle("🎉 面接通過処理")
      .setDescription(`対象: <@${target.id}>\n\n${allLines.join("\n")}`)
      .setColor(errors.length === 0 ? 0x57f287 : 0xfee75c)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
