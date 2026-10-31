import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, ensureZombieSchema, updateZombieConfig, startZombieGame, setZombieRole, beginZombieGame,
  syncZombiePresence, requestZombieAction, decideZombieRequest, getZombieGame, endZombieGame, setZombieReward,
  changeZombieSettingList, zombieConfigsTable, zombieGamesTable, zombieJobsTable, zombieOperationsTable,
  walletsTable, transactionsTable, deliverZombieJob, zombieDeliveryFailures, type ZombieConfig,
} from "@workspace/db";
describe.skipIf(process.env.RUN_ZOMBIE_DB_TESTS !== "1")("persistent zombie event", () => {
  const guilds: string[] = [];
  let guild: string, gameId: string;
  const id = () => randomUUID(), now = Date.now(), t = (seconds: number) => now + seconds * 1000;
  const rewards = { humanSurvival: 10, humanVictory: 20, neverInfected: 30, zombieVictory: 40, mostInfections: 50, healerCoop: 60, perHeal: 70 };
  const config: ZombieConfig = { vcIds: ["tavern", "small"], excludedUsers: [], excludedRoles: [],
    announceId: "announcement", rulesId: "rules", resultId: "results", adminId: "admin", infectionLogId: "infections", roleLogId: "roles", rewards };
  beforeAll(async () => { await ensureZombieSchema(); });
  beforeEach(async () => {
    guild = `zombie-test-${id()}`; guilds.push(guild); gameId = id();
    await updateZombieConfig(guild, config);
  });
  afterAll(async () => {
    for (const guildId of guilds) for (const table of [zombieJobsTable, zombieOperationsTable, zombieGamesTable, zombieConfigsTable, walletsTable, transactionsTable])
      await db.delete(table).where(eq(table.guildId, guildId));
  });
  async function prepare(names = ["z", "h", "x", "doctor"]) {
    await startZombieGame(gameId, guild, names.map(id => ({ id, name: `名前-${id}` })), now);
    await setZombieRole(guild, "z", "zombie", now);
    if (names.includes("doctor")) await setZombieRole(guild, "doctor", "healer", now);
  }
  async function begin(names?: string[]) {
    await prepare(names); await beginZombieGame(guild, t(1));
    await syncZombiePresence(guild, "epoch", Object.fromEntries((names ?? ["z", "h", "x", "doctor"]).map(id => [id, "tavern"])), t(1));
  }
  async function infect(target = "h", seconds = 181) {
    const request = await requestZombieAction(id(), guild, "z", target, "infect", t(seconds));
    return decideZombieRequest(guild, gameId, request.id, "admin", true, t(seconds));
  }
  async function money(user: string) {
    return (await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guild), eq(walletsTable.userId, user))))[0]?.balance ?? 0;
  }
  it("registers only the supplied initial participants, excludes configured users and prevents parallel events", async () => {
    await changeZombieSettingList(guild, "excludedUsers", "excluded", true);
    const game = await startZombieGame(gameId, guild, ["z", "h", "excluded", "z"].map(id => ({ id, name: id })), now);
    expect(Object.keys(game.players)).toEqual(["z", "h"]);
    expect(game.phase).toBe("preparing");
    await expect(startZombieGame(id(), guild, [{ id: "other", name: "other" }])).rejects.toThrow("すでに");
  });
  it("allows multiple healers and human corrections only during preparation", async () => {
    await prepare();
    await setZombieRole(guild, "x", "healer", now);
    await setZombieRole(guild, "x", "human", now);
    expect((await getZombieGame(guild))?.players.x!.role).toBe("human");
    await beginZombieGame(guild, t(1));
    await expect(setZombieRole(guild, "h", "healer")).rejects.toThrow("準備中");
  });
  it("requires an initial zombie, ordinary human and all seven explicit prices", async () => {
    await updateZombieConfig(guild, { rewards: { ...rewards, perHeal: null } });
    await prepare();
    await expect(beginZombieGame(guild)).rejects.toThrow("7項目");
    await setZombieReward(guild, "perHeal", 0);
    await setZombieRole(guild, "z", "human");
    await expect(beginZombieGame(guild)).rejects.toThrow("最初のゾンビ");
    expect((await getZombieGame(guild))?.phase).toBe("preparing");
  });
  it("rejects unsafe prospective reward sums before running", async () => {
    await updateZombieConfig(guild, { rewards: { ...rewards, perHeal: 2147483647 } });
    await prepare();
    await expect(beginZombieGame(guild)).rejects.toThrow("整数");
  });
  it("requires a full continuous 180 seconds and does not infect before admin approval", async () => {
    await begin();
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(180))).rejects.toThrow("現在179秒");
    const request = await requestZombieAction(id(), guild, "z", "h", "infect", t(181));
    expect(request.seconds).toBe(180);
    expect((await getZombieGame(guild))?.players.h!.role).toBe("human");
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(182))).rejects.toThrow("承認待ち");
    await decideZombieRequest(guild, gameId, request.id, "admin", false, t(182));
    expect((await getZombieGame(guild))?.players.h!.role).toBe("human");
  });
  it("resets continuous time on movement, mute/absence, or gateway epoch change", async () => {
    await begin();
    await syncZombiePresence(guild, "epoch", { z: "tavern", h: "small" }, t(150));
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(181))).rejects.toThrow("酒場VC");
    await syncZombiePresence(guild, "epoch", { z: "tavern", h: "tavern" }, t(160));
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(181))).rejects.toThrow("現在21秒");
    await syncZombiePresence(guild, "new-connection", { z: "tavern", h: "tavern" }, t(400));
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(500))).rejects.toThrow("現在100秒");
    await syncZombiePresence(guild, "new-connection", { z: "tavern" }, t(501));
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(1000))).rejects.toThrow("酒場VC");
  });
  it("never counts conversation before an actor became a zombie", async () => {
    await begin(); await infect();
    await expect(requestZombieAction(id(), guild, "h", "x", "infect", t(182))).rejects.toThrow("現在1秒");
  });
  it("keeps healers immune without disclosing their role in the application response", async () => {
    await begin();
    const r = await requestZombieAction(id(), guild, "z", "doctor", "infect", t(181));
    expect(r.status).toBe("pending");
    const result = await decideZombieRequest(guild, gameId, r.id, "admin", true, t(182));
    expect(result.request.status).toBe("stale");
    expect(result.game.players.doctor!.role).toBe("healer");
  });
  it("serializes duplicate approvals and invalidates competing requests after state changes", async () => {
    await begin(); await infect("h");
    const first = await requestZombieAction(id(), guild, "z", "x", "infect", t(400));
    const second = await requestZombieAction(id(), guild, "h", "x", "infect", t(400));
    const results = await Promise.all([1, 2].map(() => decideZombieRequest(guild, gameId, first.id, "admin", true, t(401))));
    expect(results[0]!.game.players.x!.version).toBe(results[1]!.game.players.x!.version);
    expect(results[0]!.game.players.z!.infectedUsers).toEqual(["h", "x"]);
    expect((await decideZombieRequest(guild, gameId, second.id, "admin", true, t(402))).request.status).toBe("stale");
  });
  it("treats expired and cross-event approvals as invalid", async () => {
    await begin();
    const request = await requestZombieAction(id(), guild, "z", "h", "infect", t(181));
    await expect(decideZombieRequest(guild, "wrong-event", request.id, "admin", true, t(182))).rejects.toThrow("対象");
    expect((await decideZombieRequest(guild, gameId, request.id, "admin", true, t(1081))).request.status).toBe("stale");
  });
  it("heals infections, counts unique targets only and preserves never-infected history", async () => {
    await begin(); await infect();
    const heal = await requestZombieAction(id(), guild, "doctor", "h", "heal", t(361));
    await decideZombieRequest(guild, gameId, heal.id, "admin", true, t(361));
    await infect("h", 541);
    const healAgain = await requestZombieAction(id(), guild, "doctor", "h", "heal", t(721));
    const result = await decideZombieRequest(guild, gameId, healAgain.id, "admin", true, t(721));
    expect(result.game.players.h!.role).toBe("human");
    expect(result.game.players.h!.everInfected).toBe(true);
    expect(result.game.players.doctor!.healedUsers).toEqual(["h"]);
    expect(result.game.players.z!.infectedUsers).toEqual(["h"]);
  });
  it("automatically wins when every non-healer is infected, paying each person exactly once", async () => {
    await begin(["z", "h", "doctor"]);
    const result = await infect();
    expect(result.game.phase).toBe("ended"); expect(result.game.winner).toBe("zombie");
    expect(await money("z")).toBe(90);
    expect(await money("h")).toBe(40);
    expect(await money("doctor")).toBe(60);
    await endZombieGame(guild, gameId);
    expect(await money("z")).toBe(90);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild));
    expect(ledger).toHaveLength(3);
  });
  it("settles human survival, victory, never-infected, infection and healer rewards correctly", async () => {
    await begin(); await infect();
    const heal = await requestZombieAction(id(), guild, "doctor", "h", "heal", t(361));
    await decideZombieRequest(guild, gameId, heal.id, "admin", true, t(361));
    const result = await endZombieGame(guild, gameId, false, t(362));
    expect(result.winner).toBe("human");
    expect(await money("h")).toBe(30); expect(await money("x")).toBe(60);
    expect(await money("z")).toBe(50); expect(await money("doctor")).toBe(130);
  });
  it("freezes running rewards even if next-event configuration changes", async () => {
    await begin();
    await setZombieReward(guild, "humanSurvival", 999);
    await endZombieGame(guild, gameId);
    expect(await money("h")).toBe(60);
  });
  it("atomically rolls back all payouts and the ending on recipient balance overflow", async () => {
    await begin();
    await db.insert(walletsTable).values({ guildId: guild, userId: "z", balance: 2147483647 });
    await infect(); // z now earns the positive most-infected reward on human win.
    await expect(endZombieGame(guild, gameId)).rejects.toThrow("残高上限");
    expect((await getZombieGame(guild))?.phase).toBe("running");
    expect(await money("doctor")).toBe(0); expect(await money("h")).toBe(0);
  });
  it("rolls back the final infection too if automatic victory payment fails", async () => {
    await begin(["z", "h", "doctor"]);
    await db.insert(walletsTable).values({ guildId: guild, userId: "z", balance: 2147483647 });
    await expect(infect()).rejects.toThrow("残高上限");
    const game = await getZombieGame(guild);
    expect(game?.players.h!.role).toBe("human"); expect(game?.phase).toBe("running");
    expect(game?.players.z!.infectedUsers).toHaveLength(0);
  });
  it("cancels without rewards and rejects actions after cancellation", async () => {
    await begin(); await endZombieGame(guild, gameId, true);
    await expect(requestZombieAction(id(), guild, "z", "h", "infect", t(181))).rejects.toThrow("開催中");
    expect(await money("h")).toBe(0);
  });
  it("keeps end-operation receipts across later events to prevent replay ending the new game", async () => {
    await begin();
    const operation = { id: id(), actor: "admin" };
    await endZombieGame(guild, gameId, false, t(300), operation);
    const next = await startZombieGame(id(), guild, [{ id: "a", name: "a" }, { id: "b", name: "b" }], t(301));
    const replay = await endZombieGame(guild, next.id, false, t(302), operation);
    expect(replay.id).toBe(gameId);
    expect((await getZombieGame(guild))?.id).toBe(next.id);
    expect((await getZombieGame(guild))?.phase).toBe("preparing");
  });
  it("retries failed DM jobs, stores sanitized errors and never repeats a completed delivery", async () => {
    await prepare();
    const job = (await db.select().from(zombieJobsTable).where(eq(zombieJobsTable.guildId, guild))).find(r => r.payload.kind === "dm")!;
    await deliverZombieJob(job.id, async () => { throw new Error("secret request header should not be saved"); }, new Date(t(5)));
    expect((await zombieDeliveryFailures(guild))[0]?.error).not.toContain("secret");
    let sent = 0;
    await Promise.all([1, 2].map(() => deliverZombieJob(job.id, async () => { sent++; }, new Date(t(70)))));
    expect(sent).toBe(1);
  });
  it("isolates events, participants and wallets across guilds", async () => {
    await begin();
    const other = `zombie-test-${id()}`; guilds.push(other);
    expect(await getZombieGame(other)).toBeUndefined();
    await expect(decideZombieRequest(other, gameId, id(), "admin", true)).rejects.toThrow("対象");
  });
  it("allows seven explicitly zero rewards without silently treating null as zero", async () => {
    await updateZombieConfig(guild, { rewards: { humanSurvival: 0, humanVictory: 0, neverInfected: 0,
      zombieVictory: 0, mostInfections: 0, healerCoop: 0, perHeal: 0 } });
    await begin(["z", "h"]);
    await endZombieGame(guild, gameId);
    expect((await getZombieGame(guild))?.phase).toBe("ended");
    expect(await money("h")).toBe(0);
  });
  it("rolls back every wallet if the reward ledger cannot be written", async () => {
    await begin();
    await db.insert(transactionsTable).values({ guildId: guild, userId: "z", amount: 0, reason: "synthetic collision",
      sessionKey: `zombie-reward:${gameId}:z` });
    await expect(endZombieGame(guild, gameId)).rejects.toThrow();
    expect((await getZombieGame(guild))?.phase).toBe("running");
    expect(await money("doctor")).toBe(0);
    expect(await money("x")).toBe(0);
  });
  it("deduplicates an admin command received after automatic settlement as well", async () => {
    await begin(["z", "h", "doctor"]); await infect();
    const operation = { id: id(), actor: "admin" };
    await endZombieGame(guild, gameId, true, t(200), operation);
    const next = await startZombieGame(id(), guild, [{ id: "a", name: "a" }, { id: "b", name: "b" }], t(201));
    const repeat = await endZombieGame(guild, next.id, true, t(202), operation);
    expect(repeat.id).toBe(gameId);
    expect((await getZombieGame(guild))?.phase).toBe("preparing");
  });
});
