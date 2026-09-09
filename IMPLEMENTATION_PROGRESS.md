# Six-batch implementation progress

Baseline: public main e901c0fe986c51ee1d0c091ce2d9b211231ec29e.
Working branch: codex/component-batch-1. All six batches remain in scope.

1. Database/queue/native execution — in progress.
2. Token verification/signing/checkpoints — pending.
3. Idea Lab/readable results — pending integration acceptance.
4. News/article extraction/research — pending integration acceptance.
5. Calendar/isolated workspaces — pending.
6. Optional session observations/operational monitoring — pending.

Attribution decisions 3/4 accompany all batches. Live deployment and owner-host
qualifications require their separate authorization and acceptance; local unit
tests cannot substitute for them.

The actual pg Pool composition is now implemented with session qualification and
idle-error quarantine. A constructor/close test uses the actual pool without
opening a connection. Existing application factories are not switched yet: the
fixture-preparation factory supplies specialized Postgres.js options and must be
migrated deliberately, not broken by changing the default function signature.
Current filesystem inspection supersedes the older package note: cached PG17 was
already extracted and used by a later restore experiment. Earlier PG18 queue
experiments still cannot establish PG17 driver qualification.

## Batch 1 checkpoint

Added a trusted pool-surface adapter for node-postgres with closed admission,
tracked acquisitions, late-client destruction and exactly-once release. Two
initial synthetic tests passed. Expanded to six passing checks including acquisition
failure, never-settling acquisition, active-query shutdown and lost COMMIT response.
The never-settling test exposed and fixed delayed pool shutdown initiation.
TypeScript checking passes. This adapter is not wired into runtime yet.
Added pinned pg 8.23.0 from the existing cache (zero downloads, scripts disabled);
it already existed transitively through pg-boss. No database connection occurred.

Added explicit pg options and exercised the installed pg Client constructor against
synthetic PG environment overrides without connecting. Eight focused tests pass.
Full-source `pnpm check:demo` passes, covering the new unwired modules (the narrower
`pnpm check` entry graph alone did not cover them). Config captures loopback target,
credentials, encoding, startup/session limits and replication=false explicitly.
Actual PG17 primary/version and role preflight still must precede runtime admission.

Transport qualification now has an explicit SQL check for PG17 primary/read-write
and startup session settings. Driver owns the lease during qualification, destroys
rejected leases, and destroys leases even if shutdown interrupts qualification.
Ten focused tests and full-source TypeScript pass.

Actual disposable PG17 driver test now passes: qualification SQL, TCP-disabled
socket fixture, UUID/JSON/array values, and precommit-refusal rollback. Both fixture
runs cleaned up. First run failed because unqualified CREATE TABLE targeted the
protected first search-path schema; explicitly qualifying public fixed the fixture,
without changing runtime settings. This is not full queue/caller/role acceptance.
Reproducible command: node --import tsx scripts/test-pg17-driver.ts <reviewed-PG17-bin>.
The earlier full restore evidence has a separate schema-fingerprint mismatch;
backup/restore acceptance remains open, not covered by this driver pass.

Normal createPrivatePostgresDatabase now selects pg composition with no fallback.
The old factory is explicitly named createLegacyFixturePostgresDatabase and used
only by the specialized fixture-preparation caller. Other legacy probe/generic
database imports still need disposition before removing the postgres dependency.
Exact search_path formatting now matches unchanged application preflight and
passed the real PG17 test again with cleanup. Eleven focused checks pass.
Full-source checking required NODE_ENV=test in the sterile fixture subprocess
environment; corrected without inheriting ambient values. Compiled integration
suite was started after this migration; its result must be read before acceptance.

Compiled suite completed: 56/56 passed after default factory migration. Disposable
PG17 fixture now also runs actual pg-boss through the bounded pg adapter: schema
installed separately by the fixture, send/fetch/complete/exact result readback,
then empty fetch. Queue round trip passed and cluster cleanup confirmed. This
does not yet prove canonical task admission, restricted worker roles or recovery
after a killed worker; those remain the next integration cases.

Extended actual PG17 fixture with a disposable read-only login: allowed SELECT
passed; DELETE and CREATE TABLE were refused and quarantined their pools; original
row remained unchanged. Fixture cleanup confirmed. This validates driver behavior
under SQL permissions, not the complete application-role grants/preflight.
Independent read-only review of checkpoint 286a6a5 is in progress; pending findings
must be resolved before treating this database migration as accepted.

Independent review found missing checked-out client error handling and premature
close acknowledgement from pg-pool bookkeeping. Composition now observes every
connected client's error/end events before checkout; error quarantines the bounded
database, and close awaits actual end acknowledgements. EventEmitter regression
proves an error does not escape and delayed end delays close. Twelve tests pass;
independent remediation review remains pending. These findings invalidate any
earlier implication that the original shutdown implementation was accepted.

Focused independent remediation review accepted both fixes with no remaining
concrete finding in scope; 12 tests passed. Actual disposable fixture now uses
the production pool-lifecycle composition and includes exact owned-backend
termination while a transaction callback waits. That new native run has been
requested but its result/cleanup must be observed before claiming a pass.

Actual disconnect run subsequently passed and cleanup was confirmed. Fixture
preparation now also uses the pg lifecycle composition, preserving max=1 and the
setup application identity. Removed the unused legacy fixture adapter. Thirteen
focused tests pass; an import/type name collision found by TypeScript was fixed
by aliasing PgPool. Remaining Postgres.js users are the specialized rehearsal
probe and generic persistence helper, not a fallback from the pg runtime.

Rehearsal probe now constructs a single pg Client with cached connect promise,
error observer and actual end notification, preserving the injected probe contract
and four expected SQLSTATEs. Focused contract test preserves one reservation and
expected permission refusal. This new probe path still needs actual native probe
workload verification; previous driver tests alone do not qualify it. Generic
createPostgresClient remains the last postgres import and has no current callers
in the public source inventory; its disposition is not yet final.

Final whole-source search found createPostgresClient only at its unused definition.
Removed that generic connection-string helper and the last postgres import, then
removed Postgres.js from package/lock. The maintained bounded configuration API
remains the supported runtime path. This is an intentional pre-alpha source API
removal; external users of that unused helper must migrate to explicit configuration.
No source caller was removed or redirected to a fallback. Full compiled regression
and actual rehearsal-probe verification remain before publishing this removal.

Post-removal compiled suite passed 56/56. Extracted the unchanged pg transport
construction into an explicit trusted helper so the actual transport can run on
the disposable Unix socket. Real PG17 probe timeout returned 57014, subsequent
query retained the exact backend PID, and close/cluster cleanup passed. Full-source
TypeScript also passed. This covers one actual probe error, not all role/lock/
transaction-timeout rehearsal gates or complete canonical queue recovery.

Next: test failed/never-settling acquisitions, active query shutdown and uncertain
commit through the existing bounded wrapper; review actual pg shutdown behavior,
explicit connection/session options and transitive notices before wiring. Then
verify actual caller values and queue/recovery semantics on disposable PostgreSQL.
Do not remove Postgres.js until every remaining import has an accepted disposition.
