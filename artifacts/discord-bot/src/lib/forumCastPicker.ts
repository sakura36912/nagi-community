import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  type Guild, type GuildMember,
} from "discord.js";

export const FORUM_CAST_PAGE_PREFIX = "shop:forum-cast-page:";
const PAGE_SIZE = 25;

export function isEligibleForumCast(member: GuildMember | null, roleId: string | null | undefined): boolean {
  return !!roleId && !!member && !member.user.bot && member.roles.cache.has(roleId);
}

export async function fetchForumCastMembers(guild: Guild, roleId: string): Promise<GuildMember[]> {
  const role = await guild.roles.fetch(roleId);
  if (!role || role.id === guild.id) throw new Error("キャスト対象ロールが無効です。管理者にパネルの再設定を依頼してください。");
  // Use the fetched collection, not role.members: a partial cache can omit eligible members.
  const members = await guild.members.fetch({ withPresences: false });
  return [...members.values()].filter((member) => isEligibleForumCast(member, roleId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja") || a.id.localeCompare(b.id));
}

export function buildForumCastPicker(itemId: number, quantity: number, members: GuildMember[], page = 0) {
  if (!members.length) throw new Error("指定ロールを持つキャストがいません。購入は行っていません。");
  if (!Number.isInteger(page) || page < 0) throw new Error("不正なページ番号です。");
  const pages = Math.ceil(members.length / PAGE_SIZE);
  const current = Math.min(page, pages - 1);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`shop:forum-cast:${itemId}:${quantity}`)
    .setPlaceholder("指定するキャストを選択してください")
    .setMinValues(1).setMaxValues(1)
    .addOptions(members.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((member) => ({
      label: member.displayName.slice(0, 100),
      value: member.id,
      description: `@${member.user.username} ／ ID: ${member.id}`.slice(0, 100),
    })));
  const components: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
  if (pages > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${FORUM_CAST_PAGE_PREFIX}${itemId}:${quantity}:${Math.max(0, current - 1)}`)
        .setLabel("前のページ").setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
      new ButtonBuilder().setCustomId(`${FORUM_CAST_PAGE_PREFIX}${itemId}:${quantity}:${Math.min(pages - 1, current + 1)}`)
        .setLabel("次のページ").setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1),
    ));
  }
  return {
    content: `指定ロールのキャストを選択してください。（${members.length}人／${current + 1}/${pages}ページ）`,
    components,
    allowedMentions: { parse: [] as [] },
  };
}
