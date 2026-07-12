import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ShopItem } from "@workspace/db";
import type { Guild, GuildMember } from "discord.js";
import { logger } from "../lib/logger";
import {
  DEFAULT_DAILY_AMOUNT,
  NICKNAME_CHANGE_EFFECT,
  addShopItem,
  buyItem,
  claimDaily,
  createOrUpdateCurrency,
  getGuildSettings,
  getLeaderboard,
  getOrCreateWallet,
  getShopItem,
  giveCurrency,
  listInventory,
  listRoleRewards,
  listShopItems,
  refundPurchase,
  removeRoleReward,
  removeShopItem,
  setRewardDayOfMonth,
  setRewardInterval,
  setRoleReward,
  transfer,
} from "../lib/economy";

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new Error("このコマンドはサーバー内でのみ使用できます。");
  }
  return interaction.guildId;
}

function requireManageGuild(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.memberPermissions?.has("ManageGuild")) {
    return false;
  }
  return true;
}

function formatMs(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}時間${minutes}分`;
}

export const SHOP_BUY_PREFIX = "shop:buy:";
export const NICKNAME_MODAL_PREFIX = "shop:nickname-modal:";
const NICKNAME_MODAL_INPUT_ID = "nickname";
// Discord caps action rows at 5, each holding up to 5 buttons.
const MAX_SHOP_BUY_BUTTONS = 25;

function buildNicknameModal(itemId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${NICKNAME_MODAL_PREFIX}${itemId}`)
    .setTitle("新しいニックネーム")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NICKNAME_MODAL_INPUT_ID)
          .setLabel("新しいニックネーム")
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(32)
          .setRequired(true),
      ),
    );
}

// Checks whether the bot can actually set this member's nickname before we
// charge anything for it: needs Manage Nicknames, and (per Discord's rules)
// the bot's highest role must outrank the target's highest role, and the
// target must not be the guild owner.
function canSetNickname(guild: Guild, member: GuildMember): boolean {
  const me = guild.members.me;
  if (!me) {
    return false;
  }
  if (!me.permissions.has("ManageNicknames")) {
    return false;
  }
  if (member.id === guild.ownerId) {
    return false;
  }
  return me.roles.highest.position > member.roles.highest.position;
}

async function purchaseAndApplyEffect(
  guildId: string,
  member: GuildMember,
  itemId: number,
  currencyName: string,
  nickname: string,
): Promise<{ ok: true; item: ShopItem } | { ok: false; reason: string }> {
  if (!canSetNickname(member.guild, member)) {
    return {
      ok: false,
      reason: "Botにニックネームを変更する権限がありません(Manage Nicknames権限、またはロールの順序を確認してください)。",
    };
  }

  const result = await buyItem(guildId, member.id, itemId, currencyName);
  if (!result.ok) {
    return result;
  }

  try {
    await member.setNickname(nickname);
  } catch (err) {
    // The effect failed after we already charged — undo the purchase so the
    // user isn't billed for something that didn't happen.
    try {
      await refundPurchase(guildId, member.id, result.item);
    } catch (refundErr) {
      logger.error(
        `Failed to refund ${member.id} for item #${result.item.id} after nickname change failure — user may be charged without effect`,
        refundErr,
      );
      return {
        ok: false,
        reason: "ニックネームの変更と返金の両方に失敗しました。管理者にご連絡ください。",
      };
    }
    return {
      ok: false,
      reason: "ニックネームの変更に失敗したため、購入を取り消し、返金しました。",
    };
  }

  return result;
}

function buildShopPanel(items: ShopItem[], currencyName: string) {
  const embed = new EmbedBuilder()
    .setTitle("🛒 ショップ")
    .setColor(0xf5a623);

  if (items.length === 0) {
    embed.setDescription("ショップにアイテムはまだありません。");
    return { embeds: [embed], components: [] };
  }

  embed.setDescription(
    items
      .map((i) => `**#${i.id} ${i.name}** — ${i.price}${currencyName}${i.description ? `\n${i.description}` : ""}`)
      .join("\n\n"),
  );

  const buyable = items.slice(0, MAX_SHOP_BUY_BUTTONS);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buyable.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      buyable.slice(i, i + 5).map((item) =>
        new ButtonBuilder()
          .setCustomId(`${SHOP_BUY_PREFIX}${item.id}`)
          .setLabel(`購入: ${item.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      ),
    );
    rows.push(row);
  }

  return { embeds: [embed], components: rows };
}

export async function handleShopBuyButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "このボタンはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const itemId = Number(interaction.customId.slice(SHOP_BUY_PREFIX.length));
  if (!Number.isInteger(itemId)) {
    await interaction.reply({ content: "不正なボタンです。", ephemeral: true });
    return;
  }

  const item = await getShopItem(interaction.guildId, itemId);
  if (!item) {
    await interaction.reply({ content: "そのアイテムは見つかりませんでした。", ephemeral: true });
    return;
  }

  // Nickname-change items need text input, so show a modal as the initial
  // response instead of deferring/buying immediately.
  if (item.effectType === NICKNAME_CHANGE_EFFECT) {
    await interaction.showModal(buildNicknameModal(item.id));
    return;
  }

  // Defer immediately so DB latency can't blow past Discord's initial
  // response window and fail the interaction.
  await interaction.deferReply({ ephemeral: true });

  const settings = await getGuildSettings(interaction.guildId);
  const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);

  if (result.ok) {
    await interaction.editReply(`**${result.item.name}**を購入しました!`);
  } else {
    await interaction.editReply(result.reason);
  }
}

export async function handleNicknameModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.member || !("setNickname" in interaction.member)) {
    await interaction.reply({ content: "このフォームはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const itemId = Number(interaction.customId.slice(NICKNAME_MODAL_PREFIX.length));
  const nickname = interaction.fields.getTextInputValue(NICKNAME_MODAL_INPUT_ID).trim();

  if (!Number.isInteger(itemId) || nickname.length === 0) {
    await interaction.reply({ content: "不正な入力です。", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member;
  const settings = await getGuildSettings(interaction.guildId);
  const result = await purchaseAndApplyEffect(
    interaction.guildId,
    member,
    itemId,
    settings.currencyName,
    nickname,
  );

  if (result.ok) {
    await interaction.editReply(`**${result.item.name}**を購入し、ニックネームを「${nickname}」に変更しました!`);
  } else {
    await interaction.editReply(result.reason);
  }
}

const currencyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("currency")
    .setDescription("このサーバー専用の通貨を設定します")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("通貨を作成・設定します(管理者用)")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("通貨の名前(例: コイン)").setRequired(true).setMaxLength(20),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("daily_amount")
            .setDescription(`/daily で受け取れる額(デフォルト: ${DEFAULT_DAILY_AMOUNT})`)
            .setRequired(false)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName("info").setDescription("現在の通貨設定を表示します")),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === "create") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const name = interaction.options.getString("name", true).trim();
      if (name.length === 0) {
        await interaction.reply({ content: "通貨名を入力してください。", ephemeral: true });
        return;
      }
      const dailyAmount = interaction.options.getInteger("daily_amount") ?? undefined;
      const settings = await createOrUpdateCurrency(guildId, name, dailyAmount);
      await interaction.reply(
        `このサーバーの通貨を **${settings.currencyName}** に設定しました。\`/daily\` で1日あたり **${settings.dailyAmount}${settings.currencyName}** 受け取れます。`,
      );
      return;
    }

    if (sub === "info") {
      const settings = await getGuildSettings(guildId);
      await interaction.reply(
        `現在の通貨: **${settings.currencyName}**\nデイリーボーナス: **${settings.dailyAmount}${settings.currencyName}**`,
      );
      return;
    }
  },
};

const balanceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("balance")
    .setDescription("自分または指定したユーザーの残高を表示します")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("確認したいユーザー").setRequired(false),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const target = interaction.options.getUser("user") ?? interaction.user;

    if (target.id !== interaction.user.id && !requireManageGuild(interaction)) {
      await interaction.reply({ content: "他のユーザーの残高を確認できるのは管理者のみです。", ephemeral: true });
      return;
    }

    const [wallet, settings] = await Promise.all([
      getOrCreateWallet(guildId, target.id),
      getGuildSettings(guildId),
    ]);
    await interaction.reply({
      content: `${target.id === interaction.user.id ? "あなた" : `<@${target.id}>`}の残高: **${wallet.balance}${settings.currencyName}**`,
      ephemeral: true,
    });
  },
};

const dailyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("毎日受け取れる通貨を受け取ります"),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const settings = await getGuildSettings(guildId);
    const result = await claimDaily(guildId, interaction.user.id, settings.dailyAmount);
    if (result.ok) {
      await interaction.reply(
        `${settings.dailyAmount}${settings.currencyName}を受け取りました!現在の残高: **${result.balance}${settings.currencyName}**`,
      );
    } else {
      await interaction.reply({
        content: `まだ受け取れません。次回まであと ${formatMs(result.msRemaining)} です。`,
        ephemeral: true,
      });
    }
  },
};

const payCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("pay")
    .setDescription("他のユーザーに送金します")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("送金先のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("送金額").setRequired(true).setMinValue(1),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);

    if (target.bot) {
      await interaction.reply({ content: "Botには送金できません。", ephemeral: true });
      return;
    }

    const settings = await getGuildSettings(guildId);
    const result = await transfer(guildId, interaction.user.id, target.id, amount, settings.currencyName);
    if (result.ok) {
      await interaction.reply(`<@${target.id}>に**${amount}${settings.currencyName}**送金しました。`);
    } else {
      await interaction.reply({ content: result.reason, ephemeral: true });
    }
  },
};

const giveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("give")
    .setDescription("ユーザーに通貨を付与します(管理者用)")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("付与先のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("付与額(マイナスで没収)").setRequired(true),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);

    if (!requireManageGuild(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);

    if (target.bot) {
      await interaction.reply({ content: "Botには付与できません。", ephemeral: true });
      return;
    }

    const settings = await getGuildSettings(guildId);
    const result = await giveCurrency(guildId, target.id, amount, settings.currencyName);
    if (result.ok) {
      const verb = amount >= 0 ? "付与" : "没収";
      await interaction.reply(
        `<@${target.id}>から${verb}: ${Math.abs(amount)}${settings.currencyName}。現在の残高: **${result.balance}${settings.currencyName}**`,
      );
    } else {
      await interaction.reply({ content: result.reason, ephemeral: true });
    }
  },
};

const DISCORD_MESSAGE_LIMIT = 2000;

const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("サーバー内の資産ランキングを表示します")
    .addBooleanOption((opt) =>
      opt.setName("all").setDescription("全員分の所持通貨を表示します(管理者用)").setRequired(false),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const showAll = interaction.options.getBoolean("all") ?? false;

    if (showAll && !requireManageGuild(interaction)) {
      await interaction.reply({ content: "このオプションはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const [wallets, settings] = await Promise.all([
      getLeaderboard(guildId, showAll ? undefined : 10),
      getGuildSettings(guildId),
    ]);

    if (wallets.length === 0) {
      await interaction.reply("まだランキングデータがありません。");
      return;
    }

    const lines = wallets.map(
      (w, i) => `**${i + 1}位** <@${w.userId}> — ${w.balance}${settings.currencyName}`,
    );

    const header = showAll ? `## 💰 全員の所持通貨(${wallets.length}人)` : "## 🏆 ランキング";
    const chunks: string[] = [];
    let current = header;
    for (const line of lines) {
      if (current.length + line.length + 1 > DISCORD_MESSAGE_LIMIT) {
        chunks.push(current);
        current = line;
      } else {
        current += `\n${line}`;
      }
    }
    chunks.push(current);

    await interaction.reply({ content: chunks[0], allowedMentions: { parse: [] }, ephemeral: showAll });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, allowedMentions: { parse: [] }, ephemeral: showAll });
    }
  },
};

const shopCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("shop")
    .setDescription("ショップを操作します")
    .addSubcommand((sub) => sub.setName("list").setDescription("購入可能なアイテム一覧を表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("buy")
        .setDescription("アイテムを購入します")
        .addIntegerOption((opt) =>
          opt.setName("item_id").setDescription("アイテムID(/shop list で確認)").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("inventory").setDescription("自分の所持アイテムを表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("ショップにアイテムを追加します(管理者用)")
        .addStringOption((opt) => opt.setName("name").setDescription("アイテム名").setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName("price").setDescription("価格").setRequired(true).setMinValue(1),
        )
        .addStringOption((opt) => opt.setName("description").setDescription("説明").setRequired(false))
        .addStringOption((opt) =>
          opt
            .setName("effect")
            .setDescription("購入時の特殊効果")
            .setRequired(false)
            .addChoices({ name: "ニックネーム変更権", value: NICKNAME_CHANGE_EFFECT }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("ショップからアイテムを削除します(管理者用)")
        .addIntegerOption((opt) =>
          opt.setName("item_id").setDescription("アイテムID").setRequired(true),
        ),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      const [items, settings] = await Promise.all([listShopItems(guildId), getGuildSettings(guildId)]);
      const panel = buildShopPanel(items, settings.currencyName);
      await interaction.reply(panel);
      return;
    }

    if (sub === "buy") {
      const itemId = interaction.options.getInteger("item_id", true);
      const item = await getShopItem(guildId, itemId);
      if (!item) {
        await interaction.reply({ content: "そのアイテムは見つかりませんでした。", ephemeral: true });
        return;
      }

      if (item.effectType === NICKNAME_CHANGE_EFFECT) {
        await interaction.showModal(buildNicknameModal(item.id));
        return;
      }

      const settings = await getGuildSettings(guildId);
      const result = await buyItem(guildId, interaction.user.id, itemId, settings.currencyName);
      if (result.ok) {
        await interaction.reply(`**${result.item.name}**を購入しました!`);
      } else {
        await interaction.reply({ content: result.reason, ephemeral: true });
      }
      return;
    }

    if (sub === "inventory") {
      const items = await listInventory(guildId, interaction.user.id);
      if (items.length === 0) {
        await interaction.reply({ content: "所持アイテムはありません。", ephemeral: true });
        return;
      }
      const lines = items.map((row) => `**${row.item.name}** x${row.quantity}`);
      await interaction.reply({ content: `## 🎒 所持アイテム\n${lines.join("\n")}`, ephemeral: true });
      return;
    }

    if (sub === "add") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const name = interaction.options.getString("name", true);
      const price = interaction.options.getInteger("price", true);
      const description = interaction.options.getString("description");
      const effect = interaction.options.getString("effect");
      const [item, settings] = await Promise.all([
        addShopItem(guildId, name, price, description, effect),
        getGuildSettings(guildId),
      ]);
      await interaction.reply(`アイテム **#${item.id} ${item.name}**(${item.price}${settings.currencyName})をショップに追加しました。`);
      return;
    }

    if (sub === "remove") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const itemId = interaction.options.getInteger("item_id", true);
      const removed = await removeShopItem(guildId, itemId);
      await interaction.reply(
        removed ? `アイテム#${itemId}を削除しました。` : "そのアイテムは見つかりませんでした。",
      );
      return;
    }
  },
};

const rewardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("reward")
    .setDescription("ロールごとの自動報酬を設定します(管理者用)")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("ロールに自動報酬を設定します")
        .addRoleOption((opt) => opt.setName("role").setDescription("対象ロール").setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("配布間隔ごとの付与額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("ロールの自動報酬を解除します")
        .addRoleOption((opt) => opt.setName("role").setDescription("対象ロール").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("設定済みの自動報酬一覧を表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("interval")
        .setDescription("自動報酬の配布間隔を設定します(分指定)")
        .addIntegerOption((opt) =>
          opt.setName("minutes").setDescription("配布間隔(分)").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("day")
        .setDescription("毎月の給料日を設定します(例: 25 = 毎月25日)")
        .addIntegerOption((opt) =>
          opt
            .setName("day")
            .setDescription("給料日(1〜31)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31),
        ),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);

    if (!requireManageGuild(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "remove") {
      const role = interaction.options.getRole("role", true);
      const removed = await removeRoleReward(guildId, role.id);
      await interaction.reply(
        removed ? `<@&${role.id}> の自動報酬を解除しました。` : "そのロールには自動報酬が設定されていません。",
      );
      return;
    }

    if (sub === "list") {
      const [rewards, settings] = await Promise.all([listRoleRewards(guildId), getGuildSettings(guildId)]);
      if (rewards.length === 0) {
        await interaction.reply("自動報酬は設定されていません。");
        return;
      }
      const lines = rewards.map((r) => `<@&${r.roleId}> — ${r.amount}${settings.currencyName}`);
      const scheduleLabel = settings.rewardDayOfMonth
        ? `毎月${settings.rewardDayOfMonth}日`
        : `${settings.rewardIntervalMinutes}分ごと`;
      await interaction.reply({
        content: `## ⏱️ 自動報酬設定(${scheduleLabel})\n${lines.join("\n")}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === "set") {
      // Re-fetch settings after upsert to reflect the current schedule label.
      const role = interaction.options.getRole("role", true);
      const amount = interaction.options.getInteger("amount", true);
      const [reward, settings] = await Promise.all([
        setRoleReward(guildId, role.id, amount),
        getGuildSettings(guildId),
      ]);
      const scheduleLabel = settings.rewardDayOfMonth
        ? `毎月${settings.rewardDayOfMonth}日`
        : `${settings.rewardIntervalMinutes}分ごと`;
      await interaction.reply(
        `<@&${reward.roleId}> の自動報酬を **${amount}${settings.currencyName}** に設定しました(配布: ${scheduleLabel})。`,
      );
      return;
    }

    if (sub === "interval") {
      const minutes = interaction.options.getInteger("minutes", true);
      const settings = await setRewardInterval(guildId, minutes);
      await interaction.reply(`自動報酬の配布間隔を **${settings.rewardIntervalMinutes}分ごと** に設定しました。`);
      return;
    }

    if (sub === "day") {
      const day = interaction.options.getInteger("day", true);
      const settings = await setRewardDayOfMonth(guildId, day);
      await interaction.reply(`給料日を **毎月${settings.rewardDayOfMonth}日** に設定しました。`);
      return;
    }
  },
};

export const commands: Command[] = [
  currencyCommand,
  balanceCommand,
  dailyCommand,
  payCommand,
  giveCommand,
  leaderboardCommand,
  shopCommand,
  rewardCommand,
];
