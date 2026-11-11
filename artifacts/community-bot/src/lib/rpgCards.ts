import { createHash } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  type Client, type ButtonInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import { advancePvpGuild, duePvpGuilds, pendingRpgCards, deliverRpgCard, ForgeError, type RpgCard } from "@workspace/db";
import { logger } from "./logger";

export async function assertRpgCardChannel(interaction: ChatInputCommandInteraction | ButtonInteraction) {
  const channel = interaction.channel;
  if (!interaction.guild || !channel || channel.isDMBased() || !channel.isTextBased() || !("send" in channel)) {
    throw new ForgeError("サーバーのメッセージ送信可能なチャンネルで操作してください。");
  }
  if (channel.isThread() && (channel.archived || channel.locked)) throw new ForgeError("アーカイブ・ロック中のスレッドでは操作できません。");
  const me = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages])) {
    throw new ForgeError("公開カードを表示するため、Botにチャンネルの閲覧・送信・埋め込みリンク権限が必要です。課金はしていません。");
  }
  return channel.id;
}
export function rpgCardMessage(card: RpgCard) {
  const embed = new EmbedBuilder().setTitle(card.title).setColor(card.color).setDescription(card.description);
  if (card.fields?.length) embed.addFields(card.fields);
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (card.forgeOwnerId) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`forge:upgrade:${card.forgeOwnerId}`)
        .setLabel("次の強化（本人専用）").setStyle(ButtonStyle.Primary)));
  }
  if (card.duelId && card.phase !== "finished") {
    const buttons = card.phase === "pending"
      ? [["accept", "承諾して対戦", ButtonStyle.Success], ["decline", "辞退", ButtonStyle.Secondary], ["cancel", "募集を取り消す", ButtonStyle.Danger]] as const
      : [["attack", "攻撃", ButtonStyle.Primary], ["heal", "回復（有料）", ButtonStyle.Success], ["surrender-confirm", "降参", ButtonStyle.Danger]] as const;
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.map(([action, label, style]) => new ButtonBuilder().setCustomId(`pvp:${action}:${card.duelId}`).setLabel(label).setStyle(style))));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
}
let running = false;
let timer: ReturnType<typeof setInterval> | undefined;
export async function runRpgCards(client: Client) {
  if (running) return;
  running = true;
  try {
    for (const guildId of await duePvpGuilds()) {
      try {
        for (const failure of await advancePvpGuild(guildId)) {
          logger.error(`[pvp] Refund needs retry duel=${failure.duelId}`, failure.error);
        }
      }
      catch (error) { logger.error(`[pvp] Expiry/refund needs retry guild=${guildId}`, error); }
    }
    for (const row of await pendingRpgCards()) {
      const delivered = await deliverRpgCard(row.id, async notice => {
        const channel = await client.channels.fetch(notice.channelId);
        if (!channel || !channel.isTextBased() || !("send" in channel)
          || !("guildId" in channel) || channel.guildId !== notice.guildId) throw new Error("Public RPG card channel unavailable");
        const message = await channel.send({ ...rpgCardMessage(notice.card),
          nonce: createHash("sha256").update(notice.id).digest("hex").slice(0, 24), enforceNonce: true });
        return message.id;
      });
      if (delivered?.error) logger.warn(`[rpg] Public card delivery failed; retry scheduled id=${row.id}`, delivered.error);
    }
  } catch (error) { logger.error("[rpg] Public card/PvP recovery failed", error); }
  finally { running = false; }
}
export function startRpgCards(client: Client) {
  if (timer) return;
  void runRpgCards(client);
  timer = setInterval(() => { void runRpgCards(client); }, 15000);
  timer.unref();
}
