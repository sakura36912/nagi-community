export interface RewardPresenceRow {
  guildId: string;
  userId: string;
  channelId: string;
}

export interface ActiveRewardVoiceState {
  guildId: string;
  userId: string;
  channelId: string;
}

export interface RewardPresenceReconciliationHandlers {
  clear: (guildId: string, userId: string) => Promise<unknown>;
  move: (guildId: string, userId: string, channelId: string) => Promise<unknown>;
  seed: (guildId: string, userId: string, channelId: string) => Promise<unknown>;
}

export interface RewardPresenceReconciliationResult {
  preserved: number;
  moved: number;
  cleared: number;
  seeded: number;
}

/**
 * DB上のVC報酬計測と、Discord上で実際に報酬対象VCへ接続中の状態を同期する。
 * 接続中の既存行はjoinedAtを維持し、再起動をまたいだ滞在時間を失わない。
 */
export async function reconcileVcRewardPresenceRows(
  existingRows: RewardPresenceRow[],
  activeStates: ActiveRewardVoiceState[],
  handlers: RewardPresenceReconciliationHandlers,
): Promise<RewardPresenceReconciliationResult> {
  const keyOf = (guildId: string, userId: string) => `${guildId}:${userId}`;
  const existingByKey = new Map(
    existingRows.map((row) => [keyOf(row.guildId, row.userId), row]),
  );
  const activeByKey = new Map(
    activeStates.map((state) => [keyOf(state.guildId, state.userId), state]),
  );
  const result: RewardPresenceReconciliationResult = {
    preserved: 0,
    moved: 0,
    cleared: 0,
    seeded: 0,
  };

  for (const row of existingRows) {
    const active = activeByKey.get(keyOf(row.guildId, row.userId));
    if (!active) {
      await handlers.clear(row.guildId, row.userId);
      result.cleared++;
    } else if (active.channelId !== row.channelId) {
      await handlers.move(row.guildId, row.userId, active.channelId);
      result.moved++;
    } else {
      result.preserved++;
    }
  }

  for (const active of activeStates) {
    if (existingByKey.has(keyOf(active.guildId, active.userId))) continue;
    await handlers.seed(active.guildId, active.userId, active.channelId);
    result.seeded++;
  }

  return result;
}
