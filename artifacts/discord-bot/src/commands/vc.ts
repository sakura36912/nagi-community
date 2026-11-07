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
  SlashCommandSubcommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildChannel,
  type ModalSubmitInteraction,
  type TextBasedChannel,
  type VoiceChannel,
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
  getHubSessionsByGuildId,
} from "@workspace/db";
import { getGuildSettings, setVcWarnBeforeMinutes } from "../lib/economy";
import { getTavernChannelNames } from "../lib/chestTracker";
import { logger } from "../lib/logger";
import { isBeachVoiceChannel } from "../lib/vcRewardEligibility";
import { isVcStreamingEnabled, toggleVcStreaming } from "../lib/vcStreaming";

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

function isHubStreamEnabled(ch: GuildChannel, everyoneId: string): boolean {
  return isVcStreamingEnabled(ch, everyoneId);
}

export function buildHubVcPanelMessage(
  channelId: string,
  ownerId: string,
  streamEnabled: boolean,
  includeStreamControl = true,
) {
  const isBeachTransferPanel = !includeStreamControl;
  const embed = new EmbedBuilder()
    .setTitle(isBeachTransferPanel ? "🏖️ 砂浜コントロールパネル" : "🚢 船室コントロールパネル")
    .setColor(0x5865f2)
    .setDescription(
      `<@${ownerId}> の${isBeachTransferPanel ? "砂浜" : "船室"}です.${
        includeStreamControl
          ? `\n📺 画面共有: **${streamEnabled ? "ON ✅" : "OFF 🚫"}**`
          : ""
      }`,
    )
    .setFooter({ text: `${isBeachTransferPanel ? "砂浜" : "船室"}オーナーのみ操作できます` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(hubPanelId(HUB_PANEL_BTN_RENAME, channelId, ownerId))
      .setLabel("VC名変更")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✏️"),
  );
  if (includeStreamControl) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(hubPanelId(HUB_PANEL_BTN_STREAM, channelId, ownerId))
        .setLabel(streamEnabled ? "画面共有: ON" : "画面共有: OFF")
        .setStyle(streamEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji("📺"),
    );
  }
  return { embeds: [embed], components: [row] };
}

export function isBeachTransferHub(
  ...channelNames: Array<string | null | undefined>
): boolean {
  return channelNames.some((name) => name?.trim() === "砂浜");
}

async function getParentChannelName(
  guild: VoiceState["guild"],
  channel: { parentId?: string | null } | null,
): Promise<string | null> {
  if (!channel?.parentId) return null;
  const parent = guild.channels.cache.get(channel.parentId)
    ?? await guild.channels.fetch(channel.parentId).catch(() => null);
  return parent?.name ?? null;
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

  let result: Awaited<ReturnType<typeof toggleVcStreaming>>;
  try {
    result = await toggleVcStreaming(interaction.guild, channelId);
  } catch (error) {
    logger.error(`[vcHub] Stream toggle failed channel=${channelId}`, error);
    await interaction.editReply("❌ 画面共有設定を完了できませんでした。一部反映の可能性があります。Botの権限を確認して再操作してください。");
    return;
  }
  const { channel: ch, enabled: newState } = result;

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

function addHubRegistrationOptions(sub: SlashCommandSubcommandBuilder) {
  return sub
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
        .setDescription("生成VCを置くカテゴリ（省略するとトリガーと同じカテゴリ）")
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
    );
}

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
      addHubRegistrationOptions(
        sub
          .setName("hub-add")
          .setDescription("入ると自動でVCを作成・転送するトリガーチャンネルを登録します"),
      ),
    )
    // ── hub add/remove/list (nested form) ────────────────────────────────
    .addSubcommandGroup((group) =>
      group
        .setName("hub")
        .setDescription("Hubチャンネルを管理します")
        .addSubcommand((sub) =>
          addHubRegistrationOptions(
            sub
              .setName("add")
              .setDescription("入ると自動でVCを作成・転送するトリガーチャンネルを登録します"),
          ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Hubチャンネル登録を解除します")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("解除するVCチャンネル")
                .addChannelTypes(ChannelType.GuildVoice)
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("登録済みのHubチャンネル一覧を表示します"),
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
        .setDescription("既存の高級船室パネルをすべて最新レイアウトに更新します（管理者）"),
    )
    // ── hub-refresh-panels ────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-refresh-panels")
        .setDescription("既存のHub生成VCにパネルを送信し、権限も修正します（管理者）"),
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
    const hubSub = group === "hub"
      ? sub
      : sub.startsWith("hub-")
        ? sub.slice("hub-".length)
        : null;

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

    // ── hub-refresh-panels ────────────────────────────────────────────────
    if (sub === "hub-refresh-panels") {
      if (!interaction.guild) return;
      await interaction.deferReply({ ephemeral: true });
      logger.info(`[vcHub] hub-refresh-panels started by ${interaction.user.id} in guild ${interaction.guildId}`);
      const sessions = await getHubSessionsByGuildId(interaction.guildId);
      if (sessions.length === 0) {
        await interaction.editReply("このサーバーにアクティブな Hub VCはありません。");
        return;
      }
      let updated = 0; let skipped = 0;
      const botId = interaction.client.user?.id;
      for (const session of sessions) {
        try {
          const ch = interaction.guild.channels.cache.get(session.channelId)
            ?? await interaction.guild.channels.fetch(session.channelId).catch(() => null);
          if (!ch || !("messages" in ch) || !("permissionOverwrites" in ch) || !("send" in ch)) { skipped++; continue; }
          const gc = ch as import("discord.js").GuildChannel;
          const tc = ch as import("discord.js").VoiceChannel;
          // パネルがすでにあれば edit、なければ send
          const msgs = await tc.messages.fetch({ limit: 50 });
          const existing = msgs.find(
            (m) => m.author.id === botId && m.embeds[0]?.title === "🚢 船室コントロールパネル",
          );
          const nowStream = isHubStreamEnabled(gc, interaction.guild.roles.everyone.id);
          if (existing) {
            await existing.edit(buildHubVcPanelMessage(session.channelId, session.ownerId, nowStream));
          } else {
            await tc.send(buildHubVcPanelMessage(session.channelId, session.ownerId, nowStream));
          }
          updated++;
        } catch (err) {
          logger.warn(`[vcHub] refresh-panels: failed for channel ${session.channelId}`, err);
          skipped++;
        }
      }
      await interaction.editReply(
        `✅ Hub VCパネルを更新しました。\n更新: ${updated} 件 / スキップ: ${skipped} 件（チャンネル消失・送信失敗）`,
      );
      return;
    }

    // ── hub-add ───────────────────────────────────────────────────────────
    if (hubSub === "add") {
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
    if (hubSub === "remove") {
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
    if (hubSub === "list") {
      const hubs = await getHubChannels(interaction.guildId);
      if (hubs.length === 0) {
        await interaction.reply({
          content:
            "Hub チャンネルはまだ登録されていません。`/vc hub add` で追加できます。",
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

/** Copy the source Hub's channel-specific role/member rules into its new room. */
export function hubVoiceOverwrites(source: VoiceChannel) {
  return source.permissionOverwrites.cache.map(({ id, type, allow, deny }) => ({
    id,
    type,
    allow: allow.bitfield,
    deny: deny.bitfield,
  }));
}

/**
 * メンバーが Hub チャンネルに入ったとき:
 *   1. 新しいVCを生成
 *   2. メンバーを転送
 *   3. セッションを記録
 */
export async function handleHubJoin(newState: VoiceState): Promise<void> {
  if (!newState.channelId || !newState.member) return;
  logger.info(`[vcHub] handleHubJoin called: channelId=${newState.channelId} member=${newState.member.id}`);

  const hub = await getHubByChannelId(newState.channelId);
  logger.info(`[vcHub] getHubByChannelId result: ${hub ? `found template="${hub.nameTemplate}" panelOnly=${hub.panelOnly}` : "null (not a hub)"}`);
  if (!hub) return;

  // パネルのみ Hub（別Botが転送を担当）は VC 作成しない。
  // パネル送信は handlePanelOnlyHubTransfer が担当する。
  if (hub.panelOnly) return;

  const guild       = newState.guild;
  const member      = newState.member;
  const displayName = member.displayName;
  const channelName = hub.nameTemplate.replace("{user}", displayName).slice(0, 100);

  // 生成先カテゴリ: hub 設定 → hub 自身の親カテゴリ → なし
  // カテゴリと Hub の権限は異なる場合があるため、転送元を最新状態で取得する。
  const hubChannel = await guild.channels.fetch(hub.hubChannelId, { force: true });
  if (!hubChannel || hubChannel.type !== ChannelType.GuildVoice) {
    logger.error(`[vcHub] Source voice channel missing hub=${hub.hubChannelId}`);
    return;
  }
  const categoryId = hub.categoryId ?? hubChannel?.parentId ?? undefined;

  try {
    // client.user.id は常に利用可能（guild.members.me はキャッシュ未取得の場合がある）
    const botId = newState.client.user?.id ?? guild.members.me?.id;

    // 酒場ハブかどうかを事前判定（権限上書きの要否・パネル送信の要否に使用）
    const tavernNames = await getTavernChannelNames(guild.id);
    const isTavern = tavernNames.has(hub.nameTemplate);

    // カテゴリだけを継承すると、Hub 独自の賭博師・賭博頭領などの
    // UseApplicationCommands 許可が落ちる。Hub の上書きを全件コピーする。
    const newVc = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: categoryId,
      permissionOverwrites: hubVoiceOverwrites(hubChannel),
      ...(hub.userLimit != null ? { userLimit: hub.userLimit } : {}),
    });

    await createHubSession(guild.id, newVc.id, member.id, hub.id);

    logger.info(`[vcHub] panel check: channel=${newVc.id} template="${hub.nameTemplate}" isTavern=${isTavern} botId=${botId ?? "none"}`);
    if (!isTavern) {
      await newVc
        .send(buildHubVcPanelMessage(newVc.id, member.id, isHubStreamEnabled(newVc, guild.roles.everyone.id)))
        .catch((err) => logger.error("[vcHub] Failed to send hub panel", err));
      logger.info(`[vcHub] panel sent to channel=${newVc.id}`);
    }
    // 酒場ハブから生成されたチャンネルを永続ログに記録（過去データ検索に使用）
    if (isTavern) {
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

/** 別Botによる転送先を、退出判定より先に元Hubと紐付ける。 */
export async function recordPanelOnlyHubTransfer(
  oldState: VoiceState,
  newState: VoiceState,
) {
  if (!oldState.channelId || !newState.channelId) return null;

  const hub = await getHubByChannelId(oldState.channelId);
  if (!hub?.panelOnly) return null;

  const guild  = newState.guild;
  const member = newState.member;
  if (!member) return null;

  const vc = guild.channels.cache.get(newState.channelId)
    ?? await guild.channels.fetch(newState.channelId).catch(() => null);
  if (!vc || vc.type !== ChannelType.GuildVoice) return null;

  // The external bot owns this room; record only its source Hub.
  const existingSession = await getHubSession(vc.id).catch(() => null);
  if (!existingSession) {
    await createHubSession(guild.id, vc.id, member.id, hub.id).catch((err) =>
      logger.warn(
        `[vcHub] panel_only: Failed to record transfer session channel=${vc.id} hub=${hub.hubChannelId}`,
        err,
      ),
    );
  }
  return { hub, guild, member, vc };
}

/** パネルのみHubの転送先VCに操作パネルを送信する。 */
export async function handlePanelOnlyHubTransfer(
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  const transfer = await recordPanelOnlyHubTransfer(oldState, newState);
  if (!transfer) return;
  const { hub, guild, member, vc } = transfer;

  const sourceChannel = oldState.channel
    ?? await guild.channels.fetch(hub.hubChannelId).catch(() => null);
  const [sourceParentName, targetParentName] = await Promise.all([
    getParentChannelName(guild, sourceChannel),
    getParentChannelName(guild, vc),
  ]);
  const isBeachTransfer =
    isBeachTransferHub(
      hub.nameTemplate,
      sourceChannel?.name,
      sourceParentName,
      vc.name,
      targetParentName,
    )
    || isBeachVoiceChannel(sourceChannel?.name ?? "", sourceParentName);

  // カテゴリの ViewChannel 権限を継承させるため @everyone への上書きは行わない。
    const panel = buildHubVcPanelMessage(vc.id, member.id, isHubStreamEnabled(vc, guild.roles.everyone.id), !isBeachTransfer);
  try {
    const botId = newState.client.user?.id;
    const messages = await vc.messages.fetch({ limit: 50 });
    const existingPanel = messages.find(
      (message) =>
        (!botId || message.author.id === botId)
        && (
          message.embeds[0]?.title === "🚢 船室コントロールパネル"
          || message.embeds[0]?.title === "🏖️ 砂浜コントロールパネル"
        ),
    );
    if (existingPanel) {
      await existingPanel.edit(panel);
    } else {
      await vc.send(panel);
    }
  } catch (err) {
    logger.error("[vcHub] panel_only: Failed to send or update panel", err);
  }
  logger.info(
    `[vcHub] panel_only: panel sent to channel=${vc.id} ` +
    `(from hub=${oldState.channelId}, beach=${isBeachTransfer}, streamControl=${!isBeachTransfer})`,
  );
}

/**
 * 起動時に、すでに砂浜VCへ投稿されている旧船室パネルを移行する。
 * panel-only Hubはセッション行を持たないため、砂浜VCを直接検索する。
 */
export async function refreshExistingBeachHubPanels(
  discordClient: import("discord.js").Client,
): Promise<void> {
  let updated = 0;
  let skipped = 0;

  for (const guild of discordClient.guilds.cache.values()) {
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    for (const channel of channels.values()) {
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;

      try {
        const parentName = await getParentChannelName(guild, channel);
        if (!isBeachTransferHub(channel.name, parentName)) continue;

        const messages = await channel.messages.fetch({ limit: 50 });
        const botId = discordClient.user?.id;
        const panelMessage = messages.find(
          (message) =>
            (!botId || message.author.id === botId)
            && message.embeds[0]?.title === "🚢 船室コントロールパネル",
        );
        if (!panelMessage) continue;

        const ownerId = panelMessage.embeds[0]?.description?.match(/<@!?(\d+)>/)?.[1];
        if (!ownerId) {
          skipped++;
          logger.warn(`[vcHub] beach panel migration skipped: owner not found channel=${channel.id}`);
          continue;
        }

        await panelMessage.edit(buildHubVcPanelMessage(channel.id, ownerId, true, false));
        updated++;
      } catch (err) {
        skipped++;
        logger.warn(`[vcHub] beach panel migration failed channel=${channel.id}`, err);
      }
    }
  }

  logger.info(`[vcHub] beach panel migration complete: updated=${updated} skipped=${skipped}`);
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
  const hub = await getHubChannelById(session.hubId);

  // panel-only Hubs are transferred and deleted by another bot. Keep only the
  // Chinchiro source mapping; never delete the externally-managed voice channel.
  if (hub?.panelOnly) {
    if (!channel || !channel.isVoiceBased() || channel.members.size === 0) {
      await deleteHubSession(oldState.channelId).catch((err) =>
        logger.warn(`[vcHub] panel_only: Failed to clear transfer session channel=${oldState.channelId}`, err),
      );
    }
    return;
  }

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
