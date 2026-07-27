import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import {
  listActiveBounties,
  getBounty,
  postBounty,
  cancelBounty,
  awardBounty,
  setBountyPosterRoleId,
  type Bounty,
} from "../lib/bounty";
import { getGuildSettings } from "../lib/economy";
import { getPointBalance } from "../lib/points";
import { logger } from "../lib/logger";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ── Embed builders ────────────────────────────────────────────────────────────

function bountyStatusLabel(status: string): string {
  return status === "active" ? "🟡 募集中" : status === "awarded" ? "✅ 達成済み" : "❌ キャンセル";
}

function buildBoardEmbed(bounties: Bounty[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("💰 懸賞金ボード")
    .setColor(0xf39c12);

  if (bounties.length === 0) {
    embed.setDescription("現在アクティブな懸賞金はありません。");
    return embed;
  }

  for (const b of bounties.slice(0, 10)) {
    embed.addFields({
      name: `#${b.id} ｜ ${b.title}`,
      value:
        `> ${b.description.slice(0, 120)}${b.description.length > 120 ? "…" : ""}\n` +
        `💎 **${b.reward.toLocaleString("ja-JP")} pt**　／　掲載: <@${b.posterId}>`,
      inline: false,
    });
  }

  if (bounties.length > 10) {
    embed.setFooter({ text: `他 ${bounties.length - 10} 件は /bounty list で確認できます` });
  }

  return embed;
}

// ── Command ───────────────────────────────────────────────────────────────────

export const bountyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("bounty")
    .setDescription("懸賞金機能（ポイントを使って懸賞金を掛ける）")
    // ── post ──────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("post")
        .setDescription("懸賞金を掛ける（自分のポイントから報酬を出す）")
        .addStringOption((opt) =>
          opt.setName("title").setDescription("タイトル（最大50文字）").setRequired(true).setMaxLength(50),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("達成条件の詳細（最大500文字）").setRequired(true).setMaxLength(500),
        )
        .addIntegerOption((opt) =>
          opt.setName("reward").setDescription("報酬ポイント数").setRequired(true).setMinValue(1),
        ),
    )
    // ── cancel ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("cancel")
        .setDescription("自分が掛けた懸賞金をキャンセルしてポイントを返金する")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("懸賞金ID（/bounty list で確認）").setRequired(true),
        ),
    )
    // ── award ─────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("award")
        .setDescription("【管理者】達成者に懸賞金ポイントを支払う")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("懸賞金ID").setRequired(true),
        )
        .addUserOption((opt) =>
          opt.setName("user").setDescription("達成したユーザー").setRequired(true),
        ),
    )
    // ── list ──────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("アクティブな懸賞金の一覧を表示する"),
    )
    // ── board ─────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub.setName("board").setDescription("このチャンネルに懸賞金ボードを投稿する"),
    )
    // ── setrole ───────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("setrole")
        .setDescription("【管理者】懸賞金を掛けられるロールを設定する")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("許可するロール（省略で全員許可）").setRequired(false),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    // ── setrole ───────────────────────────────────────────────────────────────
    if (sub === "setrole") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ 管理者のみ使用できます。", ephemeral: true });
        return;
      }
      const role = interaction.options.getRole("role");
      await setBountyPosterRoleId(guildId, role?.id ?? null);
      await interaction.reply({
        content: role
          ? `✅ 懸賞金を掛けられるロールを <@&${role.id}> に設定しました。`
          : "✅ ロール制限を解除しました（全員が懸賞金を掛けられます）。",
        ephemeral: true,
      });
      return;
    }

    // ── post ──────────────────────────────────────────────────────────────────
    if (sub === "post") {
      await interaction.deferReply({ ephemeral: true });

      const settings = await getGuildSettings(guildId).catch(() => null);
      const requiredRoleId = settings?.bountyPosterRoleId;
      if (requiredRoleId) {
        const member = interaction.member;
        const roleIds =
          member && "roles" in member && typeof member.roles === "object" && "cache" in (member.roles as object)
            ? [...(member.roles as import("discord.js").GuildMemberRoleManager).cache.keys()]
            : [];
        if (!roleIds.includes(requiredRoleId)) {
          await interaction.editReply(`❌ <@&${requiredRoleId}> を持つユーザーのみ懸賞金を掛けられます。`);
          return;
        }
      }

      const title       = interaction.options.getString("title", true);
      const description = interaction.options.getString("description", true);
      const reward      = interaction.options.getInteger("reward", true);

      // Show current balance before posting
      const balance = await getPointBalance(guildId, interaction.user.id);
      if (balance < reward) {
        await interaction.editReply(
          `❌ ポイントが不足しています。\n現在の残高: **${balance.toLocaleString("ja-JP")} pt** / 必要: **${reward.toLocaleString("ja-JP")} pt**\n\nポイントはVC滞在・ロール保持・ブースト・イベント順位で獲得できます。`,
        );
        return;
      }

      try {
        const bounty = await postBounty(guildId, interaction.user.id, title, description, reward);
        await interaction.editReply(
          `✅ 懸賞金を掛けました（ID: **#${bounty.id}**）\n` +
          `**${title}**\n報酬: **${reward.toLocaleString("ja-JP")} pt**\n` +
          `残高: **${(balance - reward).toLocaleString("ja-JP")} pt**`,
        );
        logger.info(`[bounty] post id=${bounty.id} poster=${interaction.user.id} reward=${reward}pt`);
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_POINTS") {
          await interaction.editReply("❌ ポイントが不足しています。");
        } else {
          logger.error("[bounty] post error", err);
          await interaction.editReply("❌ 懸賞金の登録に失敗しました。");
        }
      }
      return;
    }

    // ── cancel ────────────────────────────────────────────────────────────────
    if (sub === "cancel") {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getInteger("id", true);

      const existing = await getBounty(guildId, id);
      if (!existing) {
        await interaction.editReply(`❌ ID **#${id}** の懸賞金が見つかりません。`);
        return;
      }
      if (existing.status !== "active") {
        await interaction.editReply(`❌ ID **#${id}** はすでに${bountyStatusLabel(existing.status)}です。`);
        return;
      }
      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      if (existing.posterId !== interaction.user.id && !isAdmin) {
        await interaction.editReply("❌ 自分が掛けた懸賞金のみキャンセルできます。");
        return;
      }

      await cancelBounty(guildId, id);
      await interaction.editReply(
        `✅ 懸賞金 **#${id}「${existing.title}」** をキャンセルしました。\n` +
        `**${existing.reward.toLocaleString("ja-JP")} pt** を返金しました。`,
      );
      return;
    }

    // ── award ─────────────────────────────────────────────────────────────────
    if (sub === "award") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ 管理者のみ使用できます。", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      const id     = interaction.options.getInteger("id", true);
      const winner = interaction.options.getUser("user", true);

      const existing = await getBounty(guildId, id);
      if (!existing) {
        await interaction.editReply(`❌ ID **#${id}** の懸賞金が見つかりません。`);
        return;
      }
      if (existing.status !== "active") {
        await interaction.editReply(`❌ ID **#${id}** はすでに${bountyStatusLabel(existing.status)}です。`);
        return;
      }

      await awardBounty(guildId, id, winner.id);

      const embed = new EmbedBuilder()
        .setTitle("🏆 懸賞金達成！")
        .setColor(0xf1c40f)
        .addFields(
          { name: "懸賞金", value: `#${id} **${existing.title}**`, inline: false },
          { name: "達成者", value: `<@${winner.id}>`, inline: true },
          { name: "報酬", value: `**${existing.reward.toLocaleString("ja-JP")} pt**`, inline: true },
          { name: "掲載者", value: `<@${existing.posterId}>`, inline: true },
        )
        .setTimestamp();

      await (interaction.channel as TextChannel).send({ embeds: [embed] }).catch(() => null);
      await interaction.editReply(`✅ **#${id}** の懸賞金を <@${winner.id}> に支払いました。`);
      logger.info(`[bounty] award id=${id} winner=${winner.id}`);
      return;
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });
      const bounties = await listActiveBounties(guildId);
      const embed = buildBoardEmbed(bounties);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── board ─────────────────────────────────────────────────────────────────
    if (sub === "board") {
      await interaction.deferReply({ ephemeral: true });
      const bounties = await listActiveBounties(guildId);
      const embed = buildBoardEmbed(bounties);
      await (interaction.channel as TextChannel).send({ embeds: [embed] });
      await interaction.editReply("✅ 懸賞金ボードを投稿しました。");
    }
  },
};
