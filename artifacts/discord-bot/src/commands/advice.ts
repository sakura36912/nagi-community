import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { logger } from "../lib/logger";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const ADVICE_ROLE_NAME = "評価員アドバイス券";
const ALLOWED_ROLE_NAMES = ["航海士", "提督", "大提督"];

export const adviceEndCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("アドバイス終了")
    .setDescription("指定したユーザーからアドバイス券ロールを剥奪します")
    .addUserOption((opt) =>
      opt.setName("ユーザー").setDescription("アドバイスを受けたユーザー").setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    // Runtime authorization guard — defence-in-depth: require one of the
    // designated server roles in addition to the Discord-level permission gate.
    const executor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const hasAllowedRole = executor?.roles.cache.some((r) => ALLOWED_ROLE_NAMES.includes(r.name));
    if (!hasAllowedRole) {
      await interaction.reply({
        content: `❌ このコマンドは ${ALLOWED_ROLE_NAMES.map((n) => `「${n}」`).join("・")} ロールのみ実行できます。`,
        ephemeral: true,
      });
      return;
    }

    const target = interaction.options.getUser("ユーザー", true);
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: "❌ 指定されたユーザーがサーバーに見つかりません。", ephemeral: true });
      return;
    }

    // "評価員アドバイス券" ロールを名前で検索
    const role = interaction.guild.roles.cache.find((r) => r.name === ADVICE_ROLE_NAME)
      ?? (await interaction.guild.roles.fetch().then((roles) => roles.find((r) => r.name === ADVICE_ROLE_NAME)).catch(() => undefined));

    if (!role) {
      await interaction.reply({
        content: `❌ 「${ADVICE_ROLE_NAME}」ロールがこのサーバーに見つかりません。`,
        ephemeral: true,
      });
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      await interaction.reply({
        content: `ℹ️ <@${target.id}> はすでに「${ADVICE_ROLE_NAME}」ロールを持っていません。`,
        ephemeral: true,
      });
      return;
    }

    try {
      await member.roles.remove(role);
      await interaction.reply({
        content: `✅ <@${target.id}> から「${ADVICE_ROLE_NAME}」ロールを剥奪しました。`,
      });
      logger.info(`[advice-end] ${interaction.user.id} removed ${ADVICE_ROLE_NAME} from ${target.id} in guild ${interaction.guild.id}`);
    } catch (err) {
      logger.error("[advice-end] Failed to remove advice role", err);
      await interaction.reply({ content: "❌ ロールの剥奪に失敗しました。Botの権限を確認してください。", ephemeral: true });
    }
  },
};
