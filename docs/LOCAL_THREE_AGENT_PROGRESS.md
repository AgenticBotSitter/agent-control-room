# Local three-agent progress tracker

**Purpose:** one shared, plain-English status page for the local Control Room
build. It follows the September 24 Claude completion plan and the five local
product phases derived from it. It is deliberately a progress tracker, not
proof that the installed product is running.

**Last updated:** September 24, 2026

**Execution contract:** [`LOCAL_THREE_AGENT_EXECUTION_PLAN.md`](LOCAL_THREE_AGENT_EXECUTION_PLAN.md)
is the sanitized five-phase build and acceptance plan for this checkout. This
tracker reports progress against that plan; neither file represents preview or
fixture evidence as a live installation.

## At-a-glance build status

These are **rough build-completeness estimates**, not claims that a live
installation works. A phase is complete only when its real-world proof is
recorded.

| Phase | Approximate progress | Current state | What comes next |
| --- | ---: | --- | --- |
| 1. Local Hermes Agent | 92% | The complete canonical source activation path is built and tested, including revocation during launch preparation. | Run one harmless real website task through the protected installation. |
| 2. Local Claude Code | 75% | Its installed-process route and narrow task lifecycle were rechecked end-to-end in source. | Run protected qualification and one real task journey. |
| 3. Local Codex worker | 35% | A narrow Mac process-provider candidate reaches the existing Codex lifecycle in disposable tests. | The existing product decision keeps Mac Codex unavailable: its private state still requires a safe upstream-supported protected-home mechanism. It is not a prerequisite for finishing the Hermes-and-Claude local product. |
| 4. Real website journey | 65% | The owner screens and installed worker composition exist in source, and a verified portable release was assembled and extracted into a disposable clean-install rehearsal. Its read-only preparation gate reports that it is ready for owner setup; `/local-preview` remains correctly labelled preview-only. | Create the protected installed settings, perform the owner-attended service safety check, then prove the live journey. |
| 5. Three-worker coexistence | 25% | Hermes and Claude source behavior is shared and tested. | Demonstrate separate real work, recovery, and corrections for all three workers. |

**Now building:** Phase 4 — finish the protected local installation/website
composition for Hermes and Claude. The Mac Codex route is deliberately held at
the safety gate: its candidate process provider does not yet satisfy the
existing protected-private-state requirement, so it must not be wired into the
installed product merely because disposable tests pass. Phases 1 and 2 are
source-complete; their real-world proof still waits for the shared protected
installation.

**After that:** Phase 5 — use that real website/controller assembly for one
bundled owner-attended proof window for Hermes and Claude, followed by their
separate-result, review, correction, and recovery checks. Codex remains an
honest unavailable option on this Mac until its separate upstream capability
exists; it is not silently substituted with this desktop chat.

**Overall local three-agent build:** approximately **58% complete**. The
largest unfinished part is moving from safe, tested source code to one real,
protected local installation and proving it through the website.

## Parallel review help available now

The build is ready for two safe, useful outside reviews while the lead work
continues. They are intentionally source-only: neither review starts a worker
or changes the installation.

- A local Hermes worker can verify the receipt, recheck, replay, result, and
  correction path.
- A local Claude Code reviewer can verify its installed-route and protected
  readiness/status path.

The exact bounded instructions are in
[`LOCAL_AGENT_REVIEW_PACKETS.md`](LOCAL_AGENT_REVIEW_PACKETS.md). Their reports
can find defects earlier, but they do not replace the later owner-attended
qualification or live website proof.

**Latest independent Hermes review:** the reviewer confirmed that the durable
receipt is recorded before execution and that replay avoids a second attempt.
The initially reported authority-check concern was rechecked against the
current source: the delivery layer supplies the same current-authority check
again after task-file preparation and executable re-attestation, immediately
before the operating system can start Hermes. No live Hermes task was run.

**Latest Hermes safety addition:** a focused regression journey now models an
approved task becoming revoked while local process preparation is under way.
The second, task-bound authority check stops the launch; the saved delivery is
not retried automatically. The focused Hermes checks and the supported release
TypeScript check (`pnpm check`) passed. This is source proof only, not a live
task.

## Current build checkpoint

**Current phase:** Phase 4 — the protected local installation and website
assembly for Hermes and Claude.

**Next phase:** Phase 5 — demonstrate that the workers can complete separate
real tasks through that same website, including a review and a requested
correction. Phase 3 (the Mac Codex worker) remains intentionally separate: it
cannot be called complete until its stronger protected-private-state safety
gate has an approved implementation and review.

**Update format:** Each meaningful build update records (1) the phase worked,
(2) what changed, (3) what was tested, and (4) whether the remaining item is
source work or an owner-attended real-world proof. This avoids treating a
passing disposable test as a running installation.

## Claude completion-plan checklist

This is the direct, short checklist derived from the private Claude local
three-agent completion handoff. That handoff is deliberately kept outside this
sanitized implementation checkout because it contains local deployment context.
It makes clear which of Claude's named stages are source-complete and which
need a real installation. The five product phases above also include Hermes,
Codex, the website, and three-worker proof, so the two tables are complementary
rather than competing plans.

| Claude plan stage | Status | What is complete | What remains |
| --- | --- | --- | --- |
| C0. Shared local-worker contract | **Source complete** | Hermes and Claude follow the same saved task, result, review, correction, cancellation, and recovery rules in disposable tests. | Demonstrate that shared flow in the real protected installation. |
| C1. Claude protected process qualification | **Source complete** | The fixed text-only Claude route, protected qualification, safe output handling, and recorded non-secret evidence are implemented and tested. | Run the owner-attended qualification against the installed Claude program. |
| C2. One Hermes-plus-Claude installation path | **Source complete** | The protected installation composition can keep Hermes and Claude as separate local routes without adding another queue, database, service, or result store. | Materialize and activate that protected installation. |
| C3. Website as local control surface | **Source complete** | The owner pages distinguish setup, unavailable, and saved-task evidence from a live-worker claim. | Use them against the real installation and real database. |
| C4. Real two-worker proof | **Pending live proof** | The disposable two-worker journey is complete. | Run two harmless real text tasks, including review, a correction, restart handling, and a safe failure case. |
| C5. Keep future multi-computer path intact | **Ongoing guardrail** | Current local work retains the shared packet, receipt, lifecycle, and one-database rule. | Recheck this whenever a local adapter or installation change lands. |

## Read this first

- **Built in source** means the code and disposable test data support the
  behavior. It does **not** mean an agent, website, database connection, or
  background service is live on the owner's Mac.
- **Live proof needed** means the behavior still has to be demonstrated using
  the real protected installation, real website, and existing VPS PostgreSQL
  database.
- Do not put passwords, tokens, connection strings, private file locations,
  worker identities, or provider routing details in this file.
- A model choice is normal worker configuration. It is not a separate
  authorization step. The product will later let the owner choose from models
  already qualified for the chosen worker, without exposing credentials.

## Overall snapshot

| Phase | Status | What is true now | What still proves completion |
| --- | --- | --- | --- |
| 1. Local Hermes Agent | **Source integration ready** | The bounded runner is connected to the existing delivery, result, review, replay, and correction path in source. | One harmless real website task reaches Hermes and returns a saved result for review. |
| 2. Local Claude Code | **Source integration ready** | Claude uses the same durable task/result/review lifecycle in source, with text-only review limits. | Its protected local process is qualified and one real task/restart/correction journey succeeds. |
| 3. Local Codex worker | **Candidate route only** | Shared Codex task, recovery, journal, and result contracts are tested, alongside a narrow Mac process-provider candidate. The existing shared worker composition owns result forwarding. | The existing protected-private-state custody requirement remains mandatory. Obtain an approved mechanism and independent security review before it may enter the protected installed composition and a real owner-attended journey. Desktop chat alone is not that worker. |
| 4. Real website journey | **Source UI ready** | The website has project, task, worker-status, result, review, correction, and attention surfaces; it labels preview data honestly. | The installed website is signed into and uses the real VPS database and real workers end-to-end. |
| 5. Three-worker coexistence | **Partially source-proven** | Hermes and Claude have shared-lifecycle tests that prevent cross-worker result recovery. | Hermes, Claude, and Codex each complete distinct real tasks; restart, revocation, and correction are demonstrated. |

## Phase-by-phase details

### 1. Local Hermes Agent — first live worker

**Completed in source**

- A fixed, text-only, one-turn runner can be created only from a freshly
  qualified local Hermes session.
- The runner is tied to one installation, worker, release, task policy, and
  reviewed executable identity. It rechecks the executable before it starts a
  task.
- The protected installation configuration records that reviewed program
  fingerprint, so later activation cannot quietly point the runner at another
  Hermes program.
- The installed delivery graph can now hold an **inactive** runner connection.
  It refuses a task before attended qualification, accepts only the exact
  qualified runner once, and then creates a fresh task-specific connection at
  the existing final authority check. A restart leaves it inactive again;
  it never pretends a past approval is still live.
- The existing attended setup stage now requires a freshly qualified runner
  before it can fill that connection. It rereads the current setup record
  before activation, so a changed, cancelled, or stale setup cannot enable
  Hermes after the owner confirms it.
- The normal Control Room delivery records its receipt before it can acquire
  Hermes. A changed or revoked task does not run; a replay reads the saved
  result instead of starting Hermes again.
- Results follow the existing saved-result, owner-review, and correction flow.

**Known limitation**

- This practical Mac route trusts the owner's same-user local environment. It
  is not a hostile-machine sandbox.

**Remaining**

1. Finish the protected installed owner-host that obtains the selected Hermes
   configuration without leaking it and constructs the already-wired attended
   qualifier. **Completed in source:** it is now an inert protected runtime
   which, only during the attended setup stage, reviews the configured Hermes
   program, performs one text-only qualification, and yields one exact runner
   to the inactive connection.
2. Connect the prepared installation to the existing VPS database through the
   already selected private route.
3. Run one owner-approved harmless real task from the real website, then prove
   review, correction, revoked-task refusal, and restart recovery.

### 2. Local Claude Code — same lifecycle, limited first capability

**Completed in source**

- Claude delivery reserves the same kind of durable task receipt before a
  process can be acquired.
- It is restricted to the defined text-review capability; it is not silently
  granted general editing or unrestricted tools.
- Source tests cover lost replies, changed authority, cancellation, restart
  behavior, and shared Hermes/Claude operation.

**Remaining**

1. Finish the protected installed-process composition and its real login/
   permission qualification.
2. Demonstrate one real task, result, review, restart recovery, and correction
   through the installed website.

### 3. Local Codex worker — separate from this desktop chat

**Completed in source**

- Control Room already has strict task-start, recovery, result, and review
  contracts for a Codex App Server worker.
- The shared task delivery and workspace safeguards are exercised by the
  current source tests.

**Not complete**

- There is no accepted managed macOS Codex worker yet. The Codex desktop chat
  is the owner's development interface, not an automatically enrolled worker.
- A future Mac worker must use a supported process interface, protect its
  private state, use a narrow execution policy, and pass a real owner-attended
  qualification. It must not fake that proof or substitute a Linux worker.
- The selected first route and its source package are recorded in
  [`LOCAL_MAC_CODEX_ROUTE_DECISION.md`](LOCAL_MAC_CODEX_ROUTE_DECISION.md).

### 4. Real website journey

**Completed in source**

- Owner-facing screens cover project and task creation, worker availability,
  saved results/evidence, review, corrections, attention, and setup status.
- The UI tests specifically refuse to call preview or setup-only information
  a live worker.

**Remaining**

1. Assemble the protected local runtime configuration and launch the actual
   website/controller against the existing VPS PostgreSQL database.
2. Sign in and demonstrate: create project, create task, select an available
   worker, inspect its saved result, accept it, and request a correction.
3. Record actual status from the real controller rather than fixture data.

### 5. Three-worker coexistence and recovery

**Completed in source**

- Hermes and Claude can use one shared task/result/review lifecycle without
  taking each other's saved results.
- Control Room's general Codex lifecycle and recovery checks currently pass.

**Remaining**

1. Repeat the live journey for all three actual local workers.
2. Demonstrate separate tasks/results, worker failure, cancellation or
   revocation, controller/worker restart, and one correction without duplicate
   execution.
3. Write a compact, non-secret evidence record of what was actually run and
   any remaining limits.

## Shared prerequisites for live proof

These are not a request for a sequence of separate approvals. They are the
remaining technical work that must be assembled before one short owner-attended
activation window can be offered.

| Item | Current status | Why it matters |
| --- | --- | --- |
| Protected local owner-host | Incomplete | It must join protected configuration, journal custody, real worker qualification, and the existing controller without exposing secrets. |
| VPS PostgreSQL private connection | Prepared historically; not rechecked live here | The VPS database is the one authority database for this installation. |
| Protected local data and recovery | Source preparation exists; live restore not proven | Saved results and recovery evidence must survive restart without becoming a second authority database. |
| Small local background service | Source preparation exists; not activated | The website/controller must stay available and restart safely. |
| Real worker enablement | Not done | A source adapter or standalone qualification is not permission to run normal tasks. |

## Current tested evidence

The following checks passed in the active implementation checkout using only
disposable test data:

- Local Hermes, Claude, shared-lifecycle, and website-focused checks: **56
  passed**.
- Local product-shell/owner-interface checks: **87 passed**.
- Codex delivery, recovery, journal, and result checks: **213 passed; zero
  failed; one intentionally skipped**.
- Mac Codex provider plus existing App Server session checks: **10 passed; zero
  failed** (one non-Mac check skipped by design).
- Protected Hermes configuration-binding checks: **19 passed; zero failed**.
- Inactive-to-active local Hermes runner bridge: **15 passed; zero failed**.
- Owner-admission and setup-stage regression checks: **35 passed; zero
  failed**.
- Protected owner-qualification runtime checks: **6 passed; zero failed**.
- Claude qualification, installed admission, delivery, shared-worker, and
  local-executor checks: **35 passed; zero failed** (September 24 recheck).
- Combined protected-installation, Hermes/Claude lifecycle, operator-status,
  and browser-journey checks: **37 passed; zero failed** (September 24
  recheck).
- Disposable release assembly and extracted-package preparation: **passed**;
  the package reported `readyForOwnerSetup: true` without starting a service,
  creating a database, or writing credentials.
- Type checking passed. Change-format checks passed.

These checks are useful evidence for source behavior. They do not prove a live
website, database connection, worker, login, or persistent service.

## Next build package

**Real local Hermes proof:** prepare the protected installation, perform its
one owner-attended activation, then submit one harmless text-review task from
the real website. Confirm its saved result, owner review, correction, replay
refusal, and restart status. Reuse the existing configuration custody, journal
custody, delivery, result, and review services; do not add a queue, broker,
database, or second task lifecycle.

## Update log

| Date | Phase(s) | What changed | Result |
| --- | --- | --- | --- |
| September 24, 2026 | 1 | Added the protected owner-attended Hermes qualification runtime and wired its one-use runner into the installed local delivery route. | Source and targeted tests passed; real installation proof remains pending. |
| September 24, 2026 | 2 | Re-read the Claude qualification, admission, installed composition, and queue-executor paths against the C1-C3 plan. | No missing source integration gap found. Focused verification passed: 35 checks, type check, and formatting check. Real qualification and task remain pending. |
| September 24, 2026 | 3 | Mapped the existing Codex App Server task, recovery, journal, and process-acquisition code against the local three-agent handoff. | The missing part is a managed Mac process route with a bounded owner-trusted policy; the existing Linux-only launcher cannot honestly be reused as-is. |
| September 24, 2026 | 3 | Added a Mac-only owner-trusted Codex App Server process provider with one exact binding, fixed `app-server` arguments, executable recheck, protected local-directory check, and cancellation cleanup. | It also passed through the existing App Server session framing and cleanup checks: 10 passed, with type and formatting checks. It is source-only and has not started real Codex. |
| September 24, 2026 | 3 | Changed the private Codex host to depend on the shared reviewed-process capability rather than the Linux-only launcher type. | The new Mac provider can now enter the existing host/journal path without duplicating it. Combined process and host checks: 20 passed, two platform-specific checks skipped, plus type and formatting checks. |
| September 24, 2026 | 3 | Added a process-local duplicate-binding fence and a close-during-verification fence to the Mac Codex provider. | Two provider objects cannot start one task binding, and shutdown prevents a late spawn. The provider/session check remains green: 10 passed, one non-Mac check skipped. |
| September 24, 2026 | 3 | Required the Mac Codex private-state folder and task working folder to be distinct, non-overlapping protected directories. | A misconfigured overlap is refused before any process can launch. The provider test and type check remain green. |
| September 24, 2026 | 3 | Rechecked completed-result handling before adding a Mac-specific bridge. | Reused the existing shared worker composition, which already owns recovery and the signed saved-result sender. No duplicate result path was retained. Twenty-five focused recovery/sender checks, type check, and formatting check passed. |
| September 24, 2026 | 3 | Connected the Mac Codex process provider to the existing protected private Codex host in a disposable Mac-only test. | The host accepted the provider without using the Linux launcher. Two Mac checks passed; one non-Mac check was skipped by design. No real Codex process, service, or account was used. |
| September 24, 2026 | 3 | Exported the Mac Codex provider through the existing compiled private-node entry used by later installation assembly. | Full release build, TypeScript check, and 12 relevant compiled/private-host/provider checks passed; one non-Mac check was skipped by design. No service was started. |
| September 24, 2026 | 1, 4 | Rechecked the installed Hermes delivery path before relying on it for the website journey. | Thirty-one focused local-delivery, runner, installation-assembly, and launcher checks passed. The task is durably receipted before launch and a final authority recheck runs immediately before the local process boundary. |
| September 24, 2026 | 3, 4 | Re-read the shipped owner-host preflight, protected configuration publisher, and Mac launcher boundary against the current local build. | Corrected the tracker: the remaining website/install gap is the fixed protected owner-host composition, while the Codex route remains unavailable until its stronger Mac private-state custody requirement is met. Nineteen focused disposable checks passed; no live service, worker, database connection, or credential was used. |
| September 24, 2026 | 4 | Re-ran the complete disposable owner-interface and browser-journey lanes. | All 87 interface checks and all 5 browser-journey checks passed. The pages correctly distinguish unavailable, preview, saved, and live states; this remains source evidence, not a live installation. |
| September 24, 2026 | 1, 2, 4 | Ran the complete local-installation acceptance lane, including release build, installer, protected-data, recovery, setup, website host, Hermes/Claude composition, and PostgreSQL boundary checks. | The complete disposable suite passed. It proves the local package remains internally consistent after the active source changes; it did not create a database, open a listener, start a service, or invoke any worker. |
| September 24, 2026 | 1, 2 | Re-ran the focused canonical Hermes delivery and shared Hermes/Claude lifecycle checks. | Fourteen checks passed: receipt-before-launch, final authority recheck, refusal without invocation, uncertainty without retry, exact replay/restart recovery, single-use task ports, executable re-attestation, and separate Hermes/Claude result recovery. The real protected-installation journey remains the only Phase 1 completion proof. |
| September 24, 2026 | 2 | Re-ran the focused Claude qualification, post-install admission, local queue-executor, and shared-lifecycle checks. | Seven checks passed. Claude remains bounded to the reviewed text-only capability, refuses unresolved delivery, and retains separate durable recovery from Hermes. Its real protected qualification and first real task are still pending. |
| September 24, 2026 | 3 | Rechecked the proposed owner-trusted Mac Codex wording against the existing documented custody rule. | The stricter protected-private-state mechanism remains a mandatory product safety gate. The candidate stays source-only and unavailable; it was not wired into the installed composition or represented as live. |
| September 24, 2026 | 1, 2, 5 | Audited direct Hermes correction handling in the shared local-worker lifecycle. | The existing lifecycle correctly refuses to complete a result merely because a correction was requested: the corrected task must actually be delivered and returned. The restored shared journey passed. A real Hermes correction journey remains an explicit live-proof item, not a shortcut that source fixtures can claim complete. |
| September 24, 2026 | 4 | Traced the local website and installed Hermes composition to distinguish an operational route from preview data. | The local-preview route remains honestly preview-only. The next build package is protected installed application assembly, not modifying preview screens to claim live worker state. |
| September 24, 2026 | 2, 5 | Rechecked the bounded Claude route and shared Hermes/Claude lifecycle while the protected installation handoff remains owner-held. | Eleven focused checks passed: unresolved jobs are not acknowledged, task pages use server-recorded worker state, and Hermes/Claude results remain separated. This is source evidence, not live activation. |
| September 24, 2026 | 4 | Ran the shipped owner-host preflight from the active development checkout. | It correctly refused because this checkout is not a prepared installed release. It read no protected configuration and started no database, service, worker, or agent. Release preparation and one owner-held setup window remain the path to a real website. |
| September 24, 2026 | 4 | Verified the release license/provenance evidence and assembled the portable local release into a new disposable folder. | The focused release suite passed 8/8. Assembly produced a 385-file package and checksum without publishing, signing, installing, starting a service, or contacting workers. The next step is protected installation preparation, not another source-only package. |
| September 24, 2026 | 1–4 | Ran the combined local-worker and installed-runtime regression group after packaging. | Type checking passed and 17 focused checks passed. Hermes delivery is receipted before launch, Hermes/Claude remain separated, and the Mac Codex route enters the existing private host without the Linux launcher. No live database, website, or worker was touched. |
| September 24, 2026 | 3 | Traced the actual installed application composition rather than relying on the standalone Codex tests. | Corrected the progress estimate: the installed composer currently enables Hermes and optional Claude, but does not yet receive the Mac Codex provider. The next source package is that shared-composition wiring; no live capability was misrepresented as complete. |
| September 24, 2026 | 1, 2, 5 | Re-ran the topology-neutral correction and shared Hermes/Claude lifecycle checks. | Three checks passed. A correction remains a new, linked task that uses the same durable delivery route; it is not an automatic rerun or a second local queue. This proves the source contract only. A real correction must still be assigned, delivered, and returned during the live proof. |
| September 24, 2026 | 2, 5 | Extended the shared local-worker lifecycle proof to drive a saved Claude change request through the existing revision planner. | The correction creates exactly one linked Claude revision plan, starts no work by itself, requires normal later assignment, and replays without a second plan. Three focused correction/lifecycle checks and type checking passed. This remains disposable-data proof. |
| September 24, 2026 | 1, 5 | Extended the existing full local Hermes delivery/recovery proof with the same owner-review and revision-planning path. | Hermes now proves a saved result enters the canonical owner-review gate, a requested change produces one linked Hermes revision task, no revision starts automatically, and exact replay creates no duplicate plan. Five focused Hermes/Claude/topology checks plus type checking passed. This remains disposable-data proof. |
| September 24, 2026 | 1, 2, 4 | Re-ran the protected installed-runtime assembly and the Hermes/Claude admission preparation checks. | Twenty-eight checks passed. The installed composition retains one authority database and one result/review lifecycle, admits Hermes through the owner gate, adds Claude without replacing Hermes, and refuses altered routes, identities, callbacks, and stale setup evidence. It remains source-only until one protected installation is activated. |
| September 24, 2026 | 1, 2, 4, 5 | Re-ran the complete local-installation acceptance lane after the Hermes and Claude correction-lineage work. | The full disposable installation suite completed without a reported failure, and the active checkout passed formatting validation. The existing owner interface already reads the same three local-worker capability model; no second status screen or local-only lifecycle was added. This is still not a live website or worker proof. |
| September 24, 2026 | 2, 4, 5 | Added Claude’s already-existing, plan-bound local-process readiness as an explicit input to the bundled activation checklist. | Twenty-six activation/installation checks and type checking passed. A verified Claude readiness record now produces a distinct “approve Claude’s first task” item, but cannot turn the installation live by itself. The checklist still refuses forged, stale, cross-installation, or incomplete evidence. |
| September 24, 2026 | 1, 4 | Rechecked the complete protected local Hermes runner path before advancing the installed website package. | Twenty-one focused checks plus TypeScript validation passed. A task is recorded before a one-use runner can receive it; policy refusal, executable drift, cancellation, and restart replay cannot trigger a second Hermes attempt. This is source evidence only; no real task, worker, database connection, or listener was started. |
| September 24, 2026 | 1, 2, 4 | Ran the complete local-installation acceptance lane against the active local three-agent source. | The production-shaped release build and local installation, setup, protected-data, Hermes, Claude, PostgreSQL-boundary, and website checks completed successfully. Build warnings only concerned deprecated or ineffective bundler import conventions. No real service, database connection, agent, credential, or listener was started. |
| September 24, 2026 | 4, 5 | Added the redacted all-worker activation checklist to the existing installed-operator status projection. | The operator can now report the full, bound list of remaining local activation gates in one read-only status response. It accepts no readiness or action input from the caller, so viewing status cannot enable a worker. The targeted operator, runtime-assembly, and activation tests plus type checking passed. |
| September 24, 2026 | 4, 5 | Corrected the activation-checklist type so its nested lists are read-only in both runtime and TypeScript, then re-ran the browser and installation regression group. | The browser owner journey, local worker status, compiled setup page, operator, runtime-assembly, and activation checks passed. The website already has the authenticated setup/readiness and worker-capability surfaces, so no duplicate status page was added. This remains a tested source path, not a running website. |
| September 24, 2026 | 4 | Wired verified protected Hermes/Claude readiness through the installed operator status projection. | The owner website can now distinguish a rechecked, qualified local worker from a missing one without accepting a browser-supplied readiness claim or enabling work. When verified Claude evidence exists, it also shows only the next owner action for Claude's first task. Focused operator, installed-runtime, and worker-preflight checks plus TypeScript validation passed; this is still source evidence, not a live worker. |
| September 24, 2026 | 4 | Changed the shipped owner-host preflight from a one-blocker response to a complete, ordered, read-only prerequisite bundle. | The release now tells the owner all currently missing installation boundaries before any setup attempt. Release assembly, owner-host tests, and type checking passed. The check still reads no credential or protected path and starts no database, website, service, or worker. |
| September 24, 2026 | 3 | Re-ran the complete focused Mac Codex process, private-state, and App Server session safety lane before deciding whether it can enter the installed product. | Nineteen checks passed and one non-Mac check was intentionally skipped. The candidate safely fixes a single task binding and cleans up its process, but its local journal files still lack the required held native custody. Codex therefore remains unavailable in the installed product rather than being incorrectly marked ready. |
| September 24, 2026 | 3, 4 | Reconciled the candidate Mac Codex code with the repository's existing final local-product decision and held-descriptor custody research. | The prior candidate cannot solve Codex's protected-home pathname requirement. The local product will therefore finish Hermes and Claude first, while the website continues to show Mac Codex as unavailable rather than claiming a three-worker installation that is not safe. No live service, database, worker, or private state was touched. |
| September 24, 2026 | 3, 4 | Corrected the local website's Codex capability card so even a structurally valid saved custody record cannot imply that an owner command will make Mac Codex ready. | Sixteen focused website/capability checks and TypeScript validation passed. The page now explains that the missing capability is upstream protected-home support, directs the owner to Hermes/Claude locally or the supported Linux Codex route, and does not expose private settings or start anything. |
| September 24, 2026 | 1, 2, 4 | Rebuilt the release and ran the full disposable local-installation regression after the capability-card correction. | The complete local-installation suite passed, including release assembly, clean-install rehearsal, setup, protected-data, recovery, local Hermes/Claude composition, website, and database-boundary checks. It produced only existing build warnings and did not start a live service, database connection, worker, or agent. |
| September 24, 2026 | 1–5 | Added the sanitized five-phase execution contract beside this active implementation checkout. | It states the required real-world proof for each phase, preserves the one-database/shared-lifecycle rule, and records the current Codex protected-state gate without exposing local paths, credentials, or private network details. |
| September 24, 2026 | 1 | Independently reviewed the canonical local Hermes runner and rechecked the review findings against the active source. | The final authority callback already runs after task preparation and executable re-attestation, immediately before spawn; the duplicate-attempt check uses the frozen admitted task. Twenty-one focused delivery, installed-composition, owner-runner, and qualification checks passed, along with type and formatting checks. Real website activation remains the next proof. |
| September 24, 2026 | 1, 2, 3 | Added bounded local-review packets so Hermes and Claude can independently check their own routes before the live website is activated, alongside the existing Codex safety review. | The Hermes and Claude packets check their canonical lifecycle and installed readiness respectively; the Codex packet checks its protected-state decision. All are read-only, avoid protected configuration and native execution, and return evidence for lead review rather than authority to enable a worker. |
| September 24, 2026 | 1, 2, 4, 5 | Re-ran the combined protected-installation, Hermes/Claude lifecycle, operator-status, and browser-journey regression group. | Thirty-seven checks, TypeScript, and formatting validation passed. The verified source route remains ready for the bundled owner-attended installation proof; no real website, worker, database connection, or service was started. |
| September 24, 2026 | 4 | Rebuilt and assembled a disposable portable release, extracted it into a clean temporary folder, and ran its shipped read-only preparation gate. | The archive contains 385 files and the extracted package reported `readyForOwnerSetup: true`. It did not publish, install, sign, start a service, create a database, write credentials, or invoke an agent. |
| September 24, 2026 | 1, 3 | Incorporated the independent Marvin/Hermes route review and corrected narrow test typing defects in the Hermes and local Codex checks. | The Hermes route verdict remains pass: receipt-before-launch, final authority recheck, replay fencing, and existing result/review composition are present. Focused Hermes/Codex checks pass, and `pnpm check` passes. The broader `tsc --noEmit` command still has unrelated older full-tree errors, so all tracker references to a “type check” mean the supported release check unless an entry explicitly says otherwise. |

## Update rules for Codex and Claude

1. Update this file after a meaningful code package, real test result, or live
   activation attempt—not for ordinary planning discussion.
2. Update the at-a-glance table whenever a phase advances, stalls, or changes
   its next action. Keep estimates deliberately rough and never use them to
   imply real-world proof.
3. Mark source tests and real-world proof separately. Never upgrade a source
   result to a live claim without an actual recorded journey.
4. Keep the next build package to one concrete outcome. If it is blocked,
   name the missing capability or owner-attended action in plain English and
   proceed with independent source work.
5. Preserve this file as a sanitized collaboration record. Put private
   operational detail only in protected local documentation.
