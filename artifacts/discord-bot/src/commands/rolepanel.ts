import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  insertRolePanelButtons,
  getRolePanelButtons,
  deleteRolePanelButtons,
} from "../lib/rolePanel";

// ── Constants ────────────────────────────────────────────────────────────────

export const ROLE_PANEL_PREFIX = "rolepanel:";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildPanelComponents(
  messageId: string,
  buttons: { roleId: string; label: string; style: number }[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.slice(i, i + 5).map((b) =>
          new ButtonBuilder()
            .setCustomId(`${ROLE_PANEL_PREFIX}${messageId}:${b.roleId}`)
            .setLabel(b.label.slice(0, 80))
            .setStyle(b.style as ButtonStyle),
        ),
      ),
    );
  }
  return rows;
}

// ── Command ───────────────────────────────────────────────────────────────────

export const rolePanelCommand = {
  data: new SlashCommandBuilder()
    .setName("rolepanel")
    .setDescription("ロール選択パネルを管理します（管理者）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("post")
        .setDescription("このチャンネルにロール選択パネルを投稿します")
        .addStringOption((opt) =>
          opt.setName("title").setDescription("パネルのタイトル").setRequired(true),
        )
        .addRoleOption((opt) =>
          opt.setName("role1").setDescription("ロール①").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("label1").setDescription("ボタンラベル①（省略時はロール名）").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("role2").setDescription("ロール②").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("label2").setDescription("ボタンラベル②").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("role3").setDescription("ロール③").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("label3").setDescription("ボタンラベル③").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("role4").setDescription("ロール④").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("label4").setDescription("ボタンラベル④").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("role5").setDescription("ロール⑤").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("label5").setDescription("ボタンラベル⑤").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("パネルの説明文（省略可）").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("投稿済みのパネルを削除します（メッセージIDを指定）")
        .addStringOption((opt) =>
          opt.setName("message_id").setDescription("削除するパネルのメッセージID").setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // ── post ────────────────────────────────────────────────────────────────
    if (sub === "post") {
      const title       = interaction.options.getString("title", true);
      const description = interaction.options.getString("description");

      // Collect up to 5 role+label pairs
      const entries: { roleId: string; label: string; style: number }[] = [];
      for (let i = 1; i <= 5; i++) {
        const role  = interaction.options.getRole(`role${i}`);
        const label = interaction.options.getString(`label${i}`);
        if (!role) continue;
        entries.push({
          roleId: role.id,
          label:  (label ?? role.name).slice(0, 80),
          style:  ButtonStyle.Primary,
        });
      }

      if (entries.length === 0) {
        await interaction.reply({ content: "❌ ロールを最低1つ指定してください。", ephemeral: true });
        return;
      }

      // Build a temporary embed; we need the messageId to finalize button customIds
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x5865f2);
      if (description) embed.setDescription(description);

      // Post a placeholder first (no components yet) to get the messageId
      await interaction.reply({ content: "✅ パネルを投稿しました。", ephemeral: true });

      const channel = interaction.channel as import("discord.js").TextChannel;
      // Post with dummy messageId first, then edit with real one
      const posted = await channel.send({ embeds: [embed], components: [] });
      const messageId = posted.id;

      // Now build real components with the actual messageId and edit the message
      const rows = buildPanelComponents(messageId, entries);
      await posted.edit({ embeds: [embed], components: rows });

      // Persist to DB
      await insertRolePanelButtons(interaction.guildId, channel.id, messageId, entries);

      logger.info(`[rolepanel] posted panel messageId=${messageId} roles=${entries.map((e) => e.roleId).join(",")}`);
      return;
    }

    // ── remove ──────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const messageId = interaction.options.getString("message_id", true);
      const channel   = interaction.channel as import("discord.js").TextChannel;

      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
      } catch {
        // メッセージが既に削除されていても DB は掃除する
      }

      await deleteRolePanelButtons(messageId);
      await interaction.reply({ content: `✅ パネル（ID: \`${messageId}\`）を削除しました。`, ephemeral: true });
      return;
    }
  },
};

// ── Button handler ────────────────────────────────────────────────────────────

export async function handleRolePanelButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "このボタンはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  // customId format: "rolepanel:{messageId}:{roleId}"
  const parts     = interaction.customId.slice(ROLE_PANEL_PREFIX.length).split(":");
  const messageId = parts[0];
  const roleId    = parts[1];

  if (!messageId || !roleId) {
    await interaction.reply({ content: "不正なボタンです。", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Get all buttons registered for this panel
  const panelButtons = await getRolePanelButtons(messageId);
  if (panelButtons.length === 0) {
    await interaction.editReply("❌ このパネルはすでに削除されています。");
    return;
  }

  // Fetch member to check current roles
  const member = await interaction.guild.members.fetch(interaction.user.id);

  const hasRole = member.roles.cache.has(roleId);

  try {
    if (hasRole) {
      await member.roles.remove(roleId);
      await interaction.editReply(`✅ <@&${roleId}> を解除しました。`);
      logger.info(`[rolepanel] remove user=${interaction.user.id} guild=${interaction.guildId} role=${roleId}`);
    } else {
      await member.roles.add(roleId);
      await interaction.editReply(`✅ <@&${roleId}> を付与しました。`);
      logger.info(`[rolepanel] add user=${interaction.user.id} guild=${interaction.guildId} role=${roleId}`);
    }
  } catch (err) {
    logger.error("[rolepanel] role toggle failed", err);
    await interaction.editReply("❌ ロールの変更に失敗しました。Botの権限を確認してください。");
  }
}
