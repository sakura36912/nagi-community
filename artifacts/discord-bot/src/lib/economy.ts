import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  db,
  walletsTable,
  shopItemsTable,
  inventoryItemsTable,
  transactionsTable,
  guildSettingsTable,
  roleRewardsTable,
  privateVcSessionsTable,
  squadTreasuriesTable,
  squadTreasuryTxTable,
  communitySheetsTable,
  communitySheetSettingsTable,
  communityVcSessionsTable,
  shopLicenseConfigTable,
  groupShopSalesTable,
  memberJoinHistoryTable,
  type Wallet,
  type ShopItem,
  type GuildSettings,
  type RoleReward,
  type PrivateVcSession,
  type SquadTreasury,
  type SquadTreasuryTx,
  type CommunitySheet,
  type CommunitySheetSettings,
  type ShopLicenseConfig,
  type GroupShopSale,
} from "@workspace/db";

export const DEFAULT_CURRENCY_NAME = "円";
export const DEFAULT_DAILY_AMOUNT = 500;
export const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Shop item effect types recognized by the bot.
export const NICKNAME_CHANGE_EFFECT = "nickname_change";
export const PRIVATE_VC_EFFECT = "private_vc"; // permanent (no expiry)
export const VC_RENAME_EFFECT  = "vc_rename";  // rename existing private VC, no duration
export const PRIVATE_VC_1D_EFFECT = "private_vc_1d";
export const PRIVATE_VC_1W_EFFECT = "private_vc_1w";
export const PRIVATE_VC_1M_EFFECT = "private_vc_1m";
export const EVAL_EXTEND_EFFECT    = "eval_extend_1w"; // +7 days
export const EVAL_EXTEND_2W_EFFECT = "eval_extend_2w"; // +14 days
export const EVAL_EXTEND_1M_EFFECT = "eval_extend_1m"; // +30 days
export const PERM_ROLE_EFFECT      = "perm_role";       // assign a role permanently
export const EVAL_RESURFACE_EFFECT = "eval_resurface";  // create new eval sheet after failure
export const SHOP_LICENSE_EFFECT   = "shop_license";    // assign squad-specific shop-license role
export const URA_EXTEND_1D_EFFECT  = "ura_extend_1d";   // extend existing ura VC by 1 day (no create)

// Duration in milliseconds for each timed VC effect type.
export const TIMED_VC_DURATIONS: Record<string, number> = {
  [PRIVATE_VC_1D_EFFECT]: 24 * 60 * 60 * 1000,
  [PRIVATE_VC_1W_EFFECT]: 7 * 24 * 60 * 60 * 1000,
  [PRIVATE_VC_1M_EFFECT]: 30 * 24 * 60 * 60 * 1000,
};

/** 裏フリールーム延長専用。既存セッションがある場合のみ延長（新規作成なし）。 */
export const URA_EXTEND_DURATIONS: Record<string, number> = {
  [URA_EXTEND_1D_EFFECT]: 24 * 60 * 60 * 1000,
};

/** Maps eval-extend effect type → number of days to add to endDate. */
export const EVAL_EXTEND_DAYS: Record<string, number> = {
  [EVAL_EXTEND_EFFECT]:    7,
  [EVAL_EXTEND_2W_EFFECT]: 14,
  [EVAL_EXTEND_1M_EFFECT]: 30,
};

// Inserts the default general shop items for a guild if it has none yet.
// Safe to call multiple times — uses a count guard so it never duplicates.
export async function seedDefaultShopItems(guildId: string): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.category, "general")));

  if (count > 0) return;

  await db.insert(shopItemsTable).values([
    {
      guildId,
      name: "名前変更券",
      description: "サーバー内のニックネームを自由に変更できます。",
      price: 1000,
      effectType: NICKNAME_CHANGE_EFFECT,
      category: "general",
    },
    {
      guildId,
      name: "期間延長券",
      description: "あなたの評価シートの期限を1週間延長します。",
      price: 3000,
      effectType: EVAL_EXTEND_EFFECT,
      category: "general",
    },
  ]);
}

// Inserts the default VC shop items (timed private VCs) for a guild.
// Safe to call multiple times — uses a count guard so it never duplicates.
export async function seedDefaultVcShopItems(guildId: string): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.category, "vc")));

  if (count > 0) return;

  await db.insert(shopItemsTable).values([
    {
      guildId,
      name: "非公開VC（1日）",
      description: "自分だけが見える専用VCを1日間作成します。期間終了後に自動削除されます。",
      price: 1000,
      effectType: PRIVATE_VC_1D_EFFECT,
      category: "vc",
    },
    {
      guildId,
      name: "非公開VC（1週間）",
      description: "自分だけが見える専用VCを1週間作成します。期間終了後に自動削除されます。",
      price: 5000,
      effectType: PRIVATE_VC_1W_EFFECT,
      category: "vc",
    },
    {
      guildId,
      name: "非公開VC（1ヶ月）",
      description: "自分だけが見える専用VCを1ヶ月間作成します。期間終了後に自動削除されます。",
      price: 15000,
      effectType: PRIVATE_VC_1M_EFFECT,
      category: "vc",
    },
  ]);
}

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const [existing] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId));

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(guildSettingsTable)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();

  if (created) {
    // Seed default shop items for brand-new guilds.
    await seedDefaultShopItems(guildId);
    await seedDefaultVcShopItems(guildId);
    await seedDefaultUraShopItems(guildId);
    return created;
  }

  const [settings] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId));

  if (!settings) {
    throw new Error("Failed to create or fetch guild settings");
  }

  return settings;
}

export async function setVcCategoryId(
  guildId: string,
  vcCategoryId: string | null,
): Promise<GuildSettings> {
  await getGuildSettings(guildId); // ensure row exists
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ vcCategoryId })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update vc_category_id");
  return settings;
}

export async function setUraCategoryId(
  guildId: string,
  uraCategoryId: string | null,
): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ uraCategoryId })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update ura_category_id");
  return settings;
}

export async function setUraChannelId(
  guildId: string,
  uraChannelId: string | null,
): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ uraChannelId })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update ura_channel_id");
  return settings;
}

export async function setReturnLogChannelId(
  guildId: string,
  returnLogChannelId: string | null,
): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ returnLogChannelId })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update return_log_channel_id");
  return settings;
}

// ─── 出戻り履歴 ──────────────────────────────────────────────────────────────

/** excluded = false の参加回数を返す（昇格通知での出戻り判定用）。 */
export async function countRealJoins(guildId: string, userId: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM member_join_history
        WHERE guild_id = ${guildId} AND user_id = ${userId} AND excluded = 'false'`,
  );
  return Number((result.rows[0] as { cnt: number }).cnt);
}

export async function setReturnLogExcludedRoleIds(
  guildId: string,
  roleIds: string[],
): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const value = roleIds.length > 0 ? roleIds.join(",") : null;
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ returnLogExcludedRoleIds: value })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update return_log_excluded_role_ids");
  return settings;
}

/**
 * メンバー参加を記録し、除外フラグなし記録の件数（実質的な出戻り回数）を返す。
 * previousJoinCount === 0 → 初回 or 除外ロールのみで来ていた
 * previousJoinCount >= 1 → 出戻り
 */
export async function recordMemberJoin(
  guildId: string,
  userId: string,
): Promise<{ joinId: number; previousJoinCount: number }> {
  const countResult = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM member_join_history
        WHERE guild_id = ${guildId} AND user_id = ${userId} AND excluded = 'false'`,
  );
  const previousJoinCount = Number((countResult.rows[0] as { cnt: number }).cnt);

  const [row] = await db
    .insert(memberJoinHistoryTable)
    .values({ guildId, userId })
    .returning();
  if (!row) throw new Error("Failed to insert member_join_history");

  return { joinId: row.id, previousJoinCount };
}

/**
 * 最も新しい未退出の参加レコードに left_at をセットする。
 * memberRoleIds が除外ロールのみ（あるいは全部除外）だった場合は excluded = 'true' にする。
 */
export async function recordMemberLeave(
  guildId: string,
  userId: string,
  memberRoleIds: string[],   // @everyone を除いたロールID一覧
  excludedRoleIds: string[], // 管理者が設定した除外ロールID一覧
): Promise<void> {
  // 除外ロール以外のロールを一つでも持っていれば「正規在籍」とみなす
  const hasQualifyingRole =
    excludedRoleIds.length === 0 ||
    memberRoleIds.some((id) => !excludedRoleIds.includes(id));
  const excludedFlag = hasQualifyingRole ? "false" : "true";

  await db.execute(
    sql`
      UPDATE member_join_history
      SET left_at  = now(),
          excluded = ${excludedFlag}
      WHERE id = (
        SELECT id FROM member_join_history
        WHERE guild_id = ${guildId}
          AND user_id  = ${userId}
          AND left_at IS NULL
        ORDER BY joined_at DESC
        LIMIT 1
      )
    `,
  );
}

export async function setPromotionLogSettings(
  guildId: string,
  promotionLogChannelId: string | null,
  promotionWatchRoleId: string | null,
): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ promotionLogChannelId, promotionWatchRoleId })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update promotion_log settings");
  return settings;
}

export async function setBanLogChannelId(
  guildId: string,
  banLogChannelId: string | null,
): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ banLogChannelId })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update ban_log_channel_id");
  return settings;
}

export async function createOrUpdateCurrency(
  guildId: string,
  currencyName: string,
  dailyAmount?: number,
): Promise<GuildSettings> {
  const [settings] = await db
    .insert(guildSettingsTable)
    .values({
      guildId,
      currencyName,
      ...(dailyAmount !== undefined ? { dailyAmount } : {}),
    })
    .onConflictDoUpdate({
      target: guildSettingsTable.guildId,
      set: {
        currencyName,
        ...(dailyAmount !== undefined ? { dailyAmount } : {}),
      },
    })
    .returning();

  if (!settings) {
    throw new Error("Failed to create or update guild currency settings");
  }

  return settings;
}

/** ウォレットを SELECT のみで返す。存在しなければ null（INSERT しない）。 */
export async function findWallet(
  guildId: string,
  userId: string,
): Promise<Wallet | null> {
  const [row] = await db
    .select()
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
  return row ?? null;
}

export async function getOrCreateWallet(
  guildId: string,
  userId: string,
): Promise<Wallet> {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(walletsTable)
    .values({ guildId, userId, balance: 0 })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  // Row was created concurrently by another interaction; fetch it.
  const [wallet] = await db
    .select()
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

  if (!wallet) {
    throw new Error("Failed to create or fetch wallet");
  }

  return wallet;
}

/**
 * 初期発行（初回限定）を付与する。
 * 既に受け取っている場合は { ok: false } を返す。
 */
export async function claimInitialIssue(
  guildId: string,
  userId: string,
  amount: number,
  currencyName: string,
): Promise<{ ok: true; newBalance: number } | { ok: false }> {
  const wallet = await getOrCreateWallet(guildId, userId);
  if (wallet.initialIssuedAt !== null && wallet.initialIssuedAt !== undefined) {
    return { ok: false };
  }

  const now = new Date();
  const [updated] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${amount}`,
      initialIssuedAt: now,
    })
    .where(
      and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`${walletsTable.initialIssuedAt} IS NULL`,
      ),
    )
    .returning();

  if (!updated) {
    // 競合：別リクエストが先に付与した
    return { ok: false };
  }

  await recordTransaction(guildId, userId, amount, "initial_issue");
  return { ok: true, newBalance: updated.balance };
}

export async function recordTransaction(
  guildId: string,
  userId: string,
  amount: number,
  reason: string,
  relatedUserId?: string,
): Promise<void> {
  await db.insert(transactionsTable).values({
    guildId,
    userId,
    amount,
    reason,
    relatedUserId: relatedUserId ?? null,
  });
}

export async function claimDaily(
  guildId: string,
  userId: string,
  dailyAmount: number,
): Promise<{ ok: true; balance: number } | { ok: false; msRemaining: number }> {
  await getOrCreateWallet(guildId, userId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - DAILY_COOLDOWN_MS);

  // Conditional update: only succeeds if the cooldown has actually elapsed,
  // checked atomically in the same statement to prevent concurrent double-claims.
  const [updated] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${dailyAmount}`,
      lastDailyAt: now,
    })
    .where(
      and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`(${walletsTable.lastDailyAt} IS NULL OR ${walletsTable.lastDailyAt} <= ${cutoff})`,
      ),
    )
    .returning();

  if (!updated) {
    const [wallet] = await db
      .select()
      .from(walletsTable)
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

    const elapsed = wallet?.lastDailyAt ? now.getTime() - wallet.lastDailyAt.getTime() : DAILY_COOLDOWN_MS;
    return { ok: false, msRemaining: Math.max(DAILY_COOLDOWN_MS - elapsed, 0) };
  }

  await recordTransaction(guildId, userId, dailyAmount, "daily");

  return { ok: true, balance: updated.balance };
}

export async function transfer(
  guildId: string,
  fromUserId: string,
  toUserId: string,
  amount: number,
  currencyName: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (amount <= 0) {
    return { ok: false, reason: "金額は1以上を指定してください。" };
  }
  if (fromUserId === toUserId) {
    return { ok: false, reason: "自分自身には送金できません。" };
  }

  await getOrCreateWallet(guildId, fromUserId);
  await getOrCreateWallet(guildId, toUserId);

  // Debit is conditional on sufficient balance, checked atomically in the
  // same statement so concurrent transfers can't overdraw the sender.
  const insufficientFunds = await db.transaction(async (tx) => {
    const [debited] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${amount}` })
      .where(
        and(
          eq(walletsTable.guildId, guildId),
          eq(walletsTable.userId, fromUserId),
          sql`${walletsTable.balance} >= ${amount}`,
        ),
      )
      .returning();

    if (!debited) {
      return true;
    }

    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${amount}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, toUserId)));

    return false;
  });

  if (insufficientFunds) {
    const sender = await getOrCreateWallet(guildId, fromUserId);
    return { ok: false, reason: `残高が不足しています(所持: ${sender.balance}${currencyName})。` };
  }

  await recordTransaction(guildId, fromUserId, -amount, "transfer", toUserId);
  await recordTransaction(guildId, toUserId, amount, "transfer", fromUserId);

  return { ok: true };
}

export async function giveCurrency(
  guildId: string,
  userId: string,
  amount: number,
  currencyName: string,
  reason = "admin-give",
): Promise<{ ok: true; balance: number } | { ok: false; reason: string }> {
  if (amount === 0) {
    return { ok: false, reason: "金額には0以外の値を指定してください。" };
  }

  await getOrCreateWallet(guildId, userId);

  // Conditional on non-negative resulting balance so an admin can't push a
  // user's balance below zero with a negative grant.
  const [updated] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(
      and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`${walletsTable.balance} + ${amount} >= 0`,
      ),
    )
    .returning();

  if (!updated) {
    const wallet = await getOrCreateWallet(guildId, userId);
    return { ok: false, reason: `残高が不足しています(所持: ${wallet.balance}${currencyName})。` };
  }

  await recordTransaction(guildId, userId, amount, reason);

  return { ok: true, balance: updated.balance };
}

export async function setRoleReward(
  guildId: string,
  roleId: string,
  amount: number,
): Promise<RoleReward> {
  const [reward] = await db
    .insert(roleRewardsTable)
    .values({ guildId, roleId, amount })
    .onConflictDoUpdate({
      target: [roleRewardsTable.guildId, roleRewardsTable.roleId],
      set: { amount },
    })
    .returning();

  if (!reward) {
    throw new Error("Failed to create or update role reward");
  }

  return reward;
}

export async function removeRoleReward(guildId: string, roleId: string): Promise<boolean> {
  const deleted = await db
    .delete(roleRewardsTable)
    .where(and(eq(roleRewardsTable.guildId, guildId), eq(roleRewardsTable.roleId, roleId)))
    .returning();

  return deleted.length > 0;
}

export async function listRoleRewards(guildId: string): Promise<RoleReward[]> {
  return db.select().from(roleRewardsTable).where(eq(roleRewardsTable.guildId, guildId));
}

export async function setRewardInterval(guildId: string, minutes: number): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ rewardIntervalMinutes: minutes, rewardDayOfMonth: null })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();

  if (!settings) {
    throw new Error("Failed to update reward interval");
  }

  return settings;
}

// Set a fixed calendar day (1–31) for monthly salary distribution.
// Clears the interval mode — the two are mutually exclusive.
export async function setRewardDayOfMonth(guildId: string, day: number): Promise<GuildSettings> {
  await getGuildSettings(guildId);
  const [settings] = await db
    .update(guildSettingsTable)
    .set({ rewardDayOfMonth: day })
    .where(eq(guildSettingsTable.guildId, guildId))
    .returning();

  if (!settings) {
    throw new Error("Failed to update reward day of month");
  }

  return settings;
}

// Returns true when calendar-day mode is active and today is the configured
// payout day AND we haven't already paid out this month.
export function isDueCalendarDay(settings: GuildSettings, now: Date): boolean {
  if (settings.rewardDayOfMonth === null || settings.rewardDayOfMonth === undefined) {
    return false;
  }

  const targetDay = settings.rewardDayOfMonth;
  const todayDay = now.getDate();
  if (todayDay !== targetDay) {
    return false;
  }

  const lastAt = settings.lastRewardAt;
  if (!lastAt) {
    return true;
  }

  // Already paid this calendar month?
  return lastAt.getFullYear() !== now.getFullYear() || lastAt.getMonth() !== now.getMonth();
}

export async function markRewardDistributed(guildId: string, at: Date): Promise<void> {
  await db
    .update(guildSettingsTable)
    .set({ lastRewardAt: at })
    .where(eq(guildSettingsTable.guildId, guildId));
}

// Sums each member's applicable role-reward amounts and pays them out.
// `members` maps userId -> the roleIds that member currently holds.
export async function distributeRoleRewards(
  guildId: string,
  currencyName: string,
  members: Map<string, string[]>,
): Promise<{ paidCount: number; totalPaid: number }> {
  const rewards = await listRoleRewards(guildId);
  if (rewards.length === 0) {
    return { paidCount: 0, totalPaid: 0 };
  }

  const amountByRoleId = new Map(rewards.map((r) => [r.roleId, r.amount]));

  let paidCount = 0;
  let totalPaid = 0;

  for (const [userId, roleIds] of members) {
    const amount = roleIds.reduce((sum, roleId) => sum + (amountByRoleId.get(roleId) ?? 0), 0);
    if (amount <= 0) {
      continue;
    }

    const result = await giveCurrency(guildId, userId, amount, currencyName, "auto-reward");
    if (result.ok) {
      paidCount += 1;
      totalPaid += amount;
    }
  }

  return { paidCount, totalPaid };
}

// Returns all user IDs that have a wallet in this guild (used by the reward
// scheduler to know who to check roles for — no privileged intent needed).
// Inserts the default ura (裏フリールーム) shop items for a guild.
// Safe to call multiple times — uses a count guard so it never duplicates.
export async function seedDefaultUraShopItems(guildId: string): Promise<void> {
  // effectType 単位で存在確認し、なければ挿入する（既存ギルドにも追加アイテムを自動追加）
  const defaults: Array<{ name: string; description: string; price: number; effectType: string }> = [
    {
      name: "裏フリールーム（1日）",
      description: "自分だけが見える専用VCを1日間作成します。期間終了後に自動削除されます。",
      price: 1000,
      effectType: PRIVATE_VC_1D_EFFECT,
    },
    {
      name: "裏フリールーム（1週間）",
      description: "自分だけが見える専用VCを1週間作成します。期間終了後に自動削除されます。",
      price: 5000,
      effectType: PRIVATE_VC_1W_EFFECT,
    },
    {
      name: "裏フリールーム（1ヶ月）",
      description: "自分だけが見える専用VCを1ヶ月間作成します。期間終了後に自動削除されます。",
      price: 15000,
      effectType: PRIVATE_VC_1M_EFFECT,
    },
    {
      name: "裏フリールーム延長（1日）",
      description: "既存の裏フリールームの期限を1日延長します。部屋がない場合は使用できません。",
      price: 800,
      effectType: URA_EXTEND_1D_EFFECT,
    },
    {
      name: "裏フリールーム名前変更",
      description: "自分の裏フリールームの名前を変更します。",
      price: 500,
      effectType: VC_RENAME_EFFECT,
    },
  ];

  const existing = await db
    .select({ effectType: shopItemsTable.effectType })
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.category, "ura")));
  const existingEffects = new Set(existing.map((r) => r.effectType));

  const toInsert = defaults.filter((d) => !existingEffects.has(d.effectType));
  if (toInsert.length === 0) return;

  await db.insert(shopItemsTable).values(
    toInsert.map((d) => ({ ...d, guildId, category: "ura" })),
  );
}

// ---------------------------------------------------------------------------
// Private VC session management (timed channels)
// ---------------------------------------------------------------------------

export async function createPrivateVcSession(
  guildId: string,
  userId: string,
  channelId: string,
  expiresAt: Date,
  category: string = "vc",
): Promise<PrivateVcSession> {
  const [session] = await db
    .insert(privateVcSessionsTable)
    .values({ guildId, userId, channelId, expiresAt, category })
    .returning();

  if (!session) throw new Error("Failed to create private VC session");
  return session;
}

// Returns the user's active (not-yet-expired) VC session, or null if none.
export async function getActivePrivateVcSession(
  guildId: string,
  userId: string,
  category?: string,
): Promise<PrivateVcSession | null> {
  const now = new Date();
  const [session] = await db
    .select()
    .from(privateVcSessionsTable)
    .where(
      and(
        eq(privateVcSessionsTable.guildId, guildId),
        eq(privateVcSessionsTable.userId, userId),
        gt(privateVcSessionsTable.expiresAt, now),
        category !== undefined
          ? eq(privateVcSessionsTable.category, category)
          : undefined,
      ),
    )
    .limit(1);
  return session ?? null;
}

// Extends the session's expiresAt by additionalMs (base = max(current expiresAt, now)).
export async function extendPrivateVcSession(
  id: number,
  additionalMs: number,
): Promise<PrivateVcSession> {
  // Use SQL so the calculation happens atomically in the DB.
  const [updated] = await db
    .update(privateVcSessionsTable)
    .set({
      expiresAt: sql`GREATEST(${privateVcSessionsTable.expiresAt}, NOW()) + (${additionalMs} * interval '1 millisecond')`,
    })
    .where(eq(privateVcSessionsTable.id, id))
    .returning();
  if (!updated) throw new Error("Failed to extend private VC session");
  return updated;
}

// Returns all sessions whose lease has expired (expiresAt <= now).
export async function getExpiredPrivateVcSessions(now: Date): Promise<PrivateVcSession[]> {
  return db
    .select()
    .from(privateVcSessionsTable)
    .where(lte(privateVcSessionsTable.expiresAt, now));
}

export async function deletePrivateVcSession(id: number): Promise<void> {
  await db.delete(privateVcSessionsTable).where(eq(privateVcSessionsTable.id, id));
}

export async function getGuildWalletUserIds(guildId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: walletsTable.userId })
    .from(walletsTable)
    .where(eq(walletsTable.guildId, guildId));
  return rows.map((r) => r.userId);
}

export async function getLeaderboard(
  guildId: string,
  limit?: number,
): Promise<Wallet[]> {
  const query = db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.guildId, guildId))
    .orderBy(desc(walletsTable.balance));

  return limit === undefined ? query : query.limit(limit);
}

export async function listShopItems(guildId: string, category = "general"): Promise<ShopItem[]> {
  return db
    .select()
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.category, category)))
    .orderBy(shopItemsTable.price);
}

export async function getShopItem(guildId: string, itemId: number): Promise<ShopItem | undefined> {
  const [item] = await db
    .select()
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)));

  return item;
}

export async function addShopItem(
  guildId: string,
  name: string,
  price: number,
  description: string | null,
  effectType: string | null = null,
  category = "general",
  targetRoleId: string | null = null,
): Promise<ShopItem> {
  const [item] = await db
    .insert(shopItemsTable)
    .values({ guildId, name, price, description, effectType, category, targetRoleId })
    .returning();

  if (!item) {
    throw new Error("Failed to create shop item");
  }

  return item;
}

export async function updateShopItemPrice(
  guildId: string,
  itemId: number,
  price: number,
): Promise<ShopItem | null> {
  const [updated] = await db
    .update(shopItemsTable)
    .set({ price })
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)))
    .returning();

  return updated ?? null;
}

export async function removeShopItem(
  guildId: string,
  itemId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)))
    .returning();

  return deleted.length > 0;
}

export async function buyItem(
  guildId: string,
  userId: string,
  itemId: number,
  currencyName: string,
): Promise<{ ok: true; item: ShopItem } | { ok: false; reason: string }> {
  const [item] = await db
    .select()
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)));

  if (!item) {
    return { ok: false, reason: "そのアイテムは見つかりませんでした。" };
  }

  await getOrCreateWallet(guildId, userId);

  // Debit is conditional on sufficient balance, checked atomically in the
  // same statement so concurrent purchases can't overspend.
  const insufficientFunds = await db.transaction(async (tx) => {
    const [debited] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${item.price}` })
      .where(
        and(
          eq(walletsTable.guildId, guildId),
          eq(walletsTable.userId, userId),
          sql`${walletsTable.balance} >= ${item.price}`,
        ),
      )
      .returning();

    if (!debited) {
      return true;
    }

    // Rely on the (guildId, userId, shopItemId) unique constraint so
    // concurrent first-time purchases increment instead of duplicating rows.
    await tx
      .insert(inventoryItemsTable)
      .values({ guildId, userId, shopItemId: item.id, quantity: 1 })
      .onConflictDoUpdate({
        target: [
          inventoryItemsTable.guildId,
          inventoryItemsTable.userId,
          inventoryItemsTable.shopItemId,
        ],
        set: { quantity: sql`${inventoryItemsTable.quantity} + 1` },
      });

    return false;
  });

  if (insufficientFunds) {
    const wallet = await getOrCreateWallet(guildId, userId);
    return {
      ok: false,
      reason: `残高が不足しています(所持: ${wallet.balance}${currencyName}、必要: ${item.price}${currencyName})。`,
    };
  }

  await recordTransaction(guildId, userId, -item.price, `shop:${item.name}`);

  return { ok: true, item };
}

// Reverses a buyItem() purchase: refunds the price and removes one unit of
// inventory (deleting the row if it drops to zero). Used when a purchase's
// side effect (e.g. applying a shop item's effect) fails after charging.
export async function refundPurchase(
  guildId: string,
  userId: string,
  item: ShopItem,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${item.price}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

    const [inventoryRow] = await tx
      .select()
      .from(inventoryItemsTable)
      .where(
        and(
          eq(inventoryItemsTable.guildId, guildId),
          eq(inventoryItemsTable.userId, userId),
          eq(inventoryItemsTable.shopItemId, item.id),
        ),
      );

    if (inventoryRow) {
      if (inventoryRow.quantity <= 1) {
        await tx.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, inventoryRow.id));
      } else {
        await tx
          .update(inventoryItemsTable)
          .set({ quantity: sql`${inventoryItemsTable.quantity} - 1` })
          .where(eq(inventoryItemsTable.id, inventoryRow.id));
      }
    }
  });

  await recordTransaction(guildId, userId, item.price, `refund:${item.name}`);
}

// ─── Squad Treasuries ────────────────────────────────────────────────────────

export async function setupSquadTreasury(
  guildId: string,
  roleId: string,
  name: string,
  leaderRoleId: string | null,
): Promise<SquadTreasury> {
  const [row] = await db
    .insert(squadTreasuriesTable)
    .values({ guildId, roleId, name, leaderRoleId })
    .onConflictDoUpdate({
      target: [squadTreasuriesTable.guildId, squadTreasuriesTable.roleId],
      set: { name, leaderRoleId, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Failed to create treasury");
  return row;
}

export async function getSquadTreasury(id: number): Promise<SquadTreasury | undefined> {
  const [row] = await db
    .select()
    .from(squadTreasuriesTable)
    .where(eq(squadTreasuriesTable.id, id));
  return row;
}

export async function listSquadTreasuries(guildId: string): Promise<SquadTreasury[]> {
  return db
    .select()
    .from(squadTreasuriesTable)
    .where(eq(squadTreasuriesTable.guildId, guildId))
    .orderBy(squadTreasuriesTable.name);
}

/** Find all treasuries whose roleId is in the given list of role IDs. */
export async function getTreasuriesByRoles(
  guildId: string,
  roleIds: string[],
): Promise<SquadTreasury[]> {
  if (roleIds.length === 0) return [];
  const all = await db
    .select()
    .from(squadTreasuriesTable)
    .where(eq(squadTreasuriesTable.guildId, guildId));
  return all.filter((t) => roleIds.includes(t.roleId));
}

export async function depositToTreasury(
  guildId: string,
  treasuryId: number,
  userId: string,
  amount: number,
): Promise<{ treasuryBalance: number; walletBalance: number }> {
  return db.transaction(async (tx) => {
    // Deduct from wallet
    const [wallet] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${amount}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
      .returning();
    if (!wallet || wallet.balance < 0) throw new Error("残高が不足しています");

    // Add to treasury
    const [treasury] = await tx
      .update(squadTreasuriesTable)
      .set({ balance: sql`${squadTreasuriesTable.balance} + ${amount}` })
      .where(eq(squadTreasuriesTable.id, treasuryId))
      .returning();
    if (!treasury) throw new Error("金庫が見つかりません");

    await tx.insert(squadTreasuryTxTable).values({
      guildId, treasuryId, userId, amount, reason: "入金",
    });

    return { treasuryBalance: treasury.balance, walletBalance: wallet.balance };
  });
}

export async function withdrawFromTreasury(
  guildId: string,
  treasuryId: number,
  userId: string,
  amount: number,
): Promise<{ treasuryBalance: number; walletBalance: number }> {
  return db.transaction(async (tx) => {
    // Deduct from treasury
    const [treasury] = await tx
      .update(squadTreasuriesTable)
      .set({ balance: sql`${squadTreasuriesTable.balance} - ${amount}` })
      .where(eq(squadTreasuriesTable.id, treasuryId))
      .returning();
    if (!treasury || treasury.balance < 0) throw new Error("金庫の残高が不足しています");

    // Add to wallet
    const [wallet] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${amount}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
      .returning();
    if (!wallet) throw new Error("ウォレットが見つかりません");

    await tx.insert(squadTreasuryTxTable).values({
      guildId, treasuryId, userId, amount: -amount, reason: "出金",
    });

    return { treasuryBalance: treasury.balance, walletBalance: wallet.balance };
  });
}

export async function giveToCrunchTreasury(
  guildId: string,
  treasuryId: number,
  userId: string,
  amount: number,
): Promise<number> {
  const [row] = await db
    .update(squadTreasuriesTable)
    .set({ balance: sql`${squadTreasuriesTable.balance} + ${amount}` })
    .where(eq(squadTreasuriesTable.id, treasuryId))
    .returning();
  if (!row) throw new Error("金庫が見つかりません");
  await db.insert(squadTreasuryTxTable).values({
    guildId, treasuryId, userId, amount, reason: "管理者付与",
  });
  return row.balance;
}

export async function getTreasuryHistory(
  treasuryId: number,
  limit = 10,
): Promise<SquadTreasuryTx[]> {
  return db
    .select()
    .from(squadTreasuryTxTable)
    .where(eq(squadTreasuryTxTable.treasuryId, treasuryId))
    .orderBy(desc(squadTreasuryTxTable.createdAt))
    .limit(limit);
}

// ─── Eval Sheet helpers ──────────────────────────────────────────────────────

export async function getEvalSheetSettings(guildId: string): Promise<CommunitySheetSettings | undefined> {
  const [row] = await db
    .select()
    .from(communitySheetSettingsTable)
    .where(eq(communitySheetSettingsTable.guildId, guildId));
  return row;
}

export async function setEvalSheetForumConfig(
  guildId: string,
  forumChannelId: string | null,
  triggerRoleIds: string[] | null,
  evalPeriodDays: number,
): Promise<void> {
  await db
    .insert(communitySheetSettingsTable)
    .values({ guildId, forumChannelId, triggerRoleIds: triggerRoleIds?.join(",") ?? null, evalPeriodDays })
    .onConflictDoUpdate({
      target: communitySheetSettingsTable.guildId,
      set: {
        forumChannelId,
        triggerRoleIds: triggerRoleIds?.join(",") ?? null,
        evalPeriodDays,
        updatedAt: new Date(),
      },
    });
}

export async function setEvalNameboardUrl(guildId: string, nameboardUrl: string | null): Promise<void> {
  await db
    .insert(communitySheetSettingsTable)
    .values({ guildId, nameboardUrl, evalPeriodDays: 14 })
    .onConflictDoUpdate({
      target: communitySheetSettingsTable.guildId,
      set: { nameboardUrl, updatedAt: new Date() },
    });
}

export async function setRosterCategoryId(guildId: string, rosterCategoryId: string | null): Promise<void> {
  await db
    .insert(communitySheetSettingsTable)
    .values({ guildId, rosterCategoryId, evalPeriodDays: 14 })
    .onConflictDoUpdate({
      target: communitySheetSettingsTable.guildId,
      set: { rosterCategoryId, updatedAt: new Date() },
    });
}

export async function createEvalSheet(
  guildId: string,
  userId: string,
  startDate: Date,
  endDate: Date,
  channelId?: string,
  messageId?: string,
): Promise<CommunitySheet> {
  const [row] = await db
    .insert(communitySheetsTable)
    .values({ guildId, userId, startDate, endDate, channelId, messageId })
    .returning();
  return row;
}

export async function listEvalSheets(guildId: string): Promise<CommunitySheet[]> {
  return db
    .select()
    .from(communitySheetsTable)
    .where(eq(communitySheetsTable.guildId, guildId))
    .orderBy(asc(communitySheetsTable.createdAt));
}

export async function getLatestEvalSheet(guildId: string, userId: string): Promise<CommunitySheet | undefined> {
  const [row] = await db
    .select()
    .from(communitySheetsTable)
    .where(and(eq(communitySheetsTable.guildId, guildId), eq(communitySheetsTable.userId, userId)))
    .orderBy(desc(communitySheetsTable.createdAt))
    .limit(1);
  return row;
}

export async function deleteEvalSheet(id: number): Promise<void> {
  await db.delete(communitySheetsTable).where(eq(communitySheetsTable.id, id));
}

/**
 * Returns sheets whose endDate has passed and whose reminder has not yet been sent.
 * Used by the reminder scheduler to detect newly-expired eval periods.
 */
export async function listSheetsNeedingReminder(): Promise<CommunitySheet[]> {
  return db
    .select()
    .from(communitySheetsTable)
    .where(
      and(
        // 終了日のJST日付が「今日のJST日付」と一致する行を対象にする
        sql`(${communitySheetsTable.endDate} AT TIME ZONE 'Asia/Tokyo')::date = (now() AT TIME ZONE 'Asia/Tokyo')::date`,
        sql`${communitySheetsTable.reminderSentAt} IS NULL`,
      ),
    );
}

/** Mark the reminder as sent so we don't fire it twice. */
export async function markSheetReminderSent(id: number): Promise<void> {
  await db
    .update(communitySheetsTable)
    .set({ reminderSentAt: sql`now()` })
    .where(eq(communitySheetsTable.id, id));
}

/**
 * Returns all sheets whose end_date has not yet passed (still active).
 * Used by the periodic VC-time refresh scheduler.
 */
export async function listActiveSheets(): Promise<CommunitySheet[]> {
  return db
    .select()
    .from(communitySheetsTable)
    .where(sql`${communitySheetsTable.endDate} > now()`);
}

/** Total VC seconds for a user between two dates (mirrors community bot's getVcTimeInPeriod). */
export async function getSheetVcSeconds(
  guildId: string,
  userId: string,
  startDate: Date,
  endDate: Date,
): Promise<number> {
  const rows = await db.execute<{ total_seconds: string }>(sql`
    SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
      LEAST(COALESCE(left_at, NOW()), ${endDate})
      - GREATEST(joined_at, ${startDate})
    ))))::bigint AS total_seconds
    FROM community_vc_sessions
    WHERE guild_id = ${guildId}
      AND user_id = ${userId}
      AND joined_at < ${endDate}
      AND COALESCE(left_at, NOW()) > ${startDate}
  `);
  return Number(rows.rows[0]?.total_seconds ?? 0);
}

export async function listInventory(
  guildId: string,
  userId: string,
): Promise<Array<{ item: ShopItem; quantity: number }>> {
  const rows = await db
    .select({ item: shopItemsTable, quantity: inventoryItemsTable.quantity })
    .from(inventoryItemsTable)
    .innerJoin(shopItemsTable, eq(inventoryItemsTable.shopItemId, shopItemsTable.id))
    .where(and(eq(inventoryItemsTable.guildId, guildId), eq(inventoryItemsTable.userId, userId)));

  return rows;
}

/**
 * Extends the endDate of the user's most recent community eval sheet by `days`.
 * If the sheet has already expired, the extension starts from now instead of
 * the (past) endDate, so the user always gets the full benefit.
 * Returns { newEndDate } on success, or null when no sheet is found.
 */
export async function extendCommunitySheet(
  guildId: string,
  userId: string,
  days: number,
): Promise<{
  newEndDate: Date;
  channelId: string | null;
  messageId: string | null;
  startDate: Date;
  userId: string;
} | null> {
  const [sheet] = await db
    .select()
    .from(communitySheetsTable)
    .where(
      and(
        eq(communitySheetsTable.guildId, guildId),
        eq(communitySheetsTable.userId, userId),
      ),
    )
    .orderBy(desc(communitySheetsTable.createdAt))
    .limit(1);

  if (!sheet) return null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const base = sheet.endDate < new Date() ? new Date() : sheet.endDate;
  const newEndDate = new Date(base.getTime() + days * MS_PER_DAY);

  await db
    .update(communitySheetsTable)
    .set({ endDate: newEndDate, needsUpdate: false })
    .where(eq(communitySheetsTable.id, sheet.id));

  return {
    newEndDate,
    channelId: sheet.channelId ?? null,
    messageId: sheet.messageId ?? null,
    startDate: sheet.startDate,
    userId: sheet.userId,
  };
}

// ─── Shop License Config ──────────────────────────────────────────────────────

/** Upsert a squad-role → license-role mapping. */
export async function setShopLicenseConfig(
  guildId: string,
  squadRoleId: string,
  licenseRoleId: string,
): Promise<ShopLicenseConfig> {
  const [row] = await db
    .insert(shopLicenseConfigTable)
    .values({ guildId, squadRoleId, licenseRoleId })
    .onConflictDoUpdate({
      target: [shopLicenseConfigTable.guildId, shopLicenseConfigTable.squadRoleId],
      set: { licenseRoleId },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert shop license config");
  return row;
}

/** List all squad→license mappings for a guild. */
export async function listShopLicenseConfigs(guildId: string): Promise<ShopLicenseConfig[]> {
  return db
    .select()
    .from(shopLicenseConfigTable)
    .where(eq(shopLicenseConfigTable.guildId, guildId))
    .orderBy(asc(shopLicenseConfigTable.createdAt));
}

/**
 * Given the IDs of roles a user currently holds, return the first matching
 * shop-license config row, or undefined if none match.
 */
export async function getShopLicenseForUser(
  guildId: string,
  userRoleIds: string[],
): Promise<ShopLicenseConfig | undefined> {
  if (userRoleIds.length === 0) return undefined;
  const configs = await listShopLicenseConfigs(guildId);
  return configs.find((c) => userRoleIds.includes(c.squadRoleId));
}

// ─── Group Shop Sales Log ─────────────────────────────────────────────────────

/** Record a group-shop purchase against a squad role (fire-and-forget safe). */
export async function recordGroupShopSale(
  guildId: string,
  userId: string,
  item: { id: number; name: string; price: number },
  squadRoleId: string,
): Promise<void> {
  await db.insert(groupShopSalesTable).values({
    guildId,
    userId,
    itemId: item.id,
    itemName: item.name,
    squadRoleId,
    amount: item.price,
  });
}

export type GroupShopSalesSummary = {
  squadRoleId: string;
  totalAmount: number;
  purchaseCount: number;
};

/** Aggregate group-shop sales per squad role for a guild. */
export async function getGroupShopSalesSummary(
  guildId: string,
): Promise<GroupShopSalesSummary[]> {
  const rows = await db
    .select({
      squadRoleId: groupShopSalesTable.squadRoleId,
      totalAmount: sql<number>`sum(${groupShopSalesTable.amount})::int`,
      purchaseCount: sql<number>`count(*)::int`,
    })
    .from(groupShopSalesTable)
    .where(eq(groupShopSalesTable.guildId, guildId))
    .groupBy(groupShopSalesTable.squadRoleId)
    .orderBy(sql`sum(${groupShopSalesTable.amount}) desc`);
  return rows;
}

/** Detailed purchase log for a guild, newest first. */
export async function getGroupShopSalesLog(
  guildId: string,
  limit = 50,
): Promise<GroupShopSale[]> {
  return db
    .select()
    .from(groupShopSalesTable)
    .where(eq(groupShopSalesTable.guildId, guildId))
    .orderBy(desc(groupShopSalesTable.purchasedAt))
    .limit(limit);
}
