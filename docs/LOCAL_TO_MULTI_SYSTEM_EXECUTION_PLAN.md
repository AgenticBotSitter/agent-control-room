# Local-to-multi-system execution plan

**Status:** authoritative completion plan, September 22, 2026
**Scope:** finish a usable **This computer** installation first, then extend that
same installation into **Several computers**.
**Supersedes for execution order:** the ordering portions of
`SINGLE_MACHINE_PRODUCT_BUILD_PLAN.md`, `SINGLE_MACHINE_FINAL_EXECUTION_PLAN.md`
and `UNIFIED_TOPOLOGY_BUILD_PLAN.md`. Those documents remain architectural and
historical evidence.
**Does not authorize:** a production database, credential access, a persistent
service, a native agent run, network exposure, DNS changes, deployment, or
destructive cleanup.

## Active execution boundary

**Until the local acceptance journey below is complete, only the `This
computer` track is active.**  Work on remote enrollment, remote delivery,
cross-computer recovery, controller relocation, and topology migration is
deferred.  Those packages may remain as previously accepted source evidence,
but they must not consume the active build capacity or be presented as progress
toward a working local installation.

The immediate objective is one Mac installation with its own local controller
components, Hermes Agent and Claude Code workers, and a truthful local website.
Codex Desktop remains the local lead/operator rather than a managed worker on
macOS.  The `Several computers` track begins only after that local journey has
completed its real, owner-attended acceptance evidence.

## The outcome

Agent Control Room is one product with two installation choices:

1. **This computer:** the controller, website, PostgreSQL database, scheduler,
   protected result storage, and supported workers run on one computer.
2. **Several computers:** the same controller reaches additional enrolled
   workers on other computers.

Changing between these choices must not create a second product, copy task
state between databases, or change the project/task/result/review/correction
lifecycle. Each installation always has:

- one authoritative PostgreSQL database;
- one pg-boss scheduler;
- one signed delivery contract;
- one result and evidence path;
- one owner review and correction path; and
- one installation journal, release identity, and audit history.

## What “finished” means

### Finished local installation

An owner can install one verified release, complete resumable setup, open the
website, create a project and task, see truthful worker capability, run a
supported local worker, inspect progress and saved results, accept or request
a correction, restart the computer without duplicating work, restore a backup
into an empty destination, and upgrade or roll back without losing authority.

The first macOS local release supports **Hermes Agent** and **Claude Code** as
local workers. Codex remains visible but unavailable on macOS until both
macOS custody proofs pass. This is an honest supported product, not an
unfinished dashboard. A Codex worker joins through the reviewed Linux route in
the several-computer phase. A later Mac Codex implementation may be added only
after its separate safety conditions are satisfied.

### Finished several-computer installation

The same owner can enroll a remote worker, send it the same task packet,
survive disconnect and reconnect without guessing or repeating work, revoke
it, reject an incompatible version, recover its saved result, and review it in
the same website. The controller and database can be deliberately relocated
with one fenced writer and verified backup/restore; they are never synchronized
as two active authorities.

## Current baseline

The source already contains and retains:

- canonical projects, tasks, attempts, results, reviews, corrections,
  approvals, schedules and audit history;
- one PostgreSQL authority model and pg-boss queue;
- shared local/remote delivery packets and receipts;
- durable result publication, protected result staging and restart-safe exact
  replay;
- substantial project, work, review, attention, agent and setup pages;
- the Hermes 0.21 task plan, queue delivery, controlled runner, staged result,
  pending-review and correction path;
- Claude bounded stream decoding, process-session ownership, shared admission,
  result publication and local installation composition;
- Codex App Server framing, journals, result contracts and a reviewed Linux
  process-acquisition route;
- remote enrollment, targeting, compatibility, reconnect, revocation and
  two-worker source-test foundations;
- PostgreSQL provisioning, migration, backup and restore tools;
- protected local storage, backup inventory, service-plan, release precheck
  and setup-journal foundations; and
- source-tested local/remote lifecycle and correction journeys.

The active source package has since incorporated the operation-scoped native
installation-journal session, its deterministic macOS sidecar assembly, and
the protected installed-configuration host. The current local source branch
has passed focused native-custody, macOS-launcher, and unified topology lanes.
Those are source and disposable-test results, not a released installation or
authority to perform the owner-attended operating-system steps. Publication
and hosted CI remain separate acceptance evidence.

## Reuse-before-rebuild rule

Every phase below begins by naming what is retained or borrowed. Custom code is
permitted only for the Control Room-specific connection between those pieces.
A README resemblance is not evidence: copied or materially adapted source must
have a pinned revision, compatible license, file-level fit decision, tests, a
notice in `THIRD_PARTY.md`, and an independent review.

### Retained Control Room foundations

| Need | Required reuse |
| --- | --- |
| Authority, queue and lifecycle | Existing PostgreSQL, pg-boss and canonical services |
| Release and licensing | Existing VPS build, runtime-license scans and release precheck |
| PostgreSQL setup and recovery | Existing provision, migration-ledger, backup, restore and evidence tools |
| Protected results | Existing persistent local storage, reservation, staging and backup inventory |
| Hermes | Existing Hermes 0.21 queue, plan, runner, staging and review compositions |
| Claude | Existing stream decoder, process-session host, admission and result publisher |
| Codex | Existing App Server contract, journals, workspace checks and Linux native bridge |
| Local/remote delivery | Existing shared packet, receipt, topology transition and conformance journeys |
| Website | Existing private React application and canonical server reads/writes |

### External code decisions already settled

| Project | Use | Do not import |
| --- | --- | --- |
| T3 Code, MIT, pinned `6a699f0` | Release staging, checksum, atomic switch and clear connection-state behavior as narrowly adapted concepts | Its supervisor, Effect runtime, relay, session/profile stores, database or credential authority |
| Hermes WebUI, MIT, pinned `f6a37b2` | Refresh coalescing and deliberate lost-request/lost-reply behavior as test/UI reference | Its Python application, session database or writable fallback |
| Hermes Desktop, MIT, pinned `2663e2e` | Distinct connection/authorization/capability/unknown states and duplicate-approval prevention as UI reference | Electron, IPC, secret handling, SSH setup or broad approval behavior |
| Anthropic Agent SDK, MIT, pinned `f7547d7` | Subprocess cancellation and transport behavior as qualification reference | A second task lifecycle or authority store |
| Restic 0.19.1, BSD-2-Clause | Operator-installed retained snapshots | Task coordination or database authority |
| Herdr, Apache-2.0, pinned `309749a` | Optional read-only session observation | Launch, scheduling, completion or task authority |
| Alibaba Open Code Review, Apache-2.0, pinned `71ed3a2` | Optional advisory review of a frozen diff | Approval, merge or scheduler authority |
| Ralph Sandbox, MIT, pinned `5cc70ef` | Later containment concepts for isolated coding work | Shared credentials, fallback scheduler or completion markers |

If a later package needs a new donor, it must pass `REUSE_DECISION_GATE.md`
before implementation starts.

## Model and effort policy

Use the least expensive model that can safely own the decision:

- **Qwen 3.8 27B Long, medium:** bounded code maps, donor-file comparisons,
  test-case drafts, fixture generation and first-pass review. It does not make
  architecture, security, credential, migration or final acceptance decisions.
- **Terra, medium:** isolated UI work, ordinary adapters, documentation,
  packaging mechanics and focused tests with settled contracts.
- **Sol, medium:** normal lead orchestration and cross-module integration.
- **Sol, high:** process lifecycle, recovery, PostgreSQL integration, release
  switching and remote-delivery implementation.
- **Astra, high:** architecture changes, authority boundaries, threat analysis
  and difficult independent review.
- **Astra, xhigh:** native credential/process custody, database relocation,
  final security acceptance and any decision whose failure could duplicate
  work, expose credentials or create two writers.
- **Claude Opus or another different high-level model:** selective independent
  review of major shared-contract, native, security and relocation packages;
  never routine implementation by default.

The lead may use one or two parallel helpers, at most three, only for
non-overlapping packages. A producer never performs its own final review.

---

# Part I — Complete “This computer”

## L0 — Stabilize and integrate the current source package

**Model:** Sol medium lead; Terra medium for compatibility fixes; different Sol
high reviewer if behavior changes.
**Reuse:** current pull request #343 and its registered CI lanes.
**Work:**

1. Re-run the registered checks against the integrated journal/configuration
   custody package and correct only demonstrated compatibility or race defects.
2. Obtain and retain independent review for any native or security-sensitive
   correction.
3. Publish one coherent tested checkpoint when repository publication is
   authorized; do not describe a local branch as a released installation.

**Done when:** the branch is clean, the integrated journal/configuration
custody package has the registered local evidence and an independent review,
the hosted checks are green after publication, and no temporary prototype is
presented as release code.

## L1 — Finish protected installation custody

**Model:** Sol high implementation; Astra xhigh security review. No Terra-only
implementation package may own this native custody boundary.
**Reuse:** retained installation journal, protected-root sidecar, installed
configuration custody, release manifest and native descriptor patterns.
**Thin new work:**

1. Complete the native held-session helper for one installation-journal
   operation.
2. Add deterministic sidecar build, manifest, archive and release evidence.
3. Wire the accepted helper beneath installed configuration and journal use;
   do not expose it as a generic command runner.
4. Prove path replacement, symlink, ancestor replacement, malformed input,
   deadline, cancellation, cleanup and process-retirement failures refuse
   safely.

**Done when:** setup can safely retain and update its journal using verified
installed bytes, and the live blocker
`native_journal_operation_custody_missing` is removed only by accepted evidence.

## L2 — Assemble the durable local installation

**Model:** Sol high implementation; Astra high database/recovery review.
**Reuse:** existing PostgreSQL roles/migrations, pg-boss startup, private
configuration, protected result storage, Restic integration, database
backup/restore and local runtime assembly.
**Work:**

1. Assemble one installation-owned configuration from protected private input.
2. Complete the production first-owner authentication host and prove startup
   revalidates that owner and the final reviewed installation before serving.
3. Complete the private PostgreSQL executable, module, configuration and
   connection custody composition; credentials remain in the owner-selected
   secret facility and never enter setup evidence.
4. Complete the production recovery-rehearsal adapter that joins existing
   database and protected-result restore evidence without creating a new
   recovery authority.
5. Provision or select one PostgreSQL database and restricted roles through the
   existing guarded procedure.
6. Run the migration ledger and database evidence check.
7. Bind one pg-boss scheduler and one protected result root.
8. Perform a database plus protected-results backup.
9. Restore into a disposable empty destination and verify identity, roles,
   required records and restricted login behavior.
10. Reread the settled journal, configuration, first-owner, database, scheduler,
    release and recovery evidence immediately before the first startup effect.
    The source now has a pure, redacted two-snapshot binding contract for this
    final check. It refuses altered, incomplete, or substituted evidence and
    has no reader or startup power of its own. The owner-held installation
    reader remains responsible for supplying two genuinely separate current
    observations; copying the first snapshot is not a valid reread.

**Owner gate:** selecting private paths and database credentials, and allowing
the actual disposable provision/restore.
**Done when:** projects, tasks, schedules and saved results survive restart and
the verified restore; no local file or backup becomes a second task authority.

## L3 — Install the Mac background service and supported release

**Model:** Sol high implementation; Astra high review of privileges, update and
rollback.
**Reuse:** Control Room launcher/service package, T3 release-staging concepts,
release precheck, license inventory and rollback fence.
**Work:**

1. Produce one reproducible digest-verified release archive and manifest. A
   digest proves unchanged bytes, not publisher identity; authenticated public
   provenance requires a separate signing/attestation decision.
2. Stage it into a versioned directory, verify it, and atomically select the
   current release.
3. Complete the native service publication/control adapter beneath the accepted
   fixed service definition; it must not become a generic process controller.
4. Install one unprivileged owner-session background service with fixed
   arguments and protected configuration.
5. Complete the authenticated health publisher so setup status comes from the
   exact installed release and service identity rather than a caller claim.
6. Add health, bounded drain, stop, restart and status operations.
7. Rehearse upgrade to a second verified release and rollback to the prior
   verified release while preserving data.
8. Provide data-preserving uninstall; never silently delete PostgreSQL or
   protected results.

**Owner gate:** service installation/start and real restart/rollback.
**Done when:** closing the browser does not stop the controller, and after a Mac
restart or owner logout the accepted LaunchAgent automatically returns when the
owner logs in again without duplicating work. True pre-login or logged-out
operation would require a separate system-service design and review; the
current LaunchAgent must not claim it.

## L4 — Activate the local Hermes vertical

**Model:** Sol high integration; Terra medium tests/UI; Astra high review of
task authority and restart behavior.
**Reuse:** all existing Hermes 0.21 contracts, the already successful local
text and runner qualifications, queue delivery, staging, replay and review
services. Do not modify Hermes.
**Work:**

1. Bind the privately selected Hermes executable, profile, provider/model and
   workspace to the installation using only a safe fingerprint.
2. Preserve the successful owner-attended qualifications as plan-bound setup
   evidence.
3. Enable one narrowly defined text/review task policy first.
4. Prove one real task, denied action, cancellation, saved terminal result,
   controller restart, pending review and correction without a second run.
5. Qualify a separate isolated-worktree writing policy before allowing code
   changes; bind exact allowed paths, commands, size and process cleanup.

**Owner gate:** the first real bounded Hermes task and any later writing-policy
qualification.
**Done when:** Hermes automatically receives a normal queued task and returns
one reviewable result through the same canonical lifecycle.

## L5 — Activate the local Claude vertical

**Model:** Sol high process integration; Astra xhigh process/authentication
review; optional Claude Opus independent review.
**Reuse:** accepted Claude installation composition, bounded stream decoder,
owned session host, result publisher and Anthropic transport/cancellation test
patterns.
**Work:**

1. Qualify the exact installed Claude CLI, authentication behavior and output
   format without importing credentials into Control Room.
2. Bind the accepted private process host to the installation transition.
3. Prove one approved task, denied permission, cancellation, budget/auth
   failure, terminal result and restart read.
4. Route the result into the same pending-review and correction path as Hermes.

**Owner gate:** installed-CLI qualification and first bounded real task.
**Done when:** Claude and Hermes can work independent queued tasks concurrently
without either owning scheduling or review.

## L6 — Complete the local website and owner workflow

**Model:** Terra medium UI/test packages; Sol medium integration review; Astra
high only for protected-read/write boundaries.
**Reuse:** existing Control Room application, T3/Hermes UI state concepts,
canonical server services and current browser acceptance harness.
**Work:**

1. Complete one shared bounded coding-workspace package before enabling any
   writing adapter: isolated workspace acquisition, one delivery-bound lease,
   exact permitted paths/commands/limits, immutable authenticated change
   inventory, cleanup and capacity release across success, cancellation,
   uncertainty and restart. Text-only workers remain explicitly text-only
   until this package and their adapter-specific writing policy pass.
2. Finish project creation/archive/reopen and project-specific navigation.
3. Finish task creation, worker recommendation, explicit assignment and
   capability/unavailable explanations.
4. Show truthful queued/running/disconnected/uncertain/completed states.
5. Show bounded result, evidence fingerprint and aggregate changed-file facts.
6. Finish accept, correction, rejection and attention workflows.
7. Finish schedules, Idea Lab participant tasks and news/research-to-task
   promotion through the same queue.
8. Finish installation, first-owner authentication, backup, service, health,
   release and recovery status pages.
9. Prove keyboard, narrow-screen, accessibility, refresh, lost-request,
   lost-reply and direct-link/reload journeys.

**Done when:** ordinary use requires the website rather than terminal commands,
and every unavailable or simulated capability is labeled honestly.

## L7 — Local release acceptance

**Model:** Sol high acceptance lead; Astra xhigh security/recovery review;
different high-level reviewer for the exact release.
**Reuse:** existing clean-install acceptance, operator proof runbook, browser
journeys, release precheck and full registered test lanes.
**Proof sequence:**

1. Install from the exact downloadable release into an empty supported Mac.
2. Complete resumable setup and owner login.
3. Create a project and run Hermes and Claude tasks concurrently.
4. Review one result and request one correction.
5. Interrupt delivery, lose a reply, restart the service and restart the Mac.
6. Confirm no duplicate run/result and recover the exact saved evidence.
7. Back up, restore into an empty disposable destination and verify.
8. Upgrade, roll back, and verify projects/results remain intact.
9. Run license, secret-leak, permission, accessibility and full release checks.

**Done when:** the release meets the local definition of finished above and its
remaining limitations—especially Mac Codex—are clear in-product and in docs.

## L8 — Conditional local macOS Codex track

**Model:** Astra xhigh architecture and implementation; separate Astra xhigh or
equivalent security review. Qwen/Terra may map or draft tests only.
**Reuse:** existing Codex App Server adapter, journals, workspace checks,
result path and the rejected prototype's negative evidence. T3 remains
reference-only.
**Start condition:** do not implement another wrapper until both conditions are
feasible:

1. exact executable identity can be verified while the process is suspended,
   before user code; and
2. Codex accepts an inherited protected home-directory capability, or another
   reviewed mechanism eliminates the pathname replacement race for private
   Codex state.

The package must also prove complete process-group retirement, cross-layer
deadlines, stream backpressure, exact executable ownership and restart read.
If upstream capability is still absent, keep Codex unavailable on the Mac and
proceed to its supported Linux worker route in M4. This conditional track does
not block the finished local Hermes-and-Claude product.

---

# Part II — Extend to “Several computers”

## M0 — Freeze the topology transition and rollback contract

**Model:** Astra high architecture; Sol high implementation.
**Reuse:** existing topology plan, installation transition journal, shared
delivery contract and database relocation preparation.
**Source progress (September 24):** authenticated transition records now make
the existing `all_drained` versus `uncertain_work_recorded` outcome available
to typed callers. Disposable journeys preserve that outcome through durable
rereads, replay, failure, rollback, and commit in both directions. They retain
the single database and scheduler identities and fence only affected workers.
They do not observe a live drain, publish a route, or elect a controller.
**Work:**

1. Define local-to-several, several-to-local and worker-route-change
   transitions as journaled plans.
2. Implement explicit worker add, remove and rebind operations through the
   existing transition store and admission fence.
3. Pause new admission, drain accepted work, and retain unresolved deliveries
   as uncertain instead of converting them into retries.
4. Invalidate only the proofs affected by changed worker, adapter, route,
   release, database or scheduler bindings; retain unaffected evidence.
5. Preserve installation, database, scheduler, release and project identity.
6. Commit only after every bound proof is current. Record commit failure and
   prepare rollback without partially publishing a route.
7. Fence starts during transition; permit only one active controller writer.
8. Test interruption, process loss, stale proof, commit failure and rollback at
   every transition boundary. Local Claude addition must consume this same
   accepted transition contract.

**Done when:** changing topology changes delivery placement only and a crash at
any stage resumes or refuses safely without two authorities.

## M1 — Prepare an optional private Linux controller target

**Model:** Sol high operations; Astra xhigh ingress/authentication review.
**Reuse:** existing Linux release, PostgreSQL procedures, Cloudflare Access
profile, Tailscale/private-network decisions, service and backup machinery.
**Work:**

1. Stage and verify the same release on one private Linux target without
   starting an application writer, scheduler or replacement database.
2. Prepare private ingress, owner MFA, service, health, backup, restore,
   upgrade and rollback evidence without activating the target.
3. Keep the listener and database unexposed while inert.
4. Continue using the existing Mac controller for the first several-computer
   worker proof. Several computers does not require controller relocation.
5. Activate this target only through the accepted M6 fence/export/restore/
   verification procedure, after the prior writer is proven stopped.

**Owner gate:** infrastructure credentials, private hostname, MFA and live
service/database actions.
**Done when:** the target is fully preflighted but inert. If later activated
through M6, the controller is continuously available without making the public
project website an administrative entrance.

## M2 — Enroll and manage remote worker identity

**Model:** Sol high implementation; Astra high identity/revocation review.
**Reuse:** existing asymmetric worker identity, enrollment, compatibility,
capability, lease and revocation contracts.
**Authority decision:** [`REMOTE_WORKER_ENROLLMENT_AUTHORITY_DECISION.md`](REMOTE_WORKER_ENROLLMENT_AUTHORITY_DECISION.md)
defines the required canonical worker-enrollment projection.  Existing
`control_nodes`/`control_node_keys` remain necessary machine/key evidence;
the Hermes-specific connection registry is not remote-worker authority.
**Work:**

1. Enroll one worker with a unique key and installation-bound identity.
2. Record safe platform, adapter, version and capability evidence.
3. Keep executable paths, accounts, provider settings and network details on
   the worker.
4. Implement renewal, rotation, quarantine, drain and permanent revocation.

**Source progress (September 24):** the append-only canonical enrollment
store now records the exact worker/node/key/adapter/capability/release binding,
with exact retry and lifecycle revisions. Remote delivery rereads that store
before preparation, sending, receipt intake and reconnect recovery. A stale
resolver snapshot is refused after key rotation, draining, quarantine or
revocation. This is disposable source evidence only: no worker has been
enrolled against a live installation.

**Done when:** one worker can be individually trusted or revoked without
rotating every machine or revealing private configuration to the browser.

## M3 — Complete remote delivery and reconnect

**Model:** Sol high distributed-state implementation; Astra xhigh uncertainty
and replay review.
**Reuse:** shared delivery packet/receipt, signed node protocol, remote session
manager, result publication and source-tested reconnect journeys.
**Source progress (September 24):** a two-worker disposable conformance
journey now checks that one enrolled worker cannot receive, adopt, or settle
the other's packet. A reconstructed controller plus replacement session can
recover exactly the original durable receipt without sending again. This is
not a live worker enrollment, network connection, provider call, or execution
proof; protected installed receipt mounting remains a separate owner-bound
implementation.
The first result-return layer now accepts signed, receipt-bound progress and
terminal evidence only after it rereads the current enrollment and delivery
receipt. Its ordering and terminal replay protection are intentionally
session-local and inert: it cannot yet publish a result, finish a task, release
capacity, or claim restart-safe generic result recovery. A later canonical
publisher must add those durable effects in the existing PostgreSQL lifecycle.
The exact reuse and required missing bindings are maintained in
[`GENERIC_REMOTE_RESULT_PUBLICATION_PLAN.md`](GENERIC_REMOTE_RESULT_PUBLICATION_PLAN.md).
The durable terminal record will reuse the existing harness-run ledger as
defined in [`REMOTE_TERMINAL_RECORD_DECISION.md`](REMOTE_TERMINAL_RECORD_DECISION.md),
not a separate remote-result store.
Before it can write that ledger, remote receipt acceptance must register one
discovered remote run and retain the existing lease, delivery, receipt and
enrollment fingerprints. The terminal intake then locks and rereads those
records together. This is an implementation dependency, not a second worker
or another queue.
**Work:**

1. Deliver the exact controller packet to only its intended worker.
2. Authenticate progress, terminal result and failure evidence through the
   accepted [receipt-bound ingress decision](REMOTE_WORKER_RESULT_INGRESS_DECISION.md).
3. Reconnect to the original delivery rather than create a new task.
4. Treat lost acknowledgement as uncertain until durable evidence is read.
5. Reject duplicate, changed, expired, revoked and wrong-worker messages.

**Done when:** disconnect and reconnect never silently repeat a provider or
workspace effect and never create a second result.

## M4 — Activate remote Hermes and Linux Codex workers

**Model:** Sol high adapter integration; Astra xhigh Codex/native review;
Terra medium conformance tests.
**Reuse:** the same local Hermes adapter behind remote delivery and the reviewed
Linux Codex descriptor-acquisition/App Server path.
**Selected Linux custody route:** before the Linux Codex worker can be mounted,
qualify the systemd-managed trusted Node state process in
[`LINUX_TRUSTED_STATE_PROCESS_CONTRACT.md`](LINUX_TRUSTED_STATE_PROCESS_CONTRACT.md).
It retains the current Node SQLite journals inside one protected domain and
uses a separate untrusted execution identity. This is a qualification target,
not a claim that the route is installed or worker-ready. Do not start a second
candidate or custom SQLite filesystem unless that qualification documents a
specific unmet requirement.
**Work:**

1. Qualify a remote Hermes worker with the same capability-specific policy.
2. Complete the trusted Codex signer/checkpoint operation and live server
   composition beneath the already reviewed Linux acquisition boundary.
3. Qualify the selected Linux Codex executable, authentication, workspace,
   start/read/stop and cleanup behavior.
4. Route remote Hermes and Codex through the same canonical
   task/result/review/correction path. If the controller has moved to Linux,
   the Mac Claude worker returns through this same remote delivery/result route
   rather than retaining a hidden local-only callback.
5. Prove simultaneous work, denied actions, restart read and capacity release.

**Owner gate:** first real remote Hermes and Codex qualification/tasks.
**Done when:** Mac Hermes/Claude and Linux Codex can all work through one
Control Room installation and one owner website.

## M5 — Controlled two-node acceptance

**Model:** Sol high acceptance lead; Astra xhigh adversarial review.
**Reuse:** unified conformance journeys and operator proof runbook.
**Proof:** targeted delivery, wrong-worker refusal, incompatible version,
disconnect before receipt, disconnect after effect, reconnect, result recovery,
revocation, key rotation, correction, restart, backup and restore.
**Done when:** every remote transition is evidenced and no test depends on a
second authority or manual copying of task state.

## M6 — Controller/database relocation without synchronization

**Model:** Astra xhigh design and review; Sol high implementation.
**Reuse:** database backup/restore, relocation preparation, transition journal,
rollback checkpoint and release identity.
**Work:**

1. Drain new starts and fence the old controller.
2. Take and verify one bound database and protected-result backup.
3. Restore into an empty target and verify installation identity.
4. Start one new writer only after the old writer is proven stopped.
5. Re-enroll or repoint delivery routes without changing task identity.
6. Retain an explicit rollback window; never run bidirectional sync.

**Owner gate:** real relocation and final old-writer retirement.
**Done when:** Mac-to-Linux, Linux-to-Mac where supported, and host replacement
use one documented procedure with no overlap between writers.

## M7 — Multi-system release acceptance and public packaging

**Model:** Astra high release lead; independent Astra xhigh security review;
Terra medium documentation/installer verification.
**Reuse:** the local release/install path, support matrix, public adapter SDK,
conformance kit and full CI lanes.
**Work:**

1. Repeat clean installation from the public release asset.
2. Select This computer, then transition to Several computers.
3. Add and revoke a worker, survive disconnect/restart, review and correct work.
4. Relocate the controller using the supported procedure.
5. Verify notices, secrets, permissions, backups, accessibility, upgrade and
   rollback.
6. Publish accurate setup, support, troubleshooting and contribution docs.

**Done when:** another owner can install either topology and transition between
them without developer-only commands or hidden private knowledge.

---

# Execution order, parallel work and decision gates

## Critical path

`L0 → L1 → L2 → L3 → L4/L5 → L6 → L7`, then and only then
`M0 → M1(preparation)/M2 → M3 → M4 → M5 → M6(optional relocation) → M7`

- L4 and L5 may run in parallel after L2 provides the accepted installation
  boundary.
- Most of L6 may proceed in parallel with L3–L5, but live-status controls wait
  for the accepted installed compositions.
- M0 source work begins only after the local acceptance journey is complete.
  It must not consume capacity while L2–L7 are still incomplete.
- M1 inert controller-host preparation and M2 worker-enrollment source work may
  run in parallel after M0. M1 never activates a second writer.
- M5 completes the several-computer product with the existing controller; M6
  is required only when relocating that controller or its database.
- L8 is conditional and never blocks the Linux Codex path.

## Required owner actions

The owner is needed only for:

1. selecting protected local paths and supplying private configuration;
2. provisioning or connecting the real PostgreSQL database;
3. installing/starting the background service;
4. first real Hermes and Claude tasks;
5. private hostname, MFA and live remote transport;
6. first real remote Hermes/Codex tasks; and
7. actual backup/restore, update/rollback or relocation rehearsals.

Source contracts, UI, tests, release assembly, documentation and disposable
proofs must continue while an owner gate is unavailable.

## Acceptance discipline

For every phase:

1. Confirm the named retained component or donor decision before coding.
2. Freeze a bounded package with non-overlapping paths and exact tests.
3. Run focused tests while developing, then the registered product lane.
4. Require an independent review proportional to risk.
5. Correct material findings on the same package and re-review them.
6. Update `BUILD_STATUS.md`, `SUPPORT_MATRIX.md`, attribution and this plan.
7. Publish only a substantial coherent package; never call simulated or
   source-only evidence live.

## Immediate next package

The source-only journal/configuration custody package is integrated locally.
The next implementation work is **local L2–L6 only**:

1. complete the remaining protected local setup and service-custody seams;
2. finish the sealed local Hermes runtime path and the already-composed Claude
   qualification/activation path;
3. keep the existing website's worker, task, result and review views tied to
   truthful local evidence; and
4. assemble one reversible, owner-operated local activation bundle only after
   the source route is complete. It must not create a second database,
   scheduler, broker, writer, or remote worker.

Remote enrollment, private routing for additional computers, controller
relocation, and every `M*` package remain deferred until L7.

This file is the execution checklist. Detailed contracts remain in their named
architecture documents; if a detailed contract conflicts with a summary here,
the stricter security/authority contract wins and this plan must be corrected
before implementation continues.
