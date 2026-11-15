import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder,
  OverwriteType, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type Guild, type ModalSubmitInteraction, type VoiceState,
  type OverwriteData, type VoiceChannel,
} from "discord.js";
import {
  deliverKpVipRoom, getKpTicketSettings, KpTicketError, KP_VIP_HUB_ID, listKpVipOrders,
  type KpTicketSession,
} from "@workspace/db";
import { logger } from "./logger";

export const KP_VIP_PREFIX = "shop:kp-vip:";
const visibility = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect;
const access = visibility | PermissionFlagsBits.Speak | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory;

/** Only the purchased room changes, never the source Hub/category or cast's role. */
export function kpVipOverwrites(
  source: { id: string; type: OverwriteType; allow: { bitfield: bigint }; deny: { bitfield: bigint } }[],
  everyoneId: string, allowedIds: string[], isPublic: boolean,
): OverwriteData[] {
  const rows = source.map(row => ({
    id: row.id, type: row.type,
    allow: row.type === OverwriteType.Role ? row.allow.bitfield & ~visibility : row.allow.bitfield,
    deny: row.type === OverwriteType.Role ? row.deny.bitfield & ~visibility : row.deny.bitfield,
  }));
  for (const row of rows) {
    // Remove any copied member access too: private VIP is for the named participants only.
    row.allow &= ~visibility;
    row.deny = isPublic ? row.deny & ~visibility : row.deny | visibility;
  }
  const everyone = rows.find(row => row.id === everyoneId);
  if (everyone) {
    everyone.allow = isPublic ? everyone.allow | visibility : everyone.allow & ~visibility;
    everyone.deny = isPublic ? everyone.deny & ~visibility : everyone.deny | visibility;
  } else rows.push({ id: everyoneId, type: OverwriteType.Role,
    allow: isPublic ? visibility : 0n, deny: isPublic ? 0n : visibility });
  for (const id of new Set(allowedIds)) {
    const row = rows.find(r => r.id === id);
    if (row) { row.allow |= access; row.deny &= ~access; }
    else rows.push({ id, type: OverwriteType.Member, allow: access, deny: 0n });
  }
  return rows;
}

export function kpVipPanel(order: KpTicketSession, roomId: string) {
  const castIds = order.selection.castIds ?? (order.selection.castId ? [order.selection.castId] : []);
  const customerIds = order.selection.customerIds ?? [order.userId];
  return {
    embeds: [new EmbedBuilder().setTitle("KP島 VIPコントロールパネル").setColor(0xd4af37)
      .setDescription(`お客様: ${customerIds.map(id => `<@${id}>`).join("、")}\n${customerIds.length}人・キャスト${castIds.length}人\n初期状態は非公開です。公開にすると他のメンバーも閲覧・入室できます。\n非公開に戻すと対象者以外を退出させます（管理者を除く）。\nVIPは延長対象外です。`)
      .setFooter({ text: "購入者本人のみ操作できます。管理者はDiscordの仕様上、非公開VCも閲覧できます。" })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${KP_VIP_PREFIX}private:${roomId}`).setLabel("非公開VC").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${KP_VIP_PREFIX}public:${roomId}`).setLabel("公開VC").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${KP_VIP_PREFIX}rename:${roomId}`).setLabel("VC名変更").setStyle(ButtonStyle.Primary),
    )], allowedMentions: { parse: [] as [] },
  };
}

export async function validateKpVipSource(guild: Guild) {
  const hub = await guild.channels.fetch(KP_VIP_HUB_ID, { force: true });
  if (!hub || hub.type !== ChannelType.GuildVoice) throw new KpTicketError("VIP転送元VCがこのサーバーにありません。管理者に確認してください。");
  const me = await guild.members.fetchMe();
  const permissions = hub.permissionsFor(me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.EmbedLinks])) {
    throw new KpTicketError("BotにVIP転送元VCの閲覧・接続・メンバー移動・チャンネル管理・権限管理・埋め込み権限が必要です。引き落としはしていません。");
  }
  if (hub.parent && !hub.parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
    throw new KpTicketError("BotにVIP作成先カテゴリのチャンネル管理権限が必要です。");
  }
  return hub;
}

async function ticketExists(guild: Guild, order: KpTicketSession) {
  const channel = await guild.channels.fetch(order.channelId, { force: true }).catch(error => {
    if (error?.code === 10003) return null;
    throw error;
  });
  return !!channel;
}

function participants(order: KpTicketSession, botId: string) {
  return [...new Set([...(order.selection.customerIds ?? [order.userId]),
    ...(order.selection.castIds ?? [order.selection.castId!]), botId])];
}

/** VIP source is intercepted before the ordinary/free Hub handler. No purchase happens here. */
export async function handleKpVipHubJoin(state: VoiceState): Promise<boolean> {
  if (state.channelId !== KP_VIP_HUB_ID) return false;
  if (!state.member || state.member.user.bot) return true;
  let created: VoiceChannel | undefined;
  try {
    const orders = await listKpVipOrders(state.guild.id, state.member.id);
    let order: KpTicketSession | undefined;
    for (const candidate of orders) {
      if (await ticketExists(state.guild, candidate)) { order = candidate; break; }
    }
    if (!order) throw new KpTicketError("このVCは支払い済みVIPのお客様・指名キャスト専用です。先にチケットでVIPを注文してください。");
    const hub = await validateKpVipSource(state.guild);
    const bot = await state.guild.members.fetchMe();
    const settings = await getKpTicketSettings(state.guild.id);
    const castIds = order.selection.castIds ?? (order.selection.castId ? [order.selection.castId] : []);
    const casts = await Promise.all(castIds.map(id => state.guild.members.fetch({ user: id, force: true }).catch(() => null)));
    if (!settings || casts.length !== castIds.length || casts.some(cast =>
      !cast || !settings.castRoleIds.some(id => cast.roles.cache.has(id)))) {
      throw new KpTicketError("指名キャストの所属・キャストロールを確認できません。管理者に連絡してください。");
    }
    const roomId = await deliverKpVipRoom(order.id, state.guild.id, async locked => {
      if (locked.selection.vipRoomId) {
        const existing = await state.guild.channels.fetch(locked.selection.vipRoomId, { force: true }).catch(error => {
          if (error?.code === 10003) return null;
          throw error;
        });
        if (existing) {
          if (existing.type !== ChannelType.GuildVoice) throw new KpTicketError("VIP転送先の種類が不正です。");
          return existing.id;
        }
      }
      const owner = await state.guild.members.fetch({ user: locked.userId, force: true });
      created = await state.guild.channels.create({
        name: `VIP・${owner.displayName}`.slice(0, 100), type: ChannelType.GuildVoice,
        parent: hub.parentId, userLimit: (locked.selection.customerIds?.length ?? (locked.selection.vipTier === "shared" ? 2 : 1))
          + (locked.selection.castIds?.length ?? 1),
        permissionOverwrites: kpVipOverwrites([...hub.permissionOverwrites.cache.values()],
          state.guild.id, participants(locked, bot.id), false),
      });
      await created.send(kpVipPanel(locked, created.id));
      return created.id;
    });
    // Commit the room mapping first: failed moves can retry without another payment.
    created = undefined;
    if (state.member.voice.channelId === KP_VIP_HUB_ID) await state.member.voice.setChannel(roomId);
  } catch (error) {
    if (created) await created.delete("VIP room setup failed").catch(cleanup => logger.error("[kp-vip] Failed to clean incomplete room", cleanup));
    logger.error("[kp-vip] Transfer failed", error);
    await state.member.send(error instanceof KpTicketError ? error.message : "VIP転送に失敗しました。再課金はしていません。管理者に確認してください。").catch(() => {});
  }
  return true;
}

export async function handleKpVipHubLeave(state: VoiceState): Promise<boolean> {
  if (!state.channelId) return false;
  const orders = await listKpVipOrders(state.guild.id, undefined, state.channelId);
  if (!orders.length) return false;
  const room = await state.guild.channels.fetch(state.channelId, { force: true }).catch(error => {
    if (error?.code === 10003) return null;
    throw error;
  });
  if (room?.type === ChannelType.GuildVoice && room.members.size === 0) await room.delete("VIP room became empty");
  return true;
}

async function ownedRoom(interaction: ButtonInteraction | ModalSubmitInteraction, roomId: string) {
  if (!interaction.guild) throw new KpTicketError("サーバー内で操作してください。");
  const [order] = await listKpVipOrders(interaction.guild.id, undefined, roomId);
  if (!order || order.userId !== interaction.user.id || !await ticketExists(interaction.guild, order)) {
    throw new KpTicketError("有効なVIPチケットの購入者本人だけが操作できます。");
  }
  const room = await interaction.guild.channels.fetch(roomId, { force: true });
  if (!room || room.type !== ChannelType.GuildVoice) throw new KpTicketError("VIP専用VCが見つかりません。");
  return { order, room };
}

export async function handleKpVipControl(interaction: ButtonInteraction | ModalSubmitInteraction) {
  const [action, roomId] = interaction.customId.slice(KP_VIP_PREFIX.length).split(":");
  if (action === "rename" && interaction.isButton()) {
    // A modal must be the initial interaction response; authorization is rechecked on submit.
    await interaction.showModal(new ModalBuilder().setCustomId(`${KP_VIP_PREFIX}name:${roomId}`).setTitle("VIPのVC名変更")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("新しいVC名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
      )));
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const { order, room } = await ownedRoom(interaction, roomId ?? "");
    if (action === "name" && interaction.isModalSubmit()) {
      const name = interaction.fields.getTextInputValue("name").trim();
      if (!name) throw new KpTicketError("VC名を入力してください。");
      await room.setName(name.slice(0, 100));
      await interaction.editReply("VIPのVC名を変更しました。");
    } else if ((action === "private" || action === "public") && interaction.isButton()) {
      const bot = await interaction.guild!.members.fetchMe();
      await room.permissionOverwrites.set(kpVipOverwrites([...room.permissionOverwrites.cache.values()],
        interaction.guildId!, participants(order, bot.id), action === "public"));
      if (action === "private") {
        const allowed = new Set(participants(order, bot.id));
        for (const member of room.members.values()) {
          if (!allowed.has(member.id) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
            await member.voice.disconnect("VIP room switched to private");
          }
        }
      }
      await interaction.editReply(action === "public" ? "VIPのVCを公開しました。ほかのメンバーも閲覧・接続できます。" : "VIPのVCを非公開にしました。購入者・指名キャストのみ閲覧・接続できます（管理者を除く）。");
    } else throw new KpTicketError("この操作は使用できません。");
  } catch (error) {
    logger.error("[kp-vip] Control failed", error);
    await interaction.editReply(error instanceof KpTicketError ? error.message : "VIPのVC操作に失敗しました。Botの権限を確認してください。");
  }
}
