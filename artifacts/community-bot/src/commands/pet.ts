import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits,
  SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import {
  PET_RARITIES, PET_RARITY_NAMES, PET_SETTING_LABELS, PetError, petSetting, petSpecies,
  getPetSettings, getPetAccount, configurePet, buyPetItem, cancelPetPurchase, hatchPet, carePet, removePet, grantPetReward,
  type PetRarity, type PetItem, type PetSettingKey,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { handlePetTreatment, proposePetTreatment } from "../lib/petClinic";

const rarityChoices = PET_RARITIES.map(value => ({ name: PET_RARITY_NAMES[value], value }));
const shopChoices = [{ name: "ノーマル卵", value: "normal" }, { name: "レア卵", value: "rare" },
  { name: "エサ", value: "food" }, { name: "おもちゃ", value: "toy" }];
const panelShopChoices = shopChoices.filter(choice => choice.value !== "normal");
const rewardChoices = [...rarityChoices.map(c => ({ name: `${c.name}卵`, value: c.value })),
  { name: "エサ", value: "food" }, { name: "おもちゃ", value: "toy" }, { name: "クエスト経験値", value: "xp" }];
const adminCommands = new Set(["grant", "egg", "food", "delete", "price", "config", "species", "reward", "panel"]);
type Interaction = ChatInputCommandInteraction | ButtonInteraction;
const data = new SlashCommandBuilder().setName("pet").setDescription("1人1匹のペットを卵から育てます").setDMPermission(false)
  .addSubcommand(s => s.setName("info").setDescription("ペットの状態と今日のお世話回数を確認"))
  .addSubcommand(s => s.setName("inventory").setDescription("所持している卵・エサ・おもちゃを確認"))
  .addSubcommand(s => s.setName("hatch").setDescription("所持している卵を選んで即時孵化")
    .addStringOption(o => o.setName("egg").setDescription("孵化する卵").setRequired(true).addChoices(...rarityChoices)))
  .addSubcommand(s => s.setName("feed").setDescription("エサを1個使います"))
  .addSubcommand(s => s.setName("pet").setDescription("1日1回撫でます（日本時間）"))
  .addSubcommand(s => s.setName("play").setDescription("おもちゃ1個を使い遊びます（1日3回・日本時間）"))
  .addSubcommand(s => s.setName("release").setDescription("確認後にペットを手放します（取り消せません）"))
  .addSubcommand(s => s.setName("shop").setDescription("卵・エサの価格を確認"))
  .addSubcommand(s => s.setName("panel").setDescription("管理者：卵・エサ・おもちゃのショップパネルを設置"))
  .addSubcommand(s => s.setName("treat").setDescription("獣医限定：弱っているペットの治療を提案")
    .addUserOption(o => o.setName("user").setDescription("ペットの飼い主").setRequired(true)))
  .addSubcommand(s => s.setName("buy").setDescription("購入内容と価格を確認してから支払います")
    .addStringOption(o => o.setName("item").setDescription("商品").setRequired(true).addChoices(...shopChoices))
    .addIntegerOption(o => o.setName("quantity").setDescription("数量").setMinValue(1).setMaxValue(1000)))
  .addSubcommand(s => s.setName("settings").setDescription("育成数値とショップ設定を確認"))
  .addSubcommand(s => s.setName("grant").setDescription("管理者：ペットを卵として配布（直接孵化しません）")
    .addUserOption(o => o.setName("user").setDescription("対象者").setRequired(true))
    .addStringOption(o => o.setName("rarity").setDescription("卵のレアリティ").setRequired(true).addChoices(...rarityChoices)))
  .addSubcommand(s => s.setName("egg").setDescription("管理者：卵を配布")
    .addUserOption(o => o.setName("user").setDescription("対象者").setRequired(true))
    .addStringOption(o => o.setName("rarity").setDescription("卵のレアリティ").setRequired(true).addChoices(...rarityChoices))
    .addIntegerOption(o => o.setName("quantity").setDescription("個数").setRequired(true).setMinValue(1).setMaxValue(1000)))
  .addSubcommand(s => s.setName("food").setDescription("管理者：エサを配布")
    .addUserOption(o => o.setName("user").setDescription("対象者").setRequired(true))
    .addIntegerOption(o => o.setName("quantity").setDescription("個数").setRequired(true).setMinValue(1).setMaxValue(1000)))
  .addSubcommand(s => s.setName("delete").setDescription("管理者：確認後に対象者のペットを削除")
    .addUserOption(o => o.setName("user").setDescription("対象者").setRequired(true)))
  .addSubcommand(s => s.setName("price").setDescription("管理者：ショップ価格を変更")
    .addStringOption(o => o.setName("item").setDescription("商品").setRequired(true).addChoices(...shopChoices))
    .addIntegerOption(o => o.setName("amount").setDescription("価格（$）").setRequired(true).setMinValue(0).setMaxValue(1_000_000_000)))
  .addSubcommand(s => s.setName("config").setDescription("管理者：経験値・上限・お世話・満腹度の設定")
    .addStringOption(o => o.setName("key").setDescription("設定項目").setRequired(true)
      .addChoices(...Object.entries(PET_SETTING_LABELS).map(([value, name]) => ({ name, value }))))
    .addNumberOption(o => o.setName("value").setDescription("値（倍率以外は整数）").setRequired(true).setMinValue(0).setMaxValue(1_000_000_000)))
  .addSubcommand(s => s.setName("species").setDescription("管理者：卵から生まれる種類を設定（ノーマルの追加など）")
    .addStringOption(o => o.setName("rarity").setDescription("レアリティ").setRequired(true).addChoices(...rarityChoices))
    .addStringOption(o => o.setName("names").setDescription("種類名を読点「、」で区切る（同確率）").setRequired(true).setMaxLength(1000)))
  .addSubcommand(s => s.setName("reward").setDescription("管理者：イベント報酬・クエスト達成を記録して付与")
    .addUserOption(o => o.setName("user").setDescription("対象者").setRequired(true))
    .addStringOption(o => o.setName("reference").setDescription("達成記録ID（同じ対象者への重複配布防止）").setRequired(true).setMinLength(1).setMaxLength(60))
    .addStringOption(o => o.setName("item").setDescription("報酬").setRequired(true).addChoices(...rewardChoices))
    .addIntegerOption(o => o.setName("quantity").setDescription("数量／基礎経験値").setRequired(true).setMinValue(1).setMaxValue(1_000_000)));

async function access(i: Interaction, admin = false) {
  if (!i.guild) throw new PetError("サーバー内で使用してください。");
  if (admin) {
    const member = await i.guild.members.fetch({ user: i.user.id, force: true });
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) throw new PetError("この操作は管理者のみ使用できます。");
  }
  return i.guild.id;
}
function confirmation(customId: string, label: string, danger = false, cancelId = "pet:cancel") {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cancelId).setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
  )];
}
async function showPetPurchase(i: Interaction, guildId: string, item: PetItem, quantity: number) {
  if (!shopChoices.some(c => c.value === item)) throw new PetError("販売対象ではありません。");
  const s = await getPetSettings(guildId), price = petSetting(s, `${item}_price` as PetSettingKey);
  if (item !== "food" && item !== "toy" && !petSpecies(s, item).length) throw new PetError("この卵のペット種類が未登録です。販売を停止しています。");
  if (price * quantity > 2_147_483_647) throw new PetError("購入合計が上限を超えています。数量を減らしてください。");
  const expires = Math.floor(Date.now() / 1000) + 120;
  const label = shopChoices.find(c => c.value === item)!.name;
  await i.editReply({ content: `${label} ×${quantity}\n単価 $${price.toLocaleString()} / 合計 **$${(price * quantity).toLocaleString()}**\n銀行の共有残高から引き落とします。確認は2分間有効です。`,
    components: confirmation(`pet:buy:${i.user.id}:${item}:${quantity}:${price}:${expires}:${i.id}`, "支払って購入",
      false, `pet:cancelbuy:${i.user.id}:${i.id}`) });
}
async function errorReply(i: Interaction, e: unknown) {
  if (!(e instanceof PetError)) logger.error("[pet] Operation failed", e);
  await i.editReply({ content: e instanceof PetError ? e.message : "ペットの処理に失敗しました。状態を /pet info・inventory で確認してください。同じ購入確認を再実行しても二重課金されません。",
    embeds: [], components: [], allowedMentions: { parse: [] } });
}
export async function executePet(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const sub = i.options.getSubcommand();
    const guildId = await access(i, adminCommands.has(sub));
    const userId = i.user.id;
    let text = "";
    if (sub === "treat") { await proposePetTreatment(i); return; }
    if (sub === "panel") {
      const channel = i.channel;
      if (!channel || !("send" in channel)) throw new PetError("パネルを送信できるチャンネルで操作してください。");
      await channel.send({
        embeds: [new EmbedBuilder().setTitle("ペットショップ").setColor(0x68b88c)
          .setDescription("レア卵・エサ・おもちゃを販売しています。\nボタンで1個の購入確認を開きます。押すだけでは引き落としません。\n最新の価格は確認画面に表示します。未設定の商品は購入できません。\nまとめ買いは /pet buy から操作できます。")],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...panelShopChoices.map(c =>
          new ButtonBuilder().setCustomId(`pet:shop:${c.value}`).setLabel(c.name).setStyle(ButtonStyle.Primary)))],
        allowedMentions: { parse: [] },
      });
      await i.editReply("ペットショップパネルを設置しました。");
      return;
    }
    if (sub === "info" || sub === "inventory") {
      const a = await getPetAccount(guildId, userId);
      const p = a.pet;
      const embed = new EmbedBuilder().setColor(0x68b88c).setTitle(sub === "info" ? "ペット — 育成カード" : "ペット — インベントリ");
      if (sub === "info") {
        embed.setDescription(p ? `**${p.name}** / ${PET_RARITY_NAMES[p.rarity]}\n種類：${p.species}` : "ペットはいません。卵を入手して /pet hatch で孵化してください。");
        if (p) embed.addFields(
          { name: "レベル・経験値", value: `Lv${p.level} / ${p.xp.toLocaleString()} XP`, inline: true },
          { name: "満腹度", value: `${p.hunger}/100${p.hunger === 0 ? "（空腹）" : ""}`, inline: true },
          { name: "親密度", value: `${p.bond}/100`, inline: true },
          { name: "健康状態", value: p.weak
            ? `弱っています（${p.weak.reason === "both" ? "エサ・遊び不足" : p.weak.reason === "feed" ? "エサ不足" : "遊び不足"}）\n獣医へ治療を依頼してください。`
            : "弱った状態ではありません。", inline: false },
          { name: "誕生日", value: `<t:${Math.floor(p.bornAt / 1000)}:f>`, inline: true },
          { name: "今日のお世話（日本時間）", value: `撫でる ${a.petsToday}/1回 / 遊ぶ ${a.playsToday}/3回` },
          { name: "オーナー・個体ID", value: `<@${userId}>\n${p.id}` });
      } else embed.setDescription([...PET_RARITIES.map(r => `${PET_RARITY_NAMES[r]}卵：${a.eggs[r] ?? 0}個`),
        `エサ：${a.food}個`, `おもちゃ：${a.toys ?? 0}個`].join("\n"));
      await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }
    if (sub === "settings" || sub === "shop") {
      const s = await getPetSettings(guildId);
      const lines = sub === "shop" ? shopChoices.map(c => {
        const price = s[`${c.value}_price` as PetSettingKey];
        const missing = c.value !== "food" && c.value !== "toy" && !petSpecies(s, c.value as PetRarity).length;
        return `${c.name}：${price === undefined ? "価格未設定（販売停止）" : `$${price.toLocaleString()}`}${missing ? " / 種類未登録（販売停止）" : ""}`;
      }) : Object.entries(PET_SETTING_LABELS).map(([key, label]) =>
        `${label}：${s[key as PetSettingKey] ?? "未設定（価格は管理者が設定）"}`);
      await i.editReply({ embeds: [new EmbedBuilder().setColor(0x68b88c).setTitle(sub === "shop" ? "ペットショップ" : "ペット設定")
        .setDescription(lines.join("\n")).setFooter({ text: "育成値は標準設定。各価格は管理者が設定してください。卵の種類内は同確率です。" })] });
      return;
    }
    if (sub === "hatch") text = await hatchPet(i.id, guildId, userId, i.options.getString("egg", true) as PetRarity);
    else if (sub === "feed" || sub === "pet" || sub === "play") text = await carePet(i.id, guildId, userId, sub);
    else if (sub === "buy") {
      const item = i.options.getString("item", true) as PetItem, quantity = i.options.getInteger("quantity") ?? 1;
      await showPetPurchase(i, guildId, item, quantity);
      return;
    } else if (sub === "release" || sub === "delete") {
      const target = sub === "delete" ? i.options.getUser("user", true) : i.user;
      const a = await getPetAccount(guildId, target.id);
      if (!a.pet) throw new PetError("対象のペットはいません。");
      const expires = Math.floor(Date.now() / 1000) + 120;
      await i.editReply({ content: `「${a.pet.name}」を手放しますか？育成データは取り消せません。卵・エサ・おもちゃは残ります。`,
        components: confirmation(`pet:remove:${userId}:${target.id}:${a.pet.id}:${expires}`, "手放す（取り消し不可）", true),
        allowedMentions: { parse: [] } });
      return;
    } else if (sub === "config" || sub === "price") {
      const key = sub === "price" ? `${i.options.getString("item", true)}_price` as PetSettingKey : i.options.getString("key", true) as PetSettingKey;
      text = await configurePet(i.id, guildId, userId, { key, value: sub === "price" ? i.options.getInteger("amount", true) : i.options.getNumber("value", true) });
    } else if (sub === "species") {
      text = await configurePet(i.id, guildId, userId, { rarity: i.options.getString("rarity", true) as PetRarity,
        species: i.options.getString("names", true).split(/[、,\n]/).map(n => n.trim()).filter(Boolean) });
    } else if (["grant", "egg", "food", "reward"].includes(sub)) {
      const target = i.options.getUser("user", true);
      if (target.bot) throw new PetError("Botには配布できません。");
      const item = sub === "food" ? "food" : sub === "reward" ? i.options.getString("item", true) : i.options.getString("rarity", true);
      const quantity = sub === "grant" ? 1 : i.options.getInteger("quantity", true);
      const reference = sub === "reward" ? i.options.getString("reference", true).trim() : null;
      if (reference !== null && !reference) throw new PetError("達成記録IDを指定してください。");
      const id = reference !== null ? `pet-reward:${guildId}:${target.id}:${reference}` : i.id;
      text = await grantPetReward(id, guildId, target.id, userId, item as PetItem | "xp", quantity);
    } else throw new PetError("未対応の操作です。");
    await i.editReply({ content: text, allowedMentions: { parse: [] } });
  } catch (e) { await errorReply(i, e); }
}
export async function handlePetButton(i: ButtonInteraction) {
  try {
    if (i.customId.startsWith("pet:shop:")) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = await access(i);
      const item = i.customId.split(":")[2] as PetItem;
      if (!panelShopChoices.some(choice => choice.value === item)) {
        throw new PetError("この商品はショップパネルでは販売していません。");
      }
      await showPetPurchase(i, guildId, item, 1);
      return;
    }
    if (i.customId.startsWith("pet:treat:") || i.customId.startsWith("pet:canceltreat:")) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await handlePetTreatment(i);
      return;
    }
    // Confirmations are ephemeral messages. A component update edits their source
    // through the interaction webhook; Message#edit uses a channel-message route
    // that cannot reliably edit ephemeral messages.
    await i.deferUpdate();
    if (i.customId === "pet:cancel") {
      await i.editReply({ content: "キャンセルしました。", embeds: [], components: [], allowedMentions: { parse: [] } });
      return;
    }
    const [, action, owner, ...args] = i.customId.split(":");
    if (owner !== i.user.id) throw new PetError("この確認は本人のみ操作できます。");
    const guildId = await access(i);
    let text: string;
    if (action === "cancelbuy") {
      if (!args[0]) throw new PetError("確認情報が不正です。");
      text = await cancelPetPurchase(`pet-buy:${args[0]}`, guildId, i.user.id);
    } else if (action === "buy") {
      const [item, quantity, price, expires, requestId] = args;
      if (!requestId || Number(expires) < Date.now() / 1000) throw new PetError("確認の期限切れです。/pet buy からやり直してください。");
      text = await buyPetItem(`pet-buy:${requestId}`, guildId, i.user.id, item as PetItem, Number(quantity), Number(price));
    } else if (action === "remove") {
      const [target, petId, expires] = args;
      if (!target || !petId || Number(expires) < Date.now() / 1000) throw new PetError("確認の期限切れです。");
      if (target !== i.user.id) await access(i, true);
      text = await removePet(`pet-remove:${guildId}:${petId}`, guildId, target, i.user.id, petId);
    } else throw new PetError("未対応のボタンです。");
    await i.editReply({ content: text, embeds: [], components: [], allowedMentions: { parse: [] } });
  } catch (e) { await errorReply(i, e); }
}
export const petCommand = { data, execute: executePet };
