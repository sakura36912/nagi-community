import { ChannelType, OverwriteType, PermissionFlagsBits, type ButtonInteraction, type GuildMember, type StringSelectMenuInteraction } from "discord.js";
import { KpTicketError } from "@workspace/db";
import { logger } from "./logger";

/** Grant only the selected member access to this ticket; never change its category or other tickets. */
export async function grantKpTicketCastAccess(
  interaction: ButtonInteraction | StringSelectMenuInteraction, cast: GuildMember,
) {
  const channel = interaction.channel, me = interaction.guild?.members.me;
  if (!channel || !me || !("guildId" in channel) || channel.id !== interaction.channelId
    || channel.guildId !== interaction.guildId || cast.guild.id !== interaction.guildId) {
    throw new KpTicketError("チケットを確認できないため、キャストを追加できません。引き落としは行っていません。");
  }
  try {
    if (channel.isThread()) {
      if (channel.archived || channel.locked) throw new KpTicketError("終了・ロック済みのスレッドにはキャストを追加できません。");
      const parent = channel.parent ?? (channel.parentId ? await channel.guild.channels.fetch(channel.parentId) : null);
      if (!parent || parent.guildId !== interaction.guildId || !("permissionOverwrites" in parent)) {
        throw new KpTicketError("チケットの親チャンネルを確認できません。引き落としは行っていません。");
      }
      if (!parent.permissionsFor(cast)?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory,
      ])) {
        throw new KpTicketError("キャストに親チャンネルの閲覧・スレッド送信・履歴閲覧権限がありません。Botは親チャンネルの権限を変更しません。管理者に設定を依頼してください。引き落としは行っていません。");
      }
      await channel.members.add(cast.id);
      return;
    }
    if (channel.type !== ChannelType.GuildText) {
      throw new KpTicketError("チケットのテキストチャンネル内で操作してください。引き落としは行っていません。");
    }
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    if (channel.permissionsFor(cast)?.has(required)) return;
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageRoles])) {
      throw new KpTicketError("キャストを追加するにはBotにこのチケットの閲覧・権限管理（ロールの管理）権限が必要です。引き落としは行っていません。");
    }
    // Merge only this member's overwrite. Do not synchronize the category or grant access to a whole role.
    await channel.permissionOverwrites.edit(cast.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    }, { type: OverwriteType.Member, reason: "KPチケットで指名されたキャストの追加" });
  } catch (error) {
    if (error instanceof KpTicketError) throw error;
    logger.error("[kp-ticket] Could not add the selected cast to the ticket", error);
    throw new KpTicketError("指名キャストをチケットに追加できませんでした。Botの権限を確認して再試行してください。引き落としは行っていません。");
  }
}
