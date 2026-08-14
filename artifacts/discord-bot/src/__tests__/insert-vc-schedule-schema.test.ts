/**
 * Tests for insertVcScheduleSchema – guildId, channelId, and channelName validation.
 *
 * drizzle-zod emits z.string() for NOT NULL text columns, which still accepts
 * "". The schema is extended with .min(1) so API callers get early feedback
 * instead of allowing blank values through to the database.
 */

import { describe, expect, it } from "vitest";
import { insertVcScheduleSchema } from "@workspace/db/schema";

const validBase = {
  guildId: "guild-1",
  channelId: "channel-1",
  channelName: "my-channel",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
};

describe("insertVcScheduleSchema – channelName validation", () => {
  it("accepts a non-empty channelName", () => {
    const result = insertVcScheduleSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("rejects an empty channelName", () => {
    const result = insertVcScheduleSchema.safeParse({
      ...validBase,
      channelName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only channelName", () => {
    const result = insertVcScheduleSchema.safeParse({
      ...validBase,
      channelName: "   ",
    });
    expect(result.success).toBe(false);
  });
});

describe("insertVcScheduleSchema – guildId validation", () => {
  it("accepts a non-empty guildId", () => {
    const result = insertVcScheduleSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("rejects an empty guildId", () => {
    const result = insertVcScheduleSchema.safeParse({
      ...validBase,
      guildId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only guildId", () => {
    const result = insertVcScheduleSchema.safeParse({
      ...validBase,
      guildId: "   ",
    });
    expect(result.success).toBe(false);
  });
});

describe("insertVcScheduleSchema – channelId validation", () => {
  it("accepts a non-empty channelId", () => {
    const result = insertVcScheduleSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("rejects an empty channelId", () => {
    const result = insertVcScheduleSchema.safeParse({
      ...validBase,
      channelId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only channelId", () => {
    const result = insertVcScheduleSchema.safeParse({
      ...validBase,
      channelId: "   ",
    });
    expect(result.success).toBe(false);
  });
});
