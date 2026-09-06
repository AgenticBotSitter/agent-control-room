# E13 — queue schema coexistence and producer grants

2026-09-06. Offline candidate setup; no native database/service activation.

`native_queue_producer_roles.sql` records the previously test-only producer grants
against the existing coordinator role. It requires the fixed pre-provisioned queue,
revokes PUBLIC queue-schema access, grants read/insert on operational jobs, metadata
read and UPDATE(name) for PostgreSQL's row-lock requirement. It grants no worker
UPDATE/DELETE, new login, canonical privileges or schema creation.

Private database preflight has an explicit trusted `{ nativeQueue: true }` option.
Default calls still reject the extra schema. Opt-in permits only control_room_queue,
checks exact producer permissions for the coordinator and no queue access for other
application roles. It preserves canonical schema digest, role/session identity,
owner, parameter, default-ACL and column checks. The new check is read-only, not a
permission repair mechanism. Startup configuration does not yet select the option.

## Verification

- 32 combined actual-package/PGlite checks pass. The producer case uses the exact
  candidate SQL, performs a queue insertion, then exercises actual catalog/session
  checks through the combined coordinator and web preflights.
- Queue-free preflight refuses coexistence. Explicit opt-in accepts the prepared
  coordinator and isolated web role. Missing UPDATE(name), excess retry_limit UPDATE,
  job DELETE and an unrelated schema all fail the combined coordinator check.
- 25 existing coordinator-database/startup checks pass; typecheck, targeted lint and
  whitespace validation pass.

The combined preflight fixture substitutes only PGlite's unsupported TEMP metadata,
as existing tests do. This is not a real PostgreSQL qualification. Result/evidence/
session wrappers share the no-queue-access check but have not each been separately
exercised with an actual pg-boss schema in this block.

## Next

Compose actual startup with prepared producer ownership, worker identity and SQL
settings, then test drain/cleanup ordering. Queue structure/version acceptance and
real PostgreSQL transactions/roles remain required; table-name and permission checks
do not replace schema integrity. Keep native services off until scoped activation.
No GitHub publication, dependency/lockfile change, download or native effects.
