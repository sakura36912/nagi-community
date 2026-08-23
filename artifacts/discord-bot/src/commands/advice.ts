import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction, Guild } from "discord.js";
import { logger } from "../lib/logger";
import { getGuildSettings, setAdviceLogChannelId } from "../lib/economy";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const ADVICE_ROLE_NAME = "評価員アドバイス券";
const ALLOWED_ROLE_NAMES = ["航海士", "提督", "大提督"];

/**
 * アドバイス券の購入ログを指定チャンネルへ投稿する。
 * 購入処理そのものを失敗させないよう、ログの取得・投稿失敗は警告だけに留める。
 */
export async function logAdviceTicketPurchase(
  guild: Guild,
  userId: string,
  item: { name: string; price: number },
  targetRoleId: string,
): Promise<void> {
  try {
    const role = guild.roles.cache.get(targetRoleId)
      ?? await guild.roles.fetch(targetRoleId).catch(() => null);
    if (!role || role.name !== ADVICE_ROLE_NAME) return;

    const member = guild.members.cache.get(userId)
      ?? await guild.members.fetch(userId).catch(() => null);
    if (!member?.roles.cache.has(role.id)) return;

    const settings = await getGuildSettings(guild.id);
    if (!settings.adviceLogChannelId) return;

    const logChannel = guild.channels.cache.get(settings.adviceLogChannelId)
      ?? await guild.channels.fetch(settings.adviceLogChannelId).catch(() => null);
    if (!logChannel?.isTextBased()) {
      logger.warn(`[advice-log] Configured channel is not text-based: ${settings.adviceLogChannelId}`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🎫 評価アドバイス券 購入ログ")
      .setColor(0x5865f2)
      .addFields(
        { name: "メンバー", value: `<@${userId}>`, inline: true },
        { name: "商品", value: item.name, inline: true },
        { name: "価格", value: `${item.price.toLocaleString()}${settings.currencyName}`, inline: true },
        { name: "付与ロール", value: `<@&${role.id}>`, inline: false },
      )
      .setTimestamp();

    await logChannel.send({
      content: `<@${userId}>`,
      embeds: [embed],
      allowedMentions: { users: [userId], roles: [] },
    });
  } catch (err) {
    logger.warn("[advice-log] Failed to post advice ticket purchase log", err);
  }
}

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

export const adviceLogCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("アドバイスログ")
    .setDescription("評価員アドバイス券の購入ログを設定します")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("購入ログを送るテキストチャンネルを設定します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("ログ送信先のテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("アドバイス券の購入ログを無効化します"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("現在のログチャンネル設定を確認します"),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "このコマンドは管理者のみ使用できます。", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const channel = interaction.options.getChannel("channel", true);
      await setAdviceLogChannelId(interaction.guildId, channel.id);
      await interaction.editReply(`✅ アドバイス券の購入ログを <#${channel.id}> に設定しました。`);
      return;
    }

    if (sub === "clear") {
      await setAdviceLogChannelId(interaction.guildId, null);
      await interaction.editReply("✅ アドバイス券の購入ログを無効化しました。");
      return;
    }

    const settings = await getGuildSettings(interaction.guildId);
    await interaction.editReply(
      settings.adviceLogChannelId
        ? `🎫 アドバイス券の購入ログチャンネル: <#${settings.adviceLogChannelId}>`
        : "🎫 アドバイス券の購入ログは現在無効です。`/アドバイスログ set` で設定してください。",
    );
  },
};
