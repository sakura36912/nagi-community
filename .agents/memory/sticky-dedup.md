---
name: Sticky message deduplication
description: スティッキーメッセージが重複投稿される問題の根本原因と確定実装
---

## 確定実装（lock + author.bot）

```typescript
const stickyProcessingChannels = new Set<string>();

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return; // ボット投稿（自分自身を含む）は無視
  if (!message.guildId) return;

  const channelKey = `${message.guildId}:${message.channelId}`;
  if (stickyProcessingChannels.has(channelKey)) return;
  stickyProcessingChannels.add(channelKey);

  try {
    // getStickyMessage → bulk-delete → channel.send → updateLastMessageId
  } finally {
    stickyProcessingChannels.delete(channelKey);
  }
});
```

## Why: デバウンスを使わない理由

デバウンスは「タイマーが自分をマップから削除した直後から非同期処理完了まで」の間に
新規メッセージが届くと第2タイマーが立ち上がり並走する。結果として2件投稿される。
構造的に解消できないため採用しない。

## Why: `message.author.id === client.user?.id` を使わない理由

WebSocket reconnect の瞬間に `client.user` が null になることがあり、
ボット自身のスティッキー投稿が除外されずロック解放後に再度処理される。
`message.author.bot` は discord.js が常に正しく設定するため安全。

## 孤立スティッキーの除去

再投稿前に直近100件を fetch し `m.author.bot && m.content === sticky.content` に
マッチするものを `Promise.allSettled(msgs.map(m => m.delete()))` で全削除する。
これにより過去の重複投稿バグで生じた孤立メッセージも次回ユーザー投稿時に消える。
