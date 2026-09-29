---
name: Multiplayer Chinchiro settlement
description: 複数人チンチロの実残高精算、募集主への送金表示、旧卓互換。
---

複数人チンチロはテストモードを初期維持し、管理者が実残高モードを明示的に有効にした卓だけ実精算する。親の選び方・親子の勝敗・既存倍率は維持する。募集主は賭博師・賭博頭領・管理者ロールのいずれかを持つ必要があり、各敗者の純負け額の25%（端数切り捨て）を募集主へ送金する。勝者への従来配当を維持するため、最大損失額を事前に預かり、同卓終了・期限切れ・退出時は未精算の預かり分を返す。旧1対1卓は独立して維持する。公開卓にロールボタンを表示し、Bot側で手番本人だけ操作を許可する。1押下は1投で、目無しなら同じ手番のまま最大3投まで続ける。参加者が退出したら結果確定後も含めて卓全体を終了する。同じ強さの出目は親勝ちとし、出目は画像ではなくUnicodeで表示する。

ラウンド結果は「親」「子」「金額（予定増減／確定損益）」「ディーラーへの送金額」に分ける。親は1回、子は全員分のユーザー名とUnicode出目・役名を並べ、金額欄は親対各子の結果をユーザーごとに合算して符号付きで表示する。送金額は実精算と同じく各ユーザーの負の純損益の25%を端数切り捨てて合計し、テストモードでは実送金のない予定額と明記する。

**Why:** ユーザーが親の従来の選び方と勝敗処理を変えずに、負け額の25%は募集主へ送ること、実残高での運用を許可した。最大損失を賭け受付時に確保して、結果表示と財布残高の食い違いを避ける。

**How to apply:** Snapshot test/live mode on each table. Apply wager reserve, loser collection, recipient credit, winner payout, result lock, and audit ledger in atomic idempotent transactions. Return escrow on cancellation, expiry, or participant departure. Production database schema changes must use its supported migration path, not app startup DDL. Keep old one-on-one settlements isolated.