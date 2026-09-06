# Native quality evidence and canonical completion

2026-09-05, architect-owned implementation contract; no live effects authorized.

1. Add a real deterministic document-structure verifier: UTF-8 size, exact Markdown heading presence,
   and forbidden literal terms. All rules are supplied by trusted composition, pinned to exact existing
   acceptance profile ID/digest and scenario. No defaults, regular expressions from input, shell, model,
   plugin, network or filesystem execution. These checks prove structure only, never semantic quality.
   Independent accepted reviews and every other profile check remain necessary.
   The supported format excludes HTML/comment/angle-bracket markup outside fenced code. Such input
   records unsupported_markup failure, rather than counting invisible pseudo-headings. Closing ATX
   heading hashes are normalized. This is a conservative structured Markdown subset, not a renderer.
2. Re-read authenticated native run/history, original HMAC review plan, actual artifact bytes and exact
   immutable review target before evaluating. Record service-owned Completion Gate evidence with rule,
   content and verdict digests; raw text/terms are not copied into audit. Immutable exact replay does
   not overwrite a failed check; changed configuration conflicts. Stage checkpoint changes until the
   database-owned precommit fence and supplied current-operation guard both accept.
3. Add one trusted supplied-database canonical completion operation for an already successful native
   run and ready Completion Gate. It revalidates exact plan/result/target/profile, canonical job and
   current attempt/lease/node/epoch. No signed legacy events or duplicate artifact manifests are made.
   Job and attempt leased-to-running projections derive from authenticated terminal execution evidence;
   then legal transitions make attempt/job succeeded and lease released in the SAME transaction, with
   normal transition/outbox records and one audit. Existing running states are supported. A replaced,
   revoked, orphaned, cancelled or failed attempt cannot be resurrected.
4. Completion is recording already-performed work, not new execution permission. The terminal native
   observation must fall within the original bound deadline and lease/authority expiration. Review may
   arrive later; an active, unreplaced lease can then be released without renewing or extending it.
   Expiry that has already changed canonical state wins; completion refuses that state. Current wall
   time must not precede any evidence/state timestamp. Scope cancellation is checked precommit.
5. Deterministic completion identity and exact persisted transition evidence reconcile a lost reply.
   No partial success, second artifact, repeat native start, automatic effect retry or generic job-write
   bypass. Completion grants no approval/execution authority and does not complete upstream workflows.

The coordinator's currently restricted deployment SQL profile does not yet include every native
result/harness capability. This block supplies a tested internal operation, not a public website finish
button or an automatically installed worker. Production composition/role changes must be separately
reviewed rather than quietly using a broader database login. PGlite is test-only.

Root owns shared bindings, service/transaction/authority logic and final integration. Sol implementation
lane owns only the pure verifier plus its tests. Independent test lane covers actual canonical lifecycle
and negative/replay cases; separate reviewer audits frozen product. Existing isolated checkouts and
installed dependencies only; no setup/download/native/provider/deployment work.
