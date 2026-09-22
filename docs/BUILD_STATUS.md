# Agent Control Room build status

**Status:** active source build. The product is prepared and extensively tested
with disposable data; no Control Room installation or local worker is
operational yet.

## Current installable-product checkpoint (2026-09-21)

The public macOS package now uses one shared, platform-neutral launcher core,
with macOS supplying only its deterministic wrapper and fixed browser opener.
The core stages an exact release, runs the existing
effect-free checks, creates or exactly replays one canonical revision-zero
setup plan, starts the bounded read-only setup host, and opens the fixed local
setup page. A fresh plan is controller-only: no database, scheduler, Hermes,
Codex, Claude, or other worker is invented or enabled. Reopening the same exact
package reuses the first revision; changed first inputs conflict instead of
rewriting history. Resume also binds the exact expected release version and
manifest digest before dependency preparation, so an older journal cannot make
the launcher operate on an older release during an upgrade. The browser remains
GET/HEAD-only and cannot perform setup effects. Focused source, journal,
release, launcher, and type checks pass. Linux can reuse this core after its
native wrapper is supplied; Windows still requires native custody and process
adapters rather than POSIX assumptions.

The GitHub pull request also has a required unified-product CI lane so every
local/multi-computer test file is reachable from a required workflow. The next
build package was the private runner beneath the durable, terminal-confirmed
PostgreSQL owner-action transaction. That source-only runner now binds the
exact release and all 87 verified migration-ledger entries, requires attached
owner confirmation, reuses the existing provision/migrate/evidence tools, and
validates the final roles, memberships, permissions, migrations, required rows,
and restricted login against the reviewed production contracts. Provisioning
and migration remain intermediate observations; only exact final evidence can
produce the terminal confirmation consumed by the journal transaction. Any
malformed reply after an effect might have started is uncertain and cannot be
retried automatically. The two preceding release stages now use
the real stager and package-preflight reports, bind both reports to the exact
release manifest, and record their receipts only through the existing
append-only plan journal. Concurrent changes, stale replay, changed evidence,
or uncertain state refuse. The PostgreSQL transaction records one final
terminal-confirmed exact-replay receipt through that same journal; it does not
call PostgreSQL itself. No public release has been published and no live
database, service, credential, agent, listener, or browser operation was
performed by these source packages. The private adapter/configuration binding
is now source-complete behind injected custody and fixed tool ports. It reuses
the existing provision, migration and evidence implementations, replaces all
ambient PostgreSQL process settings with reviewed values, accepts only exact
operation-specific replies, closes credential custody independently of tool
cleanup, and retains no private value in observations or errors. The production
custody loader, concrete process/module boundary and owner-attended rehearsal
remain separate work; none has run.

The protected-data stage now also has an accepted source-only owner runner
contract. It reuses the existing private artifact configuration and persistent
storage preflight, binds attached-owner confirmation and exact redacted
preflight evidence to the current request, and treats any failure after
directory creation may have occurred as non-retryable uncertainty. Parent and
root identities are checked around creation and preflight, and the runner has
no repair or deletion authority. The real operating-system implementation of
identity-bound, no-follow directory creation remains intentionally absent and
must be separately reviewed before this runner can touch an owner's directory.
The private macOS/POSIX composition beneath that runner is now source-complete
as a strict native-port boundary: it derives the effective process user,
reuses the production persistent-storage preflight exactly once, and requires
one path-free receipt proving descriptor-relative `mkdirat` plus no-follow
`fstatat`. Node does not expose those syscalls and the repository has no
reviewed native binding, so no path-based fallback was added. This remains a
deliberate live-install blocker until that small native implementation is
separately reviewed and owner-attended; disposable adversarial tests are not
native qualification evidence.

The initial macOS background-service owner step now also has a source-only
private runner and exact installation-journal settlement. It reuses the
accepted platform lifecycle, macOS service package/action, local service
observation and supervisor-readiness records; requires the already-passed
database, protected-data, first-owner and recovery outcomes plus attached-owner
confirmation; and sends only the fixed structured install sequence to one
injected branded tool. Final running evidence must bind the same plan, release,
service, database, protected data and readiness record before the existing
`platform_service` stage can pass. Cancellation, deadline, malformed replies,
observation mismatch or cleanup ambiguity after entry remain uncertain, and
service start alone never grants an agent readiness. The repository still has
no reviewed launchd/process/filesystem implementation for that port, so no
service was installed or started and live local enablement remains blocked.

The protected-data stage now also has a durable settlement transaction over
the existing append-only installation journal. It rebuilds the exact protected
action and binds the installation, topology, release, running revision, passed
database outcome, prior protected-root binding, storage configuration and
namespace, redacted owner request, verified private-runner observation and
storage-preflight receipt. Only an installation-bound terminal envelope around
the exact private protected-root runner result may append the stage. The saved
stage outcome is the resulting `protectedDataBindingDigest`, not a database or
transaction receipt, preserving the existing recovery contract. Exact replay
and concurrent identical confirmation converge; stale, changed, foreign,
uncertain or competing evidence refuses without repair or retry. Recovery is
now source-complete through the matching private owner runner and durable
settlement transaction. The runner captures one exact installation-bound owner
confirmation and one injected existing-rehearsal callable, then accepts only
the existing combined disposable database-and-artifact restore proof bound to
the running plan revision, topology, release, passed database and protected-data
outcomes, database identity, schema and storage namespace. Pre-effect refusal
is distinct from post-call uncertainty. Only its exact terminal confirmation
may append the existing recovery stage, whose outcome remains the proof digest;
exact replay and concurrent identical settlement converge, while stale,
changed, foreign-installation, competing or uncertain evidence refuses. No
live filesystem, storage, backup, restore, database or credential effect was
performed, and the production owner-attended adapter remains absent.

The guided local setup flow now also has one source-only private dispatcher
over the existing installation plan journal. It verifies the exact
installation, topology, release, plan digest and revision, dispatches only the
first incomplete owner-effect stage after the retained launcher prerequisite transaction, and reuses the accepted PostgreSQL,
protected-data and first-owner runners and settlement transactions. It creates
no second state machine, database, receipt store, scheduler, browser effect or
native effect. PostgreSQL's provision, migration and terminal evidence remain
one ordered call, with owner confirmation and exact release/ledger checks at
each existing runner request. An uncertain call leaves the stage running, so a
later call refuses rather than retrying. Recovery remains an explicit stop
because its production owner-attended adapter is absent and its concurrent
dispatcher integration has not been independently accepted; the service is a
second explicit stop because no reviewed macOS native port exists. No live
setup operation was performed.

The first-owner stage now has an accepted durable settlement transaction over
the existing installation journal. It rebuilds the exact prepared request from
the running plan, including the passed database outcome, expected owner subject,
and independently observed empty-owner state. Only a private wrapper's exact
terminal confirmation of the expected existing owner can append the stage
receipt; preparation, an armed ceremony, a changed subject or proof, stale or
uncertain state, and competing outcomes refuse. This transaction accepts no
login assertion, one-time code, credential, database handle, listener, owner
creation port, or alternate receipt store. A private owner-attended runner and
live ceremony adapter remain required before any real owner ceremony.

That private first-owner runner is now source-complete behind injected ports.
It requires attached-owner confirmation bound to the exact installation,
release, running plan revision, passed database outcome and expected subject;
accepts only the retained ceremony's completed response; and independently
requires an exact existing-owner proof before producing the transaction's
terminal confirmation. Pre-effect refusal is distinct from post-attempt
uncertainty, cleanup is narrowly bounded, and outputs and errors are redacted.
The retained-ceremony composition beneath that runner is now source-complete.
It wraps the existing ceremony and bootstrap-only route without opening another
listener, captures its injected callables, and accepts terminal completion only
from that same route. One fixed authoritative query then requires the exact
configured database, tenant, workspace, active human identity, pinned subject,
and unique unrevoked owner grant; only a bounded binding digest leaves the
adapter. Cleanup can only close the retained ceremony and is independently
bounded. Existing host mounting, database connection custody, and the reviewed
owner-attended native control attempt remain production seams. No live
assertion, code, credential, database, listener, browser or native effect was
used here.

## Current build block

**This computer** is being completed as one installation choice of the same
Agent Control Room product as **Several computers**. Both choices retain one
PostgreSQL authority database, the existing pg-boss scheduler, and one
project → task → delivery → result → review → correction lifecycle.

The current priority is the first local Hermes Agent text-review path. It is a
bounded supplied-context review path, not project-writing authority. Its
owner-run fixed runner check has now passed on the Mac: the exact private
Control Room bridge reached the existing Hermes installation and returned one
expected text-only response. The sanitized proof is not copied into this
repository. Codex and Claude Code use the same lifecycle but remain visibly
unavailable until their separate host qualifications are complete.

The normal private task application also now reads the saved worker-capacity
snapshot through a narrow authenticated server endpoint, without exposing a
database handle or starting workers. A separate installation-owned admission
gate prevents browser requests, status signals or reported worker capability
from making local Hermes, Codex or Claude selectable, plannable or leaseable.
The protected operator assembly can admit only its captured local Hermes route
after the existing readiness proof; Codex and Claude remain unavailable until
their distinct proof exists. Historical receipts and an already-recorded lease
remain readable for recovery. Focused adapter tests, private-startup tests,
VPS compilation and TypeScript passed. This is source and disposable-test
evidence only: it enables no worker, database, listener or persistent service.

The local Hermes path now also has a source-only owner-admission preparation.
It re-verifies a saved installation binding against current private
observations, authenticates the supplied installation ID through an exact
replay against the existing installation journal, binds the shared delivery, canonical result, durable review and
correction contracts, and emits only a redacted owner-review request. Before
that proof exists it names the first incomplete database, protected-data,
first-owner, recovery, service or agent-readiness stage. Capacity observations
cannot satisfy the gate. Even an exact request remains blocked on production
private startup, recorded owner admission, durable `agent_readiness`
settlement and passed final setup review. Nine adversarial checks and the
TypeScript check pass; no queue, store, callback, service, worker or task was
created or started.

The installable-product track now also has eighteen accepted source foundations:
an allowlisted reproducible release archive with a manifest and checksum; a
standalone extracted-release preflight that needs no developer dependency;
crash-safe, concurrency-tested placement of a verified release into an inert
version directory without activating it;
isolated, production-only dependency preparation that is bound to the exact
verified release and publishes atomically without running package scripts or
starting the application;
release packaging that manifest-binds and ships that dependency command and
runtime, with an extracted-release proof through the public command boundary;
an artifact-only clean-install rehearsal that runs the shipped setup command
from an extracted release in separate processes, resumes from a private
disposable receipt, and refuses altered staged files before another dependency
operation; this is explicitly rehearsal evidence, not a live installation;
a deterministic macOS release asset that reuses the accepted release archive
writer, contains one human-opened `.command` launcher, verifies exact file
bytes and permissions before writing an installation directory, bounds and
terminates its child process group, and invokes only the existing stager,
read-only preflight and shipped setup command; a manual read-only GitHub
workflow builds the asset twice and compares it byte-for-byte but cannot
publish, tag, sign, attest, install or use repository secrets;
an effect-free local Hermes installation binding that ties the already
qualified runner to the exact topology, release, recovery and healthy-service
observations while keeping owner enablement and real work separate;
an effect-free local Claude installation binding that reuses the same generic
platform-service observation and requires exact process, configuration,
topology, release, recovery and supervisor evidence while leaving the private
process host and owner qualification visibly incomplete;
an authenticated, redacted setup-progress view that labels coordination state
as saved progress rather than evidence and gives the browser no installation
or database capability;
one private, effect-free setup-action composition that reuses the existing
PostgreSQL, protected-data/recovery and platform-service planners against the
exact current plan revision, refuses private parser detail, and creates no
second journal, state machine, authority or browser capability;
that same private seam now prepares the retained first-owner ceremony, binds
it to the exact passed database outcome, and refuses an existing or uncertain
owner state without accepting a login assertion or one-time code; pure,
redacted PostgreSQL and protected-data/recovery requests name only the existing
deployment, storage, backup, restore and proof components without calling
them, while a macOS injected-runner simulation proves the existing service
and rollback order; no production runner or durable effect receipt is supplied;
the restart-safe nine-stage installation plan plus a private, append-only,
crash-recoverable pre-database journal for its exact revisions; and a redacted PostgreSQL-stage
preparation that binds that plan to the existing migration ledger and database
toolchain without retaining connection details or running SQL; and an effect-free
service lifecycle that binds status, install, bounded drain, stop, start-last,
update, rollback and data-preserving uninstall to the exact active setup plan.
Protected-data and recovery preparation now also binds the existing private
artifact store, database restore proof and artifact inventory proof to the exact
ordered setup stages without exposing a private path or running a backup.
The protected Settings page shows both the planned one-launcher journey and
the supplied saved stage progress, while prominently saying that a public
release and an owner-accepted clean install are not available yet. These components perform no live install,
database, service, credential, or worker effect. Release staging, production
dependency preparation, the owner-only protected-data/recovery actions, the effectful service wrapper,
durable plan persistence and the owner-only setup
actions and their durable replay/evidence boundary remain active build work.

The eighteenth foundation is the first real pre-install webpage boundary: the
compiled `/setup` page can render before the database-backed private
application exists, but only through an exact loopback transport that accepts
GET/HEAD, strips all credential state, rejects forwarding and cross-origin
requests, and exposes only the redacted setup and settled-plan views. Its plan
reader is genuinely read-only: an interrupted journal publication makes the
view unavailable and is never repaired or deleted by a browser GET. The
ordinary private HTTPS application, projects, actions, workers, database and
credentials remain outside this host. The double-click launcher is now wired
to the shipped host through a bounded supervisor: it waits for exact readiness,
opens only the fixed loopback setup URL, stays alive with the host, and owns
TERM/KILL/reap cleanup. Source tests exercise injected processes only; no real
listener, browser, installation, database, service, credential, or worker was
started by this package.

## What source evidence proves today

- A local Hermes delivery is bound to one intended worker, one exact task, one
  policy, one receipt and one staged terminal result. An expired, future-dated,
  changed, revoked or wrong-worker delivery is refused before a local runner
  can be called.
- Control Room repeats the canonical task, lease and authority check after the
  delivery receipt is saved and immediately before the private Hermes runner
  can be called. A permission withdrawal in that narrow handoff window stops
  the run rather than causing an automatic retry.
- A restart can recover the exact staged Hermes result without launching a
  second task or adding a duplicate completion history.
- A delayed restart retains the original authenticated Hermes delivery packet,
  rather than accidentally treating a recovered task as new work merely
  because the clock moved forward. A long-running local installation also
  derives a fresh permission gate for every prepared task, so one task's
  permission can never authorize the next task.
- The owner has separately proved the exact fixed-argument Hermes runner on
  this Mac. The check created no Control Room task, worker registration,
  database, permanent service, or project write. It is evidence that the
  runner bridge works, not evidence that the local Hermes worker is enabled for ordinary work.
- The local runner preflight and qualification now also refuse an unreviewed
  Hermes version or source revision before asking it to handle a task. The
  compatibility check reads only the fixed `--version` response and retains
  no private runner setting or raw version output.
- Claude Code can save the same bounded text-review task plan as the other
  local harnesses. Once the ordinary delivery bridge has reserved exactly one
  session, its result bridge can consume only that session, decode and prepare
  one clean terminal result for the existing review path; it cannot start a
  second process. A mismatched Claude connector profile is refused before a
  receipt is saved or an installed process could be acquired.
  Planning does not assign, start or enable Claude; it remains a source-only
  component until the installed process is qualified.
- A Claude task that has already received a canonical lease can now be read
  back into the same signed controller-to-worker delivery packet shape used by
  the local Hermes route. The preparation reader checks the task, lease,
  worker, authority, accepted connector profile and expiry again before it
  returns that packet. It does not start Claude, acquire a process, create a
  queue entry, or expose any local setting. The remaining source work is to
  connect this already-tested packet and receipt path to the existing queue
  only after the separate installed-process proof and private host binding.
- Claude now also has the same existing queue envelope as Hermes: its queued
  locator is protected by a Claude-specific authenticated record, is replayed
  rather than duplicated, and is rebuilt against the current task, lease,
  authority, route and receipt state before the queue can hand it to a private
  callback. This adds neither a database nor a scheduler. The production
  callback is deliberately absent until the separate Claude proof and private
  host binding are supplied, so the new queue path cannot start Claude.
- After its delivery receipt is durably saved, the Claude composition now
  requires one last private recheck of the canonical task and lease before it
  can acquire even an injected test process. If that recheck fails, the saved
  receipt remains an uncertainty record and cannot trigger a guessed retry or
  a second process acquisition.
- The source-level Claude queue executor now joins only an already-verified
  queue locator to the existing dispatch reader, receipt-first session helper,
  protected terminal staging, result publisher and restart recovery. It still
  has no installed-process binding, so it cannot discover, start or configure
  Claude. A saved receipt without protected terminal evidence remains clearly
  uncertain rather than becoming a fresh process attempt.
- If a restart finds an existing Claude delivery receipt, it restores that
  exact signed packet before attempting recovery instead of minting a newly
  dated packet. The queue also refuses to acknowledge receipt uncertainty or
  missing/altered staged evidence as successful delivery, leaving it visible
  for recovery or owner attention.
- Claude's source-level executor now also creates the same ordinary Control
  Room run history used by the local Hermes route. A successful disposable
  run records only `starting`, `running`, and `succeeded`; rebuilding the
  executor recovers the protected result without making a second history or
  opening a second session. This is still no evidence that the installed
  Claude program is qualified or running on this Mac.
- The application-facing Claude queue now has the same disposable proof: a
  verified queue locator reaches the shared signed delivery, ordinary run
  history, protected result and pending-review path once. A restart reads the
  staged result without reopening Claude. A refused receipt remains visibly
  not started, and stale success evidence cannot override a recorded failed or
  cancelled run. This is source/test evidence only; it does not operate
  Claude on this computer.
- The normal protected application configuration now applies that same rule at
  its final assembly boundary: a Claude callback cannot be captured merely
  because one was supplied. Its own complete process-readiness record, the
  plan-bound backup-and-restore evidence recorded in installation readiness,
  and the local supervisor readiness record must all agree first. This is
  still source and disposable-test proof only; no Claude process, credential,
  service, or local task has been enabled.
- The Mac Codex path records only two opaque safety prerequisites: suspended
  executable identity and protected private-state custody. Neither record can
  enable or launch Codex.
- Codex now has a source-only local delivery bridge that records the ordinary
  shared receipt before it can ask the existing injected host for one start
  observation. A replay, changed task, expired task or revoked authority never
  asks the host a second time. This is disposable-test evidence, not proof
  that Codex is running locally.
- A local Codex start is now considered safely recoverable only after its
  owned one-shot process has closed cleanly. An interrupted or uncertain close
  remains unrecoverable, rather than becoming a false safe-restart claim.
- The protected local setup page presents Hermes Agent, Claude Code and Codex
  separately, including what each could do after setup and what blocks it now.
  It never treats a source contract or setup proof as a live agent.
- The protected Workers view can now read a supplied, authenticated operator
  capacity projection. If the installation has not supplied this read-only
  source, the page says it is unavailable; it never invents an empty fleet.
  Each worker row shows its reported capability separately from capacity. This
  screen cannot start, schedule, assign, or reserve work.
- The Hermes setup card also distinguishes a recorded partial proof from a
  complete or failed setup. It names only the remaining proof category and
  never discloses a local command, profile, model, provider or worker identity.
- The local home dashboard refreshes its saved projects, work, results,
  attention and worker signals while the owner is viewing it, and on return to
  the tab. This is a read-only status refresh; it neither schedules work nor
  starts an agent.
- When an installation has more than one prepared worker for a project, task
  preparation requires the owner to choose one. The selected template is bound
  into the saved plan; Control Room never silently selects a worker or turns
  that choice into assignment or launch authority.
- Local Hermes, Codex and Claude identities have a shared test proof for one
  local topology, one non-executing delivery contract, wrong-worker refusal,
  restart receipt reconciliation and the existing corrected-result lifecycle.
- A local backup-and-restore proof now binds the reviewed installation plan,
  safe database restore identity, and an independently rechecked protected
  result-file inventory. It is source-only: it cannot run a backup or restore,
  promote a recovered copy, start work, or turn missing owner evidence into a
  passed installation proof.
- A future coding-worker result can now bind its verified change inventory to
  the exact durable result receipt and the pre-approved delivery/worktree
  audit plan. The record rejects a different tenant, project, task, attempt,
  run or result artifact, and its browser-safe summary exposes only aggregate
  change counts, bytes and an evidence fingerprint. It grants no authority
  to start, retry, resume, approve or merge work. This is source-only
  evidence. The existing PostgreSQL authority can now also retain the
  pre-approved audit plan—but only when its process-private workspace manager
  still owns the exact active worktree lease and the stored delivery receipt
  is accepted. The raw plan stays evidence-role-only; no web account can read
  it. The later result-bound record is now also persisted only after it
  independently rereads that protected plan and the authenticated durable
  result receipt. The protected Result-page reader now mounts only after the
  separately verified evidence database preflight and receives the complete
  result lineage. It returns only the existing aggregate-safe summary; a
  missing or damaged record is shown as unavailable, and a person without
  result permission cannot invoke it.
- The local Result page now has a per-result, aggregate-only coding-evidence
  presentation contract. It can say not configured, not applicable,
  unavailable, not authorized, or show only verified file counts, byte counts
  and an evidence fingerprint. It never receives paths, scopes, revisions,
  receipt data or content fingerprints, and it never makes unavailable proof
  look like zero changes. The protected reader is an installation-owned input
  rather than a browser database capability, and requires ordinary
  result-reading permission before it can disclose even the aggregate.
- Shared local and remote lifecycle tests prove that later remote delivery is
  an extension of the same product, not a second scheduler or database.
- An authenticated remote-session bridge can now hand one already-approved
  packet to one already-authenticated selected worker. It refuses a local
  route, a different route worker, a different packet worker, cancellation,
  and a forged reply before the session callback can run. It opens no
  connection and cannot enroll a worker, create credentials, start work,
  retry, or store a receipt; those duties remain in the existing admission and
  result/review paths. This is source and fake-session proof only.
- The reviewed topology plan now binds opaque digests of its complete current
  and requested worker-route sets and records every removed worker. A changed
  route, adapter revision, addition, or removal therefore invalidates prior
  setup evidence instead of being mistaken for the same installation plan.
  This remains source-only planning; it does not enroll, remove, start, or
  contact a worker.

## Latest accepted local checks

- TypeScript type check
- Combined local-installation foundation: 23 checks passed for deterministic
  release assembly, license-evidence freshness, extracted-package refusal,
  standalone preflight, restart-safe stage coordination and the truthful
  first-run page. Independent reviewers accepted the release, setup-plan and
  browser packages after correcting early-completion and retry hazards.
- Shared local/remote and Hermes readiness verification: 49 checks passed.
  This covers the one-database local and remote lifecycle, correction path,
  local Hermes runner safeguards, preparation and proof-recording commands.
- Combined local-agent and topology verification: 47 checks passed in the
  latest run. This covers
  Hermes delivery/revocation/restart, Claude terminal-result recovery, inert
  local adapter capture, and the shared local/remote task and correction
  lifecycle.
- Focused local capability, setup-screen, Hermes delivery/restart and
  three-local-worker conformance tests
- Shared local/remote topology and correction lifecycle tests
- Production-style application build
- Focused protected-storage and recovery verification: 28 checks passed. This
  covers restart reads, corrupt or misplaced result bytes, stale locks,
  cancelled inventory capture, backup inventory tampering and restore mismatch.
- Focused local Hermes shutdown verification: 15 checks passed. If Control
  Room itself stops an already-started local Hermes process, the task is
  recorded as cancelled and its temporary task data is removed after the child
  process closes. This does not claim that Hermes has a general public
  per-task stop feature.
- Broader local durability and startup verification: 101 checks passed. This
  covers one-database application composition, startup refusal before a
  listener opens, cleanup on partial failures, protected artifact storage,
  restart recovery, rollback protection, and the fact that a worker cannot
  turn an uncertain result into a retry.
- Shared local/remote delivery verification: 56 checks passed. The same
  controller packet, restart handling, result/review/correction lifecycle,
  wrong-worker refusal, compatibility refusal, and revocation behavior work
  through both local and remote test routes. This is proof of one product,
  not a claim that a second computer is enabled.
- Latest focused local checks: Hermes (89), Claude (35), Codex (34), and
  setup-screen (40) checks passed, followed by a full production-style build.
  No installed harness was started by these checks.
- Latest local service-preparation package: 24 focused readiness, protected
  setup-page, and recorder checks passed, followed by the TypeScript project
  check and production-style build. It did not install or start a supervisor.
- Latest operator-capacity package: 22 focused authenticated-route and
  browser-presentation checks passed, followed by the TypeScript project check
  and production-style build. It did not create a worker, start an agent, or
  connect to an installation database.
- The normal private task application now supplies that same protected,
  read-only capacity projection from its existing canonical coordinator
  records. The compiled application proof confirms the owner can read a real
  tenant-bound fleet and active-work snapshot while task assignment remains
  inert until separately authorized. The route completes authentication before
  reading the independent projection, so a one-database local installation
  does not hold its web transaction open across a second read. This package
  passed 24 focused checks, the TypeScript project check, and the
  production-style build; it did not create a worker, start an agent, connect
  to an installation database, or expose a database handle to the browser.
- Local Hermes recovery inspection now reads only an authenticated saved
  delivery and its protected staged terminal record. It reports no saved
  delivery, an unresolved saved delivery, or a staged result using only safe
  digests, sizes, and usage totals. It never contacts Hermes, exposes terminal
  text or private settings, publishes a result, or permits a retry.
- When the trusted local installation composes that recovery reader, the exact
  Hermes task page can display its saved recovery state. The page receives no
  receipt key, protected-storage handle, terminal text, executable, profile,
  model, provider, or workspace path, and it offers no start, retry, resume,
  publish, or Hermes-contact action. Multiple saved attempts stay explicitly
  ambiguous rather than having one guessed.
- Local Hermes enablement now binds its recorded backup-and-restore check to
  the exact verified, disposable restore proof for the current installation
  plan. A generic or another installation's fingerprint is refused before the
  executor can be composed. This source-only check ran 68 focused disposable
  tests and TypeScript successfully; it neither performed a backup/restore nor
  started a database, Hermes, or a persistent service.
- The protected setup page now uses that same verified backup-and-restore
  binding before it can describe Hermes as awaiting owner enablement. It
  exposes only a true/false verification state, not proof contents or local
  settings. Operator assembly also now carries an already-verified, opaque
  Codex macOS safety record through to the existing protected setup display;
  neither change enables or contacts a local agent.
- The protected browser setup endpoints now return one deliberately redacted
  setup view rather than the internal topology, readiness, transition and
  proof records. The owner can still see the selected installation choice,
  proof state and next safe step, while route identifiers, adapter details,
  fingerprints, evidence records and private host state stay on the server.
  Focused browser and navigation checks confirm the complete endpoint payload
  has none of those internal values. This remains a read-only status change;
  it cannot enable a worker or relocate the installation.
- The local setup screen now uses a browser-safe, redacted wire parser rather
  than importing server-only connector validation into the browser. A
  disposable browser journey proves that unavailable, malformed, and failed
  setup refreshes remove earlier success instead of leaving a false “ready”
  display; it also proves unavailable worker inventory remains unavailable
  while navigating Workers, a saved project and task, and Needs Me. That
  journey made no protected write and exposed no fixture route, digest, or
  private-path material. It is interface evidence only, not proof that a
  local agent or service is running.
- A requested change between local and remote worker layouts can now be
  retained as a tenant-bound, signed, append-only transition journal in the
  existing PostgreSQL authority. It preserves the reviewed pause, drain,
  proof, commit, failure and rollback-preparation history, and can answer only
  whether new admission for an affected worker should stay paused. It neither
  changes routes nor starts, stops, enrolls, revokes, or enables a worker.
  The raw journal is unavailable to the browser role.
- The existing assignment and delivery coordinator now consumes that journal
  through a private, copied node-to-worker mapping. A paused or damaged
  journal blocks a new lease or delivery only for the affected worker, before
  Hermes, Claude, Codex, or the standard native route can start it; historical
  receipts and result recovery remain readable. The browser, task template,
  queue item, and worker cannot supply the journal key or choose the mapping.
  This is a source-only admission fence, not a worker stop, database move, or
  installation activation. Focused disposable checks cover an affected route,
  an unaffected route, exact replay, tampering, role verification, and private
  configuration capture.
- A source-only database-relocation preparation record now binds the already
  verified schema/restricted-role facts, protected result inventory, external
  rollback-checkpoint fingerprint, and drained transition evidence for one
  distinct target. It is intentionally not a backup, restore, fence, or
  activation command. A real move still requires the separate owner-operated
  export, empty-target restore, verification, and one-controller cutover.
- The final private task-startup gate now independently rechecks the same
  Hermes installation, backup-and-restore, and local-service readiness
  records. A caller cannot bypass the protected setup and operator-assembly
  checks by supplying a bare local Hermes callback. This remains source-only:
  it starts neither Hermes nor a persistent service.
- The local service package can now render one fixed-argument macOS background
  service definition without installing or starting it. It contains no shell,
  credentials, task text, agent model, or retry policy. A later owner step must
  still supply the real protected configuration and explicitly install it.
- The first-owner ceremony now honors the same deployment-selected login
  assertion profile as the normal website. The private network boundary and
  ordinary project, task, and coordination routes now forward and verify only
  that selected header. A Cloudflare header is not treated as a fallback when
  the installation selected the supported fixed RS256 gateway profile. This
  fixes a source-level login mismatch; it does not create a database, socket,
  account, or web service.
- The first-owner ceremony also has a source-level durable local marker: it
  records either an attempted setup or a completed setup, refuses an unsafe or
  damaged marker, and never deletes it to make a second attempt possible. The
  marker code is not wired to a real service or VPS yet.
- The fresh first-owner source path can now create its selected empty tenant
  and workspace as part of that same guarded owner transaction. It refuses an
  existing root even if its ordinary display name matches, and rolls the new
  roots back on a collision or before-commit failure. Thirty-four focused
  disposable checks and the TypeScript check passed. This is preparation for a
  later owner-authorized installation, not a real database change.
- A bootstrap-only host can now be composed without constructing the normal
  application, web pages, task queue, workers, or artifact store. After the
  owner is created it deliberately becomes unavailable and requires a clean
  supervisor restart into the normal restricted application. It is not yet
  connected to a real control socket or database role.
- The protected startup capture now freezes the exact local backup proof after
  it verifies its match to the saved readiness record. A later mutation of a
  caller-owned object cannot change what the application treats as checked.
- The setup page's overall wording now follows the same strict binding as the
  Hermes card: a generic "passed" backup label cannot make the page say setup
  proof is complete. It asks for verified recovery evidence without exposing
  any backup details.
- Claude Code now has an installation-bound, opaque local-process readiness
  record for process identity, permission limits, and cancellation/restart
  behavior. Even a complete record remains an owner-enablement prerequisite;
  it does not start, contact, or make Claude Code available.
- Local Hermes setup now also requires a separate, plan-bound local-service
  preparation record before its card can say owner enablement is the next
  step. The record covers private configuration custody, restricted launch,
  restart/drain, and upgrade/rollback procedure using opaque evidence only.
  A small recorder can convert an already-sanitized owner review into that
  record, but it cannot install, start, stop, or inspect a background service.

These checks use disposable data. They do not prove a real agent program,
database, browser login, backup, persistent service or remote machine.

## Remaining implementation and installation work

1. Supply the separately approved private installation inputs to the existing
   safe local Hermes composition: one database, queue, protected artifact
   store, exact runner binding and read-only setup status. The source already
   captures and validates this composition without browser-controlled inputs;
   it cannot choose private settings, create a database, start a service, or
   enable Hermes by itself. The new admission preparation can bind an exact
   current installation to the retained lifecycle, but a reviewed production
   private-startup composition, attached-owner admission runner, durable
   `agent_readiness` settlement and passed final review are still required.
2. Complete the remaining fresh-install first-owner package: a durable local
   ceremony marker, bootstrap-only server composition, narrow database
   capability and reviewed Linux peer-credential control channel. The ceremony
   now creates only a brand-new, deployment-selected tenant and workspace in
   the existing guarded owner transaction; it refuses all existing roots,
   including same-named ones, and rolls back on collision or pre-commit
   failure. That is source-level, disposable-database evidence only—not an
   installed database, operating-system control socket, or normal application
   route on a fresh machine.
3. Add qualified installed-process host compositions for Codex and Claude Code
   below their existing result/review contracts. They must not become another
   scheduler, database or permission system.
4. Add capability-aware progress, usage, result, correction and attention
   presentation wherever the authoritative source provides those facts.
5. Continue remote worker enrollment, compatibility, reconnect, revocation and
   two-node source preparation under the same controller delivery contract.
6. Move Idea Lab participant rounds from its legacy direct fake coordinator
   into the same canonical task, delivery, result, review and correction path
   already used by schedules and news/research. The accepted source decision
   is [IDEA_LAB_CANONICAL_LIFECYCLE_DECISION.md](IDEA_LAB_CANONICAL_LIFECYCLE_DECISION.md).
   The first safe bridge is now present: it creates deterministic, ordinary
   proposed tasks for a selected discussion round and safely reuses an exact
   repeat. An append-only source migration and protected link store now retain
   the one selected project plus each participant/round/task relationship
   across a restart. Later-round tasks also use the same durable dependency
   links as ordinary jobs, so they cannot become eligible before the earlier
   round is complete. A protected first-round proposal operation now loads a
   saved discussion and creates those ordinary tasks without contacting a
   provider. It does not schedule, assign, contact a worker, or replace the
   legacy direct fixture. The private-page bridge is now complete: the owner
   chooses an existing active project and prepares ordinary first-round tasks
   without provider contact, assignment or launch. The page reads durable task
   links after a refresh, so it shows the prepared project rather than offering
   a second start. The ordinary task prompt now requires one small, exact JSON
   contribution shape and rejects prose, markdown or extra fields. Canonical
   contributions also now reserve a separate immutable evidence shape for the
   server to record linked task, result, review, and verification facts. This
   does not yet turn a worker result into a discussion contribution: browser
   input cannot supply that evidence, and task completion is not acceptance.
   A protected server-side projection service now selects exactly one saved
   result for the linked ordinary task, rejects malformed output, requires the
   current review target to be accepted by a human and verified, then persists
   the bounded contribution in the same locked transaction. Exact repeats
   reuse the saved contribution; changed, missing, superseded, or ambiguous
   evidence fails closed. The operation is now mounted behind the existing
   private owner session check: the browser names only the saved discussion
   and task key, while the separately verified result role re-reads all result,
   review, and verification facts. It cannot launch an agent, accept a review,
   or accept browser-supplied evidence. The Idea Lab page now lists each saved
   participant task as either waiting for a reviewed result or already added,
   and offers the owner a safe request to re-check and add only an eligible
   result. Later rounds now require every prior-round reviewed task result to
   be rechecked server-side before ordinary next-round tasks can be prepared.
   Once every canonical task result is reviewed and verified, the owner can
   save an extractive recap from those protected records; no browser-supplied
   evidence or new provider call is involved. Direct-provider Idea Lab code is
   retained only as an isolated legacy test fixture: private application
   startup now refuses that configuration, so it cannot become a production
   delivery route.

## Owner-operated gates before any real local worker is enabled

1. Choose private local runner, profile, model/provider and permitted working
   folder settings outside repository records.
2. Provide one approved PostgreSQL installation, protected result-byte storage
   and a disposable backup-and-restore proof.
3. Approve the persistent supervisor, restart/recovery and rollback procedure.
4. For local Codex on macOS, complete both custody qualifications and the
   separate exact-harness qualification. For Claude Code, qualify its installed
   process, permissions, cancellation and restart-result behavior.

Until those gates are complete, the product is accurately described as
**prepared**, not operational.

## Where to continue

- Product requirements: [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md)
- Single-computer build order: [SINGLE_MACHINE_PRODUCT_BUILD_PLAN.md](SINGLE_MACHINE_PRODUCT_BUILD_PLAN.md)
- Shared local/remote contract: [SHARED_CONNECTOR_CONTRACT.md](SHARED_CONNECTOR_CONTRACT.md)
- Operator proof procedure: [UNIFIED_OPERATOR_PROOF_RUNBOOK.md](UNIFIED_OPERATOR_PROOF_RUNBOOK.md)
- Reuse decisions and attribution: [SINGLE_MACHINE_REUSE_AUDIT.md](SINGLE_MACHINE_REUSE_AUDIT.md)
