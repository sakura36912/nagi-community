---
name: Multiplayer Chinchiro settlement
description: 複数人チンチロの通貨連携前に維持すべき精算境界と旧卓互換。
---

複数人チンチロはテストモードを初期維持し、管理者が実残高モードを明示的に有効にした卓だけ実精算する。親の選び方・親子の勝敗・既存倍率は維持する。募集主は賭博師・賭博頭領・管理者ロールのいずれかを持つ必要があり、敗者の精算額は募集主へ送金する。勝者への従来配当を維持するため、最大損失額を事前に預かり、同卓終了・期限切れ・退出時は未精算の預かり分を返す。旧1対1卓は独立して維持する。公開卓にロールボタンを表示し、Bot側で手番本人だけ操作を許可する。1押下は1投で、目無しなら同じ手番のまま最大3投まで続ける。参加者が退出したら結果確定後も含めて卓全体を終了する。同じ強さの出目は親勝ちとし、出目は画像ではなくUnicodeで表示する。

ラウンド結果は「親」「子」「金額（予定増減）」に分ける。親は1回、子は全員分のユーザー名とUnicode出目・役名を並べ、金額欄は親対各子の結果をユーザーごとに合算して符号付きで表示する。

**Why:** ユーザーが親の従来の選び方と勝敗処理を変えずに、負け額は募集主へ送ること、実残高での運用を許可した。最大損失を賭け受付時に確保して、結果表示と財布残高の食い違いを避ける。

**How to apply:** Snapshot test/live mode on each table. Apply wager reserve, loser collection, recipient credit, winner payout, result lock, and audit ledger in atomic idempotent transactions. Return escrow on cancellation, expiry, or participant departure. Production database schema changes must use its supported migration path, not app startup DDL. Keep old one-on-one settlements isolated.