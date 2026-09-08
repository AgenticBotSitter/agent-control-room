# F8 operations comparison — scoped source and executable evidence

2026-09-08; Control Room baseline `44f9064`. Not a production acceptance receipt.

## Decisions and missing decisive evidence

| Outcome/responsibility | Compared options | Decision and confidence | Evidence |
| --- | --- | --- | --- |
| A2 owner login | Existing Access assertion verifier; Authelia forward auth/OIDC | Retain Access for current owner deployment; high source-fit confidence, live acceptance still separate | E1 protocol mismatch, existing tested verifier; no Authelia runtime |
| D1 isolated application database restore | pg_dump/pg_restore procedure; pgBackRest physical restore | Native tools fit dedicated DB on shared primary; pgBackRest is not a safe drop-in; high source confidence | Existing procedure reviewed; proposed synthetic restore pending execution |
| D1 cluster disaster recovery/PITR | Native logical snapshots; pgBackRest | Complement with pgBackRest only when cluster-level scope/recovery objectives approved; no full qualification | E1 archive/restore code, no compiled binary, no R2 proof |
| D2 application reachability | Keep application health contracts; Kuma | Combine, not replace: Kuma external probe/notification engine plus narrow application readiness mapping | E2 actual condition evaluator only, not HTTP/notification fit |
| D2 host memory/container trends | Kuma; Beszel | Beszel complementary candidate; does not replace app readiness or completion integrity | E1 actual collection/auth/alert code; E2/E3 still needed |
| D4 daily-use validation | Existing app tests and browser journey | Retain actual journey tests. Neither uptime nor a memory graph proves result/revision behavior | No new browser evidence in this workstream |

This workstream is **not fully compared at E3**. In particular, don't label Kuma or
Beszel the accepted deployed winner until private probe/alert/resource experiments
below run. No resource score is available; no fabricated weighted overall score.

## Exact pins and inspected source

- [pgBackRest](https://github.com/pgbackrest/pgbackrest/tree/8c8f3ee63e310f0b3ea10b55ed3b96b4cc9296da), release/2.59.1: `src/command/restore/restore.c`, `file.c`, `src/build/config/config.yaml`, `test/src/module/command/restoreTest.c`, `meson.build`, `LICENSE`. Restore constructs selective-restore expression, streams physical files and can zero excluded DB files. Tests around selective restore explicitly expect excluded databases zeroed. This is recovery to a cluster directory, not SQL insertion into an empty DB on a running shared primary. MIT root; native dependencies include OpenSSL, libpq, libxml2, bz2/lz4/zlib and build-time YAML. Exact redistributed binary notices remain unresolved; use separately installed upstream tool, no code copy proposed.
- [Kuma](https://github.com/louislam/uptime-kuma/tree/e4821321e559c887b14e37d9979e604b221a8945), master pin, package 2.5.3 (not claimed release-qualified): `server/model/monitor.js`, `server/monitor-types/postgres.js`, `monitor-type.js`, `server/monitor-conditions/{expression,evaluator,operators}.js`; three matching `test/backend-test/monitor-conditions/test-*.js`; package and MIT license. HTTP branch supports basic/bearer/OAuth client credentials, configurable TLS verification, JSON/keyword monitoring. SQL monitor executes configured query (default SELECT 1) with database credentials. Avoid broad DB credential distribution: prefer explicit restricted health endpoint. Separate Node service, its own persistence and notification credentials; not another Control Room work authority. Full production dependency/native SQLite inventory not cleared by MIT root.
- [Beszel](https://github.com/henrygd/beszel/tree/5b87f7d7cb095ac186162e8a8f3967182aa8023b), main pin: `agent/server.go`, `agent/system.go`, `internal/alerts/alerts_status.go`, corresponding `_test.go`, `go.mod`, `LICENSE`, supplemental licenses. SSH listener authenticates configured keys, refuses PTY, serves metrics requests; this is not Hermes SSH execution. Memory collector uses gopsutil and bounded cache/buffer subtraction. Status alerts deduplicate pending timers; restart code reconstructs timers for still-down systems, starting configured delay again rather than preserving elapsed deadline. Hub uses PocketBase; notification uses Shoutrrr. Go 1.27.1 required by this pin, absent here. Root MIT does not cover bundled optional Windows LibreHardwareMonitor (MPL-2.0) and smartmontools license obligations. Prefer separately managed upstream service and exact per-platform inventory over copying internals.
- [Authelia](https://github.com/authelia/authelia/tree/296d8f21d0f48ebe69d1f6d03dff1f56e6990a3b), master pin: `internal/handlers/handler_authz_impl_forwardauth.go`, associated tests, `handler_authz_authn.go`, `go.mod`, Apache-2.0 license. Forward auth derives authorization object from trusted forwarded method/proto/host/URI. Existing Control Room verifies signed Cloudflare assertion with exact issuer/audience/sub/type, not a Remote-User header. Adopting Authelia requires supported OIDC trust adapter or independently reviewed trusted proxy boundary, identity migration, sessions/revocation and MFA/storage operations. No currently named missing owner requirement offsets this migration. It remains an optional self-hosted deployment profile, not globally rejected.

Branches pinned for source screening are not recommended production versions.
Maintenance evidence here is available implementation tests and manifest constraints,
not star counts. Before adoption resolve current stable patch, advisories and its
dependency closure; this snapshot does not certify upstream security history.

## Exact Control Room seams and replacement cost

`deploy/BACKUP_RESTORE.md` already selects native PostgreSQL 17 custom archive,
whole dedicated DB, ownership/ACL retained, separate reviewed roles, explicit empty
restore target and `pg_restore --single-transaction --exit-on-error --no-password`.
It rejects `--clean`, `--create`, dropping ownership/ACL and live-target inference.
`scripts/check-private-vps-database.mjs` performs application-specific schema/role
preflight after restore, not proof of a complete backup. `deploy/README.md` and
`deploy/SUPERVISION.md` preserve storage/lifecycle gates. Keep these; pgBackRest
cannot remove them. A future physical-recovery procedure must protect all tenants
of the shared primary and restore to an isolated cluster, not overwrite that primary.

`src/operations/v1/health.ts` exposes `buildOperationsHealthProbeV1` and snapshots
with freshness, exact scope and eleven probe types. Kuma reachability can populate
only observations it actually measured; Beszel resources can inform headroom.
Neither may synthesize passing audit/queue/backup probes or grant service control.
The current source does not demonstrate a production protected HTTP health endpoint
ready for Kuma; adding one is a thin integration task, not an existing acceptance.
Retain health contract; avoid implementing custom retry/uptime/history/notification
engines. Prefer external dashboards or bounded read-only summary links initially,
not importing Vue/PocketBase UI into React or mirroring their databases.

`src/web/v1/access-verifier.ts::createAccessVerifier` requires
`cf-access-jwt-assertion`, RS256, configured keys, exact issuer/audience, `type:app`,
bounded lifetime and token digest. Retain it for Access. Authelia cannot be enabled
by changing an issuer string; a named protocol adapter must preserve subject
binding and `requireSameOrigin` rules. Live Access configuration remains private.

Cost comparison (estimates, not measured implementation): native restore integration
uses existing scripts plus one rehearsal runner, zero new resident services; pgBackRest
adds cluster/WAL/repository configuration and recovery operations. Kuma adds one
service, persistence and credentials but avoids a custom uptime/notification engine.
Beszel adds hub + per-host agents and observability storage, avoiding custom metric
collection/history/alerts. Authelia adds identity/session/storage operations and
identity migration rather than removing an uncovered current task. **Production
files deleted: zero in this evaluation. Upstream files modified: zero.**

## Executed E2

`node research/reuse-comparisons/f8-kuma-conditions.cjs EXTRACTED_KUMA_ROOT`
ran actual pinned evaluator with synthetic response/readiness context: seven checks
passed (ready, non-200, unknown readiness, missing variable, empty condition list,
malformed JSON and empty group). Empty monitor conditions return null upstream;
application integration must not treat missing configured checks as ready.
No network, DB, listener, notification or existing application interface exercised.
Also ran upstream three `node --test test/backend-test/monitor-conditions/test-*.js`
files; see retained test receipt. No mocked upstream evaluator, dependencies installed
or source modified. RSS/startup/latency of services remain **unmeasured**.

## Required next E3/E4 experiments and action packets

1. **Logical restore, locally serialized by evaluation controller.** Use its owned
   fresh PostgreSQL 17 primary, explicit private socket and port, no ambient PG vars.
   Create `cr_f8_source` and empty `cr_f8_restore`; run repository fixture SQL only
   on source. Dump custom format with explicit source, list archive, restore with
   single transaction/exit-on-error into restore, then run verify SQL. Fixture checks
   row, ownership, read privilege, denied write and denied stranger schema access.
   Additionally prove source row unchanged, failed corrupted archive stays failure,
   required database-level ACL separately restored, and rerun actual current-schema
   application preflight. Tiny fixture alone is not current-schema E3 completion.
   Scripts never connect themselves and guard fixture names, but names are not a
   security boundary: caller must prove this is its disposable primary first.
2. **Kuma private probe.** On owned loopback listener, return 200/ready, 200/stale,
   503, timeout, redirect to login and invalid TLS as appropriate. Execute actual
   Kuma HTTP/JSON monitor, capture notification in owned synthetic sink, restart
   monitor process and verify persisted state/dedup. Feed bounded observation through
   current health builder; missing data stays unknown. Never accept login-page 200
   as application health or disable TLS for production. Use synthetic auth only.
3. **Beszel.** Serialized disposable hub/agent with fixture or explicitly reviewed
   local collection; no real Docker socket/device access. Verify rejected key,
   connect/disconnect/reconnect, metrics persistence and alert delay after restart;
   synthetic webhook sink. Collect equal-duration RSS with named platform and fixture
   load; compare only same workload. Then test advisory headroom mapping to existing
   health contract without task control. No Linux metrics from Mac fixture claims.
4. **Cluster recovery later.** pgBackRest full/incremental/WAL archive/restore into
   separate owned cluster, selected recovery target and corrupted/missing WAL failure;
   prove all database ownership/ACLs. R2 API/storage retention must be tested against
   separately authorized endpoint, not inferred from S3 compatibility. This is not
   a gate to select logical dedicated-DB restore for current initial deployment.
5. **Identity retain.** Finish real owner MFA/subject/logout/denied-owner/origin
   acceptance via existing Access design. No new auth platform needed for source
   fit; user-requested self-hosting would reopen Authelia comparison.

No decisive local comparison is silently deferred as if complete. Keep F8 open until
app probe, host metrics and representative current-schema restore are evaluated.
