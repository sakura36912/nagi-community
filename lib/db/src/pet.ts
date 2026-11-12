import { randomInt, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { petAccountsTable as accounts, petSettingsTable as settings, petActionsTable as actions } from "./schema/pet";
import { walletsTable as wallets, transactionsTable } from "./schema/economy";
import { communityVcPrivacyTable, communityVcPrivacyGlobalTable } from "./schema/community";
import {
  addPetXp, newPetAccount, PET_RARITIES, PET_RARITY_NAMES, PetError, petInteger,
  petSetting, petSpecies, refreshPet, validatePetSetting,
  type PetAccount, type PetRarity, type PetSettings, type PetSettingKey,
} from "./petRules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const where = (guildId: string, userId: string) => and(eq(accounts.guildId, guildId), eq(accounts.userId, userId));
async function lock(tx: Tx, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
async function loadSettings(tx: Tx | typeof db, guildId: string) {
  const [row] = await tx.select().from(settings).where(eq(settings.guildId, guildId));
  return row?.settings ?? {};
}
export async function getPetSettings(guildId: string) { return loadSettings(db, guildId); }
/** Shared settings lock orders configuration changes before member operations. */
async function lockSettings(tx: Tx, guildId: string, exclusive = false) {
  const key = JSON.stringify(["pet-settings", guildId]);
  if (exclusive) await lock(tx, key);
  else await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
}
export async function configurePet(id: string, guildId: string, actorId: string,
  patch: { key: PetSettingKey; value: number } | { rarity: PetRarity; species: string[] }) {
  return db.transaction(async tx => {
    await lockSettings(tx, guildId, true);
    const [receipt] = await tx.select().from(actions).where(eq(actions.id, id));
    if (receipt) {
      if (receipt.guildId !== guildId || receipt.actorId !== actorId) throw new PetError("操作情報が一致しません。");
      return receipt.result;
    }
    const s = await loadSettings(tx, guildId);
    // Settle hunger using the old rate so a newly configured rate is not retroactive.
    if ("key" in patch && (patch.key === "hunger_interval" || patch.key === "hunger_loss")) {
      const rows = await tx.select().from(accounts).where(eq(accounts.guildId, guildId));
      for (const row of rows) {
        refreshPet(row.data, s, Date.now());
        if (row.data.pet) row.data.pet.hungerAt = Date.now();
        await tx.update(accounts).set({ data: row.data }).where(where(guildId, row.userId));
      }
    }
    if ("key" in patch) s[patch.key] = validatePetSetting(patch.key, patch.value);
    else {
      if (!PET_RARITIES.includes(patch.rarity) || !patch.species.length || patch.species.length > 25
        || patch.species.some(n => !n.trim() || n.length > 40)) throw new PetError("種類名は1～40文字、1～25種類を指定してください。");
      s.species = { ...s.species, [patch.rarity]: [...new Set(patch.species.map(n => n.trim()))] };
    }
    await tx.insert(settings).values({ guildId, settings: s })
      .onConflictDoUpdate({ target: settings.guildId, set: { settings: s } });
    const result = "ペット設定を更新しました。";
    await tx.insert(actions).values({ id, guildId, userId: actorId, actorId, action: "configure", result });
    return result;
  });
}
/** Account mutations, wallet debit, stock and receipt commit or roll back together. */
async function mutate(id: string | null, guildId: string, userId: string, actorId: string, action: string,
  fn: (a: PetAccount, s: PetSettings, tx: Tx) => Promise<string> | string, now = Date.now()) {
  return db.transaction(async tx => {
    await lockSettings(tx, guildId);
    await lock(tx, JSON.stringify(["pet-user", guildId, userId]));
    if (id) {
      const [receipt] = await tx.select().from(actions).where(eq(actions.id, id));
      if (receipt) {
        if (receipt.guildId !== guildId || receipt.userId !== userId || receipt.actorId !== actorId || receipt.action !== action) {
          throw new PetError("操作情報が一致しません。");
        }
        return receipt.result;
      }
    }
    const s = await loadSettings(tx, guildId);
    const [row] = await tx.select().from(accounts).where(where(guildId, userId));
    const a = row?.data ?? newPetAccount();
    refreshPet(a, s, now);
    const result = await fn(a, s, tx);
    await tx.insert(accounts).values({ guildId, userId, data: a })
      .onConflictDoUpdate({ target: [accounts.guildId, accounts.userId], set: { data: a } });
    if (id) await tx.insert(actions).values({ id, guildId, userId, actorId, action, result });
    return result;
  });
}
export async function getPetAccount(guildId: string, userId: string, now = Date.now()) {
  return db.transaction(async tx => {
    await lockSettings(tx, guildId);
    await lock(tx, JSON.stringify(["pet-user", guildId, userId]));
    const [row] = await tx.select().from(accounts).where(where(guildId, userId));
    const a = row?.data ?? newPetAccount();
    refreshPet(a, await loadSettings(tx, guildId), now);
    if (row) await tx.update(accounts).set({ data: a }).where(where(guildId, userId));
    return a;
  });
}
export type PetItem = PetRarity | "food";
export async function buyPetItem(id: string, guildId: string, userId: string, item: PetItem, quantity: number, quotedPrice: number) {
  petInteger(quantity, 1, 1000);
  if (!["normal", "rare", "food"].includes(item)) throw new PetError("販売対象ではありません。");
  return mutate(id, guildId, userId, userId, "buy", async (a, s, tx) => {
    const price = petSetting(s, `${item}_price` as PetSettingKey);
    if (price !== quotedPrice) throw new PetError("価格が変更されました。課金していません。/pet buy から確認し直してください。");
    if (item !== "food" && !petSpecies(s, item).length) throw new PetError("この卵のペット種類が未登録です。");
    const cost = petInteger(price * quantity, 0, 2_147_483_647);
    const oldStock = item === "food" ? a.food : a.eggs[item] ?? 0;
    petInteger(oldStock + quantity);
    const [paid] = await tx.update(wallets).set({ balance: sql`${wallets.balance} - ${cost}`, updatedAt: new Date() })
      .where(and(eq(wallets.guildId, guildId), eq(wallets.userId, userId), sql`${wallets.balance} >= ${cost}`)).returning();
    if (!paid) throw new PetError("残高が不足しているか、銀行のウォレットがありません。");
    if (item === "food") a.food += quantity;
    else a.eggs[item] = (a.eggs[item] ?? 0) + quantity;
    await tx.insert(transactionsTable).values({ guildId, userId, amount: -cost,
      reason: `ペットショップ: ${item} ×${quantity} / ${id}` });
    return `${item === "food" ? "エサ" : PET_RARITY_NAMES[item] + "卵"}を${quantity}個購入しました。支払い：$${cost.toLocaleString()}`;
  });
}
export async function cancelPetPurchase(id: string, guildId: string, userId: string) {
  // The same receipt key and lock as payment make cancel/confirm races atomic.
  return mutate(id, guildId, userId, userId, "buy", () => "購入をキャンセルしました。引き落としはありません。");
}
export async function hatchPet(id: string, guildId: string, userId: string, rarity: PetRarity, now = Date.now()) {
  if (!PET_RARITIES.includes(rarity)) throw new PetError("未対応の卵です。");
  return mutate(id, guildId, userId, userId, "hatch", (a, s) => {
    if (a.pet) throw new PetError("ペットは1人1匹までです。現在のペットを手放すまで孵化できません。");
    if (!(a.eggs[rarity]! > 0)) throw new PetError("この卵を所持していません。");
    const species = petSpecies(s, rarity);
    if (!species.length) throw new PetError("この卵のペット種類が未登録です。卵は消費していません。");
    const name = species[randomInt(species.length)]!;
    a.eggs[rarity] = (a.eggs[rarity] ?? 0) - 1;
    a.pet = { id: randomUUID(), name, species: name, rarity, level: 1, xp: 0, hunger: 100, bond: 0, bornAt: now, hungerAt: now };
    delete a.vc;
    delete a.messageAt;
    return `${PET_RARITY_NAMES[rarity]}の卵から「${name}」が生まれました！`;
  }, now);
}
export async function carePet(id: string, guildId: string, userId: string, action: "feed" | "pet" | "play", now = Date.now()) {
  return mutate(id, guildId, userId, userId, action, (a, s) => {
    const p = a.pet;
    if (!p) throw new PetError("先に /pet hatch で卵を孵化してください。");
    if (action === "feed") {
      if (!a.food) throw new PetError("エサを所持していません。");
      const hunger = petSetting(s, "feed_hunger"), bond = petSetting(s, "feed_bond"), xp = petSetting(s, "feed_xp");
      addPetXp(p, s, xp);
      p.hunger = Math.min(100, p.hunger + hunger);
      p.bond = Math.min(100, p.bond + bond);
      a.food--;
    } else if (action === "pet") {
      if (a.petsToday >= 1) throw new PetError("撫でるのは1日1回です。日本時間0時にリセットされます。");
      p.bond = Math.min(100, p.bond + petSetting(s, "pet_bond"));
      a.petsToday++;
    } else {
      if (a.playsToday >= 3) throw new PetError("遊ぶのは1日3回です。日本時間0時にリセットされます。");
      const bond = petSetting(s, "play_bond"), xp = petSetting(s, "play_xp");
      addPetXp(p, s, xp);
      p.bond = Math.min(100, p.bond + bond);
      a.playsToday++;
    }
    return `${p.name}と${action === "feed" ? "食事をしました" : action === "pet" ? "触れ合いました" : "遊びました"}。\nLv${p.level} / 経験値 ${p.xp} / 満腹度 ${p.hunger} / 親密度 ${p.bond}`;
  }, now);
}
export async function removePet(id: string, guildId: string, userId: string, actorId: string, petId: string) {
  return mutate(id, guildId, userId, actorId, "remove", a => {
    if (!a.pet || a.pet.id !== petId) throw new PetError("ペットが変更されています。確認し直してください。");
    const name = a.pet.name;
    a.pet = null;
    delete a.vc;
    delete a.messageAt;
    return `${name}を手放しました。卵・エサの在庫は残ります。`;
  });
}
export async function grantPetReward(id: string, guildId: string, userId: string, actorId: string,
  item: PetItem | "xp", quantity: number) {
  petInteger(quantity, 1);
  if (!PET_RARITIES.includes(item as PetRarity) && item !== "food" && item !== "xp") throw new PetError("未対応の報酬です。");
  return mutate(id, guildId, userId, actorId, "grant", (a, s) => {
    if (item === "xp") {
      if (!a.pet) throw new PetError("対象者にペットがいません。");
      addPetXp(a.pet, s, quantity);
    } else if (item === "food") a.food = petInteger(a.food + quantity);
    else a.eggs[item] = petInteger((a.eggs[item] ?? 0) + quantity);
    return `${item === "xp" ? "経験値" : item === "food" ? "エサ" : PET_RARITY_NAMES[item] + "卵"}を${quantity}付与しました。`;
  });
}
/** No content is read or retained; Discord message IDs provide durable deduplication. */
export async function awardPetMessage(id: string, guildId: string, userId: string, now = Date.now()) {
  const s = await loadSettings(db, guildId);
  if (s.message_xp === undefined || s.message_interval === undefined || s.xp_base === undefined || s.xp_multiplier === undefined) return;
  const [row] = await db.select().from(accounts).where(where(guildId, userId));
  if (!row?.data.pet || (row.data.messageAt !== undefined && now - row.data.messageAt < s.message_interval * 1000)) return;
  return mutate(`pet-message:${id}`, guildId, userId, userId, "message", (a, current) => {
    if (!a.pet || (a.messageAt !== undefined && now - a.messageAt < petSetting(current, "message_interval") * 1000)) return "対象外";
    addPetXp(a.pet, current, petSetting(current, "message_xp"));
    a.messageAt = now;
    return "経験値を付与しました。";
  }, now);
}
/** Only continuous, connected observations accrue; never estimate an outage. */
export async function observePetVoice(guildId: string, userId: string, channel: string | null, epoch: string, now = Date.now()) {
  const [existing] = await db.select({ user: accounts.userId }).from(accounts).where(where(guildId, userId));
  if (!existing) return;
  return mutate(null, guildId, userId, userId, "voice", async (a, s, tx) => {
    const [local] = await tx.select().from(communityVcPrivacyTable)
      .where(and(eq(communityVcPrivacyTable.guildId, guildId), eq(communityVcPrivacyTable.userId, userId)));
    const [global] = await tx.select().from(communityVcPrivacyGlobalTable).where(eq(communityVcPrivacyGlobalTable.userId, userId));
    if (local?.optedOut || global?.optedOut || !a.pet || s.vc_xp === undefined || s.vc_interval === undefined
      || s.xp_base === undefined || s.xp_multiplier === undefined) { delete a.vc; return "対象外"; }
    const previous = a.vc;
    if (!channel) {
      // Keep already observed partial intervals, but never accrue while outside VC.
      if (previous) a.vc = { ...previous, channel: "", at: now, epoch };
      return "VCを退出しました。";
    }
    if (!previous || previous.epoch !== epoch || previous.channel !== channel || now - previous.at > 90_000 || now < previous.at) {
      a.vc = { epoch, channel, at: now, seconds: previous?.seconds ?? 0 };
      return "観測を開始しました。";
    }
    previous.seconds += (now - previous.at) / 1000;
    previous.at = now;
    const count = Math.floor(previous.seconds / s.vc_interval);
    if (count) {
      addPetXp(a.pet, s, Math.min(1_000_000_000, count * s.vc_xp));
      previous.seconds -= count * s.vc_interval;
    }
    return "観測を更新しました。";
  }, now);
}
