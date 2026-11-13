import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { bossBattleNotice, bossBattleControls, bossDeadline, bossDuration, bossEventEmbed, bossHp, bossImageAttachment } from "../lib/bossUi";
import type { BossEvent, BossNoticeBundle } from "@workspace/db";

const event = {
  bossType: "kraken", endsAt: new Date("2026-10-30T11:00:00Z"),
  config: { soloHp: 100000, partyHp: 200000, reward: 500000, lobbySeconds: 300, special: "none" },
} as BossEvent;
function bundle(status: string): BossNoticeBundle {
  return {
    event, battle: { status, mode: "solo", id: "test", currentHp: 99998, maxHp: 100000,
      attackCost: 10000, healCost: 50000, endsAt: event.endsAt, lobbyEndsAt: event.endsAt,
      startedAt: new Date("2026-10-30T10:00:00Z"), finishedAt: new Date("2026-10-30T10:58:51Z"),
      reason: status === "failed" ? "制限時間終了" : null, rewards: [{ userId: "one", amount: 500000 }] },
    members: [{ userId: "one", displayName: "*sakura*", hp: 494147, maxHp: 500000, damage: 2 }],
  } as BossNoticeBundle;
}
describe("readable Discord boss embeds", () => {
  it("places attack and priced healing controls only on active public battle cards", () => {
    const rows = bossBattleControls(bundle("active")).map(row => row.toJSON());
    expect(rows[0]!.components[0]).toMatchObject({ custom_id: "boss:part:test", placeholder: "攻撃する部位を選択" });
    expect((rows[0]!.components[0] as { options: { label: string; value: string }[] }).options)
      .toContainEqual(expect.objectContaining({ label: "左触手", value: "left_tentacle" }));
    expect(rows[1]!.components[0]).toMatchObject({
      custom_id: "boss:heal:test", label: "回復（$50,000）", disabled: false,
    });
    expect(bossBattleNotice(bundle("active")).toJSON().description).toContain("部位メニュー");
    for (const status of ["waiting", "won", "failed", "cancelled"]) {
      expect(bossBattleControls(bundle(status))).toEqual([]);
    }
  });
  it("disables healing when the fee is not configured while retaining part selection", () => {
    const data = bundle("active");
    data.battle.healCost = 0;
    const rows = bossBattleControls(data).map(row => row.toJSON());
    expect(rows[0]!.components[0]).toMatchObject({ custom_id: "boss:part:test" });
    expect(rows[1]!.components[0]).toMatchObject({ label: "回復（料金未設定）", disabled: true });
  });
  it("disables broken parts and enables body attacks only after all parts break", () => {
    const data = bundle("active");
    data.battle.parts = {
      left_tentacle: { hp: 0, maxHp: 20000 },
      right_tentacle: { hp: 0, maxHp: 20000 },
      head: { hp: 0, maxHp: 20000 },
    };
    const options = bossBattleControls(data)[0]!.toJSON().components[0] as { options: { label: string; value: string; description?: string }[] };
    expect(options.options).toEqual([expect.objectContaining({ label: "本体", value: "body", description: "すべての部位が破壊済みです" })]);
    const broken = bundle("active");
    broken.battle.parts = { left_tentacle: { hp: 0, maxHp: 20000 } };
    const partOptions = (bossBattleControls(broken)[0]!.toJSON().components[0] as { options: { value: string; disabled?: boolean; description?: string }[] }).options;
    expect(partOptions.some(option => option.value === "left_tentacle")).toBe(false);
  });
  it("explains wallet HP and maximum-HP percentage healing without exposing weapon stats", () => {
    const output = JSON.stringify(bossEventEmbed({ ...event, config: { ...event.config,
      playerHpSource: "wallet", healingMode: "max_hp_10_percent" } }).toJSON());
    expect(output).toContain("参加確定時の所持金");
    expect(output).toContain("最大HPの10%");
    expect(output).toContain("残高は減りません");
    expect(output).not.toContain("内部攻撃力");
  });
  it("formats durations as hours/minutes/seconds rather than long raw seconds", () => {
    expect(bossDuration(3531)).toBe("58分51秒");
    expect(bossDuration(3660)).toBe("1時間1分");
    expect(bossDuration(300)).toBe("5分");
    expect(bossDuration(0)).toBe("0秒");
  });
  it("renders bounded HP bars including zero and full HP", () => {
    expect(bossHp(50, 100)).toContain("■■■■■□□□□□");
    expect(bossHp(0, 100)).toContain("□□□□□□□□□□");
    expect(bossHp(100, 100)).toContain("■■■■■■■■■■");
    expect(bossHp(1, 0)).not.toContain("NaN");
    expect(bossHp(99998, 100000)).toContain("99.99%");
    expect(bossHp(1, 100000)).toContain("0.01%未満");
  });
  it("shows absolute Japanese time alongside Discord relative time", () => {
    expect(bossDeadline(event.endsAt)).toContain("10/30 20:00（日本時間）");
    expect(bossDeadline(event.endsAt)).toContain(":R>");
  });
  it("groups event HP and rewards without a redundant no-special field", () => {
    const embed = bossEventEmbed(event).toJSON();
    expect(embed.image?.url).toBe("attachment://boss-kraken.jpg");
    expect(embed.fields?.find(f => f.name === "ボスHP")?.value).toContain("100,000");
    expect(embed.fields?.find(f => f.name === "パーティ受付")?.value).toContain("5分");
    expect(embed.fields?.some(f => f.name === "特殊イベント")).toBe(false);
    expect(bossEventEmbed({ ...event, config: { ...event.config, special: "double_reward" } }).toJSON().fields)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "特殊イベント" })]));
  });
  it.each([
    ["kraken", "boss-kraken.jpg"],
    ["megalodon", "boss-megalodon.jpg"],
    ["leviathan", "boss-leviathan.jpg"],
  ] as const)("uses the matching illustration for %s", (bossType, filename) => {
    const bossEvent = { ...event, bossType } as BossEvent;
    expect(bossEventEmbed(bossEvent).toJSON().image?.url).toBe(`attachment://${filename}`);
    const attachment = bossImageAttachment(bossType);
    expect(attachment.name).toBe(filename);
    expect(typeof attachment.attachment).toBe("string");
    expect(existsSync(attachment.attachment as string)).toBe(true);
  });
  it("shows prices separately and identifies start posts as snapshots, not live HP", () => {
    const embed = bossBattleNotice(bundle("active")).toJSON();
    expect(embed.fields?.find(f => f.name === "攻撃 / 1回")?.value).toBe("**無料（$0）**");
    expect(embed.fields?.find(f => f.name === "回復 / 1回")?.value).toBe("**$50,000**");
    expect(embed.fields?.find(f => f.name === "部位の状態")?.value).toContain("左触手");
    expect(embed.fields?.find(f => f.name === "個別クールタイム")?.value).toContain("攻撃 5秒 ／ 回復 30秒");
    expect(embed.footer?.text).toContain("投稿時点の記録");
    expect(JSON.stringify(embed)).not.toContain("ダメージランキング");
  });
  it("keeps failure summaries short with readable duration and final ranking", () => {
    const embed = bossBattleNotice(bundle("failed")).toJSON();
    expect(embed.color).toBe(0xc84c4c);
    expect(embed.fields?.find(f => f.name === "戦闘記録")?.value).toContain("58分51秒");
    expect(embed.fields?.find(f => f.name.startsWith("参加者"))?.value).not.toContain("494,147");
    expect(embed.fields?.find(f => f.name === "終了理由")?.value).toBe("制限時間終了");
    expect(embed.fields?.some(f => f.name === "終了時ダメージランキング")).toBe(true);
  });
  it("retains settled rewards, escapes nicknames and respects Discord limits for every status", () => {
    for (const status of ["waiting", "active", "won", "failed", "cancelled"]) {
      const data = bundle(status);
      const player = data.members[0]!;
      data.members = [0, 1, 2, 3].map(i => ({ ...player, userId: String(i), displayName: `**${"名".repeat(32)}**` }));
      const embed = bossBattleNotice(data).toJSON();
      expect(embed.fields!.length).toBeLessThanOrEqual(25);
      for (const field of embed.fields!) expect(field.value.length).toBeLessThanOrEqual(1024);
      expect(JSON.stringify(embed).length).toBeLessThan(6000);
      expect(embed.fields?.find(f => f.name.startsWith("参加者"))?.value).toContain("\\*");
    }
    expect(bossBattleNotice(bundle("won")).toJSON().fields?.find(f => f.name === "獲得報酬（加算済み）")?.value).toContain("$500,000");
  });
});
