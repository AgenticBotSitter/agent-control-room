# Six-batch implementation progress

Baseline: public main e901c0fe986c51ee1d0c091ce2d9b211231ec29e.
Current working branch: codex/component-batch-4, stacked on local batches 1–3.
All six batches remain in scope; no complete batch acceptance is claimed.

## Combined regression checkpoint

Result lifecycle follow-up uses a matching real SHA-256/byte-length fixture, so
late-response assertions no longer depend on content that the browser would reject
for an invalid hash. Positive reading is proven before focus-triggered refresh.
That refresh exposed retained content remaining visible while permission was
being checked; content now clears at refresh start and remains absent on HTTP 403.
The new assertion failed before the fix and all five result tests plus full-source
TypeScript pass afterward. No backend authority or review workspace is changed.

Focused independent review confirmed the sparse-reader correction at 1386aeb;
no concrete regression found. Root accepts the correction with the prior live
collector limitations unchanged.

An asynchronous DOM result-reader regression found that changing tasks retained
the previous selected artifact and incorrectly reported access denied for an
authorized empty task. The reader is now keyed by JSON-encoded project/job tuple,
resetting local selection/error state on navigation. The deferred old response
cannot render in the new task. The new assertion failed before this change and
passes after; all five result tests and full-source TypeScript pass. This is DOM
workflow evidence, not physical-browser accessibility or live authorization proof.

Independent review of 108baf0 confirmed the recovery rollback test's transaction
path, passed both focused tests, and found no concrete issue. Root accepts this
local evidence with its documented PGlite/injected-submission limitations.

The optional observation startup setting previously type-checked but was dropped
by validation. Shared reader capture now preserves it, validates enrollment before
database acquisition, and snapshots binding/method references without polling.
Compiled startup coverage checks the protected route and post-start input mutation;
invalid enrollment checks require zero database/install/view calls. Initial route
test failed because its synthetic page omitted required false authority flags;
correcting that fixture restored the pass without weakening production validation.
Focused observations (15), startup (4 before the additional invalid-enrollment
case), and full-source TypeScript passed. Native collector composition remains gated.
Fresh full compiled build at 1d71417 passed 57/57 tests, including the additional
invalid-enrollment startup case. Independent review of that change is pending.
Review found a sparse-array validation gap: map skipped holes before resource
acquisition. Capture now visits every slot with Array.from and rejects missing
readers explicitly. Sparse and explicit-undefined regressions were added; a fresh
build and all five compiled startup tests pass after correction. Full-source
TypeScript passes. Focused remediation review remains pending.

Follow-up transaction coverage reuses one disposable canonical approval fixture:
after staging a recovery write, fulfilled/rejected Promise, false, and throwing
readiness callbacks each roll back the write and recovery audit. A subsequent
synchronous successful callback commits both. Full-source TypeScript passed.
This strengthens the earlier discovery-only evidence but uses PGlite and an
injected queue submission, not a real pg-boss worker or production PostgreSQL.
The tsx CLI first failed on its sandbox-denied IPC listener; running the same
tests with `node --import tsx --test` avoids that unnecessary listener.
The combined component command now includes the queue suite (52 passing tests).
Its full sequential run passed with exit 0, covering database adapters, queue,
Access, signing, checkpoints, ideas, results, articles, calendar and observations.
These local component checks do not replace outstanding live acceptance gates.

Independent review of 06031feec92a808b80ec278cffdad54a023080ae found no
concrete issue in the readiness-fence correction and passed all 51 queue tests.
Root's fresh compiled application build and all 56 selected tests passed at
that source checkpoint. The correction is accepted locally; the fake discovery
regression is not full transactional or real worker-crash recovery evidence.

Core recovery correction: ready-node queue discovery previously ignored a
returned Promise from its synchronous readiness callback. A regression failed
before the fix (missing expected rejection). The coordinator now reuses the
existing synchronous-fence guard for discovery and never-staged recovery checks,
including the final readiness callback. All 51 queue tests and full-source
TypeScript pass. The new test checks fulfilled/rejected promises and malformed
returns before/after a fake SQL read; it does not prove live recovery or the full
transactional recovery path. Independent review remains pending.

Returned to core queue readiness after the optional observation integration.
Three existing synthetic submission/worker/runtime test files were read in full
and copied unchanged into the contributor checkout; each SHA-256 matches its
original. No private runtime configuration or production source was exported.
`pnpm test:queue` now passes all 50 tests and full-source TypeScript passes.
Coverage includes transaction-local submission, canonical recovery-verifier
refusal, immutable delivery locators, faults, cancellation, late registration
and drain uncertainty. Tests use fake engine/database ports, not actual pg-boss
polling against PostgreSQL or a killed worker; those integration gates remain.
The roadmap now reflects completed observation/signing work without closing
their outstanding host gates. No production behavior changed in this checkpoint.

Independent review of a31cd5a3232866d9574e2fcbabb5c96f28be6941 found no concrete
issue in the unwired fixed-command process adapter and passed all 15 observation
tests. Root's full-source TypeScript rerun also passed after the explicit NODE_ENV
correction. No native process or endpoint was exercised, and no descendant-cleanup
qualification is claimed. The port is not installed in runtime composition.

An unwired pane-list process adapter now uses Node's existing subprocess API
with fixed arguments, explicit environment, output/deadline bounds and child-close
settlement. All 15 observation tests pass; initial full-source TypeScript failed
because the shared ProcessEnv type requires NODE_ENV. The adapter now supplies
an explicit production value rather than inheriting ambient configuration. The new
process tests inject EventEmitter/stream children and launch no executable.
The credential-store command runner was inspected but not reused: it inherits
environment and can reject before terminal close, conflicting with collector
admission semantics. It was not modified. This narrow adapter does not verify
binary identity, endpoint ownership or descendant cleanup, and is not supplied
to runtime composition. Independent review is pending.

Independent review of b42cbd19bb1a5a81b41cc211a1e29726e6c3bbdb found no
concrete issue in multi-source isolation, bounds or per-source visibility and
passed all 12 observation tests. Root's fresh compiled build and all 56 selected
application tests passed at the same source checkpoint. Multi-source local
composition is accepted in this scope; live machine delivery remains unqualified.

Multi-source project aggregation now replaces the earlier single-source limit.
Each reader carries an opaque enrollment key, and the protected response groups
observations with independent offline/revoked/fresh states. The overview reports
recent observers out of enrolled observers, never total machine coverage. Limits
are 16 sources per project, 256 readers per process and 1024 aggregate rows; excess
is refused rather than hidden by truncation. Synthetic two-source tests cover
distinct keys, partial outage and isolated revocation; DOM tests cover partial
coverage and independent expiry. All 12 observation tests and TypeScript pass.
This is retained-reader aggregation, not a live remote transport implementation.
Independent review is pending.

Independent review of e8a56b6692cb5f562dad8bf4b3a6b672749a18b7 found no concrete
issue in collector cancellation/admission or strict server output validation;
all 12 observation tests independently passed. The native connection requirements
and single-source-per-project limitation are recorded in
`HERDR_OBSERVATION_INTEGRATION.md`. No live collection or complete fleet coverage
is claimed by the implemented path.

The retained source now has a collector coordinator adapted from the evaluated
Herdr observer: one allowlisted pane-list port, endpoint identity checks before
and after, generation changes on observed replacement, and a two-second maximum
deadline. It forwards cancellation and holds admission until an ignored port
actually settles; late responses cannot publish or trigger retries. Twelve
observation tests pass with fake ports, disposable SQL and DOM; full-source
TypeScript passes. No executable/socket port is supplied by this module, and
no Herdr process was run. Pinned executable/endpoint isolation, terminal cleanup
qualification and operator scheduling remain required before live collection.
Independent review is pending.

Independent UI review of dbe7876c8e273b7edf61fa75ecf19a40066d028d found no
concrete issue and passed all eight observation tests. The build begun at that
checkpoint passed all 56 selected compiled tests. A subsequent service check
uses the same strict wire before returning data and rejects a reader supplying
another project or extra metadata; all eight source/DOM tests and TypeScript
pass after that addition. This later service check is not included in the
earlier independent review or claimed as separately compiled acceptance.

The project overview now mounts a session-observation panel using the retained
GET API and existing bounded browser JSON reader. A strict browser wire excludes
extra metadata/authority claims and binds the response project. Refresh, focus
and bounded periodic checks clear old rows before reauthorization; denied reads
stop automatic checks. Hidden-page transitions clear observations, late responses
from old project instances are discarded, and request duration counts against
the five-second freshness ceiling. Checks pause after 40 reads until explicit
refresh. Eight synthetic tests (including React DOM) and full-source TypeScript
pass. Physical browser/host qualification and actual source collection remain
open; this does not make an absent observer operational. UI review is pending.

Independent follow-up review of 8a1af31e43ac2b83d0e7271ea2e0fde25f42f4f2 found
no concrete issue in the protected observation route and captured read-only
composition. Reviewer independently passed all six observation tests. Root's
fresh build and all 56 selected compiled application tests also passed. These
accept the scoped local implementation, not live Herdr or browser operation.

Independent review of 2e245740bcb54bb0e62858717f71228df88ce491 found no concrete
issue in the projection/source/service and independently passed all six tests.
The following integration adds GET `/api/v1/projects/:projectId/observations`
to the existing private process. It accepts no query or mutation method, uses
the existing Access verification, project authority and no-store response
headers, and receives only a retained-reader interface. Mounted-process tests
pass for readback, expired token, source revocation, grant revocation and rejected
POST/query requests. Full-source TypeScript passes. UI mounting, actual collector
composition and live acceptance remain pending; source enrollment/replacement is
still operator-owned. The route addition is subsequent to that independent review.

The optional Herdr path now includes an immutable-enrollment retained observation
source and `WebHerdrService`, which reuses `WebSessionAuthority` and the existing
project view checks. Reads never poll a source. Revocation clears retained rows;
disconnect/replacement tickets reject late publication; freshness uses the start
of observation rather than late arrival, with a five-second ceiling. Clock
regression permanently invalidates that source. Keys now include tenant and
workspace scope as well. Six tests pass, including actual disposable SQL project
authorization and revoked-grant refusal; full-source TypeScript passes. The
application route/UI and native observation collector are not yet wired, and
source enrollment is trusted operator composition rather than a management API.
Independent review is pending. No real Herdr socket/process was used.

Batch 6 now has a pure project-scoped projection adapted from the existing
evaluated Herdr v0.9.0 pane-list bridge. It captures explicit workspace mappings,
filters before duplicate-session correlation, scopes opaque keys by project,
source, enrollment revision and observation generation, and omits raw paths,
titles and session references. Three synthetic tests passed; no Herdr process,
socket or agent ran. The projection is unwired: callers still need current
project authorization, source enrollment/revocation, freshness delivery, approved
binary identity, host isolation and protected UI integration. This is not an
authorization service or a completed optional monitoring feature. Added its
tests to the combined local command. Independent review remains pending.

At source commit 38fd882, full-source TypeScript passed and a fresh VPS build
plus all 56 selected compiled integration checks passed. The database, Access,
owner-signing, checkpoint, Idea Lab, result-renderer, article/research and calendar
suites also passed sequentially. Added `pnpm test:components` for that same
sequence and included it in contributor setup so these newer component checks
are not omitted when contributors follow the documented commands. No new CI
workflow, dependency, service, live agent, production database or credential was
used. This regression does not close the outstanding integration and live gates
listed below; it also does not rerun the separate workspace crash qualifications.

Latest checkpoint: saved Idea Lab discussion-to-owner-promotion and collected
news-to-research-task paths now have integrated disposable tests. Workspace
recovery retains physical root identities, survives tested native acknowledgement
gaps and participates in restart admission. Unresolved checkouts prevent startup.
Safe re-adoption, live worker admission and host/browser acceptance remain unfinished.
The chronological entries below retain earlier failures and superseded states.

1. Database/queue/native execution — pg adapter and disposable PG17 queue/restore evidence implemented; full worker recovery remains open.
2. Token verification/signing/checkpoints — JWT library integrated and reviewed; signing/checkpoint gates remain pending.
3. Idea Lab/readable results — protected maintained renderer integrated; full workflow and physical browser acceptance remain open.
4. News/article extraction/research — bounded extraction, storage, approved collection and reader integrated; qualified sources/browser/workflow acceptance remain open.
5. Calendar/isolated workspaces — calendar parity/persistence reviewed; workspace journal, preservation and restart detection implemented; safe re-adoption/dispatch remain open.
6. Optional session observations/operational monitoring — project-scoped retained Herdr projection, revocation/freshness handling, protected read API and overview panel implemented; native collector, physical browser and host monitoring acceptance pending.

Attribution decisions 3/4 accompany all batches. Live deployment and owner-host
qualifications require their separate authorization and acceptance; local unit
tests cannot substitute for them.

The pg Pool migration now includes application factories and removal of the old
Postgres.js client. Disposable PG17 evidence covers actual callers and restores;
see `POSTGRES_RESTORE_EVIDENCE.md`. Earlier PG18/source-only checkpoints below
are historical, not the current acceptance evidence. Production deployment is
not implied by these local results.

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

Full 64-migration schema and actual SecurityStore/WebProjectService now execute in
the disposable PG17 fixture. Project creation, exact idempotent replay, one-project
listing and changed-payload conflict refusal pass. Initial attempts failed because
the synthetic token digest omitted the required sha256: prefix; SQLSTATE/constraint
diagnostics identified the fixture error, corrected without schema changes. All
attempts cleaned up. These are actual project callers, not yet native task recovery.

Extended the same real schema fixture to WebTaskService.propose/detail/list:
idempotent repeat returns the exact receipt, startsWork remains false, and a fresh
pool/service reads the exact same saved detail and one task. This checks canonical
proposed-work persistence, not worker crash recovery or a provider result.

## Batch 2 checkpoint

Branch codex/component-batch-2 is stacked on local batch1 e6c9520, not merged or
published. Selected jsonwebtoken9.0.3 replaces direct RSA signature verification;
canonical encoding, claim schema, trust expiry, identity digest and session caps
remain enforced. Focused tests cover policy refusals, modified signature, trust
snapshot, session cap and noncanonical encoding. Two test groups pass; original
MIT license byte comparison passes. Independent review and compiled suite pending.
No login provider, MFA setting, credential or live Access configuration changed.

Compiled suite passed 56/56. Independent review found an epoch-zero injected-clock
regression in jsonwebtoken's truthy clockTimestamp default. Removed duplicate
library exp/nbf checking; existing application checks still enforce both with the
exact injected clock and session ceiling. Added epoch-zero/expiration regression:
three focused groups pass and full-source checking passes. This final correction
still needs review confirmation; owner-signing/checkpoint work remains pending.

Independent review confirmed the JWT correction; local checkpoint 3afe669 records
it. No live authentication settings changed.

## Batch 3 checkpoint

Stacked branch codex/component-batch-3 adds the selected react-markdown/remark-gfm
renderer inside the existing TaskResultsPanel. Raw HTML is skipped, images never
render/fetch, links allow only explicit HTTP(S), and exact plain text remains
available. Inputs over 32768 characters use full plain text without truncation.
Two focused rendering tests and full-source TypeScript pass. Parent authorization/
stale-result races, browser accessibility, styling, notices and compiled acceptance
remain unfinished; this is not full Idea Lab/project-view completion.

Actual TaskResultsPanel now refuses supplied content when current read permission,
project/job identity or listed artifact/hash no longer matches. Parent rendering
regression covers these cases and the untrusted-content warning; three rendering
tests pass. Added horizontally scrollable tables/code and readable blockquotes.
This is static parent coverage, not asynchronous browser race/accessibility proof.

Original react-markdown and remark-gfm license texts now compare byte-for-byte
with installed packages; attribution names versions/upstream and remaining
transitive release scope. test:results provides four passing groups, including
GFM tables/code and inert file/relative/protocol-relative links. TypeScript passes.

Independent focused renderer review found no concrete issue; static coverage is
not browser or adversarial performance acceptance. Compiled suite passed 56/56.
Additional parent render condition refuses an old page whose project/job differs
from current props while a new request loads; subsequent source checks pass.
Browser accessibility and asynchronous interaction acceptance remain open.

## Batch 4 checkpoint

Stacked branch codex/component-batch-4 adds actual selected Readability/jsdom
extraction of supplied HTML into source-hashed plain text. No collector replacement,
fetching or storage yet. Input/output/element limits reject rather than truncate;
default jsdom script/resource loading remains disabled. Two focused tests pass.
This synchronous primitive must not be wired to live routes until isolated
time/memory-bounded execution, source-bound storage, permissions and notices pass.

Added worker-thread execution with a fixed trusted entry, no inherited Node flags,
two-worker admission ceiling, 3-second deadline and V8 heap/stack limits. Results
are returned only after worker exit; timeout terminates the worker. Actual worker
test covers extraction, timeout and subsequent extraction; three tests pass.
V8 limits are not a hard total-RSS bound or OS security sandbox. HTTP integration
is still held pending resource review, source storage and authorization design.

Worker tests now also cover simultaneous requests, capacity release and excess
output refusal. Timeout is terminal even if a late worker message/error arrives;
the worker receives an empty environment. Eight article tests and full-source
TypeScript pass. Direct dependency license files are retained.

Added source-detail composition using the existing reader interface and canonical
story parser. It rechecks project/story/digest and current authority before reading,
after reading and after extraction. Reader endpoint, content type and byte count
must match. Repeat extraction is stable; changed bytes create a new detail digest
without modifying the story or approved task. Tests cover cross-project/stale
binding, revocation after extraction, cancellation and incorrect reader provenance.
The injected reader tests do not prove network, protected routes or persistence.

Independent review found jsdom's default console could log raw malformed CSS.
A disconnected VirtualConsole fixes that leak. The reviewer also caught a weak
regression fixture; it now uses the confirmed unterminated-comment reproducer.
The compiled suite passed 56/56; nine focused article tests and source checking
passed; the corrected regression fixture also passed in the final nine-test rerun.
Independent remediation review confirmed the console fix, with no other finding.

Next: source-bound detail persistence and protected reading UI, with migration,
role/real-PG tests and browser acceptance.
Do not claim this trusted composition itself authenticates a user or that V8 limits
provide a hard process RSS cap. Database queue recovery, signing/checkpoints,
Idea Lab acceptance, schedules/workspaces and operational monitoring remain open.

### Article storage and protected reader

Added immutable migration0065, source-bound HMAC/digest-verified store, web SELECT
and ingestion SELECT/INSERT permissions, and retained-only authenticated GET.
The news page now opens stored article text through the maintained renderer.
Actual disposable PG17 save/replay/readback and denied reader writes passed with
cluster cleanup. Source tests connect the extractor/store to the actual HTTP
process, including expired access and invalid requests. Fake-DOM tests cover old
project responses, reading/closing, unavailable text and focus-time access loss.

The first compiled regression run failed22 checks because the SQL web-role template
had not gained the new SELECT privilege; this was corrected to match preflight,
without granting web writes. Targeted compiled schema tests then passed3/3.
Independent review found indexed-digest replay and indefinitely retained open text.
Both were corrected with regression tests; remediation review found no additional
concrete issue. Revalidation is periodic, not a hard browser timing guarantee.
Final verification: article suite11/11, compiled suite56/56, renderer suite4/4,
full-source TypeScript and diff whitespace checks passed. Disposable PG17 final
schema fixture passed and reported cleanup. No deployment or GitHub push occurred.

Still missing: authorized ingestion wiring to populate article detail automatically,
physical-browser accessibility/visual acceptance, hostile parser resource policy
and live source acceptance. The full six-batch objective remains incomplete.

### Approved collection integration

The ingestion-wiring item above is now implemented as explicit optional maxArticles
in the approved discovery limits. Old plans do not gain new reads. The collector
reuses the existing guarded HTTP transport and all shared budgets, then saves
extractions under unchanged source settings. Parser failures prevent confirmation;
transport/authority/database uncertainty propagates instead of retrying.

Source collection tests cover opt-in, old behavior, exhausted request budget and
source disabling before save. Actual PG17 configured collection/storage passed
using synthetic HTTP and cleaned up. Build inspection exposed missing worker assets;
the Node build now emits them beside generated importers, with an actual compiled
worker test. Independent review caught cancellation not reaching the parser;
signal-driven worker termination fixes it, with source/compiled regressions and
accepted remediation review. Initial TypeScript options-inference failure was fixed
by an explicit named options parameter and JSDoc, not a type-check suppression.

Final verification after the stricter article-summary count check: compiled
regression56/56, compiled extractor1/1, article suite13/13, full-source TypeScript,
diff whitespace checks and disposable PG17 collection/storage all passed.
No production template, service, live source or GitHub state changed.

## Batch 5 calendar checkpoint

Selected cron-parser5.10.0 is now an explicit pinned dependency. Typed compatibility
grammar delegates field expansion and matching to upstream; the retained occurrence
calculator keeps window bounds, stable local keys, DST deduplication and once/interval
policy. These two reviewed generic source/test files were brought into the public
implementation checkout without private history, identities or deployment material.
Eight focused tests pass, covering numeric grammar, singleton-step compatibility,
day OR semantics, impossible dates, DST and unchanged occurrence-policy cases.

This is calculator integration, not a running scheduler. Durable occurrence/outbox
replay, broader parity and upgrade regressions, native database acceptance, final
review and isolated workspaces remain unfinished. The private source is unchanged.

Full-source TypeScript, compiled regression56/56, whitespace validation and exact
upstream license comparison also pass. The article browser fixture and manual
checklist are retained locally, but visual acceptance is still blocked by the
locked Mac. No preview listener was started during this checkpoint.

### Calendar persistence checkpoint

The existing generic occurrence store is now included in the public implementation
checkout. A shared synthetic scenario connects the selected parser/calculator to
occurrence and outbox persistence. It verifies exact replay, conflicting target
refusal, tenant separation, no acknowledgement before delivery, repeat reconciliation
and one outbox record. Review found that explicit acknowledgement could resurrect
a cancelled occurrence; it now returns occurrence_cancelled instead.

The same scenario passed on disposable PG17 after closing the first pool and
constructing a fresh pool/service. Cancelled state remains unchanged. The fixture
also completed its existing project/task, queue, article, permission and disconnect
checks and reported cleanup true. PGlite provides a separate passing source check;
that check alone is not native restart evidence.

Delivery markers in this scenario are fixture-seeded. It does not prove queue
dispatch, execution, process-crash recovery, database-server restart or scheduler
production roles. Those gates, extended parity, review and workspace isolation
remain open. Reproduce source checks with pnpm test:calendar and native checks with
the documented scripts/test-pg17-driver.ts command.

Expanded concurrency evidence: four simultaneous materializations on actual PG17
produce exactly one new occurrence and three equal replays, retaining one outbox
record. A PGlite transaction-level injected outbox-write failure leaves no partial
occurrence, and a subsequent normal attempt succeeds. The latter is source-level
rollback evidence, not a native crash simulation. Calendar9/9, full-source TypeScript
and the expanded native fixture passed; native cleanup was confirmed.

Calendar compatibility is now a durable integration regression: 42 synthetic
definition/window cases were recovered from the original comparison and their
outputs freshly calculated with the unchanged pre-adoption source (SHA256
7ddc7925c7e7ba5c3f80eeeedd52c827a0cfaa69572f6370ff259b68baa9099c).
Frozen hashes cover complete ordered outputs, including occurrence IDs and UTC/
local times, not just counts. The integrated maintained-parser calculator matches
all42. Total calendar suite51/51 and full-source TypeScript pass. The initial
attempt to transfer full output vectors exceeded tool output limits and was not
saved; the successful fixture contains complete case inputs plus count/reason and
full-output digest. No truncated historical receipt was treated as full evidence.

Do not regenerate expected hashes from the candidate implementation on an upgrade.
Changes require an explicit schedule-policy decision and migration/replay analysis.

### Independent calendar review — acceptance held

Review of 881f9fd independently reproduced two defects despite51 passing tests:

- Delimiter-based outbox IDs collide for valid generated identities: tenant x /
  schedule a:a and tenant x:a:a / schedule a produce the same outbox ID for the
  same local time. The global outbox primary key rejects the second tenant's work.
  A replacement needs an unambiguous encoding plus disposition of existing IDs;
  acknowledgement and reconciliation must use the same identity contract.
- Denver fallback windows07:00–08:00Z and08:00–09:00Z on2026-11-01 produce the
  same01:30 occurrence key with07:30Z and08:30Z respectively. The later proposal
  conflicts rather than replaying. This is a retained baseline defect; parity does
  not establish correct window-independent earlier-instant behavior. Use reviewed
  timezone-library ambiguity support rather than a new custom timezone engine.

Root reproduced the split-window issue separately. Both findings must be repaired
and regression-tested before calendar acceptance. No dispatch wiring was added.
The review used source and effect-free tests, not native execution or production.

Calendar remediation is implemented locally, pending independent re-review:
Luxon3.7.2 getPossibleOffsets selects the earlier instant independently of the
requested window. Split-window regressions cover Denver's hour and Lord Howe's
half-hour fallback. All42 original parity cases still match; calendar52/52 pass.

New outbox IDs use hexadecimal encoding of a length-prefixed ASCII identity tuple.
Existing rows are not rewritten or re-enqueued. Acknowledgement/reconciliation
accept a legacy ID only with matching tenant, topic, aggregate, idempotency key
and exact occurrence payload. Native PG17 verifies both formerly colliding scopes,
legacy reconciliation and refusal of a changed target payload. Native fixture
and full-source TypeScript pass; cleanup confirmed. This does not establish live
dispatch/recovery acceptance. No production schema migration is needed for the
encoding; legacy rows remain under the original delivery identity.

Independent remediation re-review accepted both fixes at3555f83, confirmed SQL/JS
identity encoding equivalence for permitted ASCII identifiers and exact legacy
payload binding, and found no concrete regression. Reviewer ran calendar52/52
and an in-memory SQL probe, not native effects. Root's compiled regression56/56
also passed. The selected calendar calculation/store replacement is accepted for
this tested internal-proposal scope; this is not acceptance of a running scheduler,
automatic dispatch, crash recovery or the complete fifth batch.

### Workspace integration started

The existing generic Codex workspace lease manager is now present in the public
implementation checkout. Its in-memory prepare check had an asynchronous race:
two calls could both enter creation before either recorded an active lease.
Preparation and cleanup now share a per-run pending-operation guard established
before awaiting the port and cleared in finally. Two source tests pass, covering
duplicate preparation/removal, create during removal, retained lease after removal
refusal and changed physical identity preventing removal. Full-source TypeScript
passes. No Git worktree or filesystem effect was performed by these injected tests.

This is not durable ownership, cross-process exclusion or a native adapter. Next
requirements remain the selected bounded Git port, durable recovery/ownership,
dirty-content preservation and real disposable Git tests. A failed or uncertain
native create cannot be retried or cleaned up merely from this in-memory guard;
the concrete adapter/recovery protocol must establish what exists first.

Workspace uncertainty guard: after crossing createDetachedWorktree, a rejected
call or invalid readback now retains a per-run reconciliation hold instead of
allowing immediate retry. No automatic removal is attempted. Inputs and cleanup
leases are captured before asynchronous port access, preventing caller mutation
from changing the in-flight operation or clearing the wrong busy key. Four source
tests and full-source TypeScript pass. This hold lasts only for this manager's
lifetime and deliberately provides no unverified reset API; durable reconciliation
across process restart remains to be implemented before native/runtime wiring.

Native Git fit checkpoint: scripts/test-workspace-git.ts creates an empty owned
repository with no remotes, synthetic commit identity, empty hooks/templates and
disabled global/system Git configuration. The actual manager plus fixture-local
Git port passed exact detached HEAD, unchanged checkout after source branch
advancement, duplicate preparation refusal, preserved untracked dirty file, and
clean lease removal. Fixture cleanup and absence were verified. No user checkout,
credential store, provider, network or production service was used.

The initial TypeScript check found the repository's required NODE_ENV field absent
from the sterile subprocess environment. Added NODE_ENV=test and reran checking.
The native receipt precedes that environment-only correction. The fixture-local
port is deliberately not a production adapter: it relies on a freshly generated
trusted repository, and does not qualify hostile Git configuration, ignored or
tracked dirty content, cross-process ownership, lost responses or restart recovery.
These remain required; no generic Git executor is exposed by this checkpoint.

Follow-up typing correction: NODE_ENV also required a literal type rather than
inferred string. After retaining the literal test value, full-source TypeScript
passed. No runtime policy changed.

Expanded native Git preservation evidence: tracked edits, staged edits, untracked
files and ignored files all prevent fixture-port cleanup and remain readable.
Ordinary porcelain status was explicitly empty with the ignored fixture present;
the adapter check therefore includes --ignored=matching instead of trusting that
empty result. Clean removal succeeds only after restoring/removing exact synthetic
fixture content. The native run, cleanup/absence and full-source TypeScript passed.
This strengthens the chosen Git-port acceptance scenarios; the fixture-local port
still must not be represented as the production implementation or restart proof.

Reusable native Git port checkpoint: git-workspace-port.ts now supplies the
manager's operations using an injected trusted bounded Git runner. It pins root
and common Git-directory identities, limits paths to direct managed children,
refuses existing targets, verifies detached exact HEAD/common directory and holds
uncertain effects. Removal requires its own observed identity and clean status
including ignored files. No force/reset/prune or remote command is constructed.

The native fixture now invokes this module rather than a separate fixture-only
implementation. All prior preservation cases pass, plus pre-existing-target
preservation and an injected lost response after actual worktree creation: the
directory remains, retry is refused, and unverified removal is refused. Fixture
cleanup/absence passed. Runtime remains unwired. The runner still requires a
reviewed executable/configuration/host boundary; this does not qualify arbitrary
repository hooks/filters, filesystem races against another local writer, durable
cross-process ownership or recovery after restart. Independent review is pending.

Workspace committed-content correction: clean status alone did not protect a new
detached commit. The port now retains the admitted revision and refuses removal
when HEAD differs, requiring preservation rather than silently dropping the
checkout. Actual Git regression creates a new commit with clean status, verifies
removal refusal and confirms the commit and file remain. Full native fixture and
cleanup/absence pass, as does full-source TypeScript. The fixture's final cleanup
removes its exclusively owned synthetic cohort; it is not production cleanup logic.

Independent workspace review found two gaps: manager overlap logic misclassified
the legitimate nested name ..work, and Git index flags could conceal tracked
edits from ordinary status. Corrected overlap using parent path components;
cleanup now rejects non-H entries from git ls-files -v -z, including assume-unchanged
and skip-worktree. Actual disposable Git reproduces hidden edits with empty status
for both flags and proves cleanup refusal preserves content. Five manager tests,
full-source TypeScript and native fixture/cleanup pass. Compiled56/56 passed at
the pre-remediation checkpoint; final remediation re-review remains due.

Independent re-review of ffaeb65 confirmed both workspace findings resolved and
found no concrete regression. Reviewer ran five source-only manager tests; it
did not repeat native effects. Root reran the five tests and full-source TypeScript
successfully. Durable recovery is now specified in WORKSPACE_RECOVERY_INTEGRATION.md:
reuse the bridge journal for protected local evidence while retaining PostgreSQL
admission authority. This contract is the next implementation block, not a claim
that persistence, cross-process exclusion or recovery already exists.

Workspace journal implementation started: the existing bridge SQLite journal
now holds immutable versioned intents, exact scope/attempt/lease binding, one
target/run reservation, digest-verified protected inventory and a1024-entry cap.
Admission checks run before and after insertion inside the existing immediate
transaction; revocation rolls insertion back. Historical replay returns existing,
not permission to retry. SQLite schema marker advances to5.

A disposable file-backed test passed with two journal connections: exact replay,
changed lease/job refusal, revoked-admission rollback, close/reopen persistence
and reconciliation-required inventory. Full-source TypeScript passed. This is
not a two-process race or crash test. Manager/port wiring, verified creation/removal
transitions, durable release/retention policy and independent review remain open.
No existing journal, production database or service was changed.

Two-process reservation regression: both disposable children reach an IPC ready
barrier, then compete for the same intent; exactly one records it and one reads
existing. Parent waits for both exits, reopens the journal, verifies one held intent
and confirms exact temporary-root cleanup. This initially exposed database-locked
errors before the constructor installed busy_timeout. Installing that bounded wait
before journal_mode configuration corrected the reproduced initialization race.
Five consecutive post-fix runs and full-source TypeScript passed. No application
retry loop was added. This is process-contention/persistence evidence, not a killed
Git process or verified creation/removal recovery test.

Verified-creation journaling now records immutable exact path/repository/revision
and device/inode evidence bound to a saved intent. Conflicting readback is refused;
revoked admission rolls evidence insertion back. Reopening preserves that evidence
but still reports reconciliation required. Journal schema marker advances to6.

The new journaledWorkspacePort connects intent-before-effect and evidence-before-
return to the existing port. Exact replay refuses another creation. Removal is
explicitly unavailable through this composition until its durable transition is
implemented. Tests cover reservation visibility inside the injected create call,
creation readback, binding refusal, repeat composition and no unjournaled removal.
File-backed journal, two-process reservation and composition tests pass, as does
full-source TypeScript. Actual Git plus this journal composition, crash-boundary
tests, removal transitions, reconciliation and independent review remain pending.

Actual Git/journal composition now passes in the disposable fixture: manager
preparation records the intent, creates a detached checkout through the reusable
Git port and saves matching revision/inode readback. After closing/reopening the
file-backed journal and reconstructing composition, prepare refuses reconciliation-
required state without another Git creation, and the checkout remains intact.
Full native preservation fixture, exact cleanup/absence and TypeScript passed.
This proves restart-of-composition refusal, not process-kill boundary recovery or
safe re-adoption; those and durable removal remain unfinished.

Durable removal transition added: a separate current-removal authority callback
is mandatory; immutable binding to verified creation is reserved before the Git
port runs, then a monotonic removed marker records confirmed completion. Duplicate
or interrupted removal is held for reconciliation, never automatically retried.
Journal schema marker advances to7. Tests cover absent authority, exact repeat,
missing intent, revoked-removal rollback and pending state after journal reopen.

The disposable native Git fixture now executes clean removal through this journal
composition, checks physical absence before/after journal reopen and verifies the
saved removed state and no same-run recreation. Native fixture/cleanup passed;
three journal test groups and TypeScript passed before the final pending-state
regression addition. Crash interruption, safe re-adoption, retention/release and
independent review remain unfinished; no production wiring or database change.

### Read-only workspace recovery observation

Added native observation of saved checkout identity without create/remove/adopt
effects. States distinguish absent, unchanged, changed, preserved work and
unavailable reads. Git optional locks are disabled for observation. Disposable
Git tests cover unchanged and missing checkout, changed inode, untracked/ignored
files, hidden index edits, committed work, read failure and refusal to remove
through a fresh observer. Observations remain advisory rather than atomic and
never release durable reservations or authorize another effect.

Verification: TypeScript passed; eight manager/journal tests passed (including
two actual competing processes); native Git fixture passed and confirmed exact
fixture cleanup; compiled application regression passed 56/56. No production
service, live provider, push or GitHub Actions run. Crash-boundary recovery,
safe re-adoption and independent review remain unfinished.

### Forced-process journal durability

Four new tests kill an exact disposable child with SIGKILL after its committed
intent, creation evidence, removal intent, or removed marker. The child does not
close/checkpoint SQLite before termination. Parent waits for terminal signal,
reopens the file, checks the exact retained state and verifies journaled creation
refuses replay with zero fake-port effects. All four passed, as did TypeScript;
each exclusively owned temporary directory was removed and absence checked.

Creation/removal evidence in these tests is synthetic. This is actual process-
crash journal durability evidence, not an interrupted native Git integration
test or safe adoption proof. Those broader recovery gates remain open.

Independent source review at8477eb1 found a P1 async-authority callback defect:
TypeScript permits async functions in void callback positions, so a rejected
promise previously did not stop a subsequent effect. Workspace journal and port
checks now require an undefined synchronous return, reject promises/non-undefined
values immediately and observe promise rejection to prevent unhandled rejection.
Regression covers each of the two transactional checks and the final pre-effect
check for create/remove, plus creation evidence recording. No fake effects occur;
transactional failures roll back while post-commit failures retain uncertainty.
Thirteen combined workspace tests and TypeScript passed. Re-review is pending.
The public component roadmap was also updated to distinguish newly implemented
adapters from their still-open host/runtime acceptance requirements.

Independent re-review at4ae681b accepted the async-authority remediation, ran
seven permitted fake/in-memory tests and found no concrete regression. Root also
reran the disposable native Git fixture successfully, including cleanup/absence.
Review acceptance applies to this callback fix and inspected journal/port scope;
it does not certify safe re-adoption, interrupted native Git recovery, production
authority composition or any unperformed platform acceptance.

### Native acknowledgement-gap recovery and durable roots

The new opt-in native Git crash fixture stops four exact workers with SIGKILL
after completed Git creation/before readback, after persisted creation with work,
after completed removal/before its marker, and after persisted removal. Reopened
journals retain the expected state; physical files/absence agree; fresh composition
performs zero duplicate Git effects. These are post-command acknowledgement gaps,
not interruption of Git itself. Every child reached its intended boundary and
terminated before readback; the exclusively owned fixture tree was cleaned up.

Journal schema8 adds immutable pre-creation repository/workspace/common-Git
physical identities. The journaled port captures and saves them before creation.
Root records are bound to the admitted intent, conflict checked and cannot be
retrofitted onto already-recorded creation without earlier roots. Legacy rows stay
readable but do not gain invented identity evidence. Tests cover revocation
rollback, replay, conflicting inode/path and file-backed reopen.

The observer accepts saved roots and distinguishes an actual replacement workspace
folder from absence in the original folder. Native crash tests exercise this after
restart while retaining the original synthetic tree. TypeScript,13 combined
workspace tests, all four native crash boundaries and the existing native Git
preservation fixture passed with confirmed cleanup. Independent review and the
fresh compiled regression are pending. Safe re-adoption, in-flight Git crashes,
global admission integration and release/retention policy remain unfinished.

The fresh compiled regression passed56/56. Independent source review at4a35626
found no concrete root-identity regression, but identified a P2 fixture timeout
cleanup gap: a killed worker could leave Git alive. The fixture now uses an owned
POSIX process group, terminates that group on timeout and confirms its absence
before readback/cleanup. Unconfirmed termination preserves the fixture directory.
The first stricter run exposed asynchronous process reaping (immediate absence
check failed; final cleanup still confirmed absence). A bounded one-second reaping
wait fixed that false failure without weakening the absence requirement.

A deterministic fifth case starts harmless Git blocked on stdin, invokes the same
group-termination path, and proves both worker and Git group are gone. All four
acknowledgement-gap cases plus this cleanup challenge pass; TypeScript and exact
cleanup pass. This fifth case is not in-flight worktree modification recovery.
Final source re-review of the cleanup correction remains pending.

Source re-review at51ae4c1 accepted the fixture P2 correction with no concrete
regression. Reviewer confirmed owned-group termination/absence and preserved
uncertainty; native/process execution remained root-provided evidence. This closes
the reported fixture issue, not the remaining runtime/re-adoption acceptance.

### Workspace evidence joined to restart admission

The existing native restart inventory now includes bounded workspace metadata
from the same bridge-journal transaction. Raw paths, inode/device values and root
details are omitted; an evidence digest detects changed records across the two
existing restart sweeps. Unresolved workspaces keep the inventory in reconciliation
state even without a delivery/run, rather than disappearing from startup checks.
Matching deliveries must agree on project/job/run/lease identity. Saved removal
is historical only and never becomes fresh cleanup or pickup authority.

A focused real-journal test exercises missing/matching/mismatched delivery metadata,
foreign node scope, metadata changing between sweeps, pending and historical removal,
and path exclusion. It also calls the actual lease-aware runtime constructor and
proves unresolved workspace state refuses startup before key/transport composition.
Focused tests and TypeScript passed; fresh compiled regression and independent
review pending. This does not yet re-adopt a checkout or resume a native agent.

Independent review at2ac0c7b found no concrete regression and reran the focused
in-memory test. It confirmed private-path exclusion, exact delivery binding,
startup refusal and changing-sweep detection. The fresh compiled regression
completed56/56 with exit0. No native execution or production integration was
performed for this inventory change.

### Recovery permission freshness checks

Inspection confirmed existing signed recovery permits only exact-known-run status
and stop, not checkout re-adoption or a new start. Do not reuse that permission
as workspace takeover authority. The same async callback pitfall previously fixed
for workspaces existed in recovery profile/trust freshness callbacks. A shared
synchronous-fence check now protects both without expanding either permission.

One disposable database fixture exercises valid recovery, forbidden start, and
resolved/rejected async callbacks at both freshness checks for profile and trust.
The actual adapter additionally refuses a late async rejection before stop bytes,
records uncertainty and does not retry through a replacement adapter. No live
transport, credential access or provider was used. TypeScript and three focused
test groups passed; compiled native regressions and independent review pending.

Recovery review at78176d3 found no concrete regression and reran all three focused
tests; five freshly compiled managed-session/native-evidence tests passed. The
same defect was then reproduced in start-authority with a failing expected-rejection
test. Start policy/profile freshness now uses the same synchronous fence before
admission/effect markers. A one-database matrix covers both check/mark operations,
first/final callback checks and resolved/rejected promises; no effects are recorded
for refusals and a subsequent valid simulated start still works. Malformed falsy
callback values are rejected rather than treated as missing in start/recovery.
TypeScript and focused tests passed; final start-path independent review pending.

Independent review at569675b accepted the start/recovery changes with no concrete
finding and reran both synthetic test files. All56 freshly compiled application
tests also passed. The fix changes validation of callback completion, not the
permitted operations or canonical binding rules. Safe checkout re-adoption and
live fleet acceptance remain unfinished.

### Research form project isolation

Mac UI access was rechecked and remains locked; no desktop bypass or preview
listener was attempted. Automated DOM testing reproduced a real research-form
bug: delayed project-one draft content appeared after props selected project-two.
The form now binds its instance to exact project/story/version, aborts obsolete
read-only preparation and never displays the old draft in the new context.

An uncertain save retains its existing task client/idempotency key rather than
being discarded on rebind. The form hides old content and offers only explicit
retry of that original save until settled, then opens the requested context.
Tests prove project/story version isolation, correct new-project save, and a 500
response followed by an exact original-project/body/key retry after switching.
No live agent or real server was used for these DOM checks.

`pnpm test:articles` now includes these regressions;15/15 passed with TypeScript.
Seven combined reader/research/renderer checks passed separately. Compiled article
verification and independent review pending; physical browser acceptance remains
unfinished. Existing maintained extraction/rendering and task client are reused.

### Project route identity regression closure

The research-form change at d706bc2 received an independent source review with
no concrete finding; the reviewer reran its two DOM tests. Compiled article
extraction also passed. This does not constitute physical browser acceptance.

The news, task-list and task-detail routes previously joined project and cursor
or task IDs with colons for React keys. Since IDs themselves contain colons,
different contexts could produce identical keys. A regression test reproduced
the task-list collision before the fix. These three routes now use JSON tuple
keys, keeping field boundaries explicit without changing routing or permissions.
The tests call the actual route components, check adversarial tuples and stable
identical identities. TypeScript and all 17 article/research checks pass; the
VPS artifact rebuild and compiled extractor test also pass. The route-key change
has not received a separate independent review or physical browser acceptance.

All changes remain local. GitHub inspection found no open public PR; the owner's
unnumbered merge approval could not be mapped safely to an older private PR.
No merge, push, deployment or live agent invocation was performed.

### Idea Lab saved workflow integration

Added `pnpm test:ideas` using the actual coordinator, run/registry stores,
deterministic synthesis engine and authenticated owner-decision service with one
disposable migrated PGlite database. The injected driver makes eight turns across
four perspectives/two rounds. Round two includes every prior perspective as
untrusted excerpts within the retained prompt limit. Completion and synthesis
alone create no project. Unknown owner promotion is refused; the authenticated
synthetic owner promotes once, with saved session lineage and replay handling.
Reconstructing coordinator/store objects reuses the completed run without another
invocation. A lost-response run remains ambiguous and is not reinvoked.

This is local synthetic integration evidence, not a process-kill test, actual
Hermes/Codex provider execution, native PostgreSQL qualification or browser
acceptance. Those remain open. No parallel database-heavy suites are required.
`pnpm test:ideas` and full-source `pnpm check:demo` both passed locally.

### Collected news to saved research task

Extended the existing disposable collection test through WebNewsService and the
actual task HTTP handler. The selected collector/parsers and article extractor
produce the retained source; preparation preserves the exact story digest and
source URL, creates no task, and makes no additional retrieval. Review-only news
can produce verification-first research, not a setup guide. Unknown versions and
cross-project story selection are refused. Saving returns one proposed task;
exact retry reuses its receipt, changed-body reuse conflicts, and readback retains
the complete draft with no execution attempts. The other project remains empty.

An initial test setup passed an article-specific scope to a workspace-scoped web
service and received not_found. Correcting the fixture composition resolved it;
no production behavior was weakened. This test uses injected network responses
and one migrated PGlite database, not live source/provider or production evidence.
All 17 article/research tests and full-source TypeScript checking pass with this
extended path. No independent review of the new integration test is claimed.

### Owner signing protocol closure

Exported the previously implemented generic bounded-owner-signature wrapper and
its synthetic test, preserving the one-attempt contract. Reprepared the selected
ssh2 1.17.0 in a logged isolated directory; the agent.js hash matches the earlier
evaluation. The new explicit-path evaluation script uses its exported AgentProtocol
for both ends of an in-memory connection, with ephemeral Ed25519 keys only.
Valid/denied/missing/aborted/wrong-key/short-signature cases passed; both protocol
objects are destroyed and a second sign is refused. No custom SSH framing added.

This closes protocol-to-wrapper evidence only. Actual owned connection acquisition,
late acquisition disposal, socket permissions, dedicated custody, trusted consent,
host acceptance and runtime wiring remain open. The app has no ssh2 dependency
and these local tests authorize no real signer or connection. The separately
installed package and cleanup target are recorded in DEPENDENCY_PREPARATION_LOG.md.

### Owned signing readiness and cancellation

Added an unwired owned-connection wrapper around the retained bounded signer.
Unlike OpenSSHAgent.sign, the injected connector must return a close handle
synchronously, before readiness resolves. One total deadline spans readiness and
signature; input is copied before acquisition, cancellation closes once, late
readiness cannot sign, and the wrapper cannot be retried. A failed close prevents
returning a successful signature. Closing does not prove remote signing cancellation.

Three source tests cover the existing bounded signer and the new readiness/signing
matrix. Eight pinned ssh2 in-memory cases passed, including acquisition abort and
timeout with zero sign requests even after late readiness. Full-source TypeScript
passed. This is not a real socket connector, owner custody or terminal OS-resource
proof. The trusted connector's close obligation still requires implementation and
host qualification; independent review of this new wrapper is pending.

Independent review at aa2e390 found no concrete issue and reran all three local
tests successfully. It inspected, but did not rerun, the pinned ssh2 script.
Acceptance remains limited to the owned-readiness wrapper and injected contract;
actual connector cleanup and OS-resource acceptance are not established.

### Concrete signing stream ownership

Added an unwired Node Duplex-to-selected-AgentProtocol adapter. It takes ownership
of an already-created stream while connection readiness is pending, propagates
error/end/close/abort into refusal, never creates a protocol after late readiness,
and unpipes/destroys both objects on cleanup. Cancellation reentered during the
protocol factory also destroys its returned object. Cleanup failure is retained
and repeated close cannot turn it into success. It contains no socket discovery,
key enumeration, SSH framing or credentials.

Six local source tests and eight actual pinned ssh2 in-memory cases pass; the
latter now exercise this concrete adapter rather than directly connecting the
protocols in the test. Full-source TypeScript passes. Destruction is a local
stream teardown request, not proof of terminal OS resources or remote cancellation.
Real explicitly configured connection creation, permissions, custody and host
qualification remain open; this adapter has not yet received independent review.

Independent review at 86cc8fc found no concrete issue and reran all six source
tests. It inspected, but did not execute, the pinned protocol script. Acceptance
is local stream teardown behavior, not native connection or custody qualification.

### Paired signing to canonical intake

Extended the pinned ssh2 evaluation through the actual native owner approval
issuer and canonical approval storage fixture. A complete pair opens two owned
connections and stores once, with replay returning the saved receipt and no work
start. Losing the second response refuses the whole packet; withdrawal of the
synthetic consent gate after the first signature prevents a second connection.
Neither refusal adds a stored packet, and reissuing the consumed issuer is refused.
All created in-memory streams are destroyed; the shared disposable fixture is
closed in finally. Eight protocol cases and three paired-issuer cases pass, along
with full-source TypeScript. The new composed test has not been independently
reviewed. This does not establish actual human consent, OS socket closure or real
key custody; no such resources were used.

### Explicit owner endpoint policy and connection composition

Added an unwired POSIX endpoint policy requiring an explicit normalized absolute
socket path, owner UID, owner-only immediate directory/socket permissions and
stable canonical/device/inode observations. Preparation detects directory
replacement during inspection; recheck refuses replaced objects and cancellation.
The connection composition retains the selected stream/protocol adapters and
rechecks after connection readiness, before exposing a signing protocol.

Three local tests cover unsafe input/permissions/ownership, identity changes,
cancellation and post-connect refusal with fake inspection and in-memory streams.
Full-source TypeScript passes. No actual filesystem inspector or socket factory
was added or invoked. This is not atomic filesystem-to-socket identity assurance,
peer authentication, Windows support, real key custody or deployment acceptance.
Those remain explicit work; the owner key pin and consent boundaries still apply.
Independent review of these additions remains pending.

### Native owner-agent ports, still unwired

Added native lstat/realpath metadata inspection with before/after identity checks
and symlink/alias refusal, plus an explicit Node Socket factory that connects only
when its returned effect function is called. No ambient SSH agent is read. The
socket port retains connection failure observers; synchronous connect failure
requests destruction and returns a sanitized error. Neither port is runtime-wired.

Eleven focused tests and full-source TypeScript pass. Actual filesystem inspection
uses only an owned temporary directory/symlink, removed with an ENOENT check in
finally. Socket tests inject an EventEmitter-based fake; no native socket was
created or connected. An initial alias test normalized away its intended invalid
input with path.join; the test was corrected, not the implementation relaxed.
Native socket/peer identity, OS-terminal teardown, dedicated custody and platform
acceptance remain unproven. Independent review of these ports remains pending.

Independent review at f3fb976 found no concrete issue and reran the three fake
endpoint/connection tests; it inspected but did not run native-port tests. Root
ran the new `pnpm test:owner-signing` command: all11 focused tests passed, including
the disposable metadata check and fake socket port. No native socket attempt was
performed. Real native qualification remains a separate authorization/gate.

### Retained etcd adapter source integration

Copied the existing generic five-module etcd completion-checkpoint adapter and
two synthetic test files into this sanitized checkout, under the standing source
export approval. No private history, endpoints, identities or credentials were
copied. This reuses the prior adapter instead of implementing another checkpoint
service. The port joins the existing awaited checkpoint/staging interface and
accepts only separately provisioned scope/cluster/key-generation pins.

All 18 focused tests pass: exact original-byte/value/generation/modification/lease
comparisons, large revisions, single-Put acknowledgement checks, cancellation,
shared deadlines, no writes before flush and no automatic initialization/retry.
Full-source TypeScript passes. The same-domain restore diagnostic deliberately
shows that co-restoring the database and anchor defeats independence; its passing
assertion is not backup safety. Added `pnpm test:checkpoints` for contributors.

Authenticated transport, independent provisioning/custody, canonical split-commit
recovery, actual restore and runtime/release acceptance remain unfinished. No etcd
package was installed, no service was started and no native RPC was attempted.

### SQL/checkpoint split detection

Reused the existing staged-checkpoint regression suite and scripted exact-CAS
peer. A new test connects that peer through the actual etcd adapter to the actual
CompletionGateStore and one disposable migrated database. The peer advances its
checkpoint but reports a lost acknowledgement. The SQL transaction rolls back;
the integrity row remains unchanged and the attempted profile is absent. Fresh
store objects then reject existing-record reads, new writes and provisioning on
the mismatch. Only one external write occurred; there is no retry or old-anchor
fallback. This demonstrates split detection, not recovery or distributed atomicity.

Fourteen staging/split checks and full-source TypeScript pass. The split peer is
in memory and does not prove actual etcd persistence, power-loss/crash behavior,
authenticated transport or supported restore. A reviewed owner recovery procedure
remains required. `pnpm test:checkpoints` now runs the complete focused set serially.

Independent review at c36051b found no concrete issue and passed all32 focused
tests using scripted RPCs/disposable PGlite only. It accepted split detection,
not recovery or durable etcd acceptance. CHECKPOINT_RECOVERY_REQUIREMENTS.md now
records the remaining recovery package and the fact that a digest-only checkpoint
cannot reconstruct rolled-back records. No checkpoint reset is an accepted repair.
