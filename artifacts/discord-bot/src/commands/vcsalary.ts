import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  getVcRewardSettings,
  setVcRewardSettings,
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
): EmbedBuilder {
  const enabled = ratePerHour > 0;

  const channelValue = "名前が **砂浜** のVC、または **砂浜** カテゴリ配下のVCのみ";

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
        name: "報酬対象",
        value: channelValue,
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

  return buildInfoEmbed(
    settings.ratePerHour,
    settings.minMinutes,
    guildSettings.currencyName,
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

// ─── Command definition ───────────────────────────────────────────────────────

export const vcsalaryCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vcsalary")
    .setDescription("VC滞在時間に応じた報酬の設定")
    .setDefaultMemberPermissions(0)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();

    if (sub === "setup" && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ このコマンドは管理者権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "setup") await handleSetup(interaction);
    else await handleInfo(interaction);
  },
};
