---
name: Drizzle schema index names
description: Existing PostgreSQL unique indexes must be represented with their actual names and semantics in Drizzle.
---

**Rule:** When an existing database already has a unique index, declare the same index name and uniqueness semantics in Drizzle. Model nullable idempotency keys with their existing partial unique index rather than a full-column `unique()` constraint.

**Why:** A mismatched generated constraint name can make Drizzle treat an already-protected populated table as needing a new constraint, leading it to offer an unsafe table-truncation path during schema push.

**How to apply:** If a development schema push prompts about truncating data, inspect the existing index metadata first. Align the schema definition to it or keep the established partial-index setup; never accept truncation simply to add an unrelated column.