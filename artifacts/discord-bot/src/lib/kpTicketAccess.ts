import { ChannelType, OverwriteType, PermissionFlagsBits, type ButtonInteraction, type GuildMember, type StringSelectMenuInteraction, type UserSelectMenuInteraction } from "discord.js";
import { KpTicketError } from "@workspace/db";
import { logger } from "./logger";

/** Grant only the selected member access to this ticket; never change its category or other tickets. */
type TicketMemberInteraction = ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction;

async function grantKpTicketMemberAccess(
  interaction: TicketMemberInteraction, member: GuildMember, label: "キャスト" | "お客様",
) {
  const channel = interaction.channel, me = interaction.guild?.members.me;
  if (!channel || !me || !("guildId" in channel) || channel.id !== interaction.channelId
    || channel.guildId !== interaction.guildId || member.guild.id !== interaction.guildId) {
    throw new KpTicketError(`チケットを確認できないため、${label}を追加できません。引き落としは行っていません。`);
  }
  try {
    if (channel.isThread()) {
      if (channel.archived || channel.locked) throw new KpTicketError("終了・ロック済みのスレッドにはキャストを追加できません。");
      const parent = channel.parent ?? (channel.parentId ? await channel.guild.channels.fetch(channel.parentId) : null);
      if (!parent || parent.guildId !== interaction.guildId || !("permissionOverwrites" in parent)) {
        throw new KpTicketError("チケットの親チャンネルを確認できません。引き落としは行っていません。");
      }
      if (!parent.permissionsFor(member)?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory,
      ])) {
        throw new KpTicketError(`${label}に親チャンネルの閲覧・スレッド送信・履歴閲覧権限がありません。Botは親チャンネルの権限を変更しません。管理者に設定を依頼してください。引き落としは行っていません。`);
      }
      await channel.members.add(member.id);
      return;
    }
    if (channel.type !== ChannelType.GuildText) {
      throw new KpTicketError("チケットのテキストチャンネル内で操作してください。引き落としは行っていません。");
    }
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    if (channel.permissionsFor(member)?.has(required)) return;
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles])) {
      throw new KpTicketError("キャストを追加するにはBotにこのチケットの閲覧・権限管理（ロールの管理）権限が必要です。引き落としは行っていません。");
    }
    // Merge only this member's overwrite. Do not synchronize the category or grant access to a whole role.
    await channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    }, { type: OverwriteType.Member, reason: `KPチケットで選択された${label}の追加` });
  } catch (error) {
    if (error instanceof KpTicketError) throw error;
    logger.error(`[kp-ticket] Could not add the selected ${label} to the ticket`, error);
    throw new KpTicketError(`${label}をチケットに追加できませんでした。Botの権限を確認して再試行してください。引き落としは行っていません。`);
  }
}

export function grantKpTicketCastAccess(interaction: TicketMemberInteraction, cast: GuildMember) {
  return grantKpTicketMemberAccess(interaction, cast, "キャスト");
}

export function grantKpTicketCustomerAccess(interaction: TicketMemberInteraction, customer: GuildMember) {
  return grantKpTicketMemberAccess(interaction, customer, "お客様");
}
