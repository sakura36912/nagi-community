---
name: Casino control placement
description: Keeping casino action buttons visibly attached to their game message without allowing other users to operate them.
---

ゲーム操作ボタンをゲームの公開Embedと同じメッセージに置く場合は、ボタンIDに所有者を含め、操作時に必ず照合する。

**Why:** Discordのエフェメラルメッセージは公開メッセージの直下に固定できず、後続メッセージにより見た目の位置が変わる。一方、公開ボタンだけでは他人も操作できる。

**How to apply:** 公開ゲームメッセージのボタンIDへ所有者IDを埋め込み、所有者以外の操作は公開メッセージを更新せずエフェメラルで拒否する。ゲーム更新・終了時には同じ公開メッセージのコンポーネントを更新または削除する。