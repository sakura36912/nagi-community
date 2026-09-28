---
name: Dealer-led casino rules
description: User-confirmed funding and configuration policy for the dealer-operated casino games.
---

**Rule:** In dealer-operated 丁半 and three-card poker, losing/folded stakes go to that game's dealer; configured winner payouts remain system-funded, and draws return the stake without dealer income. Keep transfers atomic/idempotent. Unspecified rules remain unconfigured until explicitly set.

**Why:** The user explicitly requested that every losing stake go to the dealer without changing the existing winner payout schedule or draw refunds.

**How to apply:** Credit losses/folds to the game's dealer in the same transaction as settlement. Do not credit the dealer for draws, withdrawals, or cancellations; preserve explicit configuration requirements.