---
name: VPS database migration
description: ユーザーが指定した移行先と既存データ保持の要件
---

ユーザーは、このDiscord BotをConoHa VPSで動かすため、移行先データベースをSQLiteにし、既存データを引き継げるようにすることを要求した。切替範囲を確認した際、PostgreSQLとの両対応ではなく「ConoHa VPS向けのSQLite専用」を選択した。

**Why:** 単に新しい空のデータベースでBotを起動する依頼ではなく、既存ユーザーデータを伴う稼働先の移行であるため。

移行先VPSのOSはUbuntuとユーザーが確認した。

**Why:** VPSへの実配置を進める際に、対象OSを質問した回答による。

**How to apply:** VPS側のセットアップはUbuntu向けに案内する。UbuntuのバージョンやNode.js等の導入状況は未確認なので、インストールやサービス変更前に確認する。

**How to apply:** VPS向け対応では既存データの移行と検証を含める。データを移さず空のSQLiteへ切り替えたり、移行確認前に元のデータベースを削除したりしない。PostgreSQLの残存コードはオフラインの移行元エクスポート用であり、稼働時の両対応を復活させない。SQLite専用コードを従来のPostgreSQL公開環境へそのまま再公開しない。

日時の移行では、元PostgreSQLのマイクロ秒を保持する。

**Why:** 実データにはミリ秒より細かい日時が多数あり、JavaScript Dateだけを経由すると末尾3桁が失われる。通常のBot操作はDateのミリ秒精度でよいが、移行・バックアップの原本を丸めてはいけない。

**How to apply:** 移行とバックアップの生データは通常のDate型変換と区別する。日時SQLの単位を混在させず、精度・期間境界・JST日付を検証する。

SQLiteドライバを変更する際は、実際の非同期精算と複数接続の競合を試す。

**Why:** 最初に試したlibsqlのローカル接続は単独テストでは成功しても、同時実行でTRANSACTION_ACTIVEやコミット時の「SQL statements in progress」が発生した。単純な接続確認だけでは金融処理の安全性を判断できなかった。

**How to apply:** 同期SQLiteのtransactionにasync callbackをそのまま渡さない。awaitを含む処理が完了するまで書き込みトランザクションを保持し、ロック待ちでイベントループを止めない。精算callback自体を再実行する自動リトライを導入しない。
