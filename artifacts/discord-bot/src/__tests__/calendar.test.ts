import { describe, expect, it } from "vitest";
import {
  buildEventEmbed,
  buildMonthEmbed,
  calendarCommand,
  getMonthRange,
  parseJstDateTime,
} from "../commands/calendar.js";

describe("calendar date handling", () => {
  it("parses valid JST date/time and rejects impossible dates", () => {
    const parsed = parseJstDateTime("2026-09-15", "21:30");
    expect(parsed?.toISOString()).toBe("2026-09-15T12:30:00.000Z");
    expect(parseJstDateTime("2026-02-30", "21:30")).toBeNull();
    expect(parseJstDateTime("2026-09-15", "24:00")).toBeNull();
  });

  it("builds an inclusive JST month range", () => {
    const range = getMonthRange("2026-09");
    expect(range?.label).toBe("2026年9月");
    expect(range?.from.toISOString()).toBe("2026-08-31T15:00:00.000Z");
    expect(range?.to.toISOString()).toBe("2026-09-30T14:59:59.999Z");
    expect(getMonthRange("2026-13")).toBeNull();
  });
});

describe("calendar display", () => {
  it("renders event details with the participant count", () => {
    const embed = buildEventEmbed(
      {
        id: 12,
        title: "定例会",
        description: "今月の連絡事項",
        scheduledAt: new Date("2026-09-15T12:00:00.000Z"),
      },
      ["user-1", "user-2"],
    );
    expect(embed.data.title).toBe("📅 定例会");
    expect(embed.data.description).toBe("今月の連絡事項");
    expect(embed.data.fields?.some((field) => field.name === "参加予定" && field.value === "2名")).toBe(true);
  });

  it("groups monthly events by JST calendar day", () => {
    const embed = buildMonthEmbed("2026年9月", [
      { id: 1, title: "夜会", scheduledAt: new Date("2026-09-01T14:00:00.000Z") },
      { id: 2, title: "昼会", scheduledAt: new Date("2026-09-02T03:00:00.000Z") },
    ]);
    expect(embed.data.description).toContain("#1 夜会");
    expect(embed.data.description).toContain("#2 昼会");
    expect(embed.data.description).toContain("9/1");
    expect(embed.data.description).toContain("9/2");
  });

  it("registers the setup, create, list, show, and delete subcommands", () => {
    const json = calendarCommand.data.toJSON() as { name?: string; options?: Array<{ name?: string }> };
    expect(json.name).toBe("calendar");
    expect(json.options?.map((option) => option.name)).toEqual([
      "setup",
      "create",
      "list",
      "show",
      "delete",
    ]);
  });
});