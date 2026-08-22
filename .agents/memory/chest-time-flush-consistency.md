---
name: Chest time flush consistency
description: Preventing chest progress from decreasing while tavern time is being written to the database.
---

酒場VC時間をメモリ上で区切ってDBへフラッシュする場合、DBへの書き込みが完了するまでの未反映秒数も、宝箱の累積時間に含める。

**Why:** メモリ上の計測開始時刻だけを先にリセットすると、その直後からDB加算完了までの間に表示する累積時間が実際より小さくなる。

**How to apply:** フラッシュが進行中の秒数はユーザー単位で保持し、宝箱の進捗計算ではDB累計・未反映秒数・現在のセッション秒数を合算する。DB書き込みの完了または失敗時には未反映秒数を必ず解放する。