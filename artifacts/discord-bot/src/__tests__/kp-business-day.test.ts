import { describe, expect, it } from "vitest";
import { kpBusinessDay, latestKpBusinessDate } from "../lib/kpBusinessDay";

describe("KP sales business day in Japan", () => {
  it.each([
    ["2026-11-08T17:59:59+09:00", "2026-11-07"],
    ["2026-11-08T18:00:00+09:00", "2026-11-08"],
    ["2026-11-09T00:00:00+09:00", "2026-11-08"],
    ["2026-11-09T09:59:59+09:00", "2026-11-08"],
    ["2026-11-09T10:00:00+09:00", "2026-11-08"],
    ["2027-01-01T02:00:00+09:00", "2026-12-31"],
  ])("defaults to the latest opening date at %s", (now, expected) => {
    expect(latestKpBusinessDate(new Date(now))).toBe(expected);
  });
  it.each(["2026-11-08", "2026-12-31", "2028-02-29"])("builds a 16-hour overnight window for %s", date => {
    const period = kpBusinessDay(date);
    expect(period.start.toISOString()).toBe(`${date}T09:00:00.000Z`);
    expect(period.end.getTime() - period.start.getTime()).toBe(16 * 60 * 60_000);
    expect(period.label).toContain(`${date} 18:00`);
    expect(period.label).toContain("10:00");
  });
  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-11-00", "2026/11/08", "2026-1-8", ""])(
    "rejects invalid business dates: %s", date => expect(() => kpBusinessDay(date)).toThrow(),
  );
});
