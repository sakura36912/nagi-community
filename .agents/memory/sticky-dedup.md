---
name: Sticky message deduplication
description: スティッキーメッセージが重複投稿される問題の根本原因と修正方針
---

## ルール
スティッキーメッセージの MessageCreate ハンドラでボット自身のメッセージを除外するときは
`message.author.bot` を使う。`message.author.id === client.user?.id` は使わない。

## Why
`client.user?.id` は WebSocket reconnect の瞬間に `undefined` を返すことがある。
その状態でボット自身が投稿したスティッキーの MessageCreate が届くと除外されず、
デバウンスタイマーが再セットされて1秒後にもう1件投稿される（計2件）。
`message.author.bot` は discord.js が常に正しく設定するフラグなので安全。

## How to apply
スティッキーハンドラ冒頭:
```typescript
if (message.author.bot) return; // ボット（自分自身を含む）の投稿は無視
```

また、デバウンス方式（チャンネルごとに 1 秒タイマーをリセット）を採用している。
孤立スティッキーの一掃: 再投稿前に直近 100 件から `author.bot && content === sticky.content` を
全削除 (`Promise.allSettled(msgs.map(m => m.delete()))`) してから新規投稿する。
