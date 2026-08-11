/**
 * /vc — VC 管理コマンド
 *   rename      : VCを即リネーム（管理者）
 *   hub-add     : 入ると自動VCを生成するトリガーチャンネルを登録（管理者）
 *   hub-remove  : Hub チャンネル登録を解除（管理者）
 *   hub-list    : 登録済み Hub 一覧を表示（管理者）
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildChannel,
  type ModalSubmitInteraction,
  type TextBasedChannel,
  type VoiceState,
} from "discord.js";
import {
  communityTavernChannelsTable,
  db,
  addHubChannel,
  getHubChannels,
  removeHubChannel,
  getHubByChannelId,
  getHubChannelById,
  createHubSession,
  getHubSession,
  deleteHubSession,
} from "@workspace/db";
import { getGuildSettings, setVcWarnBeforeMinutes } from "../lib/economy";
import { logger } from "../lib/logger";

// ─── Hub VC panel constants ──────────────────────────────────────────────────

export const HUB_PANEL_BTN_RENAME   = "vc:hub:rename:";
export const HUB_PANEL_BTN_STREAM   = "vc:hub:stream:";
export const HUB_PANEL_RENAME_MODAL = "vc:hub:rnm:";
const HUB_PANEL_RENAME_INPUT_ID     = "vc-hub-new-name";

function hubPanelId(prefix: string, channelId: string, ownerId: string) {
  return `${prefix}${channelId}:${ownerId}`;
}
function parseHubPanelId(prefix: string, customId: string): { channelId: string; ownerId: string } {
  const payload = customId.slice(prefix.length);
  const sep = payload.lastIndexOf(":");
  return { channelId: payload.slice(0, sep), ownerId: payload.slice(sep + 1) };
}

/**
 * @everyone に Stream: false の上書きがあれば OFF、なければ ON とみなす。
 * 初回作成時は上書きがないので ON が返る。
 */
function isHubStreamEnabled(ch: GuildChannel, everyoneId: string): boolean {
  if (!("permissionOverwrites" in ch)) return true;
  const ow = ch.permissionOverwrites.cache.get(everyoneId);
  return !(ow?.deny.has(PermissionFlagsBits.Stream) ?? false);
}

export function buildHubVcPanelMessage(channelId: string, ownerId: string, streamEnabled: boolean) {
  const embed = new EmbedBuilder()
    .setTitle("🚢 船室コントロールパネル")
    .setColor(0x5865f2)
    .setDescription(
      `<@${ownerId}> の船室です。\n📺 画面共有: **${streamEnabled ? "ON ✅" : "OFF 🚫"}**`,
    )
    .setFooter({ text: "船室オーナーのみ操作できます" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(hubPanelId(HUB_PANEL_BTN_RENAME, channelId, ownerId))
      .setLabel("VC名変更")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✏️"),
    new ButtonBuilder()
      .setCustomId(hubPanelId(HUB_PANEL_BTN_STREAM, channelId, ownerId))
      .setLabel(streamEnabled ? "画面共有: ON" : "画面共有: OFF")
      .setStyle(streamEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji("📺"),
  );
  return { embeds: [embed], components: [row] };
}

function checkHubOwner(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ownerId: string,
): boolean {
  if (interaction.user.id !== ownerId) {
    interaction
      .reply({ content: "❌ 船室オーナーのみ操作できます。", ephemeral: true })
      .catch(() => {});
    return false;
  }
  return true;
}

/** ✏️ VC名変更ボタン → モーダル表示 */
export async function handleHubRenameBtn(interaction: ButtonInteraction): Promise<void> {
  const { channelId, ownerId } = parseHubPanelId(HUB_PANEL_BTN_RENAME, interaction.customId);
  if (!checkHubOwner(interaction, ownerId)) return;

  const modal = new ModalBuilder()
    .setCustomId(`${HUB_PANEL_RENAME_MODAL}${channelId}:${ownerId}`)
    .setTitle("船室名変更")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(HUB_PANEL_RENAME_INPUT_ID)
          .setLabel("新しいVC名")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

/** モーダル送信 → チャンネル名を変更 */
export async function handleHubRenameModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  const payload = interaction.customId.slice(HUB_PANEL_RENAME_MODAL.length);
  const sep = payload.lastIndexOf(":");
  const channelId = payload.slice(0, sep);
  const ownerId   = payload.slice(sep + 1);
  if (!checkHubOwner(interaction, ownerId)) return;

  const newName = interaction.fields.getTextInputValue(HUB_PANEL_RENAME_INPUT_ID).trim();
  if (!newName) {
    await interaction.reply({ content: "❌ VC名を入力してください。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const ch = interaction.guild.channels.cache.get(channelId)
    ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch) {
    await interaction.editReply("❌ チャンネルが見つかりません。");
    return;
  }
  await ch.setName(newName.slice(0, 100));
  await interaction.editReply(`✅ 船室を「**${newName.slice(0, 100)}**」にリネームしました。`);
}

/** 📺 画面共有トグルボタン */
export async function handleHubStreamBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseHubPanelId(HUB_PANEL_BTN_STREAM, interaction.customId);
  if (!checkHubOwner(interaction, ownerId)) return;
  await interaction.deferReply({ ephemeral: true });

  const ch = interaction.guild.channels.cache.get(channelId)
    ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !("permissionOverwrites" in ch)) {
    await interaction.editReply("❌ チャンネルが見つかりません。");
    return;
  }
  const everyoneId = interaction.guild.roles.everyone.id;
  const nowEnabled = isHubStreamEnabled(ch as GuildChannel, everyoneId);
  const newState   = !nowEnabled;

  // @everyone の Stream を ON:true / OFF:false で上書き
  await (ch as GuildChannel).permissionOverwrites.edit(
    everyoneId,
    newState ? { Stream: true } : { Stream: false },
  );

  // パネルメッセージを更新（best-effort）
  try {
    if ("messages" in ch) {
      const msgs = await (ch as TextBasedChannel).messages.fetch({ limit: 20 });
      const panelMsg = msgs.find(
        (m) =>
          m.author.id === interaction.client.user?.id &&
          m.embeds[0]?.title === "🚢 船室コントロールパネル",
      );
      if (panelMsg) {
        await panelMsg.edit(buildHubVcPanelMessage(channelId, ownerId, newState));
      }
    }
  } catch (err) {
    logger.error(`[vcHub] Failed to update panel after stream toggle channel=${channelId}`, err);
  }

  await interaction.editReply(
    `✅ 画面共有を **${newState ? "有効 ✅" : "無効 🚫"}** にしました。`,
  );
}

// ─── /vc command ────────────────────────────────────────────────────────────

export const vcCommand = {
  data: new SlashCommandBuilder()
    .setName("vc")
    .setDescription("VCを管理します")
    .setDefaultMemberPermissions(0)
    // ── rename ────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("rename")
        .setDescription("VCを新しい名前にリネームします")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("リネームするVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("new-name")
            .setDescription("新しいチャンネル名")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100),
        ),
    )
    // ── hub-add ───────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-add")
        .setDescription(
          "入ると自動でVCを作成・転送するトリガーチャンネルを登録します",
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("トリガーにするVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription(
              "生成VCを置くカテゴリ（省略するとトリガーと同じカテゴリ）",
            )
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("name_template")
            .setDescription(
              "生成VCの名前テンプレート。{user} がメンバー名に置換されます（例: {user}のVC）",
            )
            .setMaxLength(90)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("user_limit")
            .setDescription("生成VCの人数制限（1〜99。省略すると制限なし）")
            .setMinValue(1)
            .setMaxValue(99)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("salary_rate")
            .setDescription("この Hub の生成VCでの時給（コイン/時間）。省略すると分給なし")
            .setMinValue(1)
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("salary_min_minutes")
            .setDescription("分給発生の最低滞在時間（分、デフォルト: 1）")
            .setMinValue(1)
            .setMaxValue(1440)
            .setRequired(false),
        ),
    )
    // ── hub-remove ────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-remove")
        .setDescription("Hub チャンネル登録を解除します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("解除するVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    // ── hub-list ──────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-list")
        .setDescription("登録済みの Hub チャンネル一覧を表示します"),
    )
    // ── refresh-panels ────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("refresh-panels")
        .setDescription("既存の非公開VCパネルをすべて最新レイアウトに更新します（管理者）"),
    )
    // ── warn-time ─────────────────────────────────────────────────────────
    .addSubcommandGroup((group) =>
      group
        .setName("warn-time")
        .setDescription("VCリネームスケジュールの事前警告時間を管理します")
        .addSubcommand((sub) =>
          sub
            .setName("get")
            .setDescription("現在の警告時間（分）を表示します"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("VCが削除される何分前に警告DMを送るかを設定します")
            .addIntegerOption((opt) =>
              opt
                .setName("minutes")
                .setDescription("警告を送る時間（分）。1〜120の範囲で指定してください。")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(120),
            ),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub   = interaction.options.getSubcommand();

    // ── rename ────────────────────────────────────────────────────────────
    if (sub === "rename") {
      await handleRename(interaction);
      return;
    }

    // All remaining subcommands require ManageChannels
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: "このコマンドを使用するには ManageChannels 権限が必要です。",
        ephemeral: true,
      });
      return;
    }

    // ── warn-time ─────────────────────────────────────────────────────────
    if (group === "warn-time") {
      if (sub === "get") {
        const settings = await getGuildSettings(interaction.guildId);
        await interaction.reply({
          content:
            `⏰ 現在の警告時間: **${settings.vcWarnBeforeMinutes}分前**\n` +
            `（VCが削除される ${settings.vcWarnBeforeMinutes} 分前に警告DMが送信されます）`,
          ephemeral: true,
        });
        return;
      }

      if (sub === "set") {
        const minutes = interaction.options.getInteger("minutes", true);
        await setVcWarnBeforeMinutes(interaction.guildId, minutes);
        await interaction.reply({
          content: `✅ 警告時間を **${minutes}分前** に設定しました。`,
          ephemeral: true,
        });
        return;
      }
    }

    // ── hub-add ───────────────────────────────────────────────────────────
    if (sub === "hub-add") {
      const channel         = interaction.options.getChannel("channel", true);
      const categoryOpt     = interaction.options.getChannel("category");
      const templateOpt     = interaction.options.getString("name_template");
      const userLimit       = interaction.options.getInteger("user_limit") ?? null;
      const salaryRate      = interaction.options.getInteger("salary_rate") ?? null;
      const salaryMinMin    = interaction.options.getInteger("salary_min_minutes") ?? 1;
      const nameTemplate    = templateOpt?.trim() || "{user}のVC";

      await addHubChannel(
        interaction.guildId,
        channel.id,
        categoryOpt?.id ?? null,
        nameTemplate,
        userLimit,
        salaryRate,
        salaryMinMin,
      );

      const categoryDisplay = categoryOpt ? `<#${categoryOpt.id}>` : "（トリガーと同じカテゴリ）";
      const limitDisplay    = userLimit != null ? `${userLimit}人` : "なし";
      const salaryDisplay   = salaryRate != null
        ? `${salaryRate.toLocaleString()} コイン/時間（最低 ${salaryMinMin} 分）`
        : "なし";
      await interaction.reply({
        content:
          `✅ <#${channel.id}> を Hub チャンネルとして登録しました。\n` +
          `名前テンプレート: \`${nameTemplate}\`\n` +
          `生成先カテゴリ: ${categoryDisplay}\n` +
          `人数制限: ${limitDisplay}\n` +
          `分給: ${salaryDisplay}`,
        ephemeral: true,
      });
      return;
    }

    // ── hub-remove ────────────────────────────────────────────────────────
    if (sub === "hub-remove") {
      const channel = interaction.options.getChannel("channel", true);
      const removed = await removeHubChannel(interaction.guildId, channel.id);
      if (!removed) {
        await interaction.reply({
          content: `<#${channel.id}> は Hub として登録されていません。`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: `✅ <#${channel.id}> の Hub 登録を解除しました。`,
        ephemeral: true,
      });
      return;
    }

    // ── refresh-panels ────────────────────────────────────────────────────
    // (handled in src/index.ts before execute() to avoid circular imports)

    // ── hub-list ──────────────────────────────────────────────────────────
    if (sub === "hub-list") {
      const hubs = await getHubChannels(interaction.guildId);
      if (hubs.length === 0) {
        await interaction.reply({
          content:
            "Hub チャンネルはまだ登録されていません。`/vc hub-add` で追加できます。",
          ephemeral: true,
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle("🔀 Hub チャンネル一覧")
        .setColor(0x5865f2)
        .addFields(
          hubs.map((h) => ({
            name: `<#${h.hubChannelId}>`,
            value: [
              `テンプレート: \`${h.nameTemplate}\``,
              h.categoryId
                ? `生成先カテゴリ: <#${h.categoryId}>`
                : "生成先カテゴリ: トリガーと同じ",
              h.userLimit != null ? `人数制限: ${h.userLimit}人` : "人数制限: なし",
              h.salaryRatePerHour != null
                ? `💰 分給: ${h.salaryRatePerHour.toLocaleString()} コイン/時間（最低 ${h.salaryMinMinutes} 分）`
                : "💰 分給: なし",
            ].join("\n"),
            inline: false,
          })),
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  },
};

// ─── /vc rename ──────────────────────────────────────────────────────────────

async function handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
  const me = interaction.guild?.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "BotにManageChannels権限がないため、VCをリネームできません。",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  const newName = interaction.options.getString("new-name", true).trim();

  const voiceChannel =
    interaction.guild?.channels.cache.get(channel.id) ??
    (await interaction.guild?.channels.fetch(channel.id).catch(() => null));

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "対象のボイスチャンネルが見つかりませんでした。",
      ephemeral: true,
    });
    return;
  }

  await voiceChannel.setName(newName);
  await interaction.reply({
    content: `<#${channel.id}> を **${newName}** にリネームしました。`,
    ephemeral: true,
  });
}

// ─── Hub join / leave (called from index.ts voiceStateUpdate) ────────────────

/**
 * メンバーが Hub チャンネルに入ったとき:
 *   1. 新しいVCを生成
 *   2. メンバーを転送
 *   3. セッションを記録
 */
export async function handleHubJoin(newState: VoiceState): Promise<void> {
  if (!newState.channelId || !newState.member) return;

  const hub = await getHubByChannelId(newState.channelId);
  if (!hub) return;

  const guild       = newState.guild;
  const member      = newState.member;
  const displayName = member.displayName;
  const channelName = hub.nameTemplate.replace("{user}", displayName).slice(0, 100);

  // 生成先カテゴリ: hub 設定 → hub 自身の親カテゴリ → なし
  const hubChannel = guild.channels.cache.get(newState.channelId);
  const categoryId = hub.categoryId ?? hubChannel?.parentId ?? undefined;

  try {
    const newVc = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: categoryId,
      ...(hub.userLimit != null ? { userLimit: hub.userLimit } : {}),
    });

    // カテゴリの権限同期を保ちつつ、@everyone に画面共有を明示的に許可する
    await newVc.permissionOverwrites.edit(guild.roles.everyone, { Stream: true })
      .catch((err) => logger.warn("[vcHub] Failed to set Stream permission", err));

    await createHubSession(guild.id, newVc.id, member.id, hub.id);

    // 酒場ハブから生成されたチャンネルを永続ログに記録（過去データ検索に使用）
    const TAVERN_NAMES = new Set(["大酒場🍺", "小酒場🍺"]);

    // 酒場以外のハブにのみコントロールパネルを投稿
    if (!TAVERN_NAMES.has(hub.nameTemplate)) {
      newVc
        .send(buildHubVcPanelMessage(newVc.id, member.id, true))
        .catch((err) => logger.error("[vcHub] Failed to send hub panel", err));
    }
    if (TAVERN_NAMES.has(hub.nameTemplate)) {
      await db.insert(communityTavernChannelsTable)
        .values({ guildId: guild.id, channelId: newVc.id, hubName: hub.nameTemplate })
        .onConflictDoNothing()
        .catch(() => {}); // ログ失敗は無視
    }

    // メンバーを新VCに転送
    await member.voice.setChannel(newVc).catch(async () => {
      // 転送失敗（権限不足など）→ 作成した空VCを削除
      await deleteHubSession(newVc.id);
      await newVc.delete().catch(() => {});
    });
  } catch (err) {
    logger.error(
      `[vcHub] handleHubJoin error member=${member.id} hub=${hub.hubChannelId}`,
      err,
    );
  }
}

/**
 * メンバーが Hub によって生成されたVCを離れたとき:
 *   チャンネルが空になっていれば自動削除する
 */
export async function handleHubLeave(oldState: VoiceState): Promise<void> {
  if (!oldState.channelId) return;

  const session = await getHubSession(oldState.channelId);
  if (!session) return;

  const guild   = oldState.guild;
  const channel = guild.channels.cache.get(oldState.channelId);
  if (!channel || !channel.isVoiceBased()) return;

  // まだ誰かいるなら何もしない
  if (channel.members.size > 0) return;

  try {
    await deleteHubSession(oldState.channelId);
    await channel.delete();
    logger.info(
      `[vcHub] Auto-deleted empty hub VC: ${channel.name} (${oldState.channelId})`,
    );
  } catch (err) {
    logger.error(
      `[vcHub] handleHubLeave delete error channel=${oldState.channelId}`,
      err,
    );
  }
}
