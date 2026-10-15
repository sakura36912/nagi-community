# ConoHa VPSへの移行（SQLite専用）

## 重要な前提

- **変更後のBotはPostgreSQLでは起動しません。Replitへそのまま再公開しないでください。**
- 元のPostgreSQLデータベースは削除・変更しません。移行先が正しいと確認できるまで残します。
- 開発用と本番用は別のデータです。両方を移すなら別々のバックアップ・SQLiteファイルにします。
  開発データを本番用として使ったり、2環境を混ぜたりしないでください。
- **同じトークンのBotをReplitとVPSで同時に動かさないでください。**
  ファイルロックは同じVPS・同じSQLiteファイルに対してのみ有効で、別ホスト間を保護しません。
- DBファイルはVPSの永続ディスクに置きます。ネットワーク共有/NFSや一時ディレクトリは使いません。
  2つのBotは同じ絶対パスのSQLiteファイルを使用します。

## 1. 本番切替前に試験移行する

必要な環境はLinux、**Node.js 24.12以降の24系LTS**、pnpm 10.26.1、`flock`（util-linux）です。
`node:sqlite`を使うため、別のDBサーバーやSQLite用npmネイティブビルドは不要です。
Node.jsがSQLiteのExperimentalWarningを表示する場合がありますが、失敗ではありません。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
```

これらの操作でDiscordのGateway接続は起動しません。

既存のJSONバックアップは **manifest.jsonと全data-*.json** が必要です。
Discordで取得したファイルは同じフォルダへまとめ、名前を変えないでください。

```sh
# 例。出力先はまだ存在しない絶対パスを指定します。
SQLITE_PATH=/absolute/private/trial.sqlite \
  pnpm --filter @workspace/db sqlite:import /absolute/private/database-backup-directory
```

ツールは次を検証します。

- 全ファイルのサイズ・SHA-256、バックアップID、分割順・行オフセット
- 全テーブル・列の一致、各テーブルと全体の行数
- 読み戻した全セルの内容、SQLiteの整合性、外部キー
- 既存インデックス・一意制約を含むSQLiteスキーマの生成

成功時は `contentVerified: true` とテーブル数・行数を表示します。
途中で失敗したDBは公開せず削除し、**既存の移行先ファイルは絶対に上書きしません**。
Discord IDは文字列、日時はUTCの整数マイクロ秒、配列・JSONはJSON文字列で保存します。
残高など元のPostgreSQL integer列には32ビット範囲の制約も残します。
精度を維持できない数値・未対応スキーマは、省略や丸めで続行せずエラーになります。

元DBへの書き込みや元バックアップの削除は行いません。
移行ツールにBotトークンは不要で、Discordへのログインもしません。

## 2. 切替時の最終バックアップ

試験移行の成功後も、稼働中の旧Botには新しい取引が増えます。古いスナップショットだけで
切り替えると、その後の残高・購入・給与履歴が失われます。

1. 移行予定を告知し、進行中のゲーム・未精算取引を終了する。
2. **旧環境の2つのBotと、同じDBへ書き込む他の処理を停止する。**
3. 書き込みが止まった状態で、本番PostgreSQLの最終JSONを取得する。
4. 新しい未使用ファイル名にインポートし、上記の検証に成功してからVPSを起動する。

オフラインのPostgreSQL書き出しコマンドを残しています。
これは移行専用で、SQLiteを開かず、Gatewayも起動せず、元DBには読み取り専用で接続します。

```sh
# DATABASE_URLが「移行元の本番DB」を指す、管理者の安全な環境で実行。
# 接続URLをコマンド引数やチャットへ貼らないこと。
pnpm --filter @workspace/db backup:postgres /absolute/private/final-backups
```

ReplitではDatabaseツールで**本番DBを選び、Settingsの接続情報**から接続先を確認できます。
開発Shellに最初から設定された接続先を、本番DBだと判断しないでください。
必要な接続情報は管理者だけが扱う権限600の環境ファイル等で設定し、Gitへ保存しません。
参照: https://docs.replit.com/features/data-and-storage/connection-details

Discordの `/backup export` は稼働中の整合したスナップショットを作れますが、
**実行後の書き込みを止める機能ではありません**。最終切替には上の停止・書き出し手順を使います。

## 3. VPSへコードとデータを配置する

例として、コードを `/opt/discord-bot`、データを `/var/lib/discord-bot` に置きます。
一般ユーザー `discordbot` を作り、データディレクトリはそのユーザーだけが書き込めるようにします。
コードはGit/rsync等で転送し、依存パッケージはVPS上でインストールしてください。
`node_modules`、`.env`、開発用DB、generated-artifactsをコードと一緒に公開しません。

```sh
# VPS上。ユーザー・ディレクトリが未作成の場合の例。
sudo useradd --system --home-dir /var/lib/discord-bot --create-home --shell /usr/sbin/nologin discordbot
sudo install -d -m 700 -o discordbot -g discordbot /var/lib/discord-bot

cd /opt/discord-bot
pnpm install --frozen-lockfile
pnpm run typecheck
```

最終JSON一式を安全にVPSへ転送し、Botを動かすユーザーでインポートします。
転送元・転送先のバックアップは、移行確認が済むまで保管します。

```sh
cd /opt/discord-bot
sudo -u discordbot env SQLITE_PATH=/var/lib/discord-bot/bot.sqlite \
  pnpm --filter @workspace/db sqlite:import /absolute/private/final-backup-directory
```

`sudo -u discordbot ... pnpm` でpnpmが見つからない場合は、サービスのPATHにも入る場所へ
Node.js/pnpmを導入し、同じユーザーで `node --version` / `pnpm --version` が動くことを確認します。

**既存データがある移行では `sqlite:init` を使いません。**
新規・空のBotを意図して作るときだけ、次を使えます。

```sh
SQLITE_PATH=/absolute/private/new.sqlite pnpm --filter @workspace/db sqlite:init --new-empty-database
```

DBファイルが未作成・空・未検証・スキーマ不一致の場合、Botは起動を拒否します。

## 4. 画像ファイルを引き継ぐ

カード・サイコロ画像の本体はDBではなくReplit App Storageにあります。
DB内の参照だけを移しても画像は表示できません。

Replit上で最終JSONを一時SQLiteへインポートした後、元のApp Storageが利用できる環境で実行します。
このコマンドはDBとストレージを読むだけで、Botを起動しません。

```sh
SQLITE_PATH=/absolute/private/final-copy.sqlite \
  pnpm --filter @workspace/discord-bot assets:export
```

`generated-artifacts/asset-exports/assets-export-*` に画像とSHA-256付き
`asset-manifest.json` を出力します。参照先に取得できない画像がある場合は完了扱いにしません。
この**フォルダの中身**を、VPSの `/var/lib/discord-bot/assets/` へ安全に転送します。
`bj-cards/...` / `chinchiro-dice/...` の階層を維持し、所有者をdiscordbotにします。
`ASSET_DIRECTORY` を設定すると、VPSではReplit認証を使わずこのローカル保存先を利用します。
この作業では画像の実エクスポート・VPS転送は自動実行していません。

## 5. systemdで常駐させる

`ops/vps.env.example` を参考に、VPS上だけの `/etc/discord-bot.env` を作成します。
Botトークンはそこへ管理者が入力し、権限を600にします。**チャットへ送信しないでください。**
`SQLITE_PATH` と `ASSET_DIRECTORY` は上記と同じ永続パスにします。

```sh
sudo chmod 600 /etc/discord-bot.env
sudo cp /opt/discord-bot/ops/discord-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
# この直前に旧Replit側の2つのBotが停止していることを再確認。
sudo systemctl enable --now discord-bot
sudo systemctl status discord-bot
sudo journalctl -u discord-bot -n 100 --no-pager
```

このサービスは2つのBotを監視し、どちらかが終了すると両方を停止して再起動します。
停止時は子プロセスも終了させます。追加のcron/pm2/手動実行で同じBotを重ねて起動しないでください。
Discord接続のための外向きHTTPS通信とDNSが必要です。Botだけの運用に公開HTTPポートは不要です。

Gateway接続を確認した後、残高・ショップ・給与設定・懸賞金・既存画像などを確認します。
旧DB・旧バックアップを削除するのは、移行後データを確認してから別途判断してください。

## 6. 移行後のバックアップと停止

- `/backup export` のアプリ所有者限定・本人だけへの送信はそのままです。対象は接続中のSQLiteです。
- Shellでは、サービスと同じ `SQLITE_PATH` を設定して
  `pnpm --filter @workspace/discord-bot backup:export --output /absolute/private/backups` を実行します。
- SQLite形式のJSONも `sqlite:import` で**別の未使用DBファイル**へ復元・検証できます。
- 稼働中はWALがあるため、`.sqlite` だけの単純コピーをバックアップにしません。
  JSONエクスポートを使うか、サービス停止後にDBと必要ファイルを保存してください。
- 画像ディレクトリも別途バックアップしてください。
- 停止は `sudo systemctl stop discord-bot`。コード更新前にも停止し、DBバックアップを取ります。
- 今後スキーマを変える際はバックアップ・試験移行が必要です。
  `push-force` や古いPostgreSQL用の個別移行スクリプトを本番SQLiteへ実行しないでください。

## 戻す必要がある場合

VPSのBotを停止し、SQLiteと画像を保全します。**新環境で取引が始まった後に
旧PostgreSQLへそのまま戻すと、その取引が消えます。** 差分の確認・整合を先に行ってください。
このツールはPostgreSQLへ逆移行・上書きするものではありません。
