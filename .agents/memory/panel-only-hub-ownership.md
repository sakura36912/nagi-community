---
name: Panel-only Hub ownership
description: 別Botが作成・削除するpanel-only Hub転送先の追跡と所有権境界
---

panel-only Hubから別Botが転送した先のVCは、元Hubとの対応を追跡し、元Hubを条件にする機能でも転送先を有効として扱う。ただし、転送先VCの作成・削除は外部Botの責任であり、このBotは空室時もチャンネル自体を削除しない。

**Why:** 元Hubとの対応を保存しないと、設定VC由来の転送先でもチンチロなどのVC制限に拒否される。一方、通常Hubと同じ自動削除を行うと、外部Botが管理するVCを誤って削除する。

**How to apply:** panel-only転送時は元Hubとの対応だけを保存する。最後の利用者が退出したら対応記録を消すが、Discordチャンネルは外部Botに任せる。通常Hubの生成VCは従来どおりこのBotが空室時に削除する。