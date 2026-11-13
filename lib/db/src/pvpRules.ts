import { bossHealing, bossPlayerAttack, type BossConfig, type BossFighter } from "./bossRules";
import { BOSS_ATTACK_OPENINGS, BOSS_COMBO_PROFILES, bossCombo } from "./bossAttackEffects";
import { forgeRoll, isForgeWeaponType } from "./forgeRules";

export class PvpError extends Error {}
export interface PvpState {
  players: BossFighter[];
  healCost: number | null;
  durationMinutes: number;
  /** Fixed bounty values snapshotted when this duel is created; absent only on legacy escrow duels. */
  bounties?: { challenger: number; target: number };
  winnerId?: string;
  reason?: string;
  lines: string[];
}
export const PVP_ATTACK_SECONDS = 5;
export const PVP_HEAL_SECONDS = 30;
export function pvpCombatConfig(defense: number): BossConfig {
  return {
    soloHp: 1, partyHp: 1, attack: 1, defense, reward: 0,
    durationSeconds: 1800, lobbySeconds: 120, playerHp: 1, healAmount: 1,
    counterEvery: 3, cooldownSeconds: 1, criticalPercent: 10, criticalMultiplier: 1.5,
    levelBonusPercent: 5, special: "none", bonusRoleId: null, roleMultiplier: 1,
    playerHpSource: "wallet", healingMode: "max_hp_10_percent",
  };
}
/** Uses exactly the boss weapon damage, combo and skill rules, without boss-only counterattacks. */
export function pvpCombat(
  players: BossFighter[], userId: string, action: "attack" | "heal", now: Date, roll = forgeRoll,
) {
  const copy = structuredClone(players);
  const player = copy.find(p => p.userId === userId);
  const target = copy.find(p => p.userId !== userId);
  if (!player || !target || player.hp <= 0 || target.hp <= 0) throw new PvpError("戦闘できる状態ではありません。");
  const key = action === "attack" ? "attackReadyAt" : "healReadyAt";
  const wait = (player.effects[key] ?? 0) - now.getTime();
  if (wait > 0) throw new PvpError(`あと${Math.ceil(wait / 1000)}秒待ってください。`);
  let lines: string[], paidHeal = false;
  if (action === "heal") {
    const healed = bossHealing(player, pvpCombatConfig(0));
    if (healed <= 0) throw new PvpError("HPが満タンです。料金は消費していません。");
    player.hp += healed;
    lines = [`🩹 HPが${healed.toLocaleString("ja-JP")}回復！`];
    paidHeal = true;
  } else {
    const type = player.weapon.weaponType;
    if (!isForgeWeaponType(type)) throw new PvpError("武器の設定が不正です。");
    const result = bossPlayerAttack(player, pvpCombatConfig(target.weapon.defense), roll);
    const combo = bossCombo(type, target.effects.shield ? Math.max(1, Math.floor(result.damage / 2)) : result.damage, target.hp, roll);
    target.effects.shield = false;
    target.hp -= combo.damage;
    player.damage += combo.damage; player.attackCount++;
    const openings = BOSS_ATTACK_OPENINGS[type];
    const random = roll();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new PvpError("乱数が不正です。");
    // Exclude the last opening rather than repeatedly rerolling.
    const last = player.effects.lastAttackWeapon === type ? player.effects.lastAttackOpening : undefined;
    const exclude = last !== undefined && last >= 0 && last < openings.length;
    let opening = Math.floor(random * (openings.length - (exclude ? 1 : 0)));
    if (exclude && opening >= last!) opening++;
    player.effects.lastAttackOpening = opening; player.effects.lastAttackWeapon = type;
    lines = [openings[opening]!];
    if (result.critical) lines.push("✨ 武器が眩しく輝く… 💥 クリティカル！");
    combo.hits.forEach((hit, i) => {
      if (i > 0) lines.push(BOSS_COMBO_PROFILES[type].followup);
      lines.push(`💥 ${i + 1}撃目：${hit.toLocaleString("ja-JP")}ダメージ！`);
    });
    if (combo.hits.length > 1) lines.push(`🔥 合計${combo.damage.toLocaleString("ja-JP")}ダメージ！`);
    if (result.skill) lines.push(`固有スキル：${result.skill}`);
    if (result.shield) player.effects.shield = true;
    if (result.supportHeal && player.hp < player.maxHp) {
      const healed = Math.min(player.maxHp - player.hp, Math.max(1, Math.floor(player.maxHp * 0.2)));
      player.hp += healed; lines.push(`🪄 ヒール：自分のHPが${healed.toLocaleString("ja-JP")}回復！`);
    }
    if (combo.overkill) lines.push("⚔️ オーバーキル！");
    if (target.hp === 0) lines.push("⚔️ 最後の一撃！ 対戦に勝利！");
  }
  player.effects[key] = now.getTime() + (action === "attack" ? PVP_ATTACK_SECONDS : PVP_HEAL_SECONDS) * 1000;
  return { players: copy, lines, paidHeal, winnerId: target.hp === 0 ? player.userId : undefined };
}
