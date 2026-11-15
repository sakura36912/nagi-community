import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandSubcommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction,
  type Guild, type StringSelectMenuInteraction, type ModalSubmitInteraction,
} from "discord.js";
import {
  advanceKpTicketSession, configureKpTicket, createKpTicketSession, createAdditionalKpTicketSession, deliverKpTicketLog,
  getKpTicketSession, getKpTicketSettings, isKpDrink, isKpTicketPanel, KpTicketError,
  quoteKpTicket, registerKpTicketPanel, settleKpTicket, listPaidKpTicketOrders, listTransfersToRecipient,
  KP_VIP_PRICES, KP_EXTENSION_PRICE, KP_VIP_HUB_ID,
  type KpTicketSession, type KpTicketSettings,
} from "@workspace/db";
import { getGuildSettings, getShopItem, listShopItems } from "../lib/economy";
import { fetchForumCastMembers, isEligibleForumCast } from "../lib/forumCastPicker";
import { KP_SHOP_CATEGORY, KP_SHOP_NAME } from "../lib/kpShop";
import { confirmTicketRows, KP_TICKET_PREFIX, pagedTicketMenu, ticketControls,
  ticketId, ticketMenu, ticketSummary } from "../lib/kpTicketUi";
import { logger } from "../lib/logger";
import { kpTicketStatement } from "../lib/kpTicketStatement";
import { kpCastSales } from "../lib/kpCastSales";
import { kpCustomers } from "../lib/kpCustomers";
import { grantKpTicketCastAccess } from "../lib/kpTicketAccess";
import { kpBusinessDay, latestKpBusinessDate, type KpBusinessDay } from "../lib/kpBusinessDay";
import { validateKpVipSource } from "../lib/kpVipVc";
import { kpTransferHistory } from "../lib/kpTransferHistory";

const KP_TRANSFER_RECIPIENT_ID = "1276893567599644715";

export const kpTicketPanelSubcommand = new SlashCommandSubcommandBuilder()
  .setName("ticket-panel").setDescription("チケット内にKPshopパネルを設置します（夜鴉・黒兵・管理者）")
  .addRoleOption(o => o.setName("black_role").setDescription("黒真珠ロール（省略時は名前で検索）"))
  .addRoleOption(o => o.setName("white_role").setDescription("白真珠ロール（省略時は名前で検索）"));
export const kpTicketPricesSubcommand = new SlashCommandSubcommandBuilder()
  .setName("ticket-prices").setDescription("VIP2種類と通常利用の延長の固定料金を表示します（管理者）");
export const kpCustomersSubcommand = new SlashCommandSubcommandBuilder()
  .setName("customers").setDescription("KP島の支払い済み利用顧客・履歴を確認（夜鴉・黒兵・管理者）")
  .addUserOption(o => o.setName("user").setDescription("指定すると、この顧客の利用履歴を表示"))
  .addIntegerOption(o => o.setName("page").setDescription("表示ページ（省略時は1）").setMinValue(1));
export const kpAllTicketSalesSubcommand = new SlashCommandSubcommandBuilder()
  .setName("ticket-sales").setDescription("全チケットの営業日売上を確認（夜鴉・黒兵・管理者）");
export const kpNagiTransfersSubcommand = new SlashCommandSubcommandBuilder()
  .setName("nagi-transfers").setDescription("凪への送金履歴を確認（夜鴉・黒兵・管理者）");

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

async function requireKpStaff(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  const member = await interaction.guild!.members.fetch({ user: interaction.user.id, force: true })
    .catch(() => { throw new KpTicketError("操作権限を確認できませんでした。時間をおいて再実行してください。"); });
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return;
  const roles = await interaction.guild!.roles.fetch();
  const allowed = [...roles.values()].some(role =>
    (role.name === "夜鴉" || role.name === "黒兵") && member.roles.cache.has(role.id));
  if (!allowed) throw new KpTicketError("この操作は夜鴉・黒兵ロールの所持者、または管理者のみ使用できます。");
}

export async function executeKpTicketCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const subcommand = interaction.options.getSubcommand();
    if (["ticket-panel", "customers", "ticket-sales", "nagi-transfers"].includes(subcommand)) {
      // Re-fetch the caller: a removed role must not remain authorized through cached membership.
      await requireKpStaff(interaction);
    } else if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      throw new KpTicketError("サーバー管理権限が必要です。");
    }
    const { currencyName } = await getGuildSettings(interaction.guildId);
    if (subcommand === "customers") {
      const target = interaction.options.getUser("user");
      const page = interaction.options.getInteger("page") ?? 1;
      const period = kpBusinessDay(latestKpBusinessDate());
      const orders = await listPaidKpTicketOrders(interaction.guildId, undefined, period);
      await interaction.editReply(kpCustomers(orders, currencyName, target?.id, page, period));
      return;
    }
    if (subcommand === "ticket-sales") {
      await showKpSales(interaction, kpBusinessDay());
      return;
    }
    if (subcommand === "nagi-transfers") {
      const transfers = await listTransfersToRecipient(interaction.guildId, KP_TRANSFER_RECIPIENT_ID);
      await interaction.editReply(kpTransferHistory(transfers, currencyName, KP_TRANSFER_RECIPIENT_ID));
      return;
    }
    if (subcommand === "ticket-prices") {
      const vip = interaction.options.getInteger("vip"), extension = interaction.options.getInteger("extension");
      const unset = interaction.options.getString("unset");
      if (vip !== null || extension !== null || unset) throw new KpTicketError("料金は固定です。VIP（お客様2人）は10万、VIP（お客様1人）は20万、通常利用の延長は5万です。旧料金設定は適用しません。");
      await interaction.editReply(`VIP（お客様2人・キャスト1人）: ${KP_VIP_PRICES.shared.toLocaleString()}${currencyName}\nVIP（お客様1人・キャスト1人）: ${KP_VIP_PRICES.solo.toLocaleString()}${currencyName}\n延長1回: ${KP_EXTENSION_PRICE.toLocaleString()}${currencyName}（通常利用の追加注文のみ。VIP延長不可）`);
      return;
    }
    if (!interaction.channel || !(interaction.channel.type === ChannelType.GuildText || interaction.channel.isThread()) || !canPost(interaction)) {
      throw new KpTicketError("チケットのテキストチャンネル内で実行し、Botに閲覧・送信・埋め込み権限を付与してください。");
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
    await interaction.editReply("チケット用パネルを設置しました。ドリンクにはKPshopの通常商品（特殊効果・付与ロールなし）を使用します。指名キャストはこのチケットにのみ追加します。");
  } catch (error) {
    if (!(error instanceof KpTicketError)) logger.error("[kp-ticket] Admin command failed", error);
    await interaction.editReply(error instanceof KpTicketError ? error.message : "設定・設置に失敗しました。管理者はBotログを確認してください。");
  }
}

type TicketInteraction = ButtonInteraction | StringSelectMenuInteraction;

async function showKpSales(
  interaction: TicketInteraction | ModalSubmitInteraction | ChatInputCommandInteraction,
  period: KpBusinessDay,
) {
  const orders = await listPaidKpTicketOrders(interaction.guildId!, undefined, { start: period.start, end: period.end });
  const { currencyName } = await getGuildSettings(interaction.guildId!);
  const statement = kpTicketStatement(orders, currencyName, true, period);
  const castSales = kpCastSales(orders, currencyName, period);
  const embeds = [...statement.embeds, ...castSales.embeds];
  // Discord's 6,000-character limit applies to all embeds in the message together.
  for (const embed of embeds) {
    const description = embed.data.description;
    if (description && description.length > 1500) {
      embed.setDescription(description.slice(0, 1500) + "\n\n続きは添付ファイルをご確認ください。");
    }
  }
  await interaction.editReply({
    embeds,
    files: [...statement.files, ...castSales.files],
    allowedMentions: statement.allowedMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${KP_TICKET_PREFIX}sales-date:${interaction.user.id}`)
        .setLabel("営業日を指定").setStyle(ButtonStyle.Secondary),
    )],
  });
}

/** Date entry contains no sales data; every submitted query rechecks current staff permissions. */
export async function handleKpTicketSalesDate(interaction: ButtonInteraction | ModalSubmitInteraction) {
  const [action, owner] = interaction.customId.slice(KP_TICKET_PREFIX.length).split(":");
  if (!interaction.guildId || !interaction.guild || owner !== interaction.user.id) {
    await interaction.reply({ content: "この集計操作は使用できません。/shop ticket-sales を実行してください。", ephemeral: true });
    return;
  }
  if (action === "sales-date" && interaction.isButton()) {
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`${KP_TICKET_PREFIX}sales-modal:${interaction.user.id}`).setTitle("営業日別の全チケット売上")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("business-date").setLabel("営業開始日（日本時間・YYYY-MM-DD）")
          .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(10).setMaxLength(10)
          .setValue(latestKpBusinessDate()),
      )));
    return;
  }
  if (action !== "sales-modal" || !interaction.isModalSubmit()) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    await requireKpStaff(interaction);
    await showKpSales(interaction, kpBusinessDay(interaction.fields.getTextInputValue("business-date").trim()));
  } catch (error) {
    if (!(error instanceof KpTicketError)) logger.error("[kp-ticket] Sales date query failed", error);
    await interaction.editReply({ content: error instanceof KpTicketError ? error.message : "売上集計に失敗しました。時間をおいて再実行してください。", components: [] });
  }
}

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
      await interaction.editReply({ content, embeds: [], components: [
        ticketMenu(session, "vip", "VIPの利用方法を選択（VIPは延長不可）", [
          { label: "通常利用（VIPなし）", value: "none" },
          { label: "VIP：お客様2人・キャスト1人 — 100,000＄", value: "shared", description: "購入者が10万＄を支払います。同伴者の指定はありません。" },
          { label: "VIP：お客様1人・キャスト1人 — 200,000＄", value: "solo" },
        ]), ticketControls(session),
      ] });
      break;
    case "guest":
      throw new KpTicketError("同伴者の選択はなくなりました。「最初から選び直す」で注文を再開してください。引き落としはしていません。");
    case "extension":
      await interaction.editReply({ content, embeds: [], components: [
        ticketMenu(session, "extension", "通常利用の延長を追加しますか？", [
          { label: "延長しない", value: "no" }, { label: "延長1回 — 50,000＄", value: "yes" },
        ]), ticketControls(session),
      ] });
      break;
    case "drink": {
      const items = (await listShopItems(session.guildId, KP_SHOP_CATEGORY)).filter(isKpDrink);
      if (!items.length && !session.selection.vip && !session.selection.extension) throw new KpTicketError("KPshopの通常ドリンク商品が未登録です。管理者が /shop add で登録してください。");
      const components = items.length ? pagedTicketMenu(session, "drink", "ドリンクを選択", items.map(item => ({
        label: item.name, value: String(item.id), description: `${item.price.toLocaleString()}${currencyName}`,
      })), page) : [ticketControls(session)];
      if (session.selection.vip || session.selection.extension) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ticketId("extras-only", session)).setLabel("ドリンクなしで確認へ").setStyle(ButtonStyle.Primary),
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
      + (logged ? "購入ログをこのチケット内に記録しました。" : "購入ログの投稿に失敗しました。権限を確認後、下の「ログを再送」から再送できます。再決済はしません。")
      + (session.selection.vip && session.selection.serviceVersion === 2
        ? `\nVIP転送元 <#${KP_VIP_HUB_ID}> に入室すると専用VCへ転送します。初期は非公開です。購入者がVC内パネルで公開・非公開・名前を変更できます。VIPは延長不可です。` : ""),
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
  if (encoded === "all-statement" || encoded === "nagi-transfers") {
    await interaction.reply({
      content: encoded === "all-statement"
        ? "全チケット売上は /shop ticket-sales から確認できます。"
        : "凪への送金履歴は /shop nagi-transfers から確認できます。",
      ephemeral: true,
    });
    return;
  }
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
      await requireKpStaff(interaction);
      const orders = await listPaidKpTicketOrders(interaction.guildId, interaction.channelId);
      const { currencyName } = await getGuildSettings(interaction.guildId);
      await interaction.editReply(kpTicketStatement(orders, currencyName));
      return;
    }
    if (starting) {
      if (!interaction.channel || !(interaction.channel.type === ChannelType.GuildText || interaction.channel.isThread())) {
        throw new KpTicketError("チケットのテキストチャンネル内のパネルから注文してください。");
      }
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
      await renderKpTicket(interaction, await advanceKpTicketSession(session, fixedCastId ? (session.selection.vipActive ? "drink" : "vip") : "cast",
        fixedCastId ? { castId: fixedCastId, fixedCastId, vip: false, extension: false, serviceVersion: 2,
          baseOrderId: session.selection.baseOrderId, vipActive: session.selection.vipActive } : { serviceVersion: 2 }));
      return;
    }
    if ((action === "cast-page" && session.phase === "cast") || (action === "drink-page" && session.phase === "drink")) {
      await renderKpTicket(interaction, session, page);
      return;
    }
    const settings = await currentSettings(session.guildId);
    if ((session.selection.vip || session.selection.extension) && session.selection.serviceVersion !== 2) {
      throw new KpTicketError("以前のVIP・延長の受付は終了しました。「最初から選び直す」で新料金を選び直してください。");
    }
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
      if (session.selection.vip) {
        await validateKpVipSource(interaction.guild);
      }
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
        selection.vip = false;
        selection.extension = false;
        selection.serviceVersion = 2;
        next = "vip";
        break;
      case "vip":
        if (selection.vipActive) throw new KpTicketError("VIP利用者はVIPの重複購入・延長を行えません。");
        if (!["none", "shared", "solo"].includes(value ?? "")) throw new KpTicketError("VIPの種類を選択してください。");
        selection.serviceVersion = 2;
        selection.vip = value !== "none";
        selection.vipTier = value === "shared" || value === "solo" ? value : undefined;
        selection.guestId = undefined;
        selection.extension = false;
        next = value === "none" && selection.fixedCastId ? "extension" : "drink";
        break;
      case "guest":
        throw new KpTicketError("同伴者の選択はなくなりました。「最初から選び直す」で注文を再開してください。");
      case "extension":
        if (!selection.fixedCastId || !selection.baseOrderId || selection.vip || selection.vipActive) throw new KpTicketError("延長は通常利用の追加注文のみです。VIPは延長できません。");
        if (value !== "yes" && value !== "no") throw new KpTicketError("延長の有無を選択してください。");
        selection.extension = value === "yes"; next = "drink";
        break;
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
