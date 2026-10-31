import { and, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { walletsTable, transactionsTable } from "./schema/economy";
import { zombieConfigsTable as configs, zombieGamesTable as games, zombieJobsTable as jobs, zombieOperationsTable as operations, type ZombieJob } from "./schema/zombie";
import { ensureZombieSchema } from "./zombieSchema";
import { ZombieError, ZOMBIE_REWARDS, zombieAmount, zombiePayouts, zombieWinner, zombieProof, validateZombieRewardCapacity,
  type ZombieConfig, type ZombieGame, type ZombieRole } from "./zombieRules";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function locked<T>(guildId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
  await ensureZombieSchema();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`zombie:${guildId}`},0))`);
    return run(tx);
  });
}
async function current(tx: Tx, guildId: string) {
  const rows = await tx.select().from(games).where(eq(games.guildId, guildId));
  return rows.map(r => r.state).sort((a, b) => b.createdAt - a.createdAt).at(0);
}
async function save(tx: Tx, game: ZombieGame) {
  await tx.update(games).set({ state: game }).where(eq(games.id, game.id));
}
async function job(tx: Tx, game: ZombieGame, id: string, payload: Omit<ZombieJob, "gameId">) {
  await tx.insert(jobs).values({ id: `${game.id}:${id}`, guildId: game.guildId, payload: { ...payload, gameId: game.id } }).onConflictDoNothing();
}
async function roleDm(tx: Tx, game: ZombieGame, userId: string, initial = false) {
  const p = game.players[userId]!;
  const text = p.role === "healer" ? "🩺 治療班に選ばれました。あなた自身は感染しません。\n感染者と酒場VCで連続3分以上会話して `/heal request 対象:ユーザー` で申請してください。管理承認後に治療が成立します。\n治療班であること・感染者情報は公開禁止です。自分から名乗らないでください。" :
    p.role === "zombie" ? `🧟 ${initial ? "感染源に選ばれました。あなたは最初のゾンビです。" : "あなたは感染しました。これよりゾンビ陣営です。"}\n人間と酒場VCで連続3分以上会話して \`/infect request 対象:ユーザー\` で感染申請してください。管理承認後に成立します。\nゾンビであることは公開禁止。テキスト・リアクション・無言滞在・挨拶だけの感染、迷惑行為や無理な感染は禁止です。` :
    "治療または管理者の設定により、あなたは人間状態です。イベント終了まで生存してください。役職や感染者の情報を公開しないでください。";
  await job(tx, game, `role:${userId}:${p.version}`, { kind: "dm", userId, version: p.version, text });
}
export async function getZombieConfig(guildId: string) {
  await ensureZombieSchema();
  return (await db.select().from(configs).where(eq(configs.guildId, guildId)))[0]?.config;
}
export async function updateZombieConfig(guildId: string, patch: Partial<ZombieConfig>) {
  return locked(guildId, async tx => {
    const old = (await tx.select().from(configs).where(eq(configs.guildId, guildId))).at(0)?.config;
    const config: ZombieConfig = {
      vcIds: [], excludedUsers: [], excludedRoles: [], announceId: "", rulesId: "", resultId: "",
      adminId: "", infectionLogId: "", roleLogId: "",
      rewards: Object.fromEntries(ZOMBIE_REWARDS.map(k => [k, null])) as ZombieConfig["rewards"], ...old, ...patch,
    };
    for (const amount of Object.values(config.rewards)) if (amount !== null) zombieAmount(amount);
    await tx.insert(configs).values({ guildId, config }).onConflictDoUpdate({ target: configs.guildId, set: { config } });
    return config;
  });
}
export async function changeZombieSettingList(guildId: string, key: "vcIds" | "excludedUsers" | "excludedRoles", value: string, enabled: boolean) {
  return locked(guildId, async tx => {
    const row = (await tx.select().from(configs).where(eq(configs.guildId, guildId)))[0];
    if (!row) throw new ZombieError("先に /zombie config を設定してください。");
    row.config[key] = enabled ? [...new Set([...row.config[key], value])] : row.config[key].filter(x => x !== value);
    await tx.update(configs).set({ config: row.config }).where(eq(configs.guildId, guildId));
  });
}
export async function setZombieReward(guildId: string, key: typeof ZOMBIE_REWARDS[number], value: number) {
  zombieAmount(value);
  return locked(guildId, async tx => {
    const row = (await tx.select().from(configs).where(eq(configs.guildId, guildId)))[0];
    if (!row || !ZOMBIE_REWARDS.includes(key)) throw new ZombieError("先にイベント設定を登録してください。");
    row.config.rewards[key] = value;
    await tx.update(configs).set({ config: row.config }).where(eq(configs.guildId, guildId));
  });
}
export async function getZombieGame(guildId: string) { return locked(guildId, tx => current(tx, guildId)); }
export async function getZombieGameById(id: string) {
  await ensureZombieSchema();
  return (await db.select().from(games).where(eq(games.id, id)))[0]?.state;
}
export async function startZombieGame(id: string, guildId: string, participants: { id: string; name: string }[], now = Date.now()) {
  return locked(guildId, async tx => {
    const old = await current(tx, guildId);
    if (old?.id === id) return old;
    if (old && ["preparing", "running"].includes(old.phase)) throw new ZombieError("イベントはすでに準備中または開催中です。");
    const config = (await tx.select().from(configs).where(eq(configs.guildId, guildId)))[0]?.config;
    if (!config || !config.vcIds.length || !config.adminId || !config.infectionLogId || !config.roleLogId || !config.announceId || !config.rulesId || !config.resultId)
      throw new ZombieError("公開3チャンネル・管理3チャンネル・対象VCを設定してください。");
    const unique = [...new Map(participants.map(p => [p.id, p])).values()].filter(p => !config.excludedUsers.includes(p.id));
    if (unique.length < 2) throw new ZombieError("参加対象者が2人以上必要です。");
    const game: ZombieGame = { id, guildId, phase: "preparing", config, players: Object.fromEntries(unique.map(p => [p.id, {
      ...p, role: "human", version: 0, stateAt: now, everInfected: false, infectedAt: null, infectedUsers: [], healedUsers: [],
    }])), requests: {}, presence: {}, epoch: "", observedAt: 0, createdAt: Math.max(now, (old?.createdAt ?? 0) + 1), startedAt: null, endedAt: null, winner: null, payouts: [] };
    await tx.insert(games).values({ id, guildId, state: game });
    return game;
  });
}
export async function setZombieRole(guildId: string, userId: string, role: ZombieRole, now = Date.now()) {
  return locked(guildId, async tx => {
    const game = await current(tx, guildId);
    if (!game || game.phase !== "preparing") throw new ZombieError("役職設定は準備中のみ可能です。");
    const p = game.players[userId];
    if (!p) throw new ZombieError("開始時に登録された参加者だけ指定できます。");
    if (p.role === role) return game;
    p.role = role; p.version++; p.stateAt = now; p.everInfected = role === "zombie"; p.infectedAt = role === "zombie" ? now : null;
    await roleDm(tx, game, userId, role === "zombie");
    await job(tx, game, `role-audit:${userId}:${p.version}`, { kind: "audit", channelId: game.config.roleLogId, text: `役職設定：${p.name} (${p.id}) → ${role}` });
    await save(tx, game); return game;
  });
}
export async function beginZombieGame(guildId: string, now = Date.now()) {
  return locked(guildId, async tx => {
    const game = await current(tx, guildId);
    if (game?.phase === "running") return game;
    if (!game || game.phase !== "preparing") throw new ZombieError("先に /zombie start で参加者を登録してください。");
    const updated = (await tx.select().from(configs).where(eq(configs.guildId, guildId)))[0]?.config;
    if (updated) game.config.rewards = updated.rewards;
    validateZombieRewardCapacity(game);
    if (!Object.values(game.players).some(p => p.role === "zombie") || !Object.values(game.players).some(p => p.role === "human"))
      throw new ZombieError("最初のゾンビと、人間がそれぞれ1人以上必要です（治療班は別枠）。");
    game.phase = "running"; game.startedAt = now; game.presence = {}; game.observedAt = 0;
    await job(tx, game, "announce", { kind: "announce" });
    await job(tx, game, "rules", { kind: "rules" });
    await save(tx, game); return game;
  });
}
export async function syncZombiePresence(guildId: string, epoch: string, voices: Record<string, string>, now = Date.now()) {
  return locked(guildId, async tx => {
    const game = await current(tx, guildId);
    if (!game || game.phase !== "running" || now < game.observedAt) return;
    if (game.epoch !== epoch) game.presence = {};
    for (const userId of Object.keys(game.players)) {
      const channel = voices[userId];
      if (!channel || !game.config.vcIds.includes(channel)) delete game.presence[userId];
      else if (game.presence[userId]?.channel !== channel) game.presence[userId] = { channel, since: now };
    }
    game.epoch = epoch; game.observedAt = now;
    await save(tx, game);
  });
}
export async function requestZombieAction(id: string, guildId: string, actorId: string, targetId: string, type: "infect" | "heal", now = Date.now()) {
  return locked(guildId, async tx => {
    const game = await current(tx, guildId);
    if (!game || game.phase !== "running") throw new ZombieError("開催中のイベントがありません。");
    if (game.requests[id]) {
      if (game.requests[id]!.actor !== actorId || game.requests[id]!.target !== targetId || game.requests[id]!.type !== type) throw new ZombieError("申請が一致しません。");
      return game.requests[id]!;
    }
    const actor = game.players[actorId], target = game.players[targetId];
    if (!actor || !target || actorId === targetId || actor.role !== (type === "infect" ? "zombie" : "healer"))
      throw new ZombieError("この申請はできません。参加状態・自分の役職・対象者を確認してください。");
    const proof = zombieProof(game, actor, target, now);
    for (const request of Object.values(game.requests)) if (request.status === "pending" && now - request.createdAt >= 900000) request.status = "stale";
    const pending = Object.values(game.requests).filter(r => r.status === "pending");
    if (pending.some(r => r.actor === actorId && r.target === targetId && r.type === type)) throw new ZombieError("同じ相手への申請が承認待ちです。");
    if (pending.filter(r => r.actor === actorId).length >= 10) throw new ZombieError("承認待ちの申請が10件あります。管理者の確認をお待ちください。");
    const request = { id, actor: actorId, target: targetId, type, actorVersion: actor.version, targetVersion: target.version,
      ...proof, createdAt: now, status: "pending" as const };
    game.requests[id] = request;
    await job(tx, game, `request:${id}`, { kind: "request", requestId: id });
    await save(tx, game); return request;
  });
}
async function settle(tx: Tx, game: ZombieGame, now: number) {
  const payouts = zombiePayouts(game);
  for (const p of payouts) {
    await tx.insert(walletsTable).values({ guildId: game.guildId, userId: p.userId, balance: 0 }).onConflictDoNothing();
    const credited = await tx.update(walletsTable).set({ balance: sql`${walletsTable.balance} + ${p.amount}`, updatedAt: new Date(now) })
      .where(and(eq(walletsTable.guildId, game.guildId), eq(walletsTable.userId, p.userId), sql`${walletsTable.balance} <= ${2147483647 - p.amount}`))
      .returning({ userId: walletsTable.userId });
    if (!credited.length) throw new ZombieError("報酬を加算できません。残高上限を管理者が確認してください。終了処理・感染処理も取り消しました。");
    await tx.insert(transactionsTable).values({ guildId: game.guildId, userId: p.userId, amount: p.amount,
      reason: "ゾンビイベント報酬", sessionKey: `zombie-reward:${game.id}:${p.userId}` });
    await job(tx, game, `reward:${p.userId}`, { kind: "dm", userId: p.userId, text: `イベント報酬 $${p.amount.toLocaleString("ja-JP")} を銀行Botの残高へ加算しました。` });
  }
  game.phase = "ended"; game.winner = zombieWinner(game); game.payouts = payouts; game.endedAt = now;
  for (const request of Object.values(game.requests)) if (request.status === "pending") request.status = "stale";
  await job(tx, game, "result", { kind: "result" });
}
export async function decideZombieRequest(guildId: string, eventId: string, requestId: string, adminId: string, accept: boolean, now = Date.now()) {
  return locked(guildId, async tx => {
    const game = await current(tx, guildId), request = game && Object.hasOwn(game.requests, requestId) ? game.requests[requestId] : undefined;
    if (!game || game.id !== eventId || !request) throw new ZombieError("このイベント・申請は現在の対象ではありません。");
    if (request.status !== "pending") return { game, request };
    if (game.phase !== "running") throw new ZombieError("イベントは開催中ではありません。");
    const actor = game.players[request.actor]!, target = game.players[request.target]!;
    const valid = now - request.createdAt < 900000 && request.actorVersion === actor.version && request.targetVersion === target.version
      && actor.role === (request.type === "infect" ? "zombie" : "healer") && target.role === (request.type === "infect" ? "human" : "zombie");
    request.status = !valid ? "stale" : accept ? "accepted" : "rejected"; request.decidedBy = adminId;
    if (request.status === "accepted") {
      target.role = request.type === "infect" ? "zombie" : "human"; target.version++; target.stateAt = now;
      if (request.type === "infect") {
        target.everInfected = true; target.infectedAt = now;
        actor.infectedUsers = [...new Set([...actor.infectedUsers, target.id])];
      } else { target.infectedAt = null; actor.healedUsers = [...new Set([...actor.healedUsers, target.id])]; }
      await roleDm(tx, game, target.id);
    }
    await job(tx, game, `decision:${request.id}`, { kind: "audit", channelId: game.config.infectionLogId,
      text: `申請 ${request.id} / ${request.type} / ${actor.name} (${actor.id}) → ${target.name} (${target.id})\n結果 ${request.status} / 承認者 ${adminId}\n同席 <#${request.channel}> ${request.seconds}秒` });
    await job(tx, game, `receipt:${request.id}`, { kind: "dm", userId: actor.id,
      text: `申請 ${request.id}：${request.status === "accepted" ? "管理承認により成立しました。" : "成立しませんでした。対象状態の変更・期限切れ・管理判断などによるものです。"}` });
    if (!Object.values(game.players).some(p => p.role === "human")) await settle(tx, game, now);
    await save(tx, game);
    return { game, request };
  });
}
export async function endZombieGame(guildId: string, eventId: string, cancel = false, now = Date.now(), operation?: { id: string; actor: string }) {
  return locked(guildId, async tx => {
    if (operation) {
      const receipt = (await tx.select().from(operations).where(eq(operations.id, operation.id))).at(0);
      if (receipt) {
        if (receipt.guildId !== guildId || receipt.actor !== operation.actor || receipt.action !== (cancel ? "cancel" : "end"))
          throw new ZombieError("終了操作が一致しません。");
        return (await tx.select().from(games).where(eq(games.id, receipt.gameId)))[0]!.state;
      }
    }
    const game = await current(tx, guildId);
    if (!game || game.id !== eventId) throw new ZombieError("イベントが一致しません。");
    if (["ended", "cancelled"].includes(game.phase)) {
      if (operation) await tx.insert(operations).values({ id: operation.id, guildId, actor: operation.actor, action: cancel ? "cancel" : "end", gameId: game.id });
      return game;
    }
    if (cancel) {
      game.phase = "cancelled"; game.endedAt = now;
      for (const request of Object.values(game.requests)) if (request.status === "pending") request.status = "stale";
      await job(tx, game, "cancel", { kind: "audit", channelId: game.config.adminId, text: "管理者がイベントを中止しました。報酬は配布しません。" });
    } else {
      if (game.phase !== "running") throw new ZombieError("準備中は /zombie cancel で中止してください。");
      await settle(tx, game, now);
    }
    await save(tx, game);
    if (operation) await tx.insert(operations).values({ id: operation.id, guildId, actor: operation.actor, action: cancel ? "cancel" : "end", gameId: game.id });
    return game;
  });
}
