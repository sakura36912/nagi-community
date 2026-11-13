import {
  AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  PROFILE_FIELD_LABELS, PROFILE_RANK_LABELS, configuredProfileRank,
  getProfileBackgroundImage, getProfileData, getProfileSettings, setProfileAppearance, setProfileBackgroundAsset, setProfileDisplayRole,
  setProfileField, setProfileRankRole, type ProfileField, type ProfileFrameStyle, type ProfileRankTier,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  clearProfileBackgroundCache, fetchProfileImage, getCachedProfileBackground, renderProfileCard,
} from "../lib/profileCardImage.js";

const fieldChoices = Object.entries(PROFILE_FIELD_LABELS)
  .map(([value, name]) => ({ name, value }));
const rankChoices = [
  { name: PROFILE_RANK_LABELS.regular, value: "regular" },
  { name: PROFILE_RANK_LABELS.vip, value: "vip" },
  { name: PROFILE_RANK_LABELS.vip_plus, value: "vip_plus" },
  { name: PROFILE_RANK_LABELS.special, value: "special" },
];
const frameChoices = [
  { name: "手配書", value: "wanted" },
  { name: "ゴールド", value: "gold" },
  { name: "ロイヤル", value: "royal" },
];
class ProfileCommandError extends Error {}

export const profileCommand = {
  data: new SlashCommandBuilder().setName("プロフィール").setDescription("海賊手配書風プロフィールカードを表示")
    .setDMPermission(false),
  async execute(i: ChatInputCommandInteraction) {
    await i.deferReply();
    try {
      if (!i.guild) throw new ProfileCommandError("サーバー内で使用してください。");
      const member = await i.guild.members.fetch({ user: i.user.id, force: true });
      const [settings, profile, savedBackground] = await Promise.all([
        getProfileSettings(i.guild.id),
        getProfileData(i.guild.id, i.user.id),
        getProfileBackgroundImage(i.guild.id),
      ]);
      const avatar = i.user.displayAvatarURL({ extension: "png", size: 256 });
      const rankTier = configuredProfileRank([...member.roles.cache.keys()], settings.rankRoles);
      const title = rankTier === "special" ? "👑 伝説の海賊カード"
        : rankTier === "vip_plus" ? "💎 VIP+ ゴールドカード"
          : rankTier === "vip" ? "💎 VIP ゴールドカード"
            : settings.frameStyle === "royal" ? "👑 海賊の王族カード"
              : settings.frameStyle === "gold" ? "💎 ゴールド海賊カード"
                : "🏴‍☠️ WANTED";
      const rankColor: Record<ProfileRankTier, number> = {
        regular: 0xc49a5a, vip: 0xe9b949, vip_plus: 0x5d9cec, special: 0xa779e9,
      };
      const embed = new EmbedBuilder()
        .setColor(settings.color ?? (rankTier ? rankColor[rankTier] : 0xc49a5a))
        .setAuthor({ name: i.user.username, iconURL: avatar })
        .setTitle(title)
        .setThumbnail(avatar)
        .setFooter({ text: "海賊プロフィールカード" });
      if (member.displayName !== i.user.username) {
        embed.setDescription(`サーバー表示名：${escapeMarkdown(member.displayName)}`);
      }
      if (settings.backgroundUrl) embed.setImage(settings.backgroundUrl);
      if (settings.visibleFields.bounty !== false) {
        embed.addFields({ name: "💰 懸賞金", value: profile.bounty === null
          ? "未設定" : `**${profile.bounty.toLocaleString("ja-JP")}${escapeMarkdown(profile.currencyName)}**`, inline: true });
      }
      if (settings.visibleFields.joinDate !== false) {
        embed.addFields({ name: "加入日", value: member.joinedAt
          ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>` : "取得できません", inline: true });
      }
      if (settings.visibleFields.kpRank !== false) {
        embed.addFields({ name: "🏝️ KP島会員ランク", value: rankTier ? PROFILE_RANK_LABELS[rankTier] : "未設定", inline: true });
      }
      if (settings.visibleFields.roles !== false) {
        const roles = settings.displayRoleIds
          .map(id => i.guild!.roles.cache.get(id))
          .filter((role): role is NonNullable<typeof role> => !!role && member.roles.cache.has(role.id))
          .map(role => escapeMarkdown(role.name));
        embed.addFields({ name: "🎭 ロール", value: roles.length ? roles.slice(0, 12).join("、") : "表示対象ロールなし", inline: true });
      }
      if (settings.visibleFields.battle !== false) {
        const weapon = profile.weapon;
        const weaponName = weapon
          ? ({ greatsword: "大剣", sword: "片手剣", spear: "槍", bow: "弓", dual: "双剣", staff: "杖" } as Record<string, string>)[weapon.weaponType] ?? "武器"
          : "未所持";
        embed.addFields({ name: "⚔️ 戦闘情報", value: [
          `武器：${weaponName}${weapon ? ` Lv${weapon.weaponLevel}` : ""}`,
          `ボス討伐参加：${profile.battle.defeats.toLocaleString("ja-JP")}回`,
          `最大ダメージ：${profile.battle.maxDamage.toLocaleString("ja-JP")}`,
        ].join("\n"), inline: false });
      }
      if (settings.visibleFields.pvp !== false) {
        embed.addFields({ name: "⚔️ PvP戦績", value: `${profile.pvp.wins}勝 / ${profile.pvp.losses}敗 / ${profile.pvp.draws}分`, inline: true });
      }
      if (settings.visibleFields.casino !== false) {
        const c = profile.casino;
        embed.addFields({ name: "🎰 カジノ（保存済み記録）", value: c.games
          ? `総BET：${c.totalBet.toLocaleString("ja-JP")}${escapeMarkdown(profile.currencyName)}\n総収支：${c.net >= 0 ? "+" : ""}${c.net.toLocaleString("ja-JP")}${escapeMarkdown(profile.currencyName)}\n勝利：${c.wins}回\n最大払戻：${c.maxPayout.toLocaleString("ja-JP")}${escapeMarkdown(profile.currencyName)}`
          : "保存済み記録なし", inline: false });
      }
      if (settings.visibleFields.inventory !== false) {
        embed.addFields({ name: "🎒 所持品", value: profile.petStock.length
          ? profile.petStock.map(item => escapeMarkdown(item)).join("\n")
          : "所持品なし", inline: false });
      }
      if (settings.visibleFields.pet !== false) {
        embed.addFields({ name: "🐾 ペット", value: profile.pet
          ? `${escapeMarkdown(profile.pet.name)} / Lv${profile.pet.level} / 親密度 ${profile.pet.bond}`
          : "所持ペットなし", inline: true });
      }
      const sections = (embed.toJSON().fields ?? []).map(field => ({
        title: field.name ?? "",
        lines: (field.value ?? "").split("\n"),
      }));
      let backgroundBuffer: Buffer | null = null;
      if (settings.backgroundUrl) {
        try {
          backgroundBuffer = await getCachedProfileBackground(settings.backgroundUrl);
        } catch (error) {
          logger.warn("[profile] 背景画像を読み込めませんでした。", error);
          throw new ProfileCommandError("背景画像を読み込めません。管理者は公開HTTPSのPNG/JPEG画像URLを確認してください。");
        }
      } else if (savedBackground) {
        backgroundBuffer = savedBackground.imageData;
      }
      let avatarBuffer: Buffer | null = null;
      try {
        avatarBuffer = await fetchProfileImage(avatar);
      } catch {
        // Keep the card usable when Discord's avatar CDN is temporarily unreachable.
      }
      let cardBuffer: Buffer;
      try {
        const bountyFieldVisible = settings.visibleFields.bounty !== false;
        cardBuffer = await renderProfileCard({
          displayName: member.displayName,
          username: i.user.username,
          avatarUrl: avatar,
          cardTitle: title,
          rankLabel: rankTier ? PROFILE_RANK_LABELS[rankTier] : null,
          bountyLabel: "懸賞金",
          bountyValue: bountyFieldVisible
            ? profile.bounty === null ? "未設定" : `${profile.bounty.toLocaleString("ja-JP")}${profile.currencyName}`
            : null,
          sections: sections.filter(section => !section.title.includes("懸賞金")),
          accentColor: settings.color ?? (rankTier ? rankColor[rankTier] : 0xc49a5a),
          backgroundBuffer,
          avatarBuffer,
        });
      } catch (error) {
        logger.error("[profile] 画像カードの生成に失敗しました。", error);
        throw new ProfileCommandError("カード画像を生成できません。サーバーの日本語フォント設定を確認してください。");
      }
      const filename = "profile-card.png";
      embed.setFields([])
        .setDescription("プロフィール情報は背景付きの画像カードに表示しています。")
        .setImage(`attachment://${filename}`);
      await i.editReply({
        embeds: [embed],
        files: [new AttachmentBuilder(cardBuffer, { name: filename })],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (error instanceof ProfileCommandError) {
        await i.editReply({ content: error.message, embeds: [] });
      } else {
        logger.error("[profile] プロフィールカードの生成に失敗しました。", error);
        await i.editReply({ content: "プロフィールを取得できませんでした。時間をおいて再度お試しください。", embeds: [] });
      }
    }
  },
};

export const profileSettingsCommand = {
  data: new SlashCommandBuilder().setName("プロフィール設定").setDescription("管理者：プロフィールカードの表示を設定")
    .setDMPermission(false)
    .addSubcommand(s => s.setName("項目").setDescription("カードの表示項目を切り替え")
      .addStringOption(o => o.setName("項目").setDescription("表示項目").setRequired(true).addChoices(...fieldChoices))
      .addBooleanOption(o => o.setName("表示").setDescription("表示するかどうか").setRequired(true)))
    .addSubcommand(s => s.setName("表示ロール追加").setDescription("カードに表示するロールを追加")
      .addRoleOption(o => o.setName("ロール").setDescription("表示対象ロール").setRequired(true)))
    .addSubcommand(s => s.setName("表示ロール削除").setDescription("カードに表示するロールを削除")
      .addRoleOption(o => o.setName("ロール").setDescription("削除するロール").setRequired(true)))
    .addSubcommand(s => s.setName("ランクロール").setDescription("KP島ランクに対応するロールを設定")
      .addRoleOption(o => o.setName("ロール").setDescription("ランクロール").setRequired(true))
      .addStringOption(o => o.setName("ランク").setDescription("カードに表示するランク").setRequired(true)
        .addChoices(...rankChoices)))
    .addSubcommand(s => s.setName("ランクロール解除").setDescription("KP島ランクのロール設定を解除")
      .addRoleOption(o => o.setName("ロール").setDescription("解除するロール").setRequired(true)))
    .addSubcommand(s => s.setName("色").setDescription("カードの色を設定（解除はdefault）")
      .addStringOption(o => o.setName("カラー").setDescription("#RRGGBB形式、またはdefault").setRequired(true).setMaxLength(7)))
     .addSubcommand(s => s.setName("画像").setDescription("カード背景画像を設定（URLまたは画像を添付、解除はoff）")
       .addStringOption(o => o.setName("url").setDescription("公開HTTPSのPNG/JPEG URL、またはoff").setRequired(false).setMaxLength(400))
       .addAttachmentOption(o => o.setName("ファイル").setDescription("PNG/JPEG画像（5MB以下）").setRequired(false)))
    .addSubcommand(s => s.setName("枠").setDescription("基本カードの枠テーマを設定")
      .addStringOption(o => o.setName("デザイン").setDescription("枠テーマ").setRequired(true)
        .addChoices(...frameChoices))),
  async execute(i: ChatInputCommandInteraction) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!i.guild) throw new ProfileCommandError("サーバー内で使用してください。");
      const member = await i.guild.members.fetch({ user: i.user.id, force: true });
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) throw new ProfileCommandError("管理者のみ設定できます。");
      const guildId = i.guild.id, sub = i.options.getSubcommand();
      if (sub === "項目") {
        await setProfileField(guildId, i.options.getString("項目", true) as ProfileField, i.options.getBoolean("表示", true));
      } else if (sub === "表示ロール追加" || sub === "表示ロール削除") {
        const role = i.options.getRole("ロール", true);
        await setProfileDisplayRole(guildId, role.id, sub === "表示ロール追加");
      } else if (sub === "ランクロール" || sub === "ランクロール解除") {
        const role = i.options.getRole("ロール", true);
        const tier = sub === "ランクロール" ? i.options.getString("ランク", true) as ProfileRankTier : null;
        await setProfileRankRole(guildId, role.id, tier);
      } else if (sub === "色") {
        const raw = i.options.getString("カラー", true).trim();
        if (raw.toLowerCase() === "default") await setProfileAppearance(guildId, { color: null });
        else {
          const match = /^#?([0-9a-fA-F]{6})$/.exec(raw);
          if (!match) throw new ProfileCommandError("色は #RRGGBB 形式で指定してください。");
          await setProfileAppearance(guildId, { color: Number.parseInt(match[1]!, 16) });
        }
      } else if (sub === "画像") {
        const raw = i.options.getString("url")?.trim() ?? "";
        const attachment = i.options.getAttachment("ファイル");
        if (attachment && raw) {
          throw new ProfileCommandError("画像URLと添付ファイルは同時に指定できません。どちらか一方を選んでください。");
        }
        if (attachment) {
          const contentType = attachment.contentType?.split(";")[0]?.trim().toLowerCase();
          if (contentType !== "image/png" && contentType !== "image/jpeg") {
            throw new ProfileCommandError("添付できる画像はPNGまたはJPEGです。");
          }
          if (attachment.size > 5 * 1024 * 1024) {
            throw new ProfileCommandError("画像は5MB以下にしてください。");
          }
          let imageData: Buffer;
          try {
            imageData = await fetchProfileImage(attachment.url);
          } catch (error) {
            logger.warn("[profile] 添付された背景画像を読み込めませんでした。", error);
            throw new ProfileCommandError("添付画像を検証できません。PNG/JPEGの画像をもう一度添付してください。");
          }
          await setProfileBackgroundAsset(guildId, { kind: "upload", imageData, contentType });
        } else if (!raw) {
          throw new ProfileCommandError("公開HTTPSの画像URL、画像ファイル、またはoffを指定してください。");
        } else if (raw.toLowerCase() === "off") {
          await setProfileBackgroundAsset(guildId, { kind: "clear" });
        } else {
          let url: URL;
          try { url = new URL(raw); } catch { throw new ProfileCommandError("画像URLが正しくありません。"); }
          if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
            throw new ProfileCommandError("画像URLは公開HTTPSのURL（標準ポート）で指定してください。");
          }
          await setProfileBackgroundAsset(guildId, { kind: "url", url: url.toString() });
        }
        clearProfileBackgroundCache();
      } else if (sub === "枠") {
        const frame = i.options.getString("デザイン", true) as ProfileFrameStyle;
        await setProfileAppearance(guildId, { frameStyle: frame });
      } else throw new Error("未対応の設定です。");
      await i.editReply({ content: "プロフィールカードの設定を更新しました。" });
    } catch (error) {
      if (error instanceof ProfileCommandError) {
        await i.editReply({ content: error.message });
      } else {
        logger.error("[profile] プロフィール設定の保存に失敗しました。", error);
        await i.editReply({ content: "プロフィール設定に失敗しました。時間をおいて再度お試しください。" });
      }
    }
  },
};

export const profileCommands = [profileCommand, profileSettingsCommand];
