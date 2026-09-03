const rewardEventQueues = new Map<string, Promise<void>>();

/**
 * 同一サーバー・同一ユーザーのVC報酬処理を、Discordイベントの到着順に実行する。
 * 入室DB記録より先に退出精算が走る競合を防ぐ。
 */
export function enqueueVcRewardEvent(
  guildId: string,
  userId: string,
  task: () => Promise<void>,
): Promise<void> {
  const key = `${guildId}:${userId}`;
  const previous = rewardEventQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  rewardEventQueues.set(key, current);

  return current.finally(() => {
    if (rewardEventQueues.get(key) === current) {
      rewardEventQueues.delete(key);
    }
  });
}
