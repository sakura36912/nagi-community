import { describe, expect, it } from "vitest";
import { bossBattleNotice, bossDeadline, bossDuration, bossEventEmbed, bossHp } from "../lib/bossUi";
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
    expect(embed.fields?.find(f => f.name === "ボスHP")?.value).toContain("100,000");
    expect(embed.fields?.find(f => f.name === "パーティ受付")?.value).toContain("5分");
    expect(embed.fields?.some(f => f.name === "特殊イベント")).toBe(false);
    expect(bossEventEmbed({ ...event, config: { ...event.config, special: "double_reward" } }).toJSON().fields)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "特殊イベント" })]));
  });
  it("shows prices separately and identifies start posts as snapshots, not live HP", () => {
    const embed = bossBattleNotice(bundle("active")).toJSON();
    expect(embed.fields?.find(f => f.name === "攻撃 / 1回")?.value).toBe("**無料（$0）**");
    expect(embed.fields?.find(f => f.name === "回復 / 1回")?.value).toBe("**$50,000**");
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
