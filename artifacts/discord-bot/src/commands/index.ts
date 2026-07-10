import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  CURRENCY_NAME,
  DAILY_AMOUNT,
  addShopItem,
  buyItem,
  claimDaily,
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

function formatMs(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}時間${minutes}分`;
}

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
    const wallet = await getOrCreateWallet(guildId, target.id);
    await interaction.reply(
      `${target.id === interaction.user.id ? "あなた" : `<@${target.id}>`}の残高: **${wallet.balance}${CURRENCY_NAME}**`,
    );
  },
};

const dailyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription(`毎日${DAILY_AMOUNT}${CURRENCY_NAME}を受け取ります`),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const result = await claimDaily(guildId, interaction.user.id);
    if (result.ok) {
      await interaction.reply(
        `${DAILY_AMOUNT}${CURRENCY_NAME}を受け取りました!現在の残高: **${result.balance}${CURRENCY_NAME}**`,
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

    const result = await transfer(guildId, interaction.user.id, target.id, amount);
    if (result.ok) {
      await interaction.reply(`<@${target.id}>に**${amount}${CURRENCY_NAME}**送金しました。`);
    } else {
      await interaction.reply({ content: result.reason, ephemeral: true });
    }
  },
};

const giveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("give")
    .setDescription(`ユーザーに${CURRENCY_NAME}を付与します(管理者用)`)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("付与先のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("付与額(マイナスで没収)").setRequired(true),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);

    if (!interaction.memberPermissions?.has("ManageGuild")) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);

    if (target.bot) {
      await interaction.reply({ content: "Botには付与できません。", ephemeral: true });
      return;
    }

    const result = await giveCurrency(guildId, target.id, amount);
    if (result.ok) {
      const verb = amount >= 0 ? "付与" : "没収";
      await interaction.reply(
        `<@${target.id}>から${verb}: ${Math.abs(amount)}${CURRENCY_NAME}。現在の残高: **${result.balance}${CURRENCY_NAME}**`,
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
    const wallets = await getLeaderboard(guildId, 10);

    if (wallets.length === 0) {
      await interaction.reply("まだランキングデータがありません。");
      return;
    }

    const lines = wallets.map(
      (w, i) => `**${i + 1}位** <@${w.userId}> — ${w.balance}${CURRENCY_NAME}`,
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
      const items = await listShopItems(guildId);
      if (items.length === 0) {
        await interaction.reply("ショップにアイテムはまだありません。");
        return;
      }
      const lines = items.map(
        (i) => `**#${i.id} ${i.name}** — ${i.price}${CURRENCY_NAME}${i.description ? `\n  ${i.description}` : ""}`,
      );
      await interaction.reply(`## 🛒 ショップ\n${lines.join("\n")}`);
      return;
    }

    if (sub === "buy") {
      const itemId = interaction.options.getInteger("item_id", true);
      const result = await buyItem(guildId, interaction.user.id, itemId);
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
      if (!interaction.memberPermissions?.has("ManageGuild")) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const name = interaction.options.getString("name", true);
      const price = interaction.options.getInteger("price", true);
      const description = interaction.options.getString("description");
      const item = await addShopItem(guildId, name, price, description);
      await interaction.reply(`アイテム **#${item.id} ${item.name}**(${item.price}${CURRENCY_NAME})をショップに追加しました。`);
      return;
    }

    if (sub === "remove") {
      if (!interaction.memberPermissions?.has("ManageGuild")) {
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
  balanceCommand,
  dailyCommand,
  payCommand,
  giveCommand,
  leaderboardCommand,
  shopCommand,
];
