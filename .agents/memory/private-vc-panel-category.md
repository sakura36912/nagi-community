---
name: Private VC panel categories
description: Free-room and luxury-room shop items share effect types, so panel behavior must follow the persisted shop/session category.
---

フリールーム判定では現行の `island` と旧来の `ura` を同じフリールーム系として扱い、高級船室の `vc` と混同しない。フリールームのアクセスロールは、固定の島内ロールに加えて浮上券の商品設定またはロール名から解決する。

**Why:** フリールームと高級船室が同じ期限付きVCエフェクトを共有するため、エフェクト名だけでは区別できない。旧 `ura` 商品を `vc` 扱いすると、作成先・DBセッション・コントロールパネルが高級船室側へ混ざる。

**How to apply:** 購入時は商品カテゴリから作成先とセッションカテゴリを決め、パネル再描画時は保存済みセッションカテゴリから表示を決める。`ura` は既存データ互換のため削除しない。フリールームの新規作成と既存VC更新の双方で、対象ロールへ`ViewChannel`・`Connect`・`Speak`を付与する。