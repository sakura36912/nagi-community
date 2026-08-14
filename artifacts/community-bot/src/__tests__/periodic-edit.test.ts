/**
 * Tests for the /periodic edit subcommand.
 *
 * Confirms that:
 * - A non-existent or cross-guild ID returns the "ID が見つかりません" error
 *   reply and never silently appears to succeed.
 * - Happy paths (message-only, interval-only, both fields) reply with the
 *   updated-embed success response.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  return { update, set, where, returning };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      update: mocks.update,
    },
    periodicMessagesTable: tbl("periodicMessages"),
  };
});

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { periodicCommand } from "../commands/periodic.js";

// ─── Interaction factory ──────────────────────────────────────────────────────
function makeInteraction(opts: {
  guildId?: string | null;
  id?: number;
  message?: string | null;
  interval?: number | null;
}) {
  const { guildId = "guild-123", id = 99, message = null, interval = null } = opts;

  return {
    guildId,
    options: {
      getSubcommand: () => "edit",
      getInteger: (name: string, _required?: boolean) => {
        if (name === "id") return id;
        if (name === "interval") return interval;
        return null;
      },
      getString: (name: string, _required?: boolean) => {
        if (name === "message") return message;
        return null;
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/periodic edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no row found (ID does not belong to guild)
    mocks.returning.mockResolvedValue([]);
  });

  // ── Not-found / cross-guild path ─────────────────────────────────────────

  it("replies ephemeral with 'が見つかりません' when no row is returned (ID not in guild)", async () => {
    mocks.returning.mockResolvedValue([]);

    const interaction = makeInteraction({ id: 42, message: "hello" });
    await periodicCommand.execute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const [[arg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(arg.ephemeral).toBe(true);
    expect(arg.content).toMatch(/が見つかりません/);
  });

  it("includes the requested ID in the not-found error message", async () => {
    mocks.returning.mockResolvedValue([]);

    const interaction = makeInteraction({ id: 777, message: "updated text" });
    await periodicCommand.execute(interaction as never);

    const [[arg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(arg.content).toContain("777");
  });

  it("does NOT reply with an embed when the ID is not found", async () => {
    mocks.returning.mockResolvedValue([]);

    const interaction = makeInteraction({ id: 1, message: "x" });
    await periodicCommand.execute(interaction as never);

    const [[arg]] = interaction.reply.mock.calls as [[{ embeds?: unknown[]; content?: string }]];
    expect(arg.embeds).toBeUndefined();
    expect(arg.content).toBeDefined();
  });

  it("still replies with the not-found error for a cross-guild ID (returning empty)", async () => {
    // Simulate: ID 5 belongs to guild-B, but the command fires in guild-A
    mocks.returning.mockResolvedValue([]); // WHERE id=5 AND guildId=guild-A → 0 rows

    const interaction = makeInteraction({ guildId: "guild-A", id: 5, message: "hi" });
    await periodicCommand.execute(interaction as never);

    const [[arg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(arg.ephemeral).toBe(true);
    expect(arg.content).toMatch(/が見つかりません/);
  });

  // ── Happy path: message-only ──────────────────────────────────────────────

  it("replies with the updated embed when only `message` is supplied", async () => {
    const updatedRow = {
      id: 10,
      guildId: "guild-123",
      channelId: "chan-1",
      message: "new message text",
      intervalHours: 24,
      enabled: true,
      lastPostedAt: null,
    };
    mocks.returning.mockResolvedValue([updatedRow]);

    const interaction = makeInteraction({ id: 10, message: "new message text", interval: null });
    await periodicCommand.execute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const [[arg]] = interaction.reply.mock.calls as [[{ embeds?: { data?: { title?: string } }[]; ephemeral?: boolean }]];
    expect(arg.ephemeral).toBe(true);
    expect(arg.embeds).toBeDefined();
    expect(arg.embeds![0]?.data?.title).toMatch(/編集しました/);
  });

  // ── Happy path: interval-only ─────────────────────────────────────────────

  it("replies with the updated embed when only `interval` is supplied", async () => {
    const updatedRow = {
      id: 11,
      guildId: "guild-123",
      channelId: "chan-2",
      message: "unchanged text",
      intervalHours: 48,
      enabled: true,
      lastPostedAt: null,
    };
    mocks.returning.mockResolvedValue([updatedRow]);

    const interaction = makeInteraction({ id: 11, message: null, interval: 48 });
    await periodicCommand.execute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const [[arg]] = interaction.reply.mock.calls as [[{ embeds?: { data?: { title?: string } }[]; ephemeral?: boolean }]];
    expect(arg.ephemeral).toBe(true);
    expect(arg.embeds).toBeDefined();
    expect(arg.embeds![0]?.data?.title).toMatch(/編集しました/);
  });

  // ── Happy path: both fields ───────────────────────────────────────────────

  it("replies with the updated embed when both `message` and `interval` are supplied", async () => {
    const updatedRow = {
      id: 12,
      guildId: "guild-123",
      channelId: "chan-3",
      message: "completely new text",
      intervalHours: 12,
      enabled: true,
      lastPostedAt: null,
    };
    mocks.returning.mockResolvedValue([updatedRow]);

    const interaction = makeInteraction({ id: 12, message: "completely new text", interval: 12 });
    await periodicCommand.execute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const [[arg]] = interaction.reply.mock.calls as [[{ embeds?: { data?: { title?: string } }[] }]];
    expect(arg.embeds![0]?.data?.title).toMatch(/編集しました/);
  });

  it("success embed includes the ID from the returned row", async () => {
    const updatedRow = {
      id: 20,
      guildId: "guild-123",
      channelId: "chan-4",
      message: "sample",
      intervalHours: 6,
      enabled: true,
      lastPostedAt: null,
    };
    mocks.returning.mockResolvedValue([updatedRow]);

    const interaction = makeInteraction({ id: 20, message: "sample", interval: null });
    await periodicCommand.execute(interaction as never);

    const [[arg]] = interaction.reply.mock.calls as [[{ embeds?: { data?: { fields?: { name: string; value: string }[] } }[] }]];
    const idField = arg.embeds![0]?.data?.fields?.find((f) => f.name === "ID");
    expect(idField?.value).toBe("20");
  });

  // ── Guard: both fields omitted ────────────────────────────────────────────

  it("replies with an error and skips the DB when neither message nor interval is supplied", async () => {
    const interaction = makeInteraction({ id: 1, message: null, interval: null });
    await periodicCommand.execute(interaction as never);

    const [[arg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(arg.ephemeral).toBe(true);
    expect(arg.content).toMatch(/message|interval/);
    // DB must not be called at all
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
