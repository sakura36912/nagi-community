import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { getVcRewardSettings, setVcRewardSettings } from "../lib/vcReward";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
import { getGuildSettings } from "../lib/economy";

// ─── Embed helpers ────────────────────────────────────────────────────────────

function buildInfoEmbed(
  ratePerHour: number,
  minMinutes: number,
  currencyName: string,
): EmbedBuilder {
  const enabled = ratePerHour > 0;
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
    )
    .setFooter({
      text: enabled
        ? `例: 30分滞在 → ${Math.floor((30 / 60) * ratePerHour)} ${currencyName}`
        : "rate を 1 以上に設定すると有効になります",
    });
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleSetup(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ使用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rate = interaction.options.getInteger("rate", true);
  const min = interaction.options.getInteger("min", true);

  if (rate < 0) {
    await interaction.reply({
      content: "レートは 0 以上の整数を指定してください。（0 = 無効）",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (min < 1 || min > 120) {
    await interaction.reply({
      content: "最低滞在時間は 1〜120 分で指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [settings, guildSettings] = await Promise.all([
    setVcRewardSettings(interaction.guildId, rate, min),
    getGuildSettings(interaction.guildId),
  ]);

  const embed = buildInfoEmbed(
    settings.ratePerHour,
    settings.minMinutes,
    guildSettings.currencyName,
  );
  await interaction.editReply({ embeds: [embed] });
}

async function handleInfo(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ使用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [settings, guildSettings] = await Promise.all([
    getVcRewardSettings(interaction.guildId),
    getGuildSettings(interaction.guildId),
  ]);

  const embed = buildInfoEmbed(
    settings.ratePerHour,
    settings.minMinutes,
    guildSettings.currencyName,
  );
  await interaction.editReply({ embeds: [embed] });
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
            .setDescription("報酬を受け取るための最低連続滞在時間（分）。デフォルト: 5")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(120),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("現在のVC報酬設定を確認します"),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();
    if (sub === "setup") {
      await handleSetup(interaction);
    } else {
      await handleInfo(interaction);
    }
  },
};
