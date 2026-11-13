import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "./index";
import { ensureBossSchema } from "./bossSchema";
import { getForgeWeapon } from "./forge";
import {
  bossBattlesTable, bossMembersTable, dealerCasinoBetsTable, dealerCasinoGamesTable,
  dealerCasinoSettlementsTable, inventoryItemsTable, petAccountsTable, pvpBountiesTable,
  pvpDuelsTable, profileSettingsTable, shopItemsTable, transactionsTable,
  guildSettingsTable,
} from "./schema";
import { ensureProfileSchema } from "./profileSchema";
import {
  DEFAULT_PROFILE_SETTINGS, PROFILE_FIELDS, PROFILE_FRAME_STYLES, PROFILE_RANK_TIERS,
  getProfileCasinoStats, type ProfileField, type ProfileFrameStyle, type ProfileRankTier,
  type ProfileSettings,
} from "./profileRules";

export {
  PROFILE_FIELD_LABELS, PROFILE_FIELDS, PROFILE_FRAME_STYLES, PROFILE_RANK_LABELS,
  PROFILE_RANK_TIERS, configuredProfileRank, getProfileCasinoStats,
  type ProfileField, type ProfileFrameStyle, type ProfileRankTier, type ProfileSettings,
} from "./profileRules";

function normalizeSettings(value?: Partial<ProfileSettings> | null): ProfileSettings {
  return {
    ...DEFAULT_PROFILE_SETTINGS,
    ...value,
    displayRoleIds: value?.displayRoleIds ?? [],
    rankRoles: value?.rankRoles ?? [],
    visibleFields: { ...DEFAULT_PROFILE_SETTINGS.visibleFields, ...value?.visibleFields },
  };
}

async function updateConfig(guildId: string, updater: (settings: ProfileSettings) => ProfileSettings) {
  await ensureProfileSchema();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["profile-settings", guildId])}, 0))`);
    const [row] = await tx.select().from(profileSettingsTable)
      .where(eq(profileSettingsTable.guildId, guildId)).for("update");
    const settings = updater(normalizeSettings(row?.settings));
    await tx.insert(profileSettingsTable).values({ guildId, settings })
      .onConflictDoUpdate({ target: profileSettingsTable.guildId, set: { settings } });
    return settings;
  });
}

export async function getProfileSettings(guildId: string): Promise<ProfileSettings> {
  await ensureProfileSchema();
  const [row] = await db.select().from(profileSettingsTable).where(eq(profileSettingsTable.guildId, guildId));
  return normalizeSettings(row?.settings);
}

export async function setProfileField(guildId: string, field: ProfileField, enabled: boolean) {
  if (!PROFILE_FIELDS.includes(field)) throw new Error("プロフィール項目が不正です。");
  return updateConfig(guildId, settings => ({
    ...settings, visibleFields: { ...settings.visibleFields, [field]: enabled },
  }));
}

export async function setProfileDisplayRole(guildId: string, roleId: string, enabled: boolean) {
  return updateConfig(guildId, settings => ({
    ...settings,
    displayRoleIds: enabled
      ? [...new Set([...settings.displayRoleIds, roleId])]
      : settings.displayRoleIds.filter(id => id !== roleId),
  }));
}

export async function setProfileRankRole(guildId: string, roleId: string, tier: ProfileRankTier | null) {
  if (tier !== null && !PROFILE_RANK_TIERS.includes(tier)) throw new Error("ランク種別が不正です。");
  return updateConfig(guildId, settings => {
    const rankRoles = settings.rankRoles.filter(entry => entry.roleId !== roleId);
    if (tier) rankRoles.push({ roleId, tier });
    return { ...settings, rankRoles };
  });
}

export async function setProfileAppearance(
  guildId: string,
  patch: { color?: number | null; backgroundUrl?: string | null; frameStyle?: ProfileFrameStyle },
) {
  if (patch.frameStyle !== undefined && !PROFILE_FRAME_STYLES.includes(patch.frameStyle)) {
    throw new Error("カード枠の種類が不正です。");
  }
  return updateConfig(guildId, settings => ({ ...settings, ...patch }));
}

export async function getProfileData(guildId: string, userId: string) {
  await Promise.all([ensureProfileSchema(), ensureBossSchema()]);
  const [weapon, bountyRows, currencyRows, petRows, inventoryRows, bossRows, duelRows,
    casinoLedgerRows, dealerRows] = await Promise.all([
    getForgeWeapon(guildId, userId),
    db.select({ amount: pvpBountiesTable.amount }).from(pvpBountiesTable).where(and(
      eq(pvpBountiesTable.guildId, guildId), eq(pvpBountiesTable.userId, userId),
    )),
    db.select({ currencyName: guildSettingsTable.currencyName }).from(guildSettingsTable)
      .where(eq(guildSettingsTable.guildId, guildId)),
    db.select({ data: petAccountsTable.data }).from(petAccountsTable).where(and(
      eq(petAccountsTable.guildId, guildId), eq(petAccountsTable.userId, userId),
    )),
    db.select({ name: shopItemsTable.name, quantity: inventoryItemsTable.quantity })
      .from(inventoryItemsTable).innerJoin(shopItemsTable, eq(inventoryItemsTable.shopItemId, shopItemsTable.id))
      .where(and(eq(inventoryItemsTable.guildId, guildId), eq(inventoryItemsTable.userId, userId)))
      .orderBy(desc(inventoryItemsTable.quantity)),
    db.select({ status: bossBattlesTable.status, damage: bossMembersTable.damage })
      .from(bossMembersTable).innerJoin(bossBattlesTable, eq(bossMembersTable.battleId, bossBattlesTable.id))
      .where(and(eq(bossMembersTable.guildId, guildId), eq(bossMembersTable.userId, userId))),
    db.select({ hostId: pvpDuelsTable.hostId, opponentId: pvpDuelsTable.opponentId, status: pvpDuelsTable.status,
      state: pvpDuelsTable.state }).from(pvpDuelsTable).where(and(eq(pvpDuelsTable.guildId, guildId),
      or(eq(pvpDuelsTable.hostId, userId), eq(pvpDuelsTable.opponentId, userId)))),
    db.select({ amount: transactionsTable.amount, reason: transactionsTable.reason }).from(transactionsTable)
      .where(and(eq(transactionsTable.guildId, guildId), eq(transactionsTable.userId, userId),
        or(
          sql`${transactionsTable.reason} LIKE 'BJ%'`,
          sql`${transactionsTable.reason} LIKE 'ポーカー%'`,
          sql`${transactionsTable.reason} LIKE 'ルーレット%'`,
          sql`${transactionsTable.reason} LIKE 'スロット%'`,
          sql`${transactionsTable.reason} LIKE 'ハイアンドロー%'`,
          sql`${transactionsTable.reason} LIKE 'バカラ%'`,
          sql`${transactionsTable.reason} LIKE 'チンチロ%'`,
        ))),
    db.select({ bet: dealerCasinoBetsTable.betAmount, payout: dealerCasinoSettlementsTable.payout,
      result: dealerCasinoSettlementsTable.result })
      .from(dealerCasinoSettlementsTable)
      .innerJoin(dealerCasinoBetsTable, eq(dealerCasinoSettlementsTable.betId, dealerCasinoBetsTable.id))
      .innerJoin(dealerCasinoGamesTable, eq(dealerCasinoSettlementsTable.gameId, dealerCasinoGamesTable.id))
      .where(and(eq(dealerCasinoGamesTable.guildId, guildId), eq(dealerCasinoSettlementsTable.userId, userId))),
  ]);

  const pvp = { wins: 0, losses: 0, draws: 0 };
  for (const duel of duelRows) {
    if (duel.status !== "finished") continue;
    const winnerId = duel.state.winnerId;
    if (!winnerId) pvp.draws++;
    else if (winnerId === userId) pvp.wins++;
    else pvp.losses++;
  }
  const pet = petRows[0]?.data.pet ?? null;
  const petInventory: string[] = [];
  const account = petRows[0]?.data;
  if (pet) petInventory.push(`${pet.name}（Lv${pet.level}）`);
  if (account) {
    const rarityNames: Record<string, string> = { normal: "ノーマル", rare: "レア", epic: "エピック", legend: "レジェンド", mythic: "ミシック" };
    for (const [rarity, quantity] of Object.entries(account.eggs ?? {})) {
      if (quantity) petInventory.push(`${rarityNames[rarity] ?? rarity}卵 ×${quantity}`);
    }
    if (account.food) petInventory.push(`エサ ×${account.food}`);
    if (account.toys) petInventory.push(`おもちゃ ×${account.toys}`);
  }
  return {
    weapon,
    bounty: bountyRows[0]?.amount ?? null,
    currencyName: currencyRows[0]?.currencyName ?? "$",
    inventory: inventoryRows,
    pet,
    petInventory,
    battle: {
      defeats: bossRows.filter(row => row.status === "won").length,
      maxDamage: bossRows.reduce((max, row) => Math.max(max, Number(row.damage)), 0),
      participated: bossRows.length,
    },
    pvp,
    casino: getProfileCasinoStats(casinoLedgerRows, dealerRows),
  };
}
