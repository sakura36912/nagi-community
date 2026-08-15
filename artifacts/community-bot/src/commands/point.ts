import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import {
  getPointSettings,
  setPointSettings,
  getRoleConfigs,
  addRoleConfig,
  removeRoleConfig,
  getRankConfigs,
  setRankConfig,
  getPointBalance,
  getPointRanking,
  addPoints,
  awardEventResult,
} from "../lib/points.js";
import { getEvent, getParticipants } from "../lib/community.js";

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) throw new Error("このコマンドはサーバー内でのみ使用できます。");
  return interaction.guildId;
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member) return false;
  const perms = member.permissions;
  if (typeof perms === "string") return false;
  return perms.has("Administrator");
}

function requireAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (!isAdmin(interaction)) {
    interaction.reply({ content: "このコマンドは管理者のみ使用できます。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return false;
  }
  return true;
}

const RANK_MEDALS = ["🥇", "🥈", "🥉"];

export const pointCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("point")
    .setDescription("ポイントシステム")
    .setDefaultMemberPermissions(0)

    // ── balance ──────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("balance")
        .setDescription("自分のポイント残高を確認します"),
    )

    // ── ranking ──────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub.setName("ranking").setDescription("ポイントランキングを表示します"),
    )

    // ── setup ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("ポイント設定を変更します（管理者）")
        .addIntegerOption((opt) =>
          opt
            .setName("vc_rate")
            .setDescription("VC 1時間あたりのポイント")
            .setMinValue(0),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("event_points")
            .setDescription("イベント参加ごとのポイント")
            .setMinValue(0),
        ),
    )

    // ── award ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("award")
        .setDescription("手動でポイントを付与／減算します（管理者）")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("対象メンバー").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("ポイント数（負で減算）").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("理由"),
        ),
    )

    // ── role add / remove / list ──────────────────────────────────────────────
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("役職継続日数トラッキングの設定（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("トラッキング対象ロールを追加します")
            .addRoleOption((opt) =>
              opt.setName("role").setDescription("対象ロール").setRequired(true),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("points_per_day")
                .setDescription("1日あたりのポイント")
                .setRequired(true)
                .setMinValue(1),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("トラッキング対象ロールを削除します")
            .addRoleOption((opt) =>
              opt.setName("role").setDescription("削除するロール").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("トラッキング対象ロール一覧を表示します"),
        ),
    )

    // ── rank set / list ───────────────────────────────────────────────────────
    .addSubcommandGroup((group) =>
      group
        .setName("rank")
        .setDescription("イベント順位ポイントの設定（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("特定順位のポイントを設定します")
            .addIntegerOption((opt) =>
              opt.setName("rank").setDescription("順位（1=1位）").setRequired(true).setMinValue(1),
            )
            .addIntegerOption((opt) =>
              opt.setName("points").setDescription("付与ポイント").setRequired(true).setMinValue(0),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("順位ポイント一覧を表示します"),
        ),
    )

    // ── event result ──────────────────────────────────────────────────────────
    .addSubcommandGroup((group) =>
      group
        .setName("event")
        .setDescription("イベント成績入力（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("result")
            .setDescription("イベントの順位成績を入力してポイントを付与します")
            .addIntegerOption((opt) =>
              opt.setName("event_id").setDescription("イベントID").setRequired(true),
            )
            .addUserOption((opt) =>
              opt.setName("user").setDescription("対象メンバー").setRequired(true),
            )
            .addIntegerOption((opt) =>
              opt.setName("rank").setDescription("順位").setRequired(true).setMinValue(1),
            ),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand(false);
    const group = interaction.options.getSubcommandGroup(false);

    // ── balance ──────────────────────────────────────────────────────────────
    if (sub === "balance" && !group) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const target = interaction.user;
      const balance = await getPointBalance(guildId, target.id);
      const embed = new EmbedBuilder()
        .setTitle("🏆 ポイント残高")
        .setColor(0xf5a623)
        .setThumbnail((interaction.member as GuildMember)?.displayAvatarURL() ?? interaction.user.displayAvatarURL())
        .addFields({ name: "メンバー", value: `<@${target.id}>`, inline: true })
        .addFields({ name: "ポイント", value: `**${balance.toLocaleString()} pt**`, inline: true });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── ranking ──────────────────────────────────────────────────────────────
    if (sub === "ranking" && !group) {
      await interaction.deferReply();
      const entries = await getPointRanking(guildId, 10);
      if (entries.length === 0) {
        await interaction.editReply("まだポイントを持っているメンバーがいません。");
        return;
      }
      const lines = entries.map((e, i) => {
        const medal = RANK_MEDALS[i] ?? `**${i + 1}.**`;
        return `${medal} <@${e.userId}> — **${e.balance.toLocaleString()} pt**`;
      });
      const embed = new EmbedBuilder()
        .setTitle("🏆 ポイントランキング")
        .setColor(0xf5a623)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `上位${entries.length}名` });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── setup ────────────────────────────────────────────────────────────────
    if (sub === "setup" && !group) {
      if (!requireAdmin(interaction)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const vcRate = interaction.options.getInteger("vc_rate");
      const eventPoints = interaction.options.getInteger("event_points");

      if (vcRate === null && eventPoints === null) {
        const settings = await getPointSettings(guildId);
        const embed = new EmbedBuilder()
          .setTitle("⚙️ ポイント設定")
          .setColor(0x5865f2)
          .addFields(
            { name: "VC 1時間あたり", value: `${settings.vcRatePerHour} pt`, inline: true },
            { name: "イベント参加", value: `${settings.eventParticipationPoints} pt`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const opts: Parameters<typeof setPointSettings>[1] = {};
      if (vcRate !== null) opts.vcRatePerHour = vcRate;
      if (eventPoints !== null) opts.eventParticipationPoints = eventPoints;
      await setPointSettings(guildId, opts);

      const lines: string[] = [];
      if (vcRate !== null) lines.push(`VC 1時間あたり: **${vcRate} pt**`);
      if (eventPoints !== null) lines.push(`イベント参加: **${eventPoints} pt**`);
      await interaction.editReply(`✅ ポイント設定を更新しました。\n${lines.join("\n")}`);
      return;
    }

    // ── award ────────────────────────────────────────────────────────────────
    if (sub === "award" && !group) {
      if (!requireAdmin(interaction)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      const reason = interaction.options.getString("reason") ?? undefined;

      const newBalance = await addPoints(guildId, target.id, amount, "manual", reason);
      const sign = amount >= 0 ? "+" : "";
      await interaction.editReply(
        `✅ <@${target.id}> に **${sign}${amount.toLocaleString()} pt** を付与しました。\n残高: **${newBalance.toLocaleString()} pt**${reason ? `\n理由: ${reason}` : ""}`,
      );
      return;
    }

    // ── role add ─────────────────────────────────────────────────────────────
    if (group === "role") {
      if (!requireAdmin(interaction)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (sub === "add") {
        const role = interaction.options.getRole("role", true);
        const ppd = interaction.options.getInteger("points_per_day", true);
        await addRoleConfig(guildId, role.id, ppd);
        await interaction.editReply(
          `✅ <@&${role.id}> を対象ロールに追加しました。（1日 **${ppd} pt**）`,
        );
        return;
      }

      if (sub === "remove") {
        const role = interaction.options.getRole("role", true);
        const ok = await removeRoleConfig(guildId, role.id);
        await interaction.editReply(
          ok
            ? `✅ <@&${role.id}> をトラッキング対象から削除しました。`
            : `❌ <@&${role.id}> はトラッキング対象に登録されていません。`,
        );
        return;
      }

      if (sub === "list") {
        const configs = await getRoleConfigs(guildId);
        if (configs.length === 0) {
          await interaction.editReply("トラッキング対象ロールがまだ設定されていません。\n`/point role add` で追加してください。");
          return;
        }
        const lines = configs.map((c) => `• <@&${c.roleId}> — **${c.pointsPerDay} pt/日**`);
        const embed = new EmbedBuilder()
          .setTitle("🎭 対象ロール一覧")
          .setColor(0x5865f2)
          .setDescription(lines.join("\n"));
        await interaction.editReply({ embeds: [embed] });
        return;
      }
    }

    // ── rank set / list ───────────────────────────────────────────────────────
    if (group === "rank") {
      if (!requireAdmin(interaction)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (sub === "set") {
        const rank = interaction.options.getInteger("rank", true);
        const points = interaction.options.getInteger("points", true);
        await setRankConfig(guildId, rank, points);
        await interaction.editReply(`✅ ${rank}位 → **${points} pt** に設定しました。`);
        return;
      }

      if (sub === "list") {
        const configs = await getRankConfigs(guildId);
        if (configs.length === 0) {
          await interaction.editReply("順位ポイントがまだ設定されていません。\n`/point rank set` で追加してください。");
          return;
        }
        const lines = configs.map((c) => {
          const medal = RANK_MEDALS[c.rank - 1] ?? `**${c.rank}位**`;
          return `${medal} **${c.points} pt**`;
        });
        const embed = new EmbedBuilder()
          .setTitle("🏅 イベント順位ポイント")
          .setColor(0x5865f2)
          .setDescription(lines.join("\n"));
        await interaction.editReply({ embeds: [embed] });
        return;
      }
    }

    // ── event result ──────────────────────────────────────────────────────────
    if (group === "event" && sub === "result") {
      if (!requireAdmin(interaction)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const eventId = interaction.options.getInteger("event_id", true);
      const target = interaction.options.getUser("user", true);
      const rank = interaction.options.getInteger("rank", true);

      const event = await getEvent(eventId);
      if (!event || event.guildId !== guildId) {
        await interaction.editReply(`❌ イベント ID **${eventId}** が見つかりません。`);
        return;
      }

      const pts = await awardEventResult(guildId, target.id, eventId, rank);
      if (pts === 0) {
        await interaction.editReply(
          `⚠️ ${rank}位 に対応するポイント設定がありません。\n\`/point rank set rank:${rank} points:<ポイント数>\` で設定してください。`,
        );
        return;
      }

      const newBalance = await getPointBalance(guildId, target.id);
      const medal = RANK_MEDALS[rank - 1] ?? `${rank}位`;
      await interaction.editReply(
        `✅ **${event.title}** — <@${target.id}> の成績を登録しました。\n${medal} → **+${pts} pt**\n残高: **${newBalance.toLocaleString()} pt**`,
      );
      return;
    }
  },
};
