---
name: Bot process singleton
description: Discord Botの開発ワークフローと公開VMを同時起動しない運用上の制約
---

開発ワークフローと公開VMが同じDiscord Botトークンで同時に起動すると、同じイベントを二重処理してメッセージ重複やInteractionの40060を起こす。PostgreSQL advisory lockは開発環境と公開環境のDBが分離される場合に相互排他にならないため、Botの常駐先は公開VMか開発ワークフローのどちらか一方にする。

**Why:** 片方のプロセスが別環境のDBを使うと、同じロックキーでも両方がロック取得に成功する。

**How to apply:** 公開VMでBotを運用する場合はBot用開発ワークフローを登録・起動しない。開発時にワークフローを使う場合は、公開VM側を停止してから起動する。