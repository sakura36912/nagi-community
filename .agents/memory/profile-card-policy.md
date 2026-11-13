---
name: Profile card policy
description: User-selected format and data scope for the community bot profile card.
---

Render `/プロフィール` as a generated PNG card with the configured background image behind its text. Determine KP島ランク from administrator-mapped Discord roles, and show only statistics already saved by existing features; do not add tracking solely to populate the card. Administrators can configure visible roles, fields, colors, images, and frame themes.

Never display the user's bank balance on the profile card.

In the inventory field, show only counts for eggs by rarity, food, and toys. Keep the pet's identity in its separate pet field; do not list generic shop items there.

The background must be a directly accessible public HTTPS PNG/JPEG image. Fetch it with SSRF protections and size limits; do not silently substitute a different image when the configured background fails.

**Why:** The user later changed the earlier Embed-only choice and asked for a true background with text overlaid. They also explicitly excluded bank balance and limited inventory to egg, food, and toy counts.

**How to apply:** Keep profile data sourced from existing persisted records, preserve the no-balance rule and item-count scope, and use a generated image rather than relying on Discord embed styling for backgrounds.
