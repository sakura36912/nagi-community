---
name: Workflow signal handling
description: Replitワークフロー再起動時に古いDiscord Botプロセスを残さないためのシグナル処理
---

SIGTERMやSIGINTのハンドラを登録する場合、ログを出すだけで戻らず、必ずプロセスを終了する。

**Why:** Node.jsはシグナルリスナーを登録すると既定の終了動作を行わない。ログだけのSIGTERMハンドラにより再起動前のDiscord Botが残り、新旧2プロセスが同じイベントを受けてスティッキーとVCログを二重投稿した。

**How to apply:** ワークフロー停止診断を追加・変更するときは、SIGTERM/SIGINTハンドラ内で終了まで完了させる。再起動後はDiscord Botのプロセス数が1つであることも確認する。