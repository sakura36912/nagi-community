import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db, getProfileBackgroundImage, getProfileData, getProfileSettings, setProfileAppearance,
  setProfileBackgroundAsset, setProfileDisplayRole, setProfileField, setProfileRankRole,
  petAccountsTable, profileBackgroundsTable, profileSettingsTable,
} from "@workspace/db";

describe.skipIf(process.env.RUN_PROFILE_DB_TESTS !== "1")("profile settings and saved data", () => {
  const guildId = `profile-test-${randomUUID()}`;
  const stockUserId = `stock-${randomUUID()}`;
  afterAll(async () => {
    await db.delete(profileBackgroundsTable).where(eq(profileBackgroundsTable.guildId, guildId));
    await db.delete(petAccountsTable).where(eq(petAccountsTable.guildId, guildId));
    await db.delete(profileSettingsTable).where(eq(profileSettingsTable.guildId, guildId));
  });

  it("persists display, rank, field, and appearance settings for one guild", async () => {
    await setProfileDisplayRole(guildId, "role-staff", true);
    await setProfileRankRole(guildId, "role-vip", "vip");
    await setProfileField(guildId, "casino", false);
    await setProfileAppearance(guildId, { color: 0x123abc, backgroundUrl: "https://example.com/card.png", frameStyle: "gold" });
    const settings = await getProfileSettings(guildId);
    expect(settings.displayRoleIds).toEqual(["role-staff"]);
    expect(settings.rankRoles).toEqual([{ roleId: "role-vip", tier: "vip" }]);
    expect(settings.visibleFields.casino).toBe(false);
    expect(settings).toMatchObject({ color: 0x123abc, backgroundUrl: "https://example.com/card.png", frameStyle: "gold" });
  });

  it("persists directly uploaded background bytes and removes them when switching to a URL", async () => {
    const imageData = Buffer.from("profile-background-test");
    await setProfileBackgroundAsset(guildId, { kind: "upload", imageData, contentType: "image/png" });
    expect(await getProfileBackgroundImage(guildId)).toMatchObject({ imageData, contentType: "image/png" });
    await setProfileBackgroundAsset(guildId, { kind: "url", url: "https://example.com/profile.png" });
    expect(await getProfileBackgroundImage(guildId)).toBeNull();
    expect((await getProfileSettings(guildId)).backgroundUrl).toBe("https://example.com/profile.png");
  });

  it("loads absent profile stats from existing storage without creating personal records", async () => {
    const profile = await getProfileData(guildId, `missing-${randomUUID()}`);
    expect(profile).toMatchObject({
      bounty: null, currencyName: "$",
      petStock: [], pet: null,
      battle: { defeats: 0, maxDamage: 0, participated: 0 },
      pvp: { wins: 0, losses: 0, draws: 0 },
      casino: { totalBet: 0, net: 0, wins: 0, maxPayout: 0, games: 0 },
    });
    expect(profile.weapon).toBeUndefined();
  });

  it("returns only egg, food, and toy counts for the inventory section", async () => {
    await db.insert(petAccountsTable).values({
      guildId, userId: stockUserId,
      data: { pet: null, eggs: { rare: 1 }, food: 2, toys: 1, day: "", petsToday: 0, playsToday: 0 },
    });
    const profile = await getProfileData(guildId, stockUserId);
    expect(profile.petStock).toEqual(["レア卵：1個", "エサ：2個", "おもちゃ：1個"]);
  });
});
