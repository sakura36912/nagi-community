import {
  ActionRowBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { and, asc, eq } from "drizzle-orm";
import { db, guideItemsTable } from "@workspace/db";
import type { GuideItem } from "@workspace/db";
import { logger } from "../lib/logger";

// ── Constants ─────────────────────────────────────────────────────────────────

export const GUIDE_SELECT_ID = "guide:select";

// ── DB helpers ────────────────────────────────────────────────────────────────

async function listGuideItems(guildId: string): Promise<GuideItem[]> {
  return db
    .select()
    .from(guideItemsTable)
    .where(eq(guideItemsTable.guildId, guildId))
    .orderBy(asc(guideItemsTable.sortOrder), asc(guideItemsTable.id));
}

async function getGuideItem(guildId: string, id: number): Promise<GuideItem | undefined> {
  const [row] = await db
    .select()
    .from(guideItemsTable)
    .where(and(eq(guideItemsTable.guildId, guildId), eq(guideItemsTable.id, id)));
  return row;
}

async function addGuideItem(guildId: string, title: string, content: string, sortOrder: number): Promise<GuideItem> {
  const [row] = await db
    .insert(guideItemsTable)
    .values({ guildId, title, content, sortOrder })
    .returning();
  return row!;
}

async function updateGuideItem(
  guildId: string,
  id: number,
  fields: Partial<Pick<GuideItem, "title" | "content" | "sortOrder">>,
): Promise<GuideItem | undefined> {
  const [row] = await db
    .update(guideItemsTable)
    .set({ ...fields, updatedAt: new Date() })
    .where(and(eq(guideItemsTable.guildId, guildId), eq(guideItemsTable.id, id)))
    .returning();
  return row;
}

async function deleteGuideItem(guildId: string, id: number): Promise<boolean> {
  const result = await db
    .delete(guideItemsTable)
    .where(and(eq(guideItemsTable.guildId, guildId), eq(guideItemsTable.id, id)));
  return (result.rowCount ?? 0) > 0;
}

// ── Panel builder ─────────────────────────────────────────────────────────────

export function buildGuidePanel(items: GuideItem[]) {
  const embed = new EmbedBuilder()
    .setTitle("📖 新人案内ガイド")
    .setColor(0x5865f2)
    .setDescription("知りたい項目をプルダウンから選んでください。");

  if (items.length === 0) {
    embed.setDescription("ガイドの項目がまだありません。`/guide add` で追加してください。");
    return { embeds: [embed], components: [] };
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(GUIDE_SELECT_ID)
    .setPlaceholder("項目を選んでください")
    .addOptions(
      items.slice(0, 25).map((item) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(item.title.slice(0, 100))
          .setValue(String(item.id)),
      ),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  return { embeds: [embed], components: [row] };
}

// ── Select menu handler ───────────────────────────────────────────────────────

export async function handleGuideSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const id   = Number(interaction.values[0]);
  const item = await getGuideItem(interaction.guildId, id);
  if (!item) {
    await interaction.reply({ content: "この項目は削除されました。管理者にお知らせください。", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(item.title)
    .setDescription(item.content)
    .setColor(0x5865f2)
    .setFooter({ text: "📖 新人案内ガイド" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Command ───────────────────────────────────────────────────────────────────

export const guideCommand = {
  data: new SlashCommandBuilder()
    .setName("guide")
    .setDescription("新人案内ガイドを管理します")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("ガイド項目を追加します")
        .addStringOption((opt) =>
          opt.setName("title").setDescription("項目タイトル（セレクトメニューに表示）").setRequired(true).setMaxLength(100),
        )
        .addStringOption((opt) =>
          opt.setName("content").setDescription("内容（選択時に表示されるテキスト）").setRequired(true).setMaxLength(4000),
        )
        .addIntegerOption((opt) =>
          opt.setName("order").setDescription("表示順（数値が小さいほど上）").setRequired(false).setMinValue(0),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("ガイド項目を編集します")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("項目ID（/guide list で確認）").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("title").setDescription("新しいタイトル").setRequired(false).setMaxLength(100),
        )
        .addStringOption((opt) =>
          opt.setName("content").setDescription("新しい内容").setRequired(false).setMaxLength(4000),
        )
        .addIntegerOption((opt) =>
          opt.setName("order").setDescription("新しい表示順").setRequired(false).setMinValue(0),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("ガイド項目を削除します")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("削除する項目ID").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("ガイド項目の一覧を表示します"))
    .addSubcommand((sub) =>
      sub.setName("panel").setDescription("このチャンネルにガイドパネルを投稿します"),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    const guildId = interaction.guildId;
    const sub     = interaction.options.getSubcommand();

    // ── add ─────────────────────────────────────────────────────────────────
    if (sub === "add") {
      const title   = interaction.options.getString("title", true);
      const content = interaction.options.getString("content", true);
      const order   = interaction.options.getInteger("order") ?? 0;
      const item    = await addGuideItem(guildId, title, content, order);
      await interaction.reply({
        content: `✅ ガイド項目を追加しました（ID: **${item.id}**）\n**${item.title}**`,
        ephemeral: true,
      });
      logger.info(`[guide] add guildId=${guildId} id=${item.id} title=${item.title}`);
      return;
    }

    // ── edit ─────────────────────────────────────────────────────────────────
    if (sub === "edit") {
      const id      = interaction.options.getInteger("id", true);
      const title   = interaction.options.getString("title")   ?? undefined;
      const content = interaction.options.getString("content") ?? undefined;
      const order   = interaction.options.getInteger("order")  ?? undefined;

      if (!title && !content && order === undefined) {
        await interaction.reply({ content: "❌ 変更する項目（title / content / order）を最低1つ指定してください。", ephemeral: true });
        return;
      }

      const updated = await updateGuideItem(guildId, id, {
        ...(title   !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(order   !== undefined && { sortOrder: order }),
      });

      if (!updated) {
        await interaction.reply({ content: `❌ ID **${id}** の項目が見つかりません。`, ephemeral: true });
        return;
      }

      await interaction.reply({ content: `✅ ID **${id}** の項目を更新しました。`, ephemeral: true });
      return;
    }

    // ── remove ───────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const id      = interaction.options.getInteger("id", true);
      const deleted = await deleteGuideItem(guildId, id);
      if (!deleted) {
        await interaction.reply({ content: `❌ ID **${id}** の項目が見つかりません。`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ ID **${id}** の項目を削除しました。`, ephemeral: true });
      return;
    }

    // ── list ─────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const items = await listGuideItems(guildId);
      if (items.length === 0) {
        await interaction.reply({ content: "ガイド項目がまだありません。`/guide add` で追加してください。", ephemeral: true });
        return;
      }
      const lines = items.map((i) => `**#${i.id}** [${i.sortOrder}] ${i.title}`);
      await interaction.reply({
        content: `## 📖 ガイド項目一覧\n${lines.join("\n")}`,
        ephemeral: true,
      });
      return;
    }

    // ── panel ────────────────────────────────────────────────────────────────
    if (sub === "panel") {
      const items = await listGuideItems(guildId);
      if (items.length === 0) {
        await interaction.reply({ content: "❌ ガイド項目がまだありません。先に `/guide add` で項目を追加してください。", ephemeral: true });
        return;
      }
      const panel = buildGuidePanel(items);
      await interaction.reply({ content: "✅ ガイドパネルを投稿しました。", ephemeral: true });
      await (interaction.channel as import("discord.js").TextChannel).send(panel);
      return;
    }
  },
};
