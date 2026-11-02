import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
  SlashCommandSubcommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction,
  type Guild, type StringSelectMenuInteraction,
} from "discord.js";
import {
  advanceKpTicketSession, configureKpTicket, createKpTicketSession, createAdditionalKpTicketSession, deliverKpTicketLog,
  getKpTicketSession, getKpTicketSettings, isKpDrink, isKpTicketPanel, KpTicketError,
  quoteKpTicket, registerKpTicketPanel, settleKpTicket, listPaidKpTicketOrders,
  type KpTicketSession, type KpTicketSettings,
} from "@workspace/db";
import { getGuildSettings, getShopItem, listShopItems } from "../lib/economy";
import { fetchForumCastMembers, isEligibleForumCast } from "../lib/forumCastPicker";
import { KP_SHOP_CATEGORY, KP_SHOP_NAME } from "../lib/kpShop";
import { confirmTicketRows, KP_TICKET_PREFIX, pagedTicketMenu, ticketControls,
  ticketId, ticketMenu, ticketSummary } from "../lib/kpTicketUi";
import { logger } from "../lib/logger";
import { kpTicketStatement } from "../lib/kpTicketStatement";
import { grantKpTicketCastAccess } from "../lib/kpTicketAccess";

export const kpTicketPanelSubcommand = new SlashCommandSubcommandBuilder()
  .setName("ticket-panel").setDescription("チケット内にKPshopパネルを設置します（夜鴉・黒兵・管理者）")
  .addRoleOption(o => o.setName("black_role").setDescription("黒真珠ロール（省略時は名前で検索）"))
  .addRoleOption(o => o.setName("white_role").setDescription("白真珠ロール（省略時は名前で検索）"));
export const kpTicketPricesSubcommand = new SlashCommandSubcommandBuilder()
  .setName("ticket-prices").setDescription("VIP・延長料金を後から設定します。引数なしで現在の設定を表示（管理者）")
  .addIntegerOption(o => o.setName("vip").setDescription("VIP追加料金（0は無料。省略で変更なし）").setMinValue(0).setMaxValue(2_147_483_647))
  .addIntegerOption(o => o.setName("extension").setDescription("延長1回分の追加料金（0は無料。省略で変更なし）").setMinValue(0).setMaxValue(2_147_483_647))
  .addStringOption(o => o.setName("unset").setDescription("指定した料金を未設定に戻す（他の料金指定と併用不可）").addChoices(
    { name: "VIP", value: "vip" }, { name: "延長", value: "extension" }, { name: "両方", value: "all" },
  ));

const priceLabel = (price: number | null, currency: string) => price === null ? "未設定（希望時は支払い不可）" : `${price.toLocaleString()}${currency}`;

function canPost(interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction) {
  const channel = interaction.channel, me = interaction.guild?.members.me;
  return !!channel && !!me && "send" in channel && "permissionsFor" in channel && !!channel.permissionsFor(me)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
  ]) && !(channel.isThread() && (channel.archived || channel.locked));
}

async function resolveCastRoles(interaction: ChatInputCommandInteraction) {
  const roles = await interaction.guild!.roles.fetch();
  return ["黒真珠", "白真珠"].map((name, index) => {
    const explicit = interaction.options.getRole(index === 0 ? "black_role" : "white_role");
    if (explicit) {
      if (explicit.id === interaction.guildId) throw new KpTicketError("@everyoneはキャスト対象にできません。");
      return explicit.id;
    }
    const matches = [...roles.values()].filter(role => role.name === name);
    if (matches.length !== 1) throw new KpTicketError(`「${name}」ロールを一意に特定できません。コマンドのロール欄で指定してください。`);
    return matches[0]!.id;
  });
}

export async function executeKpTicketCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "ticket-panel") {
      // Re-fetch the caller: a removed role must not remain authorized through cached membership.
      const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true })
        .catch(() => { throw new KpTicketError("操作権限を確認できませんでした。時間をおいて再実行してください。"); });
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
        const roles = await interaction.guild.roles.fetch();
        const allowed = [...roles.values()].some(role =>
          (role.name === "夜鴉" || role.name === "黒兵") && member.roles.cache.has(role.id));
        if (!allowed) throw new KpTicketError("このコマンドは夜鴉・黒兵ロールの所持者、または管理者のみ使用できます。");
      }
    } else if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      throw new KpTicketError("サーバー管理権限が必要です。");
    }
    const { currencyName } = await getGuildSettings(interaction.guildId);
    if (subcommand === "ticket-prices") {
      const vip = interaction.options.getInteger("vip"), extension = interaction.options.getInteger("extension");
      const unset = interaction.options.getString("unset");
      if (unset && (vip !== null || extension !== null)) throw new KpTicketError("未設定に戻す操作と料金指定は分けて実行してください。");
      let settings = await getKpTicketSettings(interaction.guildId);
      const patch: { vipPrice?: number | null; extensionPrice?: number | null } = {};
      if (vip !== null) patch.vipPrice = vip;
      if (extension !== null) patch.extensionPrice = extension;
      if (unset === "vip" || unset === "all") patch.vipPrice = null;
      if (unset === "extension" || unset === "all") patch.extensionPrice = null;
      if (Object.keys(patch).length) settings = await configureKpTicket(interaction.guildId, patch);
      await interaction.editReply(`VIP料金: ${priceLabel(settings?.vipPrice ?? null, currencyName)}\n延長1回分: ${priceLabel(settings?.extensionPrice ?? null, currencyName)}\n未設定と0（無料）は区別されます。`);
      return;
    }
    if (!interaction.channel || !(interaction.channel.type === ChannelType.GuildText || interaction.channel.isThread()) || !canPost(interaction)) {
      throw new KpTicketError("チケットのテキストチャンネル・スレッド内で実行し、Botに閲覧・送信・埋め込み権限を付与してください。");
    }
    const roleIds = [...new Set(await resolveCastRoles(interaction))];
    await configureKpTicket(interaction.guildId, { castRoleIds: roleIds });
    const channel = interaction.channel;
    const message = await channel.send({
      embeds: [new EmbedBuilder().setTitle(KP_SHOP_NAME).setColor(0xf5a623).setDescription(
        "キミノヒトミニKP予約受付",
      )],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${KP_TICKET_PREFIX}start`).setLabel("注文する").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${KP_TICKET_PREFIX}additional`).setLabel("追加注文").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${KP_TICKET_PREFIX}statement`).setLabel("明細を集計").setStyle(ButtonStyle.Secondary),
      )],
      allowedMentions: { parse: [] },
    });
    try {
      await registerKpTicketPanel(message.id, interaction.guildId, channel.id);
    } catch (error) {
      await message.edit({ components: [] }).catch(() => {});
      throw error;
    }
    await interaction.editReply("チケット用パネルを設置しました。ドリンクにはKPshopの通常商品（特殊効果・付与ロールなし）を使用します。料金は /shop ticket-prices で後から設定できます。");
  } catch (error) {
    if (!(error instanceof KpTicketError)) logger.error("[kp-ticket] Admin command failed", error);
    await interaction.editReply(error instanceof KpTicketError ? error.message : "設定・設置に失敗しました。管理者はBotログを確認してください。");
  }
}

type TicketInteraction = ButtonInteraction | StringSelectMenuInteraction;

async function currentSettings(guildId: string) {
  const settings = await getKpTicketSettings(guildId);
  if (!settings?.castRoleIds.length) throw new KpTicketError("先に管理者が /shop ticket-panel でキャスト対象を設定してください。");
  return settings;
}
async function checkCast(guild: Guild, settings: KpTicketSettings, castId: string) {
  const roles = await Promise.all(settings.castRoleIds.map(id => guild.roles.fetch(id)));
  if (roles.some(role => !role || role.id === guild.id)) throw new KpTicketError("キャスト対象ロールが削除されています。管理者に再設定を依頼してください。");
  const member = await guild.members.fetch({ user: castId, force: true }).catch(() => null);
  if (!member || !isEligibleForumCast(member, settings.castRoleIds)) throw new KpTicketError("指名キャストが退出したか対象ロールを失っています。最初から選び直してください。");
  return member;
}

export async function renderKpTicket(interaction: TicketInteraction, session: KpTicketSession, page = 0, notice = "") {
  const { currencyName } = await getGuildSettings(session.guildId);
  const settings = await currentSettings(session.guildId);
  const content = `${notice ? `${notice}\n` : ""}`
    + (session.selection.fixedCastId ? `指名キャスト: <@${session.selection.fixedCastId}>（変更不可）\n` : "")
    + `注文の操作は本人のみ可能です。有効期限: <t:${Math.floor(session.expiresAt.getTime() / 1000)}:R>`;
  switch (session.phase) {
    case "cast": {
      const members = await fetchForumCastMembers(interaction.guild!, settings.castRoleIds);
      if (!members.length) throw new KpTicketError("対象ロールを持つキャストがいません。購入は行っていません。");
      await interaction.editReply({ content, embeds: [], components: pagedTicketMenu(session, "cast", "指名キャストを選択", members.map(m => ({
        label: m.displayName, value: m.id, description: `ユーザーID: ${m.id}`,
      })), page) });
      break;
    }
    case "vip":
    case "extension": {
      const vip = session.phase === "vip";
      const label = vip ? "VIP" : "延長";
      await interaction.editReply({ content, embeds: [], components: [
        ticketMenu(session, session.phase, `${label}を希望しますか？`, [
          { label: "希望する", value: "yes", description: priceLabel(vip ? settings.vipPrice : settings.extensionPrice, currencyName) },
          { label: "希望しない", value: "no", description: "追加料金なし" },
        ]), ticketControls(session),
      ] });
      break;
    }
    case "drink": {
      const items = (await listShopItems(session.guildId, KP_SHOP_CATEGORY)).filter(isKpDrink);
      const extrasOnly = !!session.selection.fixedCastId && (session.selection.vip || session.selection.extension);
      if (!items.length && !extrasOnly) throw new KpTicketError("KPshopの通常ドリンク商品が未登録です。管理者が /shop add で登録してください。");
      const components = items.length ? pagedTicketMenu(session, "drink", "ドリンクを選択", items.map(item => ({
        label: item.name, value: String(item.id), description: `${item.price.toLocaleString()}${currencyName}`,
      })), page) : [ticketControls(session)];
      if (extrasOnly) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ticketId("extras-only", session)).setLabel("ドリンクなしでVIP・延長のみ追加").setStyle(ButtonStyle.Primary),
      ));
      await interaction.editReply({ content, embeds: [], components });
      break;
    }
    case "quantity":
      await interaction.editReply({ content, embeds: [], components: [
        ticketMenu(session, "quantity", "数量を選択", Array.from({ length: 25 }, (_, index) => ({
          label: `${index + 1}個`, value: String(index + 1),
        }))), ticketControls(session),
      ] });
      break;
    case "confirm":
      await interaction.editReply({ content, embeds: [ticketSummary(session, currencyName)], components: confirmTicketRows(session) });
      break;
    default: throw new KpTicketError("この注文の選択操作は終了しています。");
  }
}

async function postPaidReceipt(interaction: TicketInteraction, session: KpTicketSession, already: boolean) {
  const { currencyName } = await getGuildSettings(session.guildId);
  let logged = true;
  try {
    await deliverKpTicketLog(session.id, async paid => {
      if (!canPost(interaction) || !interaction.channel || !("send" in interaction.channel)) throw new Error("Ticket log permission unavailable");
      const log = await interaction.channel.send({
        embeds: [ticketSummary(paid, currencyName, true)], allowedMentions: { parse: [] },
        // Discord de-duplicates ambiguous send retries using the original order ID.
        nonce: paid.id, enforceNonce: true,
      });
      return log.id;
    });
  } catch (error) {
    logged = false;
    logger.error(`[kp-ticket] Paid order ${session.id}: receipt pending`, error);
  }
  await interaction.editReply({
    content: `${already ? "この注文は支払い済みです。二重の引き落としは行っていません。" : "支払いが完了しました。"}\n`
      + (logged ? "購入ログをこのチケット内に記録しました。" : "購入ログの投稿に失敗しました。権限を確認後、下の「ログを再送」から再送できます。再決済はしません。"),
    embeds: [ticketSummary(session, currencyName, true)],
    components: logged ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ticketId("retry-log", session)).setLabel("ログを再送（再決済なし）").setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleKpTicketInteraction(interaction: TicketInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "サーバーのチケット内で操作してください。", ephemeral: true });
    return;
  }
  const encoded = interaction.customId.slice(KP_TICKET_PREFIX.length);
  const starting = encoded === "start" || encoded === "additional";
  const statement = encoded === "statement";
  if (statement) await interaction.deferReply();
  else if (starting) await interaction.deferReply({ ephemeral: true });
  else await interaction.deferUpdate();
  try {
    if (statement) {
      if (!await isKpTicketPanel(interaction.message.id, interaction.guildId, interaction.channelId)) {
        throw new KpTicketError("このパネルは未登録です。管理者に再設置を依頼してください。");
      }
      const orders = await listPaidKpTicketOrders(interaction.guildId, interaction.channelId);
      const { currencyName } = await getGuildSettings(interaction.guildId);
      await interaction.editReply(kpTicketStatement(orders, currencyName));
      return;
    }
    if (starting) {
      if (!await isKpTicketPanel(interaction.message.id, interaction.guildId, interaction.channelId)) {
        throw new KpTicketError("このパネルは未登録です。管理者に再設置を依頼してください。");
      }
      const session = await (encoded === "additional" ? createAdditionalKpTicketSession : createKpTicketSession)(
        interaction.id, interaction.guildId, interaction.channelId, interaction.user.id,
      );
      if (session.selection.fixedCastId) {
        const cast = await checkCast(interaction.guild, await currentSettings(interaction.guildId), session.selection.fixedCastId);
        await grantKpTicketCastAccess(interaction, cast);
      }
      await renderKpTicket(interaction, session);
      return;
    }
    const [action, id, versionRaw, pageRaw] = encoded.split(":");
    const session = id ? await getKpTicketSession(id) : undefined;
    if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId || session.channelId !== interaction.channelId) {
      throw new KpTicketError("他の人の注文や別チケットの注文は操作できません。自分で「注文する」から開始してください。");
    }
    if (session.phase === "paid" && (action === "confirm" || action === "retry-log")) {
      await postPaidReceipt(interaction, session, true);
      return;
    }
    const version = Number(versionRaw), page = Number(pageRaw);
    if (!Number.isInteger(version) || version !== session.version || session.expiresAt.getTime() <= Date.now() || ["paid", "cancelled"].includes(session.phase)) {
      throw new KpTicketError("この操作は期限切れか処理済みです。最新の画面から操作するか、新しい注文を開始してください。");
    }
    if (action === "cancel") {
      await advanceKpTicketSession(session, "cancelled", session.selection);
      await interaction.editReply({ content: "注文をキャンセルしました。引き落としは行っていません。", embeds: [], components: [] });
      return;
    }
    if (action === "reset") {
      const fixedCastId = session.selection.fixedCastId;
      await renderKpTicket(interaction, await advanceKpTicketSession(session, fixedCastId ? "vip" : "cast",
        fixedCastId ? { castId: fixedCastId, fixedCastId } : {}));
      return;
    }
    if ((action === "cast-page" && session.phase === "cast") || (action === "drink-page" && session.phase === "drink")) {
      await renderKpTicket(interaction, session, page);
      return;
    }
    const settings = await currentSettings(session.guildId);
    if (action === "extras-only" && session.phase === "drink" && interaction.isButton()) {
      const selection = { ...session.selection, itemId: undefined, quantity: undefined };
      selection.quote = quoteKpTicket(null, settings, selection);
      await renderKpTicket(interaction, await advanceKpTicketSession(session, "confirm", selection));
      return;
    }
    if (action === "confirm" && session.phase === "confirm" && interaction.isButton()) {
      if (!canPost(interaction)) throw new KpTicketError("チケット内に購入ログを送信できません。権限を確認してください。引き落としは行っていません。");
      const cast = await checkCast(interaction.guild, settings, session.selection.castId!);
      await grantKpTicketCastAccess(interaction, cast);
      const result = await settleKpTicket(session.id, version, interaction.user.id, interaction.guildId, interaction.channelId, settings.castRoleIds);
      if (result.status === "changed") {
        await renderKpTicket(interaction, result.session, 0, "商品または追加料金が変更されたため、引き落としていません。新しい金額を確認し、もう一度確定してください。");
      } else await postPaidReceipt(interaction, result.session, result.status === "already");
      return;
    }
    if (!interaction.isStringSelectMenu() || action !== session.phase) throw new KpTicketError("注文の操作順序が不正です。最新の画面から操作してください。");
    const value = interaction.values[0];
    const selection = { ...session.selection };
    let next = session.phase;
    let notice = "";
    switch (session.phase) {
      case "cast":
        if (!value) throw new KpTicketError("キャストを選択してください。");
        if (selection.fixedCastId) throw new KpTicketError("追加注文の指名キャストは変更できません。");
        const cast = await checkCast(interaction.guild, settings, value);
        await grantKpTicketCastAccess(interaction, cast);
        selection.castId = value;
        notice = "指名キャストをこのチケットに追加しました。";
        next = "vip";
        break;
      case "vip":
      case "extension": {
        if (value !== "yes" && value !== "no") throw new KpTicketError("希望する・希望しないから選択してください。");
        if (value === "yes" && (session.phase === "vip" ? settings.vipPrice : settings.extensionPrice) === null) {
          throw new KpTicketError(`${session.phase === "vip" ? "VIP" : "延長"}料金が未設定です。管理者が設定するまで希望ありでは進めません。「希望しない」の選択は可能です。`);
        }
        selection[session.phase] = value === "yes";
        next = session.phase === "vip" ? "extension" : "drink";
        break;
      }
      case "drink": {
        const item = await getShopItem(session.guildId, Number(value));
        if (!item || !isKpDrink(item)) throw new KpTicketError("このドリンクは購入できません。");
        selection.itemId = item.id; next = "quantity";
        break;
      }
      case "quantity": {
        selection.quantity = Number(value);
        const item = await getShopItem(session.guildId, selection.itemId!);
        if (!item) throw new KpTicketError("商品が削除されました。最初から選び直してください。");
        selection.quote = quoteKpTicket(item, settings, selection);
        next = "confirm";
        break;
      }
      default: throw new KpTicketError("この操作は処理できません。");
    }
    await renderKpTicket(interaction, await advanceKpTicketSession(session, next, selection), 0, notice);
  } catch (error) {
    if (!(error instanceof KpTicketError)) logger.error("[kp-ticket] Interaction failed", error);
    const content = error instanceof KpTicketError ? error.message : "注文の処理に失敗しました。支払い操作の場合は同じ確定ボタンから結果を確認できます。";
    if (starting || statement) await interaction.editReply({ content, components: [] });
    else await interaction.followUp({ content, ephemeral: true });
  }
}
