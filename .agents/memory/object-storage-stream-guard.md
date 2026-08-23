---
name: Object Storage stream guard
description: Node 24環境でObject Storageの依存通信が投げる一時的なストリーム例外の扱い
---

`ERR_STREAM_UNABLE_TO_PIPE` は、Object Storage の依存先通信がまれにイベント経由で投げる一時的な例外として扱い、Bot全体を停止させずエラーを記録して継続する。

**Why:** カード画像のObject Storage取得中にこの例外が未処理となり、通常は個別画像の取得失敗に留まる事象でBotプロセス全体が停止した。

**How to apply:** グローバル例外処理ではこのエラーコードだけを回復可能として扱い、それ以外の未処理例外は正常でない状態を継続させない。Object Storageの依存更新やNodeランタイム更新後には、この特別扱いが不要になったかを確認する。