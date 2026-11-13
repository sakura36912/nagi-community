---
name: Profile card policy
description: User-selected format and data scope for the community bot profile card.
---

Use an Embed for `/プロフィール`. Determine KP島ランク from administrator-mapped Discord roles, and show only statistics already saved by existing features; do not add tracking solely to populate the card. Administrators can configure visible roles, fields, colors, images, and frame themes.

Embed images are displayed as the card's image/banner, not as a true background texture; Discord embeds do not support a custom background behind their text.

**Why:** The user chose Embed format, role-based KP rank, and existing saved data only. The image placement is a platform limitation of the selected format.

**How to apply:** Keep profile data sourced from existing persisted records. If a future request needs a parchment texture behind the text, confirm whether the user wants to change from Embed to a generated image card.
