# E40 — complete-probe queue schema inspection

2026-09-06. Local implementation; no database service or deployment.

E15 established that pg-boss's best-effort drift detector can swallow a catalog query
failure and still report success. The new inspectInstalledNativeQueueSchema helper
reuses that detector and its upstream schema manifest, while remembering every SQL
probe failure. It requires schema version 40, a successful drift report, no pending
index builds and no extra indexes. Failure returns a coarse error without raw SQL or
database details. Cancellation is checked before and after queries and before acceptance.

This is a read-only rehearsal helper, not automatic operational startup or repair.
Its caller must supply an authorized, bounded SQL session; cancellation does not itself
interrupt a hung database query. It never starts pg-boss, creates a pool, changes grants,
or repairs schema. Existing permission/ownership checks remain separately required.

Reuse decision: keep upstream schema definitions and comparison logic. The custom
wrapper supplies only our strict acceptance policy and failed-probe accounting. A
second independently maintained schema manifest or new worker catalog privileges would
not improve this integration. Extra indexes are intentionally rejected even when the
upstream report treats them as informational.

The actual installed-package PGlite test accepts a fresh schema and rejects injected
failures of function, enum, table, column, constraint and pending-build queries. It
also rejects pre-cancelled inspection without querying, cancellation during inspection,
an extra index and a missing required index. The final version remains 40: inspection
does not migrate a damaged schema to make its own test pass.

Focused test, TypeScript and targeted ESLint pass. The normal pnpm queue integration
command passes all 67 checks (zero failures/skips). No dependency changes or downloads.

Remaining acceptance: authorized physical PostgreSQL rehearsal with actual deployment
roles and bounded session, then integrate this check into that rehearsal's acceptance
record. This does not certify live fleet operation, browser interaction, backup/restore
or all possible schema semantics beyond the pinned upstream detector's coverage.
