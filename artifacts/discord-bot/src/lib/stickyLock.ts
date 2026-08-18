/**
 * チャンネルごとのスティッキー処理ロック。
 * MessageCreate ハンドラと /sticky set コマンドの両方から参照し、
 * 「古いスティッキー削除→新しいスティッキー投稿→DB更新」のシーケンスを
 * 同一チャンネルで同時実行しないようにする。
 *
 * キー形式: `${guildId}:${channelId}`
 */
export const stickyProcessingChannels = new Set<string>();
