import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  getVcRewardSettings,
  setVcRewardSettings,
  addVcRewardCategory,
  removeVcRewardCategory,
} from "../lib/vcReward";
import { getGuildSettings } from "../lib/economy";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ─── Embed helpers ────────────────────────────────────────────────────────────

function buildInfoEmbed(
  ratePerHour: number,
  minMinutes: number,
  currencyName: string,
  includedCategoryIds: string[],
  categoryNames: string[],
): EmbedBuilder {
  const enabled = ratePerHour > 0;

  const categoryValue =
    includedCategoryIds.length === 0
      ? "すべてのカテゴリ"
      : categoryNames.length > 0
        ? categoryNames.map((n) => `• ${n}`).join("\n")
        : includedCategoryIds.map((id) => `• <#${id}>`).join("\n");

  return new EmbedBuilder()
    .setTitle("🎙️ VC滞在報酬 設定")
    .setColor(enabled ? 0x5865f2 : 0x747f8d)
    .addFields(
      {
        name: "状態",
        value: enabled ? "✅ 有効" : "❌ 無効（レートが0）",
        inline: true,
      },
      {
        name: "時給レート",
        value: enabled ? `${ratePerHour} ${currencyName}/時間` : "0（無効）",
        inline: true,
      },
      {
        name: "最低滞在時間",
        value: `${minMinutes} 分`,
        inline: true,
      },
      {
        name: "対象カテゴリ",
        value: categoryValue,
      },
    )
    .setFooter({
      text: enabled
        ? `例: 30分滞在 → ${Math.floor((30 / 60) * ratePerHour)} ${currencyName}`
        : "rate を 1 以上に設定すると有効になります",
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireGuild(interaction: ChatInputCommandInteraction): string | null {
  if (!interaction.guildId) {
    interaction
      .reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return null;
  }
  return interaction.guildId;
}

async function resolvedInfoEmbed(
  guildId: string,
  interaction: ChatInputCommandInteraction,
): Promise<EmbedBuilder> {
  const [settings, guildSettings] = await Promise.all([
    getVcRewardSettings(guildId),
    getGuildSettings(guildId),
  ]);

  // Resolve category names from the guild's channel cache.
  const categoryNames = settings.includedCategoryIds.map((id) => {
    const ch = interaction.guild?.channels.cache.get(id);
    return ch ? ch.name : id;
  });

  return buildInfoEmbed(
    settings.ratePerHour,
    settings.minMinutes,
    guildSettings.currencyName,
    settings.includedCategoryIds,
    categoryNames,
  );
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleSetup(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = requireGuild(interaction);
  if (!guildId) return;

  const rate = interaction.options.getInteger("rate", true);
  const min = interaction.options.getInteger("min", true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await setVcRewardSettings(guildId, rate, min);
  const embed = await resolvedInfoEmbed(guildId, interaction);
  await interaction.editReply({ embeds: [embed] });
}

async function handleInfo(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = requireGuild(interaction);
  if (!guildId) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = await resolvedInfoEmbed(guildId, interaction);
  await interaction.editReply({ embeds: [embed] });
}

async function handleCategoryAdd(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = requireGuild(interaction);
  if (!guildId) return;

  const channel = interaction.options.getChannel("category", true);
  if (channel.type !== ChannelType.GuildCategory) {
    await interaction.reply({
      content: "カテゴリチャンネルを選択してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await addVcRewardCategory(guildId, channel.id);
  const embed = await resolvedInfoEmbed(guildId, interaction);
  await interaction.editReply({
    content: `✅ **${channel.name}** を対象カテゴリに追加しました。`,
    embeds: [embed],
  });
}

async function handleCategoryRemove(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = requireGuild(interaction);
  if (!guildId) return;

  const channel = interaction.options.getChannel("category", true);
  if (channel.type !== ChannelType.GuildCategory) {
    await interaction.reply({
      content: "カテゴリチャンネルを選択してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await removeVcRewardCategory(guildId, channel.id);
  const embed = await resolvedInfoEmbed(guildId, interaction);
  await interaction.editReply({
    content: `✅ **${channel.name}** を対象カテゴリから除外しました。`,
    embeds: [embed],
  });
}

// ─── Command definition ───────────────────────────────────────────────────────

export const vcsalaryCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vcsalary")
    .setDescription("VC滞在時間に応じた報酬の設定")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("VC報酬のレートと最低滞在時間を設定します（管理者）")
        .addIntegerOption((opt) =>
          opt
            .setName("rate")
            .setDescription("時給レート（コイン/時間）。0 で無効化")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100_000),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("min")
            .setDescription("最低連続滞在時間（分）。デフォルト: 5")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(120),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("info").setDescription("現在のVC報酬設定を確認します"),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("category")
        .setDescription("報酬対象カテゴリの管理（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("対象カテゴリを追加します")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("追加するカテゴリ")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("対象カテゴリを除外します")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("除外するカテゴリ")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        ),
    )
    .setDefaultMemberPermissions(null) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    const isAdminSub = group === "category" || sub === "setup";
    if (isAdminSub && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ このコマンドは管理者権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (group === "category") {
      if (sub === "add") await handleCategoryAdd(interaction);
      else if (sub === "remove") await handleCategoryRemove(interaction);
      return;
    }

    if (sub === "setup") await handleSetup(interaction);
    else await handleInfo(interaction);
  },
};
