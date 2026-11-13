import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  type ButtonInteraction, type ChatInputCommandInteraction, type Guild,
} from "discord.js";
import { PetError, createPetTreatment, getPetTreatment, settlePetTreatment } from "@workspace/db";
import { logger } from "./logger";

/** Administrator alone does not grant veterinary authority. */
export async function requirePetVet(guild: Guild, userId: string) {
  const [roles, member] = await Promise.all([
    guild.roles.fetch(), guild.members.fetch({ user: userId, force: true }),
  ]);
  const vets = roles.filter(role => role.name === "獣医");
  if (vets.size !== 1) throw new PetError("「獣医」ロールを1つ設定してください。現在は治療できません。");
  if (!member.roles.cache.has(vets.first()!.id)) throw new PetError("治療は「獣医」ロールの所持者のみ行えます。");
}
export async function proposePetTreatment(i: ChatInputCommandInteraction) {
  if (!i.guild) throw new PetError("サーバー内で使用してください。");
  await requirePetVet(i.guild, i.user.id);
  const target = i.options.getUser("user", true);
  if (target.bot) throw new PetError("Botは治療できません。");
  const channel = i.channel;
  if (!channel || !("send" in channel) || !("permissionsFor" in channel)) throw new PetError("治療確認カードを送信できるチャンネルで操作してください。");
  const me = await i.guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel, channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) throw new PetError("治療カードを送信する権限がありません。");
  const r = await createPetTreatment(i.id, i.guild.id, target.id, i.user.id);
  await channel.send({
    content: `<@${target.id}>`,
    embeds: [new EmbedBuilder().setTitle("ペット — 獣医の治療確認").setColor(0xe7a96b)
      .setDescription(`獣医：<@${i.user.id}>\n飼い主：<@${target.id}>\n治療費：**$${r.price.toLocaleString()}**\n満腹度回復：${r.hunger}\n弱った状態を治療します。飼い主が承認するまで引き落としません。`)
      .setFooter({ text: "確認は2分間有効です。承認時にも獣医のロールを確認します。" })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pet:treat:${r.id}`).setLabel("飼い主：支払って治療を承認").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pet:canceltreat:${r.id}`).setLabel("飼い主：キャンセル").setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { users: [target.id], roles: [], parse: [] },
  });
  await i.editReply("治療確認カードを送信しました。飼い主の承認待ちです。まだ引き落としていません。");
}
/** The owner approves payment, while the proposed vet must still hold the role. */
export async function handlePetTreatment(i: ButtonInteraction) {
  if (!i.guild) throw new PetError("サーバー内で使用してください。");
  const [, action, id] = i.customId.split(":");
  if (!id) throw new PetError("治療確認が不正です。");
  const r = await getPetTreatment(id, i.guild.id, i.user.id);
  const cancel = action === "canceltreat";
  if (!cancel) await requirePetVet(i.guild, r.vetId);
  const text = await settlePetTreatment(id, i.guild.id, i.user.id, cancel);
  await i.editReply({ content: text, allowedMentions: { parse: [] } });
  try {
    await i.message.edit({ content: "ペットの治療確認は終了しました。", embeds: [], components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    // The settlement is already committed. A failed public-card cleanup must
    // not replace the owner's successful result with a false failure message.
    logger.warn("[pet] 治療後の確認カードを更新できませんでした。", error);
  }
}
