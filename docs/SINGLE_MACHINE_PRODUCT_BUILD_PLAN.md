# Single-machine product build plan

**Status:** active architecture plan, September 20, 2026.  
**Goal:** make **This computer** a complete installation choice of Agent Control
Room. It must use the same projects, tasks, results, reviews, corrections,
database, and scheduler as **Several computers**. It is not a smaller fork.

## The product we are building

On one computer, an owner can open Control Room, choose a project and a bounded
task, choose an available local agent, review the requested scope, watch
truthful progress, inspect its result and changed files, then accept it or ask
for a correction. A browser closing or a computer restart must not quietly
start work twice or lose a result that was already safely saved.

The first complete local product supports the owner-installed Hermes Agent,
Claude Code, and Codex. Each is an adapter to the same Control Room lifecycle;
none owns the project, task, review decision, or scheduler.

An unavailable capability must say **not set up** or **not proven**, never
pretend that it is live.

## Fixed architecture

| Rule | Decision |
| --- | --- |
| Task authority | Existing Control Room project, task, attempt, result, review and correction records remain authoritative. |
| Database | One PostgreSQL database per installation. Local files hold protected result bytes and recovery evidence only. |
| Work engine | Existing pg-boss queue remains the only scheduler. No harness gets its own queue or automatic retry loop. |
| Agent connection | One signed delivery packet and one result/review lifecycle are used by local and later remote workers. Route choice is delivery information, not a separate task type. |
| Private settings | Executable locations, logins, model/provider settings and workspace paths stay in installation-owned configuration, never task records, browser data, logs or public GitHub. |
| Recovery | A lost acknowledgement is uncertain. The controller reads saved receipt or staged terminal evidence before deciding anything; it does not run an agent again by guesswork. |

The shared contract is in [SHARED_CONNECTOR_CONTRACT.md](SHARED_CONNECTOR_CONTRACT.md)
and the local/remote common foundation is in
[UNIFIED_TOPOLOGY_BUILD_PLAN.md](UNIFIED_TOPOLOGY_BUILD_PLAN.md).

The source-level final integration decision, including the exact decisions for
T3 Code, Hermes WebUI, and Hermes Desktop, is in
[SINGLE_MACHINE_FINAL_EXECUTION_PLAN.md](SINGLE_MACHINE_FINAL_EXECUTION_PLAN.md).
It supersedes this document's earlier Claude-before-Codex sequencing: the
owner's chosen enablement order is Hermes, Codex, then Claude.

## What we retain, borrow, and deliberately do not borrow

| Need | Decision | Why |
| --- | --- | --- |
| Projects, tasks, review, correction, durable results, PostgreSQL and queue | **Retain existing Control Room code** | It is already the one coherent authority system. Replacing it would create a second product inside the product. |
| Local protected artifacts, result staging and restart safety | **Retain existing Control Room code** | It already separates saved result bytes from task authority and prevents duplicate publication. |
| Hermes local route | **Finish existing local Hermes adapter** | The queue-to-controlled-runner-to-review path already exists. Add only the private installed-runner binding and missing proof, not a new Hermes framework. |
| Claude local route | **Finish existing Claude stream/result adapter** | Control Room already has bounded stream decoding, owned process-session cleanup and result publication. It needs a qualified installed-process host and queue/admission composition. |
| Codex local route | **Finish existing Codex App Server adapter** | Existing App Server framing, start/read journaling and workspace checks are the correct narrow foundation. Do not replace them with a generic agent framework. |
| News and research collection | **Keep attributed Control Center modules** | The retained MIT modules already supply feed discovery, source reading, freshness and curation. |
| Supplemental code review | **Adapt Alibaba Open Code Review as an optional frozen-diff reviewer** | Its versioned run manifest, input-bound resume identity and bounded file reads are useful review evidence. It can never approve or merge work. |
| Session observation | **Keep Herdr optional and read-only** | It can show a local session/pane observation but cannot launch work, complete a task, or replace Control Room history. |
| UI ideas: capability and reconnect presentation | **Evaluate exact pinned T3/Hermes UI files before copying** | They may reduce display work, but no unexamined application shell, credential path, database or global store may be adopted. |
| Isolated future coding environment | **Study Ralph Sandbox containment ideas only** | Private writable clone, resource limits and egress containment are useful concepts. Its shared credentials, automatic fallback, completion markers and scheduler are incompatible. |

Before custom code is added for a substantial component, use
[REUSE_DECISION_GATE.md](REUSE_DECISION_GATE.md). A repository's README, a
similar screen, or "faster to write" is not enough to skip this decision.
The current file-level donor decisions are recorded in
[SINGLE_MACHINE_REUSE_AUDIT.md](SINGLE_MACHINE_REUSE_AUDIT.md).

## Capability truth today

| Agent | Reusable foundation already present | Missing before calling it a working local worker |
| --- | --- | --- |
| Hermes Agent | Local queue route, task plan, controlled subprocess shape, terminal staging, result publication, review handoff and restart-safe receipt behavior. The owner-attended fixed runner bridge has been qualified on the Mac for one bounded text-only response. | Private installation binding and protected data/restart/backup proof; an approved first real task policy and owner enablement. The current `bot_room` text runner is **not** general code-writing support, and its qualification did not create a Control Room task or enable ordinary work. |
| Claude Code | Bounded stream-json decoding, owned injected session cleanup and canonical result publication; queue admission and a source-only executor that reuses the signed delivery, ordinary run history, protected staging and restart-recovery path; plus an opaque plan-bound readiness record for installed-process identity, permission limits, and cancellation/restart behavior. | A separately reviewed private installed-process binding, authenticated owner proof, and exact installed-session behavior. Current profile correctly says every live operation is unsupported until those requirements and a separate enablement decision are complete. |
| Codex | App Server contract, strict JSON-lines handling, activation/start/read journals, workspace checks and canonical result path. | A safe Mac process-custody solution and owner-attended qualification. Current code deliberately supports native execution only on the reviewed Linux route; Mac must stay unavailable until its credential-directory and suspended-process proof requirements pass. |

## Build order and completion evidence

### S0 — Make the local product contract explicit

1. Update the support/capability matrix so the local milestone truthfully says
   which of the three agents are source-ready, qualified, available, or blocked.
2. Define the common local runner boundary: intake of one approved delivery,
   bounded progress/result/uncertainty, and explicit cleanup. It must not be a
   new scheduler or authority store.
3. Inventory a precise donor decision for every missing UI/host component.

**Done when:** a contributor can tell from one page what each agent can do,
what proof is missing, and which exact existing code or approved donor applies.

### S1 — Make the local service durable and visible

1. Complete installation-owned configuration, one PostgreSQL connection,
   pg-boss worker startup, protected local artifact root and an unprivileged
   supervisor/launcher design.
2. Finish the local browser pages: project, task creation, worker capability,
   live-or-unavailable status, result/evidence, review/correction, attention,
   installation status and plain-English recovery instructions.
3. Prove a saved project/task survives service restart and a backup restores
   into a disposable empty destination.

**Done when:** the browser is a truthful control surface, not a fake agent
dashboard, and ordinary data survives a controlled restart/restore proof.

### S2 — Hermes first complete vertical slice

1. Keep the existing queue-to-Hermes-to-result-to-review path.
2. Have the owner privately select the installed Hermes executable, profile,
   model/provider and allowed workspace; record only a safe fingerprint.
3. Run separate text and exact-runner bridge qualification. Define the allowed
   task/tool/file policy before enabling project work; do not widen `bot_room`
   by assumption.
4. Prove one bounded real task, cancellation/denial, terminal staging, restart
   after delivery, restart after saved terminal evidence, review and correction.

**Done when:** one Hermes task reaches pending review once, cannot duplicate on
restart, and its permitted workspace change is inspectable by the owner.

### S3 — Codex on the selected local host

1. First decide the supported local host: prove a safe macOS custody design or
   use the existing reviewed Linux path for the first operational installation.
2. For macOS, solve the two recorded gates before enabling anything: verify the
   exact running program while suspended before user code, and hold a protected
   Codex home-directory handle rather than reopening a race-prone pathname.
3. Reuse the App Server start/read/journal/result pipeline. Qualify actual
   version, bounded framing, approval requests, stop, restart `thread/read`
   and cleanup.

**Done when:** a real Codex task has the same reviewable result/correction and
no-duplicate restart behavior as Hermes. If the macOS proof cannot be made
safe, the UI must say so and offer no pretend local-Codex start.

### S4 — Claude Code local worker

1. Qualify the exact installed Claude Code version and stream-json behavior
   without copying its credentials into Control Room.
2. Add the smallest owned process-acquisition bridge beneath existing decoder,
   session lifecycle and result publisher.
3. Bind one approved delivery to one Claude session; map permission prompts,
   stop, authentication/budget failure, terminal result and restart read into
   the shared lifecycle.
4. Keep unsupported upstream behavior visibly unavailable rather than guessed.

**Done when:** a real bounded Claude task, a denied action, a cancellation and
a post-restart result read all produce truthful canonical records without a
second turn.

### S5 — Three-agent local daily use

1. Share one isolated Git workspace contract across the three adapters.
2. Add capability-aware task assignment, progress, cost/usage when truthfully
   supplied, result/diff evidence, correction and attention views.
3. Connect schedules, Idea Lab and news/research promotion to this same task
   path—never their own runner/queue. Idea Lab follows the accepted
   [canonical lifecycle decision](IDEA_LAB_CANONICAL_LIFECYCLE_DECISION.md):
   every participant/round is a normal task with normal delivery, result,
   review and correction evidence.
4. Optionally invoke a pinned Alibaba review run against a frozen diff and
   store its bounded findings as advisory evidence.

**Done when:** the owner can assign separate bounded jobs to all three,
review their results, request corrections and recover after restart without
browser closure changing work execution.

### M1 — Several-computers is a delivery extension, not a rebuild

After S0–S5, enroll a second worker using the existing remote delivery packet,
compatibility check and signed receipt. Add controlled reconnect, revocation and
two-node proof. It must continue to use the same PostgreSQL database, queue,
result path and review screen.

**Done when:** a worker on another computer receives only its intended packet,
reconnects without a resend, and cannot create a second result or become a
second authority.

## Owner-attended gates

These are physical installation proofs, not source-code tasks. They require an
owner only when the relevant phase is ready:

1. select private local runner/executable/profile/workspace bindings;
2. allow a narrowly scoped real Hermes/Claude/Codex test where stated;
3. provision the actual one-database installation and prove backup/restore;
4. approve supervisor, local data location and real restart proof;
5. choose local host approach for Codex if macOS custody cannot be safely
   qualified; and
6. later, authorize real remote transport and two-machine proof.

No owner action is needed to finish source contracts, UI, tests, documentation,
reusable donor evaluation, or safe installation preparation first.

### Local service preparation status

The protected setup page requires a separate, plan-bound local-service readiness
record before it says Hermes is ready for the owner-enablement decision. The
record contains only four opaque evidence digests: private configuration
custody, restricted launch definition, restart/drain procedure, and
upgrade/rollback procedure. It does not identify the service manager,
configuration path, account, launch command, or any credential. Recording it
does not install, start, stop, or restart Control Room. A real supervisor and
restart proof remain owner-authorized installation work.

## Acceptance: one product, two installation choices

The local release is complete only when all three harnesses, at their honestly
supported capability level, pass the same project → task → delivery → result →
review → correction journey. A changed packet, changed receipt, lost reply,
wrong worker, denied action, cancel, restart and duplicated terminal result
must each remain truthful. The remote release repeats the delivery leg with a
real enrolled remote worker; it does not fork the data model or application.
