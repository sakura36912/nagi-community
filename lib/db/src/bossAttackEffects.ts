import { ForgeError, FORGE_MAX_INT, forgeRoll, type ForgeWeaponType } from "./forgeRules";
import type { BossEffects, BossType } from "./bossRules";

/** Hand-authored weapon-specific openings; indexes are persisted, not picked by the UI. */
export const BOSS_ATTACK_OPENINGS: Record<ForgeWeaponType, readonly string[]> = {
  greatsword: [
    "⚔️ 大剣を豪快に振り下ろした！", "⚔️ 力を込めて叩き斬った！", "⚔️ 渾身の一撃を放った！",
    "⚔️ 大剣を構え、回転斬り！", "⚔️ 地面をえぐるほどの斬撃！", "⚔️ 両手で大剣を振り抜いた！",
    "⚔️ 頭上から重い刃を叩き込んだ！", "⚔️ 踏み込みとともに横一閃！", "⚔️ 腰を落とし、逆袈裟斬り！",
    "⚔️ 大剣で敵の守りを打ち砕く！", "⚔️ 跳び上がり、刃を振り下ろす！", "⚔️ 遠心力を乗せた大回転！",
    "⚔️ 低い構えから刃を斬り上げた！", "⚔️ 一瞬の隙に重撃を叩き込む！", "⚔️ 肩越しに大剣を担ぎ、強襲！",
    "⚔️ 体重を乗せた真っ向斬り！", "⚔️ 敵の懐へ飛び込み、一刀両断！", "⚔️ 波を裂くような大薙ぎ！",
    "⚔️ 大剣の切っ先が弧を描く！", "⚔️ 全身の力を大剣に込めた！",
  ],
  sword: [
    "🗡️ 片手剣で鋭く斬りつけた！", "🗡️ 素早く踏み込み、突き攻撃！", "🗡️ 片手剣を横に薙いだ！",
    "🗡️ 軽やかに踏み込み、一閃！", "🗡️ 刃を返し、逆手から斬撃！", "🗡️ 敵の隙を突いて斬り上げた！",
    "🗡️ 低い姿勢から足元を狙う！", "🗡️ 身をひるがえし、回転斬り！", "🗡️ 正確な剣先で急所を狙う！",
    "🗡️ 半歩踏み出し、鋭い刺突！", "🗡️ 片手剣を振り抜き、袈裟斬り！", "🗡️ フェイントから刃を走らせた！",
    "🗡️ 敵の動きを読み、迎撃の一閃！", "🗡️ 跳び込んで斜めに斬り払う！", "🗡️ 手首を返し、刃がきらめく！",
    "🗡️ 懐に潜り込み、素早く斬る！", "🗡️ 鋭い踏み込みで守りを崩す！", "🗡️ 剣先を滑らせ、脇を突く！",
    "🗡️ 息を合わせて横一文字！", "🗡️ 流れるような剣さばき！",
  ],
  spear: [
    "🔱 槍を構えて突進した！", "🔱 鋭い穂先を突き出した！", "🔱 跳び込み、槍を突き下ろす！",
    "🔱 長い間合いからなぎ払い！", "🔱 腰をひねり、全力の刺突！", "🔱 穂先が一直線に走る！",
    "🔱 敵の懐を狙って踏み込む！", "🔱 槍を回し、勢いよく薙いだ！", "🔱 低く構え、足元を払った！",
    "🔱 上段から鋭く突き込んだ！", "🔱 突進の勢いを穂先に乗せる！", "🔱 槍を引き絞り、穿つ一撃！",
    "🔱 距離を測り、的確な突き！", "🔱 敵の動きに合わせて迎撃！", "🔱 長槍で大きく弧を描いた！",
    "🔱 踏み込みから逆袈裟に払う！", "🔱 槍先が波しぶきを切り裂く！", "🔱 身を沈め、斜め上へ刺突！",
    "🔱 穂先を翻し、死角を突いた！", "🔱 全身をばねにして突き放つ！",
  ],
  bow: [
    "🏹 弓を引き絞り、チャージショット！", "🏹 狙いを定め、矢を放った！", "🏹 風を読み、鋭い一射！",
    "🏹 敵の隙へ矢を射ち込んだ！", "🏹 高く放った矢が降り注ぐ！", "🏹 弦が鳴り、矢が空を裂く！",
    "🏹 膝をつき、正確な射撃！", "🏹 跳び退きながら矢を放つ！", "🏹 満月のように弓を引いた！",
    "🏹 波間を縫うような一射！", "🏹 敵の動きを先読みして射る！", "🏹 鋭い鏃が一直線に飛んだ！",
    "🏹 息を止め、狙撃の一矢！", "🏹 弓を傾け、死角から射撃！", "🏹 低い軌道で矢を走らせた！",
    "🏹 空高く狙い、曲射を放つ！", "🏹 しなる弓から全力の一射！", "🏹 矢羽がきらめき、敵を捉える！",
    "🏹 追い風を味方に矢を放つ！", "🏹 引き切った弦から渾身の射撃！",
  ],
  dual: [
    "⚔️⚔️ 双剣を交差させて斬り込む！", "⚔️⚔️ 左右の刃がきらめいた！", "⚔️⚔️ 双剣を広げ、回転斬り！",
    "⚔️⚔️ 疾風のように懐へ飛び込む！", "⚔️⚔️ 右の刃を鋭く振り抜く！", "⚔️⚔️ 左の刃で敵の隙を裂く！",
    "⚔️⚔️ 身をひねり、交差斬り！", "⚔️⚔️ 低い姿勢から斬り上げた！", "⚔️⚔️ 二つの刃が弧を描く！",
    "⚔️⚔️ 跳び込み、双刃を叩き込む！", "⚔️⚔️ 敵の脇へ回り込み、斬撃！", "⚔️⚔️ 軽やかな足運びで強襲！",
    "⚔️⚔️ 双剣を翻し、死角を狙う！", "⚔️⚔️ 刃を合わせ、渾身の突進！", "⚔️⚔️ 体を回転させて薙ぎ払う！",
    "⚔️⚔️ 波しぶきの中を駆け抜ける！", "⚔️⚔️ 鋭い踏み込みから双刃一閃！", "⚔️⚔️ 敵の目前で刃を交差させる！",
    "⚔️⚔️ 逆手に構えた双剣が走る！", "⚔️⚔️ 風を切り裂く双刃の舞！",
  ],
  staff: [
    "🪄 杖から魔法弾を放った！", "🪄 雷撃が敵を貫いた！", "🪄 炎の魔法が渦を巻く！",
    "🪄 氷の槍を撃ち出した！", "🪄 杖先に集めた光を放つ！", "🪄 魔法陣から閃光が走る！",
    "🪄 灼熱の火球を叩き込んだ！", "🪄 凍てつく風が敵を包む！", "🪄 空を裂く稲妻を呼び寄せる！",
    "🪄 魔力を練り上げ、衝撃波！", "🪄 杖を振り、光の矢を放つ！", "🪄 青い炎が敵へ迫る！",
    "🪄 水晶のような氷弾を放った！", "🪄 紫電をまとった魔法弾！", "🪄 足元の魔法陣が輝いた！",
    "🪄 魔力の奔流を解き放つ！", "🪄 杖を掲げ、星の光を落とす！", "🪄 渦巻く風の刃が襲う！",
    "🪄 炎を圧縮し、一点に撃つ！", "🪄 杖先の宝石が輝き、魔力炸裂！",
  ],
};

// Three variations for each damage tier plus three critical reactions = 12 per boss.
export const BOSS_REACTIONS: Record<BossType, readonly string[]> = {
  kraken: [
    "🐙 クラーケンは少し怯んだ…", "🐙 クラーケンの触手がぴくりと動いた…", "🐙 クラーケンが水しぶきを上げた…",
    "🐙 クラーケンが苦しそうに叫んだ！", "🐙 クラーケンの触手が大きくうねる！", "🐙 クラーケンが怒りの墨を吐いた！",
    "🐙 クラーケンが大きくよろめいた！", "🐙 クラーケンの巨体が海面を揺らす！", "🐙 クラーケンが触手を引き、身を守る！",
    "🐙 クラーケンの急所に命中！！", "🐙 クラーケンが悲鳴を上げてのけぞった！！", "🐙 クラーケンの動きが一瞬止まった！！",
  ],
  megalodon: [
    "🦈 メガロドンはわずかに泳ぎを乱した…", "🦈 メガロドンが尾びれを揺らした…", "🦈 メガロドンが海中で身をひねった…",
    "🦈 メガロドンが牙をむいて暴れた！", "🦈 メガロドンが激しく水面を叩く！", "🦈 メガロドンの突進が鈍った！",
    "🦈 メガロドンが大きく体勢を崩した！", "🦈 メガロドンの巨体が海面から跳ねた！", "🦈 メガロドンが深く沈み、苦しんでいる！",
    "🦈 メガロドンの急所を捉えた！！", "🦈 メガロドンが衝撃にのけぞった！！", "🦈 メガロドンの動きを止める会心の一撃！！",
  ],
  leviathan: [
    "🐉 リヴァイアサンの鱗が小さく震えた…", "🐉 リヴァイアサンが静かに身じろぎした…", "🐉 リヴァイアサンの尾が波を立てた…",
    "🐉 リヴァイアサンが低く唸った！", "🐉 リヴァイアサンの巨体がうねる！", "🐉 リヴァイアサンが怒りの咆哮を放つ！",
    "🐉 リヴァイアサンが大きくよろめいた！", "🐉 リヴァイアサンの体勢が崩れ、大波が起きる！", "🐉 リヴァイアサンが苦悶の叫びを上げた！",
    "🐉 リヴァイアサンの急所に直撃！！", "🐉 リヴァイアサンの咆哮が途切れた！！", "🐉 リヴァイアサンが衝撃で身を反らした！！",
  ],
};
export const BOSS_COMBO_PROFILES: Record<ForgeWeaponType, { chance: number; continuation: number; maxHits: number; power: number; followup: string }> = {
  greatsword: { chance: 0.18, continuation: 0.25, maxHits: 2, power: 0.55, followup: "🔥 返す大剣で追撃！" },
  sword: { chance: 0.30, continuation: 0.40, maxHits: 3, power: 0.50, followup: "🔥 素早い連続斬り！" },
  spear: { chance: 0.22, continuation: 0.30, maxHits: 3, power: 0.50, followup: "🔥 間髪入れずに連続突き！" },
  bow: { chance: 0.28, continuation: 0.35, maxHits: 3, power: 0.45, followup: "🔥 続けて矢を射ち込む！" },
  dual: { chance: 0.65, continuation: 0.60, maxHits: 5, power: 0.40, followup: "🔥 さらに双剣の追撃！" },
  staff: { chance: 0.20, continuation: 0.30, maxHits: 3, power: 0.50, followup: "🔥 追加の魔法弾が炸裂！" },
};
function random(roll: () => number) {
  const value = roll();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new ForgeError("乱数が不正です。");
  return value;
}
export interface BossCombo {
  hits: number[];
  damage: number;
  potentialDamage: number;
  overkill: boolean;
}
/** Extra hits use reduced post-defense base damage, stop on defeat and never trigger extra turns. */
export function bossCombo(type: ForgeWeaponType, baseDamage: number, hp: number, roll = forgeRoll): BossCombo {
  if (![baseDamage, hp].every(n => Number.isInteger(n) && n > 0 && n <= FORGE_MAX_INT)) {
    throw new ForgeError("攻撃ダメージまたは残りHPが不正です。");
  }
  const profile = BOSS_COMBO_PROFILES[type];
  const hits = [Math.min(hp, baseDamage)];
  let remaining = hp - hits[0]!, potentialDamage = baseDamage;
  for (let index = 1; index < profile.maxHits && remaining > 0; index++) {
    if (random(roll) >= (index === 1 ? profile.chance : profile.continuation)) break;
    const attempted = Math.max(1, Math.floor(baseDamage * profile.power * (0.9 + random(roll) * 0.2)));
    potentialDamage += attempted;
    const applied = Math.min(remaining, attempted);
    hits.push(applied);
    remaining -= applied;
  }
  return { hits, damage: hp - remaining, potentialDamage, overkill: potentialDamage >= hp * 1.5 && potentialDamage > hp };
}
function pick(length: number, previous: number | undefined, roll: () => number, offset = 0) {
  const eligible = Array.from({ length }, (_, i) => i + offset).filter(i => i !== previous);
  return eligible[Math.floor(random(roll) * eligible.length)]!;
}
const bossNames = { kraken: "クラーケン", megalodon: "メガロドン", leviathan: "リヴァイアサン" };
const finishes = {
  kraken: "🌊 巨大な触手を斬り払い、クラーケンを討伐しました！！",
  megalodon: "🌊 猛進する巨体を打ち破り、メガロドンを討伐しました！！",
  leviathan: "🌊 海を揺らす巨体を打ち破り、リヴァイアサンを討伐しました！！",
};
export interface BossAttackPresentation {
  lines: string[];
  hits: number[];
  potentialDamage: number;
  overkill: boolean;
  finish: boolean;
}
/** Generate inside the combat transaction; the stored receipt is reused on duplicate delivery. */
export function bossAttackPresentation(
  type: ForgeWeaponType, boss: BossType, combo: BossCombo,
  input: { critical: boolean; finished: boolean; maxHp: number; effects: BossEffects },
  roll = forgeRoll,
) {
  const opening = pick(BOSS_ATTACK_OPENINGS[type].length,
    input.effects.lastAttackWeapon === type ? input.effects.lastAttackOpening : undefined, roll);
  const tier = input.critical ? 3 : combo.damage >= input.maxHp * 0.15 ? 2 : combo.damage >= input.maxHp * 0.05 ? 1 : 0;
  const reaction = pick(3, input.effects.lastAttackReaction, roll, tier * 3);
  const lines = [BOSS_ATTACK_OPENINGS[type][opening]!];
  if (input.critical) lines.push("✨ 武器が眩しく輝く…", "💥💥 クリティカル！！");
  combo.hits.forEach((hit, index) => {
    if (index > 0) lines.push(`${BOSS_COMBO_PROFILES[type].followup}（${index + 1}撃目）`);
    lines.push(`💥 ${index === 0 && combo.hits.length > 1 ? "1撃目！ " : ""}${bossNames[boss]}に **${hit.toLocaleString("ja-JP")}ダメージ！**`);
  });
  if (combo.hits.length > 1) lines.push(`🔥 **${combo.hits.length}連撃！ 合計 ${combo.damage.toLocaleString("ja-JP")}ダメージ！**`);
  lines.push(BOSS_REACTIONS[boss][reaction]!);
  if (combo.overkill) lines.push("⚔️ 渾身の一撃！ **オーバーキル！！**",
    `💥 威力 ${combo.potentialDamage.toLocaleString("ja-JP")}！ 残りHPを超えた分はダメージ集計に含めません。`);
  if (input.finished) lines.push("⚔️ 最後の一撃！！", finishes[boss], "🎉 **討伐成功！！**");
  return {
    presentation: { lines, hits: combo.hits, potentialDamage: combo.potentialDamage,
      overkill: combo.overkill, finish: input.finished } satisfies BossAttackPresentation,
    effects: { ...input.effects, lastAttackWeapon: type, lastAttackOpening: opening, lastAttackReaction: reaction },
  };
}
