---
name: gathapin36912 calendar
description: The calendar feature is Discord-native and uses the existing community event tables.
---

gathapin36912のカレンダーは、外部カレンダー連携ではなくDiscord内の予定告知・参加表明・通知として提供し、既存の`community_events`系テーブルを利用する。日時の基準は日本時間。

**Why:** Botの利用場所がDiscordで、既存DBにイベント・参加者・通知状態の保存先があるため、外部サービスを増やさず予定管理を完結できる。

**How to apply:** 予定の作成・表示・参加表明・通知をDiscordのEmbedとボタンで実装し、日時入力や月表示は必ずJSTとして扱う。