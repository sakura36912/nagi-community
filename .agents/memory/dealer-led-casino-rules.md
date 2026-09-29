---
name: Dealer-led casino rules
description: User-confirmed funding and configuration policy for the dealer-operated casino games.
---

**Rule:** In dealer-operated 丁半, send 25% of each lost stake (integer part only) to that game's dealer; three-card poker still sends the full losing/folded stake. Configured winner payouts remain system-funded, and draws return the stake without dealer income. Keep transfers atomic/idempotent. Unspecified rules remain unconfigured until explicitly set.

**Why:** The user first requested losing stakes go to the dealer without changing winner payouts or draw refunds, then explicitly changed 丁半's dealer share to 25%. The undistributed portion is not an extra payout.

**How to apply:** Credit only the appropriate dealer share in the same transaction as settlement, rounding down per losing player. Do not credit the dealer for draws, withdrawals, or cancellations; preserve explicit configuration requirements.