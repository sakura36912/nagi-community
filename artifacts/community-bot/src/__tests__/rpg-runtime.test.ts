import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ schema: vi.fn(), recovery: vi.fn(), forge: vi.fn(), boss: vi.fn(), pvp: vi.fn(), cards: vi.fn() }));
vi.mock("@workspace/db", () => ({ ensureBossSchema: m.schema }));
vi.mock("../lib/bossRecovery.js", () => ({ startBossRecovery: m.recovery }));
vi.mock("../lib/forgeCommandRegistration.js", () => ({ syncForgeCommandRegistration: m.forge }));
vi.mock("../lib/bossCommandRegistration.js", () => ({ syncBossCommandRegistration: m.boss }));
vi.mock("../lib/pvpCommandRegistration.js", () => ({ syncPvpCommandRegistration: m.pvp }));
vi.mock("../lib/rpgCards", () => ({ startRpgCards: m.cards }));
import { startRpgRuntime } from "../lib/rpgRuntime.js";
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("community RPG startup", () => {
  it("retries partial command registration and does not start a second recovery loop", async () => {
    vi.useFakeTimers();
    m.schema.mockResolvedValue(undefined);
    m.forge.mockRejectedValueOnce(new Error("rate limit")).mockResolvedValue(undefined);
    m.boss.mockResolvedValue(undefined);
    m.pvp.mockResolvedValue(undefined);
    const stop = startRpgRuntime({ application: { commands: {} } } as never);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(m.recovery).toHaveBeenCalledTimes(1);
      expect(m.pvp).not.toHaveBeenCalled();
      expect(m.forge).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(m.forge).toHaveBeenCalledTimes(2);
      expect(m.boss).toHaveBeenCalledTimes(2);
      expect(m.pvp).toHaveBeenCalledTimes(1);
      expect(m.recovery).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(m.forge).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });
  it("does not register or recover against an unavailable schema, then recovers automatically", async () => {
    vi.useFakeTimers();
    m.schema.mockRejectedValueOnce(new Error("DB offline")).mockResolvedValue(undefined);
    m.forge.mockResolvedValue(undefined);
    m.boss.mockResolvedValue(undefined);
    m.pvp.mockResolvedValue(undefined);
    const stop = startRpgRuntime({ application: { commands: {} } } as never);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(m.recovery).not.toHaveBeenCalled();
      expect(m.forge).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60000);
      expect(m.recovery).toHaveBeenCalledTimes(1);
      expect(m.forge).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });
});
