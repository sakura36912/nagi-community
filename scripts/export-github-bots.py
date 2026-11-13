#!/usr/bin/env python3
"""Export separate, history-free Bot repositories. Never starts a Bot or reads secrets."""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOTS = [
    ("nagi-currency-bot", "discord-bot", "凪通貨BOT", "DISCORD"),
    ("nagi-community-bot", "community-bot", "多機能BOT", "COMMUNITY"),
]
ALLOWED_SOURCE = {".ts", ".json", ".sql"}
SECRET_PATTERNS = [
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"),
    re.compile(rb"(?:mfa\.[A-Za-z0-9_-]{60,}|[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})"),
    re.compile(rb"postgres(?:ql)?://[^ \t\r\n\"'<>]+:[^ \t\r\n\"'<>]+@"),
]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def copy_file(source, destination):
    if source.is_symlink():
        raise ValueError(f"Symlink is not an exportable source: {source.relative_to(ROOT)}")
    if not source.is_file():
        raise ValueError(f"Source is missing: {source.relative_to(ROOT)}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def scan_and_manifest(folder):
    hashes = {}
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or "node_modules" in path.parts:
            continue
        relative = path.relative_to(folder).as_posix()
        if path.is_symlink() or ".git" in path.parts or (
            path.name.startswith(".env") and path.name != ".env.example"
        ):
            raise ValueError(f"Disallowed export path: {relative}")
        data = path.read_bytes()
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            # Never include a matched value in the error message.
            raise ValueError(f"Potential credential detected; export blocked: {relative}")
        hashes[relative] = hashlib.sha256(data).hexdigest()
    return hashes


def export_bot(output, repository, bot_dir, title, prefix):
    destination = output / repository
    destination.mkdir()
    package = f"@workspace/{bot_dir}"
    source_bot = ROOT / "artifacts" / bot_dir
    target_bot = destination / "artifacts" / bot_dir
    for source in sorted((source_bot / "src").rglob("*")):
        if source.is_file():
            if source.suffix not in ALLOWED_SOURCE:
                raise ValueError(f"Unreviewed source type: {source.relative_to(ROOT)}")
            copy_file(source, target_bot / source.relative_to(source_bot))
    for name in ("package.json", "tsconfig.json", "vitest.config.ts"):
        copy_file(source_bot / name, target_bot / name)
    for source in sorted((ROOT / "lib/db/src").rglob("*")):
        if source.is_file():
            if source.suffix not in ALLOWED_SOURCE:
                raise ValueError(f"Unreviewed database source: {source.relative_to(ROOT)}")
            copy_file(source, destination / source.relative_to(ROOT))
    db_root = ROOT / "lib/db"
    for source in sorted(db_root.iterdir()):
        if source.name in {"package.json", "tsconfig.json", "drizzle.config.ts"} or (
            source.name.startswith("migrate-") and source.suffix == ".ts"
        ):
            copy_file(source, destination / source.relative_to(ROOT))
    copy_file(ROOT / "tsconfig.base.json", destination / "tsconfig.base.json")
    copy_file(ROOT / "pnpm-lock.yaml", destination / "pnpm-lock.yaml")
    workspace = (ROOT / "pnpm-workspace.yaml").read_text()
    workspace, changed = re.subn(
        r"(?m)^packages:\n(?:[ \t]+.*\n)+",
        f"packages:\n  - artifacts/{bot_dir}\n  - lib/db\n",
        workspace, count=1,
    )
    if changed != 1:
        raise ValueError("Could not restrict exported workspace packages")
    (destination / "pnpm-workspace.yaml").write_text(workspace)
    root_package = json.loads((ROOT / "package.json").read_text())
    write_json(destination / "package.json", {
        "name": repository, "version": "1.0.0", "private": True, "type": "module",
        "packageManager": "pnpm@10.26.1",
        "engines": {"node": ">=24 <25"},
        "scripts": {
            "start": f"pnpm --filter {package} exec node --env-file=../../.env --import tsx src/index.ts",
            "typecheck": f"tsc --build && pnpm --filter {package} run typecheck",
            "test": f"pnpm --filter {package} run test",
            "commands:register": f"pnpm --filter {package} exec node --env-file=../../.env --import tsx src/deploy-commands.ts",
        },
        "devDependencies": {"typescript": root_package["devDependencies"]["typescript"]},
    })
    write_json(destination / "tsconfig.json", {
        "extends": "./tsconfig.base.json", "files": [], "references": [{"path": "./lib/db"}],
    })
    (destination / ".env.example").write_text(
        "# 管理者がローカルで設定してください。実際の値をGitHubへ保存しないこと。\n"
        f"{prefix}_BOT_TOKEN=\n{prefix}_CLIENT_ID=\nDATABASE_URL=\n"
        + ("DEFAULT_OBJECT_STORAGE_BUCKET_ID=\nPRIVATE_OBJECT_DIR=\nPUBLIC_OBJECT_SEARCH_PATHS=\n"
           if prefix == "DISCORD" else "")
    )
    (destination / ".gitignore").write_text(
        "node_modules/\ndist/\ncoverage/\n*.tsbuildinfo\n.env\n.env.*\n!.env.example\n"
        "*.db\n*.sqlite\n*.sqlite3\n*.log\nbackups/\ngenerated-artifacts/\n.DS_Store\n"
    )
    profile_font_setup = (
        "\n多機能BOTのプロフィールカード画像には日本語フォント Noto Sans CJK JP が必要です。"
        "Ubuntu/Debian では `sudo apt-get install fonts-noto-cjk` を実行してからBotを起動してください。\n"
        if prefix == "COMMUNITY" else ""
    )
    readme = f"""# {title}

このリポジトリは既存Botのソース保存用スナップショットです。
Bot本体と必要な共有 `lib/db` を同梱しています。もう一方のBotは含みません。

## 保存内容と注意

- 現在のデータベースは **PostgreSQL** です。SQLite版ではありません。
- ユーザーデータ、DB、トークン、画像の実データ、Git履歴は含みません。
- コードを保存してもBotは起動せず、既存の稼働先も変わりません。
- このコピーと本番を同じBotトークンで同時に起動しないでください。
- 共有DBコードは両リポジトリに同じ内容を同梱しています。
  スキーマ変更は両Botとの互換性を確認し、移行前に本番バックアップを取得してください。
- 凪通貨BOTで使うReplit App Storageの画像と認証は別途必要です。
  GitHubへ保存しただけでVPSへ移行できるわけではありません。

## 環境

Node.js 24系、pnpm 10.26.1。依存関係の設定は現在のLinux x64向け設定を引き継ぎます。
{profile_font_setup}

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
cp .env.example .env
```

`.env` は管理者が編集し、トークンと接続先DBを設定します。
**このファイルをGitへ追加しないでください。**

## 起動（旧稼働先の停止とDB設定の確認後だけ実行）

```bash
pnpm start
```

DBの新規作成・移行は自動実行しません。既存DBへの `push-force` を安易に実行しないでください。
コマンドの登録は起動とは別の操作です。`pnpm run commands:register` はDiscord側を変更します。
多機能BOTの登録スクリプトは対象スコープを一括置換するため、他の登録を消さないか先に確認してください。
別プログラムに同じBotトークンを使わせないでください。

## GitHubへの初回保存

GitHubで **Private** の空リポジトリ `{repository}` を作成します。
このフォルダをリポジトリのルートにして保存します。元のプロジェクトのGit履歴は送信しません。
ブラウザからアップロードする場合、隠しファイルや大きいフォルダが欠けないよう確認してください。
トークンをリモートURLやコマンドへ埋め込まないでください。
"""
    (destination / "README.md").write_text(readme)
    # Re-resolve the copied lock against only this exported workspace.
    # No package scripts run, no runtime DB connection or Gateway is opened.
    subprocess.run(
        ["pnpm", "install", "--lockfile-only", "--ignore-scripts", "--offline"],
        cwd=destination, check=True,
    )
    hashes = scan_and_manifest(destination)
    write_json(destination / "source-manifest.json", {"files": hashes})
    archive = output / f"{repository}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for path in sorted(destination.rglob("*")):
            if path.is_file() and "node_modules" not in path.parts:
                zip_file.write(path, f"{repository}/{path.relative_to(destination).as_posix()}")
    return {"repository": repository, "sourceFiles": len(hashes), "directory": str(destination.relative_to(ROOT)),
            "archive": str(archive.relative_to(ROOT)), "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest()}


def main():
    output = ROOT / "generated-artifacts/github-export" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output.mkdir(parents=True, exist_ok=False)
    results = [export_bot(output, *bot) for bot in BOTS]
    write_json(output / "export-summary.json", results)
    print(json.dumps({"prepared": results, "uploadedToGitHub": False}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Export stopped: {error}", file=sys.stderr)
        sys.exit(1)
