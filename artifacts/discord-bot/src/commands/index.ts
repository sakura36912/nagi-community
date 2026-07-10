import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { ShopItem } from "@workspace/db";
import {
  DEFAULT_DAILY_AMOUNT,
  addShopItem,
  buyItem,
  claimDaily,
  createOrUpdateCurrency,
  getGuildSettings,
  getLeaderboard,
  getOrCreateWallet,
  giveCurrency,
  listInventory,
  listShopItems,
  removeShopItem,
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
// Discord caps action rows at 5, each holding up to 5 buttons.
const MAX_SHOP_BUY_BUTTONS = 25;

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
    const [wallet, settings] = await Promise.all([
      getOrCreateWallet(guildId, target.id),
      getGuildSettings(guildId),
    ]);
    await interaction.reply(
      `${target.id === interaction.user.id ? "あなた" : `<@${target.id}>`}の残高: **${wallet.balance}${settings.currencyName}**`,
    );
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

const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("サーバー内の資産ランキングを表示します"),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const [wallets, settings] = await Promise.all([
      getLeaderboard(guildId, 10),
      getGuildSettings(guildId),
    ]);

    if (wallets.length === 0) {
      await interaction.reply("まだランキングデータがありません。");
      return;
    }

    const lines = wallets.map(
      (w, i) => `**${i + 1}位** <@${w.userId}> — ${w.balance}${settings.currencyName}`,
    );

    await interaction.reply({
      content: `## 🏆 ランキング\n${lines.join("\n")}`,
      allowedMentions: { parse: [] },
    });
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
        .addStringOption((opt) => opt.setName("description").setDescription("説明").setRequired(false)),
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
      const [item, settings] = await Promise.all([
        addShopItem(guildId, name, price, description),
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

export const commands: Command[] = [
  currencyCommand,
  balanceCommand,
  dailyCommand,
  payCommand,
  giveCommand,
  leaderboardCommand,
  shopCommand,
];
