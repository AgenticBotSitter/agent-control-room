# Six-batch implementation progress

Baseline: public main e901c0fe986c51ee1d0c091ce2d9b211231ec29e.
Current working branch: codex/component-batch-4, stacked on local batches 1–3.
All six batches remain in scope; no complete batch acceptance is claimed.

Latest checkpoint: migration 0066 resolves the native logical-restore catalog
fingerprint mismatch without weakening fingerprint verification. See
`POSTGRES_RESTORE_EVIDENCE.md`. This supersedes the historical restore-blocked
entries below for the disposable website profile only.

1. Database/queue/native execution — in progress.
2. Token verification/signing/checkpoints — JWT integration in progress; other gates pending.
3. Idea Lab/readable results — pending integration acceptance.
4. News/article extraction/research — pending integration acceptance.
5. Calendar/isolated workspaces — typed calendar integration in progress.
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
