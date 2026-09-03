import { describe, expect, it, vi } from "vitest";
import { enqueueVcRewardEvent } from "../lib/vcRewardEventQueue.js";

describe("VC reward event serialization", () => {
  it("finishes a delayed join record before settling the following leave", async () => {
    const steps: string[] = [];
    let releaseJoin!: () => void;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });

    const join = enqueueVcRewardEvent("guild-a", "user-a", async () => {
      steps.push("join-start");
      await joinGate;
      steps.push("join-saved");
    });
    const leave = enqueueVcRewardEvent("guild-a", "user-a", async () => {
      steps.push("leave-settled");
    });

    await vi.waitFor(() => expect(steps).toEqual(["join-start"]));
    releaseJoin();
    await Promise.all([join, leave]);

    expect(steps).toEqual(["join-start", "join-saved", "leave-settled"]);
  });

  it("does not block another user in the same server", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const otherUserTask = vi.fn();

    const first = enqueueVcRewardEvent("guild-b", "user-a", () => firstGate);
    const other = enqueueVcRewardEvent("guild-b", "user-b", async () => {
      otherUserTask();
    });

    await other;
    expect(otherUserTask).toHaveBeenCalledOnce();
    releaseFirst();
    await first;
  });

  it("continues with the next event when an earlier event fails", async () => {
    const nextTask = vi.fn();
    const failed = enqueueVcRewardEvent("guild-c", "user-c", async () => {
      throw new Error("temporary failure");
    });
    const next = enqueueVcRewardEvent("guild-c", "user-c", async () => {
      nextTask();
    });

    await expect(failed).rejects.toThrow("temporary failure");
    await expect(next).resolves.toBeUndefined();
    expect(nextTask).toHaveBeenCalledOnce();
  });
});