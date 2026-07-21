import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { addPreban, removePreban, listPrebans, type CommunityPreban } from "@workspace/db";

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ─── /preban ─────────────────────────────────────────────────────────────────

export const prebanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("preban")
    .setDescription("サーバー参加前にユーザーをBANリストへ登録します（管理者用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("ユーザーIDを事前BANリストに追加します")
        .addStringOption((opt) =>
          opt
            .setName("user_id")
            .setDescription("BANするDiscordユーザーID")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("BAN理由（Discordのログにも表示されます）")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("ユーザーIDを事前BANリストから削除します")
        .addStringOption((opt) =>
          opt
            .setName("user_id")
            .setDescription("リストから除くDiscordユーザーID")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("現在の事前BANリストを表示します"),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // ── add ──────────────────────────────────────────────────────────────────
    if (sub === "add") {
      const userId = interaction.options.getString("user_id", true).trim();
      const reason = interaction.options.getString("reason") ?? undefined;

      if (!/^\d{17,20}$/.test(userId)) {
        await interaction.reply({ content: "❌ 有効なDiscordユーザーID（17〜20桁の数字）を入力してください。", ephemeral: true });
        return;
      }

      // 既にサーバーにいる場合は直接BAN
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (member) {
        try {
          await member.ban({ reason: reason ?? "事前BANリストによる自動BAN" });
          await addPreban(interaction.guildId, userId, interaction.user.id, reason);
          await interaction.reply({
            content: `🔨 <@${userId}> は既にサーバーにいたため、即座にBANしました。事前BANリストにも登録しました。`,
            ephemeral: true,
          });
        } catch {
          await interaction.reply({ content: "❌ BANに失敗しました。Botに「メンバーをBANする」権限があるか、対象のロール順位を確認してください。", ephemeral: true });
        }
        return;
      }

      // Discord の BAN リストに即登録（招待リンクを踏んだ時点で弾かれる）
      try {
        await interaction.guild.bans.create(userId, {
          reason: reason ?? `事前BAN by ${interaction.user.tag}`,
        });
      } catch {
        await interaction.reply({
          content: "❌ BANに失敗しました。Botに「メンバーをBANする」権限があるか確認してください。",
          ephemeral: true,
        });
        return;
      }

      await addPreban(interaction.guildId, userId, interaction.user.id, reason);

      // ユーザー名を取得（失敗してもIDで表示）
      const target = await interaction.client.users.fetch(userId).catch(() => null);
      const label = target ? `${target.tag} (<@${userId}>)` : `ID: ${userId}`;

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🚫 事前BAN完了")
            .setDescription(`${label} をDiscordのBANリストに登録しました。\n招待リンクを踏んだ時点で入室できなくなります。`)
            .addFields(
              { name: "理由", value: reason ?? "（なし）", inline: true },
              { name: "登録者", value: `<@${interaction.user.id}>`, inline: true },
            )
            .setTimestamp(),
        ],
        ephemeral: true,
      });
      return;
    }

    // ── remove ────────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const userId = interaction.options.getString("user_id", true).trim();
      const deleted = await removePreban(interaction.guildId, userId);
      if (!deleted) {
        await interaction.reply({ content: `❌ ID \`${userId}\` は事前BANリストに登録されていません。`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ \`${userId}\` を事前BANリストから削除しました。`, ephemeral: true });
      return;
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const rows = await listPrebans(interaction.guildId);
      if (rows.length === 0) {
        await interaction.reply({ content: "事前BANリストは空です。", ephemeral: true });
        return;
      }

      const lines = rows.map((r: CommunityPreban, i: number) => {
        const reasonStr = r.reason ? ` — ${r.reason}` : "";
        return `${i + 1}. \`${r.userId}\`${reasonStr}（<@${r.addedBy}> が登録）`;
      });

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle(`🚫 事前BANリスト（${rows.length}件）`)
        .setDescription(lines.join("\n").slice(0, 4000))
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
