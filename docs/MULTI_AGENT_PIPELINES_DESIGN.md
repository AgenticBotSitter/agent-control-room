# Multi-agent pipelines (Phase 4)

**Status:** design only. No code, no migration, no live effect.
**Scope:** how a task moves through ordered stages, each run by a chosen role, agent and
model, with independent checking, bounded correction loops and reusable templates.
**Relationship to existing decisions:** this adds no new authority, no second scheduler and
no second queue. Every concept below maps onto a record the product already owns.

**Open questions: answered.** B.13 was opened as thirteen questions. It now records thirteen
**decisions**, each written as the setting it becomes, the scope it is set at, the safe public
default, and the guardrails that hold regardless of any setting. No installation's chosen
values appear in this document; this repository carries the product, not one install's
configuration.

Read alongside: `docs/OWNER_PRODUCT_VISION.md`, `docs/PRODUCT_REQUIREMENTS.md` (sections 3
and 4), `docs/PROJECT_COORDINATION_DECISION.md`, `docs/CR3_DECISION_LOG.md` (ADR-041, ADR-042,
ADR-044, ADR-053, ADR-054), `docs/CR5C_FINAL_SECURITY_CONTRACT.md`,
`docs/claude/W8_MODEL_SELECTION.md`, `docs/ARCHITECTURE.md`,
`docs/GITHUB_APP_WORKER_BROKER.md`.

---

## Part A — Plain English

### A.1 What the owner asked for

A piece of work can have several **stages**. One agent plans it, another builds it, a third
checks it — possibly on a different model — and a fourth gives the final say. The owner
chooses, per stage, the **role**, the **agent** and the **model or effort level**. Those
choices can be saved as a **template** and reused. And a whole pipeline should be able to run
mostly by itself, including overnight, without the owner relaying messages.

### A.2 What this design does, in one paragraph

A pipeline is a short ordered list of stages. **Each stage is an ordinary Control Room task**
with one extra field saying which stage of the pipeline it is. Control Room already knows how
to create tasks, assign them to workers, take results back, review those results and request
a revision. This design does not add a second version of any of that. It adds: a marker on
the task that says "you are stage 3", a rule that stage 3 only starts once stage 2 has a
retained result, a rule that the stage which finds problems sends the work back to the
builder with those findings, and a counter that stops the loop and asks the owner. Saving a
pipeline as a template saves the *shape* — role, agent, model class, loop limit — never the
permission. When the owner runs a template, it creates ordinary tasks, and everything
downstream behaves exactly as it does today.

One part of that is genuinely new work rather than plumbing, and the owner should know which:
letting an **agent** be the reviewer. Today the database refuses any review that is not the
owner's, and the identity needed to prove two agents are different does not exist yet. The
build plan puts that in its own slice with an independent security reviewer, because it is
the only slice that adds a new write path to a security table.

### A.3 The one thing to understand about authority

An agent saying "this is good" is a **quality review**. It is not permission to publish,
install, spend money, change production, or send anything outward. Those need the owner's
separate, current approval, and the approval key that produces that proof **does not exist
yet** in this codebase (`CR5C_FINAL_SECURITY_CONTRACT.md` §7: "Until the CR-8 approval flow
can produce this attestation, approval-required external effects remain disabled"). So every
pipeline in this design ends at owner acceptance for anything consequential. A setting for
"low-risk work may accept itself" is specified as a *stored preference that is not yet
enforced*, and the interface says so out loud. It is not shipped as a working feature.

### A.4 The one thing to understand about checking

A stage may never check its own work, and — as the default — should not check the work using
the same model that produced it. "The Hermes worker switches to an OpenAI model for checks"
is exactly this rule: the checker is a different agent, and by default a different model
family.

**But this machinery is not finished.** The Completion Gate has the *policy* shape
(`CompletionAcceptanceProfileV1.reviewerSeparation`, with separate flags for `actor`,
`worker`, `agentProfile`, `harness` and `modelFamily`) and the *store* enforces it — a
non-independent reviewer is refused with `reviewer_not_independent`. Two gaps block an agent
from being a reviewer today, and this design does not pretend otherwise:

1. **No role currently granted may write it.** The exclusion is a property of the *grant set*,
   not a table-level prohibition. Three role-scoped guards fire on
   `control_completion_gate_records` inserts and each admits a different shape:
   the private-web guard (`db/migrations/0043_cr14c_owner_result_review.sql:31-50`,
   re-`CREATE OR REPLACE`d by `0053` and `0086`) admits only `review`/`finding` with a
   **human** reviewer; the task-coordinator guard
   (`db/migrations/0054_cr14c_quality_coordinator.sql:11-23`) admits only `verification` by
   the fixed service verifier; the native-results guard
   (`db/migrations/0055_cr14c_native_result_writer.sql:6-32`) admits only `target` and
   `revision`. Two non-web roles already hold `INSERT` on this table
   (`db/roles/native_results_roles.sql:28`, `db/roles/task_coordinator_roles.sql:57`) and
   neither may write a `review`. So building agent-as-reviewer means **adding a third role
   plus a fourth guard**, modelled on `0055`'s plan-join shape. There is already precedent for
   a non-web role writing here, which is precisely why it needs a security review.
2. **The identity to compare does not exist yet.** `modelFamily` appears in the types and in
   the independence check but **has no derivation anywhere in `src/`**, and the producing
   principal recorded by the existing native result writer is only
   `{actorType, actorId: nodeId}` (`db/migrations/0055_cr14c_native_result_writer.sql:23`) —
   no worker, agent profile, harness or model family to compare against.

So building "a stage can check another stage" requires **new security work**: a restricted
database role that may write agent-authored reviews under a server-created plan, and a
server-side derivation of each agent's identity and model family. Slice 3 below is scoped as
exactly that, and it is the highest-risk slice in the plan.

### A.5 What happens when the checker is not happy

The checker writes findings, Control Room creates a **new task** for the builder carrying
those findings, and the loop counter goes up by one. The original attempt is kept — nothing is
overwritten (`RES-004`). After N rounds the pipeline **stops and asks the owner**, showing
every attempt and every finding side by side. It does not keep going, and it does not decide
the work is fine. A pipeline that has tried N times and still fails is a disagreement, and a
disagreement is something a person should see.

### A.6 What a hand-off is, and is not

Stage 3 does not receive stage 2's transcript. It receives a small, bounded packet: a
reference to the retained result and its digest, a short summary stage 2 declared, the
findings if stage 2 was a checker, and pointers to protected files. It never receives the
owner's original instructions, the agent's internal reasoning, environment details or any
credential. The same rules already apply to ordinary results (`RES-002`, `SEC-007`).

### A.7 What "runs by itself overnight" honestly means

It means Control Room advances from one stage to the next using ordinary, already-authorized
task and assignment services, under an explicit project policy, within a ceiling the owner
set, and it stops and asks when anything is outside that ceiling, uncertain, repeated, or
consequential. It never means an agent can approve itself, expand its own scope, or keep
spending after a limit is reached.

---

## Part B — The design in detail

### B.1 Concepts and how each maps to an existing record

This is the core of the design: **no new system**. Each pipeline concept is a small
annotation on something that already exists.

| Pipeline concept | Existing record it maps to | What is new |
| --- | --- | --- |
| **Pipeline** | one `control_workflows` row (`WorkflowRecord`) plus a `pipeline_runs` header row | a run header that points at the workflow and records the template it came from |
| **Stage** | one `control_jobs` row (`JobRecord`) | nullable `stage_kind`, `stage_ordinal`, `pipeline_run_id` columns on the task |
| **Stage run** | one `control_attempts` row (`AttemptRecord`) | nothing — attempts already exist per job |
| **Lease / ownership** | one `control_leases` row (`LeaseRecord`) | nothing — leases already carry job, attempt, node, epoch, expiry |
| **Stage result** | the existing retained result / artifact receipt bound to the attempt | nothing — `RES-001` already binds results to project, task and attempt |
| **Review** | `CompletionReviewV1` + `CompletionFindingV1` + the target | nothing — the Completion Gate already stores all of it, **but** see A.4: an agent-authored review needs a new role and a new identity |
| **Hand-off** | the previous stage's retained result id + digest, carried in the next task's input | a bounded hand-off envelope with a fixed schema |
| **Loop** | the existing revision cycle (`nativeRevisionContext`, `CompletionRevisionV1`, the owner's revision command) | a pipeline `max_loops`, derived from the gate's `revisionNumber` — never a second counter |
| **Sign-off** | a `CompletionReviewV1` with `authority: "completion_gate"` and `decision: "accepted"` | nothing — this is exactly what the Completion Gate already records |
| **Template** | **new table** `pipeline_templates` | the only genuinely new persisted concept |

**Reuse, concretely.** `JobRecord` already carries `workflowId`, `dependsOnJobIds`,
`state`, `authority` (an `AuthorityEnvelope`) and `requiredCapability`.
`control_job_dependencies` already stores stage-to-stage edges. The
`task-execution-planner.ts` `Plan` family already handles the initial plan (`v1`) and the
revision plan (`v2`) cases. The Completion Gate already produces the exact set of states a
pipeline view needs, including `revision_limit_reached` and
`requiresSeparateApproval: true`. A pipeline stage is a task; a pipeline run is a workflow
with a header.

**What this design explicitly does not create:** a second queue (pg-boss is the scheduler,
`ARCHITECTURE.md`), a second database (DATA-001), a second review path (the Completion Gate
is it), a second approval path (`SEC-006`, CR5C §7), a second results channel
(`CONN-008` — an agent's own messaging is not a result), or a second authority plane
(`ACR-004`).

### B.2 Stage kinds

Five kinds. Only `plan` is new machinery; the other four are existing behaviours wearing a
different name.

```
stageKind:
  "plan"    →  a bounded planning turn; its result is a proposal for the orchestrator path
  "build"   →  ordinary work: assignment, lease, attempt, retained result
  "check"   →  independent quality review; writes CompletionReviewV1 + findings
  "signoff" →  the final quality review; writes an accepted CompletionReviewV1
  "effect"  →  a consequential effect; ALWAYS terminates at owner approval
```

`build` is the default and is the only kind that writes a workspace. `plan`, `check` and
`signoff` are read-only; `check` and `signoff` are the only kinds permitted to produce
findings. `effect` exists so that a template can name the consequential step explicitly rather
than hiding it inside a build stage's free text — and it is the kind that can never
self-approve. This classification is what the parallel-admission rule in B.7 keys off, so it
is stated in exactly one place.

### B.3 Authority — the hard rules

**Rule 1. Sign-off is a quality review, never effect approval.**
A `signoff` stage writes `CompletionReviewV1`. That record has `grantsApproval: false` and
`grantsExecutionAuthority: false` as literal type fields (`src/completion-gate/v1/types.ts:73`).
The Completion Gate view model already renders this honestly: the `ready` status reads
"Quality review complete" with detail "This is not approval to perform an external action"
(`src/completion-gate/v1/view-model.ts:63`). A pipeline that reaches `signoff: accepted` has
completed quality review. It has authorized nothing. The next line is still a separate owner
approval, and that approval needs `OwnerApprovalAttestationV1` signed by a key in
`ApprovalTrustStore` — an interface that exists (`src/node-policy/v1/stores.ts:42`) but whose
issuing flow (CR-8) is not complete, so **approval-required external effects remain disabled**
(CR5C §7, "Until the CR-8 approval flow can produce this attestation, approval-required
external effects remain disabled. AI pre-review may comment but cannot issue this
attestation").

**Rule 2. No stage reviews or approves its own output — but this needs new work to exist.**
`CompletionGateStoreV1.assertIndependent` walks the axes enabled in the acceptance profile
and throws `reviewer_not_independent` when producer and reviewer match on any enabled axis
(`src/completion-gate/v1/store.ts:426-430`). Three tiers:

| Tier | Rule | Status |
| --- | --- | --- |
| Absolute | the producing worker, agent profile and harness identity must differ from the reviewer's | **blocked on slice 3** — the policy exists, the data does not |
| Default in templates | the check stage uses a **different model family** from the build stage | **blocked on slice 3** — no derivation exists — see below |
| Advisory | if the owner pins every stage to one family, the pipeline still runs and the UI shows "review independence: same family" | presentation only, and explicitly a *narrowing* recorded per ADR-044, not a way to switch the rule off |

**All three tiers are blocked on slice 3.** The tiers describe what the policy shape already
permits, not what the product can do today.

Three verified gaps, all confirmed in this repository:

1. **No granted role may write a review.** Three role-scoped guards admit a different shape
   each: the private-web guard (`db/migrations/0043_cr14c_owner_result_review.sql:31-50`)
   admits only `review`/`finding` with a human reviewer — the only writer of a `review` is the
   owner's browser path, which hardcodes `actorType: "human"`
   (`src/web/v1/task-review-service.ts:174`); the task-coordinator guard
   (`db/migrations/0054_cr14c_quality_coordinator.sql:11-23`) admits only a fixed service
   `verification`; the native-results guard
   (`db/migrations/0055_cr14c_native_result_writer.sql:6-32`) admits only `target`/`revision`.
   Two non-web roles already hold `INSERT` on the table and neither may write a `review`
   (`db/roles/native_results_roles.sql:28`, `db/roles/task_coordinator_roles.sql:57`).
   Building agent-as-reviewer means **a third role and a fourth guard**, admitting a review
   bound to a server-created review plan. That is **new security surface** on a table that
   already accepts writes from two non-web roles.
2. **The producer identity is one field.** The native result writer pins a target's producer
   to exactly `{actorType: 'agent', actorId: <nodeId>}`
   (`db/migrations/0055_cr14c_native_result_writer.sql:23`). `workerId`, `agentProfileId`,
   `harness` and `modelFamily` are `undefined` on both sides, and `assertIndependent` refuses
   when a field is not a string. With those axes enabled, **every** review is refused —
   including a genuinely independent one.
3. **`modelFamily` has no derivation.** It is a type field and a comparison
   (`src/completion-gate/v1/types.ts:12`, `src/completion-gate/v1/store.ts:428`) and nothing
   else. The only
   production profile sets the axis `false`
   (`src/web/v1/mac-local-owner-review-profile.ts:22`), and the owner-trusted enablement
   record has no model field at all
   (`src/harness/v1/owner-trusted-local-enablements.ts:13-24`).

Consequence for the design: a check stage is **not** a stage that already exists. Slice 3
carries all three gaps — a model-family classifier in the owner-trusted enablement path, a
producer principal that carries the real agent identity, and the restricted reviewer role —
and its acceptance tests must distinguish "producer and reviewer are the same on this axis"
from "this axis has no recorded value", because the store treats them identically today.

**Rule 3. The owner's acceptance remains the gate for consequential work.**
Per `RES-005` and `SEC-006`. The owner asked for a project setting that allows auto-accept for
low-risk work. **There is no existing record to store that setting in**, and this design does
not pretend otherwise:

- The nearest field, `CompletionAcceptanceProfileV1.automaticLowRiskDisposition`, belongs to an
  *acceptance profile*, not a project, and is pinned to `false` by the only profile the web
  role may register (`db/migrations/0086_mac_local_owner_review_profile.sql:59`, asserted in
  `src/web/v1/mac-local-owner-review-profile.ts:24`).
- `CompletionPreferenceV1` carries `grantsApproval: false` and
  `grantsExecutionAuthority: false` as **literal type fields**
  (`src/completion-gate/v1/types.ts:141-142`), so a preference is structurally incapable of
  becoming acceptance authority. That is ADR-041 holding: "No record implicitly grants the
  function of another."
- Most importantly, *enforcing* it means issuing an approval attestation, and the node
  requires that attestation to be signed by a key in `ApprovalTrustStore`, distinct from
  ordinary server signing keys (CR5C §7). An online server assertion is explicitly
  insufficient.

Decision: auto-accept is specified as **nothing at all** — no column, no table, no UI
control, no stored preference. B.11 does not carry `auto_accept_*` columns, because a stored
flag that cannot be enforced is a lie the interface would have to apologise for later. It is
listed as a blocked feature in B.12, and decision 8 of B.13 records it as a setting whose
public default is *off and not implemented*, with a build-priority choice rather than a
value. This is the honest version: the product says "no", rather than shipping a switch that
does nothing.

**Rule 4. No stage widens authority.**
Stage authority is an `AuthorityEnvelope` exactly like any other job's. The lease carries it
in full and the node computes a strict intersection with the owner-signed ceiling; the lowest
maximum wins; an empty intersection denies (CR5C §2). A pipeline cannot request a wider
envelope than the template's recorded stage, and a template cannot request a wider envelope
than the project policy.

**Rule 5. The template is not permission.**
Saving a template records intent. Running one creates ordinary tasks whose authority is
derived from the current owner grants and the project policy at that moment. A revoked policy
takes effect on the next stage, not retroactively.

### B.4 Hand-off — bounded, with provenance, no raw prompts or secrets

When stage N's result is retained and the gate allows stage N+1 to start, Control Room builds
a **hand-off envelope**. It is schema-strict, size-bounded, and secret-scanned before storage.

```
StageHandoffV1 {
  schema: "control-room.stage-handoff/v1"
  tenantId, projectId
  pipelineRunId, fromStageOrdinal, toStageOrdinal
  fromJobId, fromAttemptId, fromResultDigest      // provenance
  summary: string (≤ 2000 chars, secret-scanned)  // NEW, declared by the producing stage
  findings: [{ code, severity, statementDigest, evidenceDigests[] }]  // digests, not prose
  artifacts: [{ artifactId, contentDigest, logicalRole }]              // ids and digests only
  usage: { inputTokens, outputTokens, totalTokens, costUsd } | "unknown"
  producedAt
  totalBytes ≤ 65_536
}
```

Two deliberate corrections against a naive reading:

- **Findings travel as digests, not statements.** `CompletionFindingV1` stores
  `statementDigest` and never the statement (`src/completion-gate/v1/types.ts:105`); the read
  model admits a statement only as `safeText` — 280 characters, single-line, with an explicit
  secret pattern (`src/completion-gate/v1/view-model.ts:10-11,29`), and only when the
  `findingStatementsLoaded` coverage flag says they were loaded. Forwarding unbounded
  agent-authored prose between stages would re-introduce exactly what the gate reduced to a
  digest. Stage N+1 receives the digests; if it needs the text, it goes through the same
  bounded, secret-checked read the owner uses.
- **`summary` is new, not reused.** Nothing in the current code carries a producer-declared
  cross-stage summary. It is a new bounded field, capped at 2,000 characters and secret-scanned
  by `assertNoSecretMaterial` before storage, exactly as the Completion Gate does for its view
  input (`src/completion-gate/v1/view-model.ts:85`).

**Bounded** means four bounds: the existing 65,536-byte artifact ceiling
(`src/node-executor/artifact-storage.ts:91,186,230`), the existing result `sizeBytes` and
result-text bounds (`src/web/v1/task-result-wire.ts:34,59`), the envelope's per-field caps,
and a new **total-bytes ceiling of 65,536** on the envelope itself. Nothing is truncated
silently — an over-limit envelope fails safely and leaves the canonical task intact
(`RES-002`).

**What is deliberately absent**, and why:

- the owner's original instructions — they stay with the originating task and are not
  forwarded. A later stage gets the summary, not the original request. This keeps
  instruction injection from one stage's output into another's context, and keeps the owner's
  words from being laundered through a chain of agents.
- the producing stage's prompt, the harness transcript, tool arguments, or reasoning;
- environment variables, file system paths, and any credential or secret-shaped value —
  `assertNoSecretMaterial` runs before the envelope is stored, exactly as it does for the
  Completion Gate (`src/completion-gate/v1/view-model.ts:85`);
- a model, provider or endpoint chosen by the producing stage. Stage N+1's model comes from
  its own stage definition in the template.

Provenance is exact: the envelope binds `(pipelineRunId, stageOrdinal, jobId, attemptId,
resultDigest)`. A result that arrives for the wrong attempt, the wrong project or a stale
digest is refused, which is `RES-001` behaviour applied at the stage boundary.

### B.5 Loops — check fails, work goes back, and the limit is a stop

The loop is the existing revision cycle, with two new bounds.

1. A `check` stage completes and writes a `CompletionReviewV1` with
   `decision: "changes_requested"` plus one or more `CompletionFindingV1`.
2. The snapshot status becomes `changes_requested`
   (`src/completion-gate/v1/store.ts:331`).
3. Control Room creates a **new task** for the build stage carrying
   `taskRevisionRequestSchema`-shaped context (which already binds `runId`, `targetId`,
   `targetDigest`, `contentHash`, `reviewId` and the feedback text) plus the hand-off
   envelope. This satisfies `RES-004`: a revision is an explicit related work item, not a
   silent rerun of the accepted attempt.
4. The loop counter is **not** an independent authority. `recordRevision` refuses
   `revision.revisionNumber > profile.maximumRevisionRounds`
   (`src/completion-gate/v1/store.ts:235`) and
   `snapshotWith` sets `revision_limit_reached` when open findings exist at that ceiling
   (`src/completion-gate/v1/store.ts:330`). The **gate's** `revisionNumber` is the single
   source of truth for how many
   rounds have happened. A pipeline-level `max_loops` is only the value the acceptance profile
   was *provisioned* with when the target was created — it can be lower, never higher. If the
   two ever disagree, the gate wins and the run stops; the pipeline counter is presentation and
   is derived from the gate, not stored as a second truth.
5. A revision is a **server-side** record, not a browser command. `taskRevisionRequestSchema`
   (`src/web/v1/task-revision-wire.ts:6`) is the `.strict()` owner command that may *trigger* a
   revision, parsed from a bounded body; it is not a task payload and it does not describe a
   new task. The payload for a loop-back is a new server-built revision context of the
   `nativeRevisionContextSchema` family (`src/completion-gate/v1/native-revision-context.ts`),
   carrying the new job id, the hand-off envelope id and the feedback digest.

**At the limit.** The pipeline does not retry, does not escalate to a larger model, does not
switch agents, does not auto-pass and does not self-accept. It:

- sets the stage run to `awaiting_owner` and surfaces the run on the project's Coordination
  page and the global Needs-attention surface;
- shows every attempt in order with its findings, the producing agent and model per attempt,
  and which findings were raised when;
- offers exactly three owner actions, and the first is honest about its cost:

  1. **Raise the limit.** This is *not* a field edit. `CompletionReviewTargetV1` binds
     `acceptanceProfileDigest`, which is re-checked on every review and revision
     (`src/completion-gate/v1/store.ts:420,423`) and a re-insert of the same profile id with a
     different digest is refused with `record_conflict`
     (`src/completion-gate/v1/store.ts:355-357`). `registerProfile` only ever inserts
     (`src/completion-gate/v1/store.ts:178-181`), and the only profile the web
     role may register is pinned to `maximumRevisionRounds: 3`
     (`db/migrations/0086_mac_local_owner_review_profile.sql:58`). So raising the limit means
     **provisioning a new acceptance profile with a higher `maximumRevisionRounds`, which
     invalidates every existing target, review and revision bound to the old profile** — the
     stage's review lineage is discarded and must restart.
     The UI must say exactly that before the owner clicks. Offering a button labelled "raise
     the limit" that silently resets the review chain would be worse than not offering it.
  2. **Accept anyway.** Records an owner review. Still not an effect approval.
  3. **Stop the pipeline.** All stages and attempts retained; nothing is discarded.

The reason for stopping rather than escalating: choosing a bigger model or a different agent
at the limit is a policy decision about cost and trust, and the vision requires the owner's
final policy choice on model and effort (`WORK-014`). An agent making that choice for the
owner would be the failure mode, not the fix. ADR-042 records the same trade-off: "Some
salvageable work pauses for human direction after the revision budget is exhausted."

### B.6 Model and agent per stage

**The dependency is real and it is not yet met.** `docs/claude/W8_MODEL_SELECTION.md` is
**Status: queued**, "Do not start until W7 is done". Its decisions are adopted here wholesale:

- The allowlist lives in the **owner-trusted enablement record**, per `nodeId`, validated
  against the installed CLI at startup. It never comes from the browser and never lives in the
  task. (W8 item 1)
- A stage's `model` and `effort` are validated against **that assigned worker's** allowlist.
  Anything off the list is rejected with 400 and **nothing starts** (W8 items 2 and
  "Done when").
- Missing values fall back to that worker's default (W8 item 2).
- The choice is recorded on the task/run record and displayed on the task and result pages;
  a result without its model is incomplete (W8 item 3).
- Invocation maps the choice to fixed argument arrays — Claude `--model <m>`, Codex
  `-m <m>` and `-c model_reasoning_effort=<e>`, Hermes the profile's provider and model.
  **Never string concatenation** (W8 item 4).
- A revision **inherits the original stage's model and effort** unless the owner changes them
  (W8 item 6). This matters for pipelines: a loop-back must not silently change models.
- An expensive choice carries a one-line cost note in the form (W8 item 5). "uses more of
  your Claude limit".

**Hermes switching providers per stage — this is new, not reused.** The owner-trusted
enablement record is **closed**: each worker is exactly
`{workerId, kind, executablePath, recordedVersion}` and the capture refuses any key outside
that set (`src/harness/v1/owner-trusted-local-enablements.ts:13-24,39-47`). There is **no**
`profileRef`, no per-worker model list, and no provider field anywhere in it today. W8's own
example is a model list per worker (`docs/claude/W8_MODEL_SELECTION.md` item 1), which is
enablement work in its own right.

So a stage's per-worker selection is specified as
`{ workerId, model, effort }` against **W8's allowlist**, and per-provider switching is
explicitly **out of scope until the enablement record is extended**. The pipeline stores a
worker id and an allowlisted model — never a credential, never a key, never a raw provider
secret. If the named model is not on that worker's allowlist, the stage does not start and the
pipeline asks the owner. Per `CONN-006` no provider credential is ever copied between
machines or into the database. Decision 12 of B.13 records this as a setting whose public
default is the worker's own default profile; the enablement record extension it needs is
delivered on the base branch, and extending it further is reviewed as a security change
rather than smuggled in here.

**Model *class* in templates.** A template may pin a class rather than a specific model —
"a reasoning-capable model in family X at high effort" — because the assigned worker may not
be the one that ran the template last time. Resolution happens at instantiation, against that
worker's allowlist. If no allowlisted model satisfies the class, **the pipeline stops and asks
the owner**. It never silently substitutes, because a silent substitution changes cost and
quality without telling anyone, which is precisely the "unknown presented as known" failure the
product principles forbid.

**Sequencing note.** Because W8 is queued, the build plan below puts the allowlist-*validation*
half of W8 in slice 2 and per-stage model selection in slice 4, after W8 lands. Slices 1 and 3
need only the role and agent identity, which already exist.

### B.7 Concurrency, collisions and leases

**Default is serial.** A pipeline advances one stage at a time. That is not a limitation to
work around; it is the correct default, because it means two workers can never unknowingly
edit the same thing. `WORK-008` already requires that ownership, lease, scope and expiry are
represented and visible so two workers do not unknowingly edit the same protected area, and
`WORK-009` already requires a hand-off to be visible before the package is claimable again.

**What is reused.**

- `control_leases` already carries `(job, attempt, node, epoch, state, acquiredAt, expiresAt,
  renewedAt)` and already has a partial unique index guaranteeing one active lease per job:
  `uq_control_leases_one_active_job`. Ownership and expiry are already visible and
  reclaimable.
- `ProjectWorkAdmissionServiceV1` (`src/project-coordination/v1/services.ts:347`) is the one
  shared admission path. Manual, scheduled and news callers all reach it, which is how
  `PROJECT_COORDINATION_DECISION.md` requires conflict admission to be enforced — "through
  the common manual and scheduled assignment/start routes, not just a project panel".
- Shared resource identity is **server-resolved and tenant-scoped**, so two projects using the
  same repository cannot evade conflict detection by aliasing it.
- Locks are taken on stable repository/resource keys in **deterministic order** before
  checking for absent holders. No in-memory-only lock service, no second scheduler.

**When parallel stages are allowed.** A pipeline may declare two stages parallel only when all
of the following hold, and the pipeline is refused otherwise:

1. Both stages declare disjoint write scopes, or both are read-only.
2. The owner has an approved parallel-writer policy in force. This is the existing
   `work.admit.parallel-narrow-write` policy action
   (`src/project-coordination/v1/parallel-write.ts:20`).
3. The enforced workspace is resolved through the trusted `EnforcedWorkspacePortV1` port, not
   asserted by the request. A service composed without that port can never admit a narrow
   writer: `admit` returns `resource_workspace_unverified`
   (`src/project-coordination/v1/parallel-write.ts:72-74`).
4. The scope declarations are compared segment-wise, case-insensitively, under the existing
   grammar: repository-relative slash-separated segments, at most 512 characters, and at most
   **96 declared scopes** across all resources
   (`src/contracts/v1/project-coordination-boundaries.ts:24,120`). There is no separate
   logical-resource count bound today — `control_work_resources` is keyed
   `(tenant_id, comparison_key)` with no per-project cap
   (`db/migrations/0076_project_work_resource_admission.sql:10-26`), so the pipeline does not
   invent one. Absolute paths, dot segments, globs and percent escapes are refused.
5. The stages hold separate workspaces, verified before integration.

**A template cannot grant itself this permission.** Parallelism is a project policy the owner
sets in the same place as the rest of owner policy. A template that asks for parallel writers
without that policy is refused at instantiation with
`resource_disjoint_write_not_permitted`, and the pipeline serialises instead of failing —
serialising is always safe, running both is not.

**Read-only stages** (`plan`, `check`, `signoff`) may run concurrently with each other, since
they declare no write scopes. They may not run concurrently with a `build` stage holding a
shared resource in the same repository. Same-repository writers serialise by default
(`PROJECT_COORDINATION_DECISION.md`: "Same-repository writers serialize by default").
Workspace isolation is for edits, not a security sandbox, and a result is never merged into a
shared repository automatically — integration is an ordinary reviewed task, serialised per
repository.

### B.8 Failure and recovery — never duplicate work

A pipeline run is a durable state machine keyed by `(pipelineRunId, stageOrdinal)`. A stage
attempt is created **only** from a committed state transition under a lock. There is no path
from a read, a page load, a retry, or a timer that creates an attempt.

| Situation | What Control Room does | What it never does |
| --- | --- | --- |
| Server crash mid-pipeline | On restart, re-read committed state and resume from the first stage whose successor transition has not committed. In-flight stages are reconciled, not re-dispatched. | Re-dispatch a stage that may have started |
| Dispatch reply lost | Read-only reconciliation finds the recorded command and the attempt. The reply is regenerated from records. | Send the command again (ADR-022: an exact repeated frame is a duplicate; altered content under the same identity is a replay conflict) |
| Worker offline mid-stage | Lease expires; the stored attempt state becomes `orphaned` (`AttemptState`, `src/domain/v1/types.ts:8`); the stage is *projected* as `uncertain` in the UI and stops. Existing trusted recovery must establish that no live attempt remains before anything is released. | Assume a disconnect means the process stopped |
| Owner closes the browser tab | Nothing. The tab was never an authority. | Cancel the pipeline or the work |
| Result arrives for a stale attempt, wrong project or wrong worker | Refused with the existing scope/identity checks. | Accept it as the current stage result |
| Effect outcome ambiguous | Stops the pipeline. Ambiguity resolves only from destination evidence or an explicit human decision recorded as a new authorized action. | Auto-retry the effect |
| Check fails repeatedly | Loop counter; at the limit, `awaiting_owner`. | Escalate, auto-pass, or self-accept |
| Template deleted mid-run | The run continues; it references the template version it started with. | Break an in-flight pipeline |

`RetryPolicy` already carries `retryAfterOrphan` and `ambiguousEffectPolicy: "attention"`, and
the product's rule is the vision's principle 8: "Safe recovery beats blind retry." A pipeline
that resumes and re-runs stage 2 because it lost confidence would be worse than a pipeline that
stops and says "I am not sure what happened" — because the owner would have no way to tell
the difference.

**Overnight specifically.** An unattended run is bounded by the authority expiry on each
stage's envelope. When it passes, no new stage may start. The effective deadline is the
earliest of ceiling duration, authority expiry, lease expiry, approval expiry and any
executor reservation (CR5C §5). A run that reaches its deadline stops at a stage boundary with
a truthful state, not mid-effect. Long stages must renew before that deadline or stop
starting effects; a renewal after expiry cannot resurrect an attempt and requires a new
attempt identity.

### B.9 The project lead / orchestrator as an optional stage type

**This is already built.** Issue #167 is closed (2026-09-17) and merged through PRs #171, #174,
#190 and #311. `src/project-coordination/v1/` provides `ProjectCoordinatorServiceV1`
(appoint / replace / revoke, delegation policy pause / resume / revoke),
`ProjectCoordinationProposalServiceV1` (ingest verified results),
`ProjectCoordinationAdoptionServiceV1` (owner-reviewed **or** bounded-policy adoption) and
`ProjectWorkAdmissionServiceV1` (the one shared admission path). `docs/PROJECT_COORDINATION_DECISION.md`
remains the architecture authority. The owner-facing surface is already at
`/projects/<id>/coordination`.

So a `plan` stage does not design an orchestrator. It:

1. runs as an ordinary assigned task on the coordinator's bound executor/adapter, and
   **carries a server-created planning marker** —
   `projectCoordinatorPlanningMarkerSchemaV1` is "server-created proof that one exact
   canonical job was explicitly requested to produce a coordination proposal"
   (`src/contracts/v1/project-coordination-boundaries.ts:52-63`). **A result without that
   marker is an ordinary task result and is never parsed as a plan.** A `plan` stage whose
   marker is missing therefore produces an inert result: the pipeline treats this as
   `uncertain` and asks the owner, it does not report "the planner failed" and it does not
   retry the stage;
2. returns a **strict** `projectCoordinationProposalSchemaV1` through the existing
   authenticated result path — `tasks` (1–32) and `edges` (≤64), no cycles, no dangling edges,
   no duplicate local ids. The schema `.strict()` means an agent **cannot** add an authority,
   credential, endpoint, callback, effect, risk, cost or identity field, and cannot name its own
   coordinator version or an owner;
3. is ingested as a proposal with a recorded accept/reject — rejections are stored visibly,
   not swallowed;
4. is adopted **only** through `authorization.kind: "owner"` or `authorization.kind: "policy"`,
   both already in `coordinationOperationRequestSchemaV1`. Routes and cost are resolved
   server-side; agent content never selects an executor, and missing cost evidence is
   `unknown`, which no ceiling can admit;
5. creates ordinary proposed tasks — the same canonical task ids any other work gets — and
   the pipeline's build stage simply waits for those tasks to exist.

**What the pipeline adds:** a stage record saying "planning stage, bound to coordinator
version N", and sequential gating. **What it must not add:** a second coordinator, a second
adoption path, a synthesised delegation policy, or any reading of agent prose as intent.
`WebSessionAuthority` stays human-only; a node signature does not identify every agent on
that node; attribution uses the exact assigned run and the existing connector/worker binding.

A revoked or replaced coordinator's earlier proposal stays in history and cannot trigger new
adoption under the former binding.

### B.10 UI

**Where it lives.** A new **Pipelines** page inside each project, alongside the existing
sections. The current navigation is
`private-app/app/project-navigation.tsx`: Overview, Inbox, Work, Agents, Automations, Files,
Reviews, Activity, Coordination, (News), Settings. In the hosted layout Pipelines sits
directly **after Work** — it is a way of organising work, and a run is a list of tasks — and
before the review-oriented sections.

Two conditions on that placement. First, `ProjectPage` gains a `pipelines` member and the
link is gated the way News already is, through `useProductModule` and
`presentation.availableModules` (`private-app/app/project-navigation.tsx:15-16`) — a static
array entry would break the rule that an unavailable section is never shown. (Idea Lab is not
the precedent here: it is a top-level module at `/ideas`, not a project-nav section.) Second,
in the non-hosted local mode the navigation collapses to a single Work link
(`private-app/app/project-navigation.tsx:22`), so Pipelines has no host there until that layout
gains a second entry; until then it is reachable only from Work, and the section is marked
unavailable rather than advertised (`WEB-010`).

**The pipeline view.** One row per stage, in order, always showing:

- ordinal and stage kind, with the role name the owner chose (`plan`, `build`, `check`,
  `signoff`, `effect`);
- the agent, the harness, and the model/effort **as recorded on the run** — never inferred
  from a recommendation;
- state in the product's honest vocabulary, mapped from the existing job/attempt/Completion
  Gate states rather than invented;
- elapsed time and, where the source truthfully provides it, usage. **Unknown usage shows
  "unknown", never zero** (principle 6, `OPS-014`). `TaskRun.usage` already models this
  honestly with nullable token counts and `hardCostLimitEnforced: false`
  (`src/web/v1/task-wire.ts:51`).
- the round, read from the Completion Gate's `revisionNumber`, and the remaining budget:
  "round 2 of 3". Not a stored pipeline counter.
- review independence: independent agent / independent model family / **same family** (a
  visible warning, not a hidden degradation).
- provenance: the previous stage's result digest, so the owner can see the chain is intact.

**Disagreements stay visible.** A run where the checker rejected and the builder disagreed
shows both, with all attempts listed. The pipeline view never synthesises a single verdict
and never erases a dissent — the same rule the Idea Lab applies to contributions
(IDEA-002). Where a check stage raised findings that the owner considers wrong, the findings
stay on the record; the owner's counter-review is an additional review, not an edit.

**The template editor.** A left-to-right stage list. Per stage: role, agent selection from
eligible registered workers (by capability and platform, never hardcoded personal names —
`WORK-011`), model class, effort, loop limit, write-scope declaration, and a plain-English
description of what this stage is for. Top-level: `maxStages`, `maxTotalLoops`, whether the
run may advance unattended, and the maximum overall duration.

Every editable control has a visible boundary next to it:

- model class → "resolved against the assigned worker's allowlist at run time";
- parallel stage → "requires an owner-approved parallel-writer policy in this project";
- unattended advance → "stops and asks when work is uncertain, repeated or consequential";
- auto-accept → "requested but not enforced: the owner approval key is not available".

**Also needed.** On the Home page, a pipeline run appears under running work with its current
stage, and under Needs attention when a stage is `awaiting_owner`, `uncertain`, blocked, or
over its loop limit. Closing the browser tab changes nothing (`PROJ-006`).

**Honest states.** Loading, empty, denied, missing, offline, error and uncertain each get
plain-English text and a safe next action. A read-only re-check looks different from a
retry that could execute work (`WEB-003`, `WEB-008`). At 360px the stage list scrolls
vertically, never page-wide horizontally (`WEB-005`).

### B.11 Data model — sketch level

**New tables (3).** Naming follows the `control_` prefix convention. All are
tenant-scoped, versioned, and carry the same `record_digest` + `auth_tag` integrity pattern
the repository already uses.

```
pipeline_templates
  id, tenant_id, project_id
  name, description
  stages jsonb          -- [{ordinal, stageKind, role, workerSelection, modelClass,
                        --   effort, writeScopes[], maxLoopsForStage}]
  max_stages, max_total_loops, may_advance_unattended, max_duration_seconds
  record_digest, auth_tag, version, created_at, updated_at
  UNIQUE (tenant_id, id)
  -- No foreign key to any authority table. A template grants nothing.
  -- No auto-accept column: see B.3 Rule 3. There is no record that can hold it.

pipeline_runs
  id, tenant_id, project_id
  request_id            -- FK to control_requests; control_workflows.request_id is NOT NULL
  template_id, template_version, template_digest    -- exact version it came from
  workflow_id           -- FK to control_workflows
  title, state, started_at, updated_at, completed_at
  state: proposed | active | paused | succeeded | failed | cancelled
  current_stage_ordinal
  unattended boolean
  record_digest, auth_tag, version
  UNIQUE (tenant_id, id)
  FK (tenant_id, project_id) -> projects

pipeline_stage_runs
  id, tenant_id, project_id
  pipeline_run_id, stage_ordinal
  stage_kind, role, worker_id, model, effort
  model_family  -- server-derived by the slice-3 classifier; never from the browser
  current_job_id, current_attempt_id, current_lease_id   -- nullable "current" pointers
  state, max_loops
  handoff_from_result_digest                            -- provenance chain
  signoff_review_id
  started_at, finished_at
  record_digest, auth_tag, version
  UNIQUE (pipeline_run_id, stage_ordinal)
  FK (tenant_id, project_id, current_job_id) -> control_jobs ON DELETE RESTRICT
  FK (tenant_id, current_attempt_id, current_job_id) -> control_attempts ON DELETE RESTRICT
  FK (tenant_id, pipeline_run_id) -> pipeline_runs ON DELETE RESTRICT
```

Four corrections that matter:

- **A `control_requests` row is required.** `control_workflows.request_id` is `NOT NULL`
  with an FK to `control_requests` (`db/migrations/0003_canonical_domain_delivery.sql:29-41`),
  and `WorkflowRecord.requestId` is required (`src/domain/v1/types.ts:78`). Instantiating a
  template therefore creates **three** canonical rows (request, workflow, pipeline run) plus
  one row per stage. The design does not claim "three new tables and nothing else created".
- **Lineage foreign keys use the existing composite keys**, declared by
  `db/migrations/0007_cr4q_integrity_hardening.sql:141,143`:
  `uq_control_jobs_tenant_id_project (tenant_id, id, project_id)` and
  `uq_control_attempts_tenant_id_job (tenant_id, id, job_id)`. A weaker
  `FK (tenant_id, job_id)` would let a stage row point at an attempt belonging to a different
  job, which `DATA-006` forbids.
- **The loop lives in the attempt chain, not in the stage row.** One build stage spans N jobs
  and N attempts as the loop runs, and a check stage's target is revised by a *different*
  task's attempt. So `pipeline_stage_runs` holds one row per stage with a `current_*` pointer,
  and the full history is the existing `control_attempts` / `control_job_dependencies` /
  `CompletionRevisionV1` chain. `UNIQUE (pipeline_run_id, stage_ordinal, loop_iteration)` — as
  first drafted — had no row to point at and would have forced `attempt_id` to be rewritten,
  which is exactly the overwrite the design forbids.
- **`pipeline_runs.state` reuses `WorkflowRecord`'s vocabulary** verbatim
  (`proposed|active|paused|succeeded|failed|cancelled`,
  `db/migrations/0003_canonical_domain_delivery.sql:33`). `awaiting_owner` is **not** a stored
  run state: it is a projection derived from the current stage's job/attempt/Completion Gate
  state, so no new state vocabulary is invented and the CHECK constraint is inherited.

**Reused, unmodified:** `control_jobs`, `control_attempts`, `control_leases`,
`control_job_dependencies`, `control_effect_intents`, `control_approvals`,
`control_completion_gate_records` (profiles, targets, reviews, verifications, findings,
revisions, preferences, approval requests and decisions), `control_artifact_manifests`,
`control_workflows`, and the whole `src/project-coordination/v1/` admission and adoption path.

**Additive columns on `control_jobs`** (nullable, no rewrite of existing rows):

```
stage_kind        text NULL  -- plan | build | check | signoff | effect
stage_ordinal     integer NULL CHECK (stage_ordinal >= 0)
pipeline_run_id   text NULL
```

A CHECK constraint requires the columns to stand or fall together:
`stage_ordinal IS NULL OR (stage_kind IS NOT NULL AND pipeline_run_id IS NOT NULL)`, so a
partially-populated stage row cannot be claimed by a pipeline. There is deliberately **no**
`loop_iteration` column: the round count is the Completion Gate's `revisionNumber`, derived
(B.5), and a second stored counter would be a second truth that could disagree with the
digest-bound one.

**Migration rules.** New files in `db/migrations/`, numbered after `0090`. Additive only: no
column is dropped, renamed or retyped; no existing row is rewritten. Foreign keys use
`ON DELETE RESTRICT`, matching the rest of the schema, so a run can never be silently
orphaned. CHECK constraints mirror the existing style. The rollback path is a documented
down-migration plus the standard refusal: if any pipeline run exists, the migration refuses
rather than dropping data. Per `OPS-006` the candidate is prepared and verified before
cutover, and per `DATA-001`/`DATA-002` the production rehearsal proves the real
PostgreSQL role ownership — PGlite evidence is not production evidence.

**Instantiation is idempotent** (`DATA-008`). "Run this template" carries an idempotency key
and binds the request digest to the template id, template version, template digest and stage
set. The existing `control_idempotency` table and its column-scoped grants to the web role
(`db/roles/private_web_roles.sql:51-54`) are used unchanged; a double-submit returns the
original run rather than creating a second one, and reusing a key with different template
content is refused. Slice 2's tests must cover both.

**Project lifecycle** (`PROJ-005`). A pipeline run has no archive path of its own; it follows
its project. Because the existing review service already gates on
`project.lifecycle !== "active"` (`src/web/v1/task-review-service.ts:118`), a run in an
archived or closed project **stops advancing and accepts no new stage** — it is retained with
its history, exactly like every other task in that project, and reopening the project makes it
eligible again without rewriting any record.

**Capability fails closed** (`RES-010`). A `check` stage on a harness with no review
capability, or a `plan` stage with no appointed coordinator, or a stage whose model is not on
the worker's allowlist, is **refused and reported as unavailable** — never started on a
fallback, never skipped, never treated as passed.

**Reuse record required** (`ACR-006`). Three new tables and a migration is substantial
custom infrastructure, so slice 1 must land a `REUSE_DECISION_GATE.md` entry naming each
existing record reused and justifying each new one. The decision in this document is the
starting point, not the record itself.

**Product-requirement updates required.** `PROJ-003` enumerates the project sections, and
`PRODUCT_REQUIREMENTS.md` §12 requires that a change to architecture, permissions, data
authority or the MVP journey update the affected requirement and its acceptance evidence. This
design adds a project section and a new review-writer role, so slice 1 must open the
`PRODUCT_REQUIREMENTS.md` changes rather than leave them implicit.

**No new authority store.** No new keys, no new signature, no new queue table, no new
result table. A pipeline row is an annotation, not a capability.

### B.12 Incremental build plan

Five independently shippable slices. Each one has a **no-loop default**: with autonomous stage
advance disabled, a stage produces its result and the run stops at `awaiting_owner`. That is
what makes every slice safe to release on its own and honest to demonstrate.

Reviewer independence applies per the repository convention: no slice is reviewed by the
agent that built it, and security-relevant slices get a fresh independent reviewer on the diff.

---

#### Slice 1 — Pipeline run records and the manual stage view

**Ships:** the three tables, the additive `control_jobs` columns, the migration with its
refusal rule, a read-only pipeline view listing stages in order with agent/model/state/loop
counter/provenance, and a manual "start next stage" action. Autonomous advance does not exist
yet. No execution change of any kind.

- **Automated:** migration applies on disposable PostgreSQL and rolls back; `stage_kind`
  rejects an unknown value; the stand-or-fall CHECK refuses a stage row with `stage_ordinal`
  but no `stage_kind`; a stage run cannot be created without its run; cross-project reads
  refuse; the composite lineage foreign keys refuse a stage row pointing at another job's
  attempt; a run with zero stages is refused; the wire schema is `.strict()` so an extra
  browser field fails; the view renders a stage whose usage is unknown as "unknown", never 0;
  two concurrent "start this stage" requests produce exactly one accepted transition and a
  deterministic refusal for the other (`WORK-005`); a run in a non-active project does not
  advance.
- **Rehearsal:** create a project, save a run with three stage rows against real PostgreSQL,
  restart the service, confirm the view is identical and the run is resumable.
- **Owner live check:** open the project Pipelines page and see the three stages with their
  roles and states, and confirm it appears in project navigation only for projects that have
  pipelines.
- **Likely builder / reviewer:** a Hermes-profile worker / Claude, with an independent
  security reviewer for the migration.

#### Slice 2 — Template editing and instantiation

**Ships:** `pipeline_templates` CRUD in the project, the template editor, and
"run this template" creating **ordinary tasks** through the existing submission path. Still
no autonomous advance. Depends on slice 1 only.

- **Automated:** instantiating a template creates a request, a workflow and a pipeline run
  plus one stage row each, with tasks carrying the existing task identity and
  `startsWork: false` until the ordinary submit action (WORK-002); the same idempotency key
  twice returns the original run and creates no second one, and the same key with different
  template content is refused (`DATA-008`); editing a template does not
  change a run already in flight; a template with a duplicate stage ordinal, a cycle in its
  stage graph, or more than `maxStages` stages is refused; a template naming a worker outside
  the project's eligible capabilities is refused; instantiating a run pins the exact template
  version and digest; a deleted template leaves an in-flight run intact.
- **Rehearsal:** save a template, restart, instantiate, confirm the created tasks match the
  template's roles and that they appear in the normal Work list.
- **Owner live check:** create a template in the browser, run it, and see the created tasks.
- **Likely builder / reviewer:** Codex / Claude.

#### Slice 3 — Agent-as-reviewer: the identity work, the role, and sequential advance

**This is the highest-risk slice in the plan, and it is the one that makes the owner's
example possible.** It carries all three gaps from B.3 rule 2:

- a **model-family classifier** in the owner-trusted enablement path, so a recorded model
  identifier resolves to a family server-side and never from the browser;
- a **producer and reviewer principal that carries the real identity** — `workerId`,
  `agentProfileId`, `harness`, `modelFamily` — replacing the current single-field principal
  that makes every enabled axis refuse;
- a **restricted database role and trigger branch** that admits an agent-authored `review`
  and `finding` bound to a server-created review plan, mirroring the existing
  result-writer pattern (a dedicated role plus a plan-join guard), and refusing any agent
  review that is not bound to one.

It also ships the first automatic transition: when a `build` or `check` stage's result is
retained, the run advances **only** when the Completion Gate snapshot permits it. Depends on
slices 1–2. Still no loops and no per-stage model selection.

- **Automated:** a check stage on the same worker identity is refused with
  `reviewer_not_independent`; the same agent profile, harness and model family are each
  refused when that axis is enabled **and both sides carry a value**; a review whose
  separation axis has no recorded value is refused with a **different** safe code from a
 same-value refusal — the two cases are not allowed to be indistinguishable; **once the new
 role exists**, a direct INSERT of an agent-authored review that is not bound to a
 server-created plan is refused by the database, not only by the service, and a review bound
 to a plan from a different job, run or project is refused;
  advancing from a stage whose result is not yet retained does nothing; advancing from an
  `uncertain` stage is refused; the run never advances past an `waiting_approval` job state;
  a stage that would exceed `maxDuration` is refused rather than started.
- **Rehearsal:** run a two-stage pipeline on the real local stack with a deliberately
  same-family checker and confirm the refusal; then with a different-family checker and
  confirm the advance. Inspect the gate records to confirm both sides carry a real principal.
- **Owner live check:** watch one pipeline advance one stage by itself, with reviewer
  independence shown on the page.
- **Likely builder / reviewer:** Codex / Claude plus an **independent security reviewer** —
  a new write role on the Completion Gate table is exactly the change that needs someone who
  did not write it.

#### Slice 4 — Loops, the limit, and per-stage model/effort

**Ships:** the correction loop, `max_loops` enforcement resolving to the Completion Gate's
`revision_limit_reached` and `revision_invalid`, the `awaiting_owner` stop, and per-stage
model/effort selection. The round count is the gate's `revisionNumber` (B.5); this slice adds
no second counter. **Depends on W8 shipping** — it consumes the allowlist rather than
inventing one.

- **Automated:** a rejected check creates exactly one new revision task with a
  server-built revision context and never mutates the prior attempt; the round count the
  pipeline shows is read from the gate's `revisionNumber` and cannot be set by the pipeline;
  `max_loops` is enforced by the profile's `maximumRevisionRounds` and a forged higher
  `revisionNumber` is refused with `revision_invalid`; a pipeline `max_loops` above the
  profile's ceiling is refused at target creation rather than silently honoured; at the limit
  the run stops, creates nothing, and surfaces to owner attention; the UI states that raising
  the limit provisions a new acceptance profile and restarts the review lineage; a model off
  the assigned worker's allowlist is rejected with 400 and **nothing starts**; a model class
  that no allowlisted model satisfies stops and asks rather than substituting; a loop-back
  inherits the original stage's model and effort.
- **Rehearsal:** run a pipeline whose checker always rejects, on the real stack, and confirm
  it stops at the limit with all attempts visible and no fifth attempt created.
- **Owner live check:** let a failing check loop once, then stop it yourself at the limit and
  raise the limit.
- **Likely builder / reviewer:** Codex / Claude; the allowlist interaction reviewed by whoever
  built W8.

#### Slice 5 — Unattended advance, overnight bounds, and the orchestrator stage

**Ships:** automatic advance within a granted project policy, wall-clock and total-budget
bounds, overnight expiry behaviour, the `plan` stage kind composed with the existing
`src/project-coordination/v1/` services, and the Notifications wiring for
`awaiting_owner`/`uncertain`.

- **Automated:** an unattended run advances only inside the delegation policy's permitted
  action set, eligible workers, risk ceiling, task/cost/concurrency allowances and validity
  window; a revocation, an exhausted allowance or an expiry stops the next stage and does not
  cancel prior committed work; a stage whose authority expires does not start; the run stops at
  a stage boundary on the deadline rather than mid-effect; a `plan` stage's proposal is
  adopted only with `authorization.kind` of `owner` or `policy`; a proposal with a cycle, a
  dangling edge or more than 32 tasks is refused and the refusal is visible; a revoked
  coordinator's earlier proposal cannot trigger new adoption; a policy with unknown cost
  evidence admits nothing.
- **Rehearsal:** an overnight-capable run on the real local stack, stopped by a wall-clock
  bound, with the retained evidence inspected afterwards; and a second run stopped by a
  simulated worker disconnect, confirming no duplicated execution.
- **Owner live check:** start a run, leave it, come back, and confirm every stage is accounted
  for, nothing ran twice, and the attention items are the ones you would expect.
- **Likely builder / reviewer:** Codex / Claude with an independent security reviewer; the
  orchestrator stage reviewed by the maintainer who owns the coordination engine.

**Explicitly not in any slice:** auto-accept enforcement. It is blocked on the owner approval
key (CR-8), and no slice may claim it.

### B.13 Decisions

The thirteen questions this design was opened with are now answered, and every one of the
answers is a **setting**, not code. The public product ships the safe end of each range as
its default and lets an installation choose differently. This section records, for each
decision: the setting it becomes, the scope it is set at, the public default, and the
guardrails that hold no matter what any installation sets.

**The setting scopes, narrowest last.** `install` is the machine-wide default, held in the
private installation configuration and never in this repository. `project` is a project's
written policy. `pipeline` is a saved template. `stage` is one stage of one template. Each
scope may only **narrow** what the scope above it allows, never widen it: a project may
stop earlier than the install default and may not start earlier; a stage may require more
independence than its pipeline and may not require less. A template is a record of intent
and grants nothing (B.3 rule 5), so a template value is a request the server checks, never
a grant.

**Four rules apply to every setting, without exception.**

1. **Validated server-side, at the moment of use.** No setting is read from a request, a
   task payload, a stage result, or a browser field. A setting that fails validation is a
   refusal with a safe code, never a fallback to a default that was not chosen.
2. **Narrowing only.** A setting can move inside what the security model already allows
   and no further. The acceptance profile's separation axes (`reviewerSeparation`), the
   delegation policy's permitted action set, the grant's risk ceiling and the cost ceilings
   are the ceiling; settings propose below it.
3. **Risky switches are explicit, explained and recorded.** Turning on an unattended merge,
   an unattended dependency change, an unattended external call, an unattended provider
   switch, or any automatic acceptance requires a separate owner confirmation, shows a
   plain-English statement of what it permits, and writes an audit event naming who
   confirmed it, when, and the value before and after.
4. **Every change is audited and never edited.** A setting change appends an event through
   the existing hash-chained audit store (`src/audit/audit-store.ts:92-138`) carrying the
   actor, the previous value, the new value and the scope. A revoked or narrowed policy
   takes effect on the next stage to start, never retroactively (B.3 rule 5).

**What is not a setting, at any scope, for any installation.**

- A `signoff` stage is a quality review. It never becomes effect approval (B.3 rule 1;
  `CompletionReviewV1.grantsApproval` is a literal `false`).
- No stage widens its own authority. The lease intersection still decides (B.3 rule 4).
- A template is not permission. Running one re-derives authority from the current grants
  and the current project policy at that moment (B.3 rule 5).
- Automatic acceptance cannot be turned into a capability by any switch. It needs an
  approval attestation signed by a key in `ApprovalTrustStore`
  (`src/node-policy/v1/stores.ts:42-44`), and that issuing flow is not complete, so
  approval-required external effects remain disabled (CR5C §7).
- The loop limit is the Completion Gate's `maximumRevisionRounds`, not a pipeline setting.
  A setting may ask for fewer rounds; it can never raise the profile's ceiling (B.5).

---

**1. Autonomy — how far a run advances by itself.**
*Setting:* `pipeline.advanceMode`. *Scope:* install default → project policy → pipeline
template → stage (stage may only narrow). *Values:* `stop_every_stage`,
`advance_past_safe_stages`, `advance_within_project_policy`.
*Public default:* `advance_past_safe_stages` — the run advances from one stage to the
next only where the next stage is a non-consequential `build`/`plan`/`check`/`signoff` and
stops before anything with an effect. An install may choose `stop_every_stage` (the whole
pipeline waits for the owner at every stage) or `advance_within_project_policy`, and the
latter is only available to a project that holds an owner-confirmed delegation policy.
*Guardrails regardless:* the run stops and asks when work is uncertain, repeated,
over its limit, out of policy, or consequential; an expired stage envelope admits nothing;
nothing in this setting grants approval, and closing the browser changes nothing
(`PROJ-006`).

**2. Correction loops — how many rounds, and what happens at the limit.**
*Setting:* `pipeline.maxLoopsPerStage` plus `pipeline.atLimitAction`. *Scope:* project
(pipeline and stage may only lower it). *Public default:* `maxLoopsPerStage = 3`, matching
the only acceptance profile the web role may register
(`db/migrations/0086_mac_local_owner_review_profile.sql:58`), and
`atLimitAction = stop_and_ask`. An install may choose `raise_limit_default` or
`accept_anyway_default` as the first button, with the cost stated beside it.
*Guardrails regardless:* the stored counter is the gate's `revisionNumber`; a pipeline value
above the profile ceiling is refused at target creation rather than honoured; raising the
limit **provisions a new acceptance profile and invalidates the review lineage bound to the
old one**, and the interface must say so before the click; the run at the limit does not
retry, escalate, switch agent, or self-accept (B.5).

**3. Reviewer independence — how strict.**
*Setting:* `review.independence`, resolved into the acceptance profile's `reviewerSeparation`
axes. *Scope:* project (a stage may only enable more axes, never fewer). *Values:*
`different_agent`, `different_agent_and_model_family`,
`different_family_for_risky_stages`. *Public default:* `different_agent_and_model_family`.
*Guardrails regardless:* absolute separation from the producing worker, agent profile and
harness identity; a stage may never review its own output; a separation axis with **no
recorded value is a refusal, not a pass** — the store treats "same value" and "no value"
identically today, so the two cases must stay distinguishable in the service layer; a
setting may only enable axes that the installed acceptance profile actually records, and
ADR-044 records that this is a *narrowing*, never a switch that turns the rule off.
"Risky stage" is defined by project policy and includes protected files, security and
authentication, migrations, merges, dependency changes, and anything with an external
effect. On this base the agent-family axis is derived coarsely from the protected worker
route rather than from a model string, so it separates every reviewer on the same harness;
tightening it to a true model-family classifier is a build item, not a setting.

**4. Which agent runs a stage.**
*Setting:* `stage.agentSelection`. *Scope:* stage (template), resolved at instantiation.
*Values:* `pinned_worker`, `pinned_with_capability_fallback`. *Public default:*
`pinned_with_capability_fallback`, because a run that stops because a machine is asleep is
worse than a run that continues on an equally capable machine.
*Guardrails regardless:* the fallback is always shown on the Pipelines page next to the
pinned name; selection is by capability and platform, never by a hardcoded personal name
(`WORK-011`); if no eligible worker satisfies the declared capability, the stage is refused
and reported as unavailable — never started on a weaker fallback, never skipped, never
counted as passed (B.11, `RES-010`).

**5. What may run unattended.**
*Setting:* four independent switches, each off by default — `autonomy.allowUnattendedMerge`,
`allowUnattendedDependencyChange`, `allowUnattendedExternalCall`, and
`autonomy.allowUnattendedProviderSwitch`. *Scope:* install default → project opt-in. An
install may enable any of them per project; the public default is **all off**, which means
no unattended merge, no unattended dependency change, no unattended call to anything
outside the installation, and no unattended provider switch.
*Guardrails regardless:* each switch requires its own owner confirmation and a
plain-English statement of what it permits; a prerequisite set must be satisfied and
proved before any of them can be turned on — all continuous-integration checks plus an
independent review from a different model family, no self-review; a kill switch that stops
every unattended action for the install without touching committed work; a complete audit
record of every action taken under the switch; a merge made under the switch must be
revertable as one unit; a dependency change may only add or upgrade a lockfile-pinned
registry package that passes a size and licence check; an external call may only reach a
destination on an owner-maintained allowlist. None of these switches substitutes for an
approval attestation: an effect that requires one still requires it (CR5C §7), and ADR-041
still holds — no record implicitly grants the function of another. The safety work these
switches depend on is a separate build phase and lands **before** any of them can be
enabled, not alongside them.

**6. Where runs are visible.**
*Setting:* `run.visibility`. *Scope:* install default → project. *Values:*
`project_page`, `project_page_and_attention`, `project_page_home_and_attention`.
*Public default:* `project_page_and_attention` — the run is listed on the project Pipelines
page and appears in Needs attention when a stage is `awaiting_owner`, `uncertain`, blocked,
or over its limit. An install may also promote active runs onto the Home page.
*Guardrails regardless:* the project Pipelines section is hidden entirely while the
installed release does not support it, and is never advertised while unavailable
(`WEB-010`); visibility is presentation and never widens authority; a run is never hidden
because the owner closed the tab.

**7. How long a finished run is kept in the active list.**
*Setting:* `retention.runArchiveAfter`. *Scope:* install default → project (may only
shorten). *Values:* `never` (**public default**), `30`, `90`, `180`, `365` days measured
from the run's terminal state. *Guardrails regardless:* archival moves a finished run out
of the active list and into a readable archive view; it never deletes a stage row, an
attempt, a result, a review, a finding or an audit event, all of which keep their own
retention class and remain readable in the archive; a run in a non-active project is
retained with its history, exactly like every other task in that project (B.11,
`PROJ-005`).

**8. Automatic acceptance of low-risk work.**
*Setting:* `completion.automaticLowRiskDisposition`. *Scope:* install → project → stage.
*Public default:* **off, and not implemented.** The honest position stands: the nearest
field belongs to an acceptance profile and is pinned to `false` by the only profile the web
role may register; `CompletionPreferenceV1` carries `grantsApproval: false` and
`grantsExecutionAuthority: false` as literal type fields, so a preference is structurally
incapable of becoming acceptance authority (B.3 rule 3, ADR-041). Enforcing it means issuing
an attestation that a compromised server cannot forge, and that flow is not built.
*Guardrails regardless:* there is **no** persisted auto-accept column anywhere (B.11), so
there is no stored flag that could later be mistaken for a capability; an AI pre-review may
comment on a decision but can never issue the attestation (CR5C §7); the interface shows the
control as unavailable with the reason, not as a switch that does nothing. The meaningful
choice for an install here is not a value but a build priority: prioritise the owner
approval key, or leave the product saying "no". Those are the only two honest options.

**9. Fan-out.**
*Setting:* `pipeline.fanOut`. *Scope:* project → pipeline template. *Values:*
`linear_only` (**public default**), `fan_out_converge`. *Guardrails regardless:* any
proposal stays inside the existing proposal bounds — at most 32 sub-tasks and 64 edges, no
cycles, no dangling edges, no duplicate local ids, and a `.strict()` schema that cannot
carry an authority, credential, endpoint, callback, effect, risk, cost or identity field
(B.9); read-only stages may run concurrently, two writers serialise; a fan-out that needs
parallel writers without an approved parallel-writer policy is refused and **serialised
instead of failing** (B.7); fan-out is admitted through the one shared
`ProjectWorkAdmissionServiceV1` path, never a private one.

**10. Per-stage model and effort.**
*Setting:* `stage.modelSelection`. *Scope:* stage. *Values:* `worker_default`
(**public default**), `pinned_allowlisted_model`, `model_class_resolved_at_instantiation`.
*Guardrails regardless:* the allowlist is the owner-trusted enablement record's model policy
per worker, never the task and never a browser field; a model off the assigned worker's
allowlist is rejected with 400 and **nothing starts**; a class that no allowlisted model
satisfies stops and asks rather than substituting; a correction round inherits the original
stage's model and effort unless the owner changes it, so a loop-back never silently changes
cost or quality; a model choice never carries a credential, and no provider credential is
copied between machines or into the database (`CONN-006`); the more expensive choices carry
a one-line cost note. This decision is recorded as **already delivered** by the
per-task-model work merged on the base branch, and this design consumes it rather than
re-specifying it.

**11. An agent may be the checker.**
*Setting:* `review.allowAgentCheckers`, resolved against an installed capability rather than
a preference. *Public default:* **human-only check stages**, with the interface saying why.
Agent-as-checker becomes available only when the restricted write role and its guard exist.
*Guardrails regardless:* the agent reviewer writes a review record with
`grantsApproval: false` and `grantsExecutionAuthority: false`; the review must be bound to a
server-created review plan, and the **database** refuses an agent-authored review that is
not bound to one, not merely the service; the separation rules in decision 3 apply to the
agent reviewer exactly as they apply to a human one; human review remains available
alongside agent review and is never displaced; adding a write role to a table that already
accepts writes from two non-web roles requires an independent security review that did not
write the change.

**12. Per-stage provider switching.**
*Setting:* `stage.providerProfile`. *Scope:* stage, resolved against the assigned worker's
enablement record. *Values:* `worker_default_profile` (**public default**),
`pinned_profile` from that worker's configured profile list. *Guardrails regardless:* the
enablement record remains the only source of what a worker may use, and extending it is
reviewed as a security change; a profile the worker does not list is refused and the stage
does not start; the stored value is a profile name, never a key or a raw provider secret;
the pipeline stores a worker id and an allowlisted model or profile — nothing else; and this
decision is **available now** rather than deferred, because the enablement record on the
base branch already carries the per-worker model and profile policy. Enabling provider
switching *unattended* is a separate switch under decision 5, default off.

**13. A finding the owner thinks is wrong.**
*Setting:* `review.overruledFindings`. *Scope:* install default → project. *Values:*
`remain_open_and_stop` (**public default**), `overrule_recorded_and_closed`.
*Guardrails regardless:* the overrule is **always** recorded with its actor, its time and
the finding it answers; the finding's statement and evidence stay on the record in both
cases, because an overruled finding is still evidence that two parties disagreed
(`IDEA-002`); the run stops at the loop limit either way — the setting changes whether the
pipeline may continue past a recorded disagreement, never whether the disagreement was
recorded; and the owner's counter-review is an additional review, never an edit that
removes one.

---

### B.14 Agent work intake

An agent must be able to **propose** work without driving the website, and the owner must be
able to approve a whole batch of it from anywhere. This section specifies that path. It
adds one machine credential, one store, one CLI, and no new queue, no new authority plane
and no new approval path.

**The credential can only propose.** One credential per registered agent, held in a
protected store on the agent's machine, with these properties and no others:

- a single permitted action, `work_batches.propose`, in its own `control_role_grants` row
  with a risk ceiling of `low` and `allowExternalEffects` false, evaluated server-side by
  the existing `evaluatePolicy` (`src/security/policy.ts:55-92`) against the same grant,
  expiry and revocation rules every other grant obeys;
- **no** ability to assign, approve, dispatch, retry, cancel, open an effect, change any
  setting, or read another project's history. Those actions are simply absent from the
  grant, so a request for one is a refusal with `no_matching_grant`, not a special case;
- project scoping exactly as a grant scopes a person: `projectIds` may be a list or `*`,
  and a project-scoped credential may propose only into those projects;
- transport reusing the two existing machine-authentication shapes rather than a new one:
  a signed node-protocol frame with its own replay and rate-limit guards
  (`src/node-protocol/v1/authentication.ts:44-120`) where the agent already speaks the
  node protocol, or a loopback-only listener with a fixed-length bearer secret compared in
  constant time and a private authorizer injected, as the GitHub worker broker's read route
  does (`src/github-app/v1/private-service.ts`, `docs/GITHUB_APP_WORKER_BROKER.md` §9).
  No credential is accepted from a query string, a path, or a command-line argument;
- every receipt it can obtain is negative-authority by construction, exactly as the existing
  queue receipt is: `startsWork: false` and `grantsExecutionAuthority: false` are literal
  fields on the receipt type (`src/web/v1/native-task-queue.ts:25-28`), not runtime
  conditions.

**The batch is the existing proposal shape, extended by role and criteria.** A batch is a
`projectCoordinationProposalSchemaV1` document — `tasks` (1–32) and `edges` (≤64), strict,
acyclic, with no dangling edges and no duplicate local ids
(`src/project-coordination/v1/schemas.ts:33-40`) — plus, per task: the pipeline role the
owner expects (`builder`, `checker` or `validator`, which map onto the existing `build`,
`check` and `signoff` stage kinds in B.2), a **requested** agent and model that are checked
against the assigned worker's allowlist at approval time rather than trusted now, and the
acceptance criteria and tests the agent proposes, as bounded text.

Validation reuses the existing bounded-rejection path. `validateCoordinationProposalV1`
returns a `CoordinationProposalValidationV1` with a bounded `safeReasonCode` and never
throws the raw text (`src/project-coordination/v1/proposal-ingestion.ts:49-127`); the
secret scan (`assertNoSecretMaterial`) runs over the whole proposal before storage; the
`.strict()` schema is what makes it impossible for a proposing agent to smuggle an
authority, a credential, an endpoint, a callback, an effect, a risk, a cost or an identity
into its own batch. A proposal is **not** a plan: a stage result only counts as a plan when
it carries the server-created planning marker
(`projectCoordinatorPlanningMarkerSchemaV1`,
`src/contracts/v1/project-coordination-boundaries.ts:53-80`), and a batch is never parsed as
one.

**Approval is the owner's, on the website or the phone.**
`workIntake.approvalRequired` is a setting with the public default **on**, and the product
offers no path that skips it. A submitted batch lands in state `proposed` and appears on the
project Pipelines page and in Needs attention. The owner may approve the whole batch,
approve some items, edit an item, or reject the batch; every one of those outcomes is
recorded, and a rejection is stored visibly rather than swallowed. The approval itself is an
owner command inside the existing `WebSessionAuthority` transaction with
`actor.require(..., ownerOnly = true)` (`src/web/v1/session-authority.ts:66-77`) — the same
path that gates a task review today — and it writes an audit event.

The phone path is a **notification plus deep link, and nothing more**. It reuses the existing
notification planner, which already produces a description and no command, and the guard
that says so: `notificationEnvelopeHasNoAuthorityV1` fails if an envelope ever carries an
authority, an action, a legal response or a command
(`src/notifications/v1/policy.ts:285-307`). ADR-053 is the governing record — a messaging
button may record a bounded response proposal for a low/medium item and may never prove
owner identity, grant execution authority, or dispatch work; a consequential decision still
opens the authenticated dashboard. "Owner approves from the phone" therefore means *the
owner is notified on the phone and can review and decide in the authenticated product*,
and the design says so in those words rather than implying a chat button is approval.

**After approval, tasks enter per-agent queues.** The queue is the one that already exists:
pg-boss, the single scheduler (`ARCHITECTURE.md`), pre-provisioned as
`native-task-delivery` with the exact bounded profile the code already asserts —
`policy: standard`, `partition: false`, `retryLimit: 0`, `deadLetter: null`, `notify: false`
(`src/persistence/pg-boss-native-task-submission.ts:6-26`) — and enqueued **inside the same
transaction** as the canonical write through `enqueueInSession`, so a commit produces both
the delivery intent and the job or neither
(`src/persistence/pg-boss-bounded-submission.ts:95-116`). There is no second queue, no
second scheduler and no second source of job truth (`ACR-007`).

- **Depth 10–20.** `workIntake.queueDepthPerAgent` is a per-agent setting, default **10**,
  bounded above at 20. Depth is enforced by counting undelivered rows for that worker
  against the ceiling at admission time. Over depth, submission is **refused with a visible
  reason**; nothing is dropped, silently reordered, or evicted, because a silently dropped
  proposal is a task that will never be built and never be explained.
- **Order.** Tasks for one agent run in committed order, and each finished task starts the
  next. Dependencies reuse what the domain already has: `control_job_dependencies` and
  `JobRecord.dependsOnJobIds` (B.1). A task whose declared dependency has not reached a
  retained, accepted result is not dispatched; it waits, and it is visible as waiting rather
  than absent.
- **Materialisation is the ordinary path.** Approved items become ordinary proposed tasks
  through `WebTaskService.proposeWithDependencies`
  (`src/web/v1/task-service.ts:214-283`), which keeps the existing owner authorization, the
  request/workflow/job bundle, the idempotency ledger, the `startsWork: false` receipt and
  the secret scan. The Idea Lab bridge is the worked precedent for exactly this shape —
  deterministic, non-runnable plans converted into ordinary proposed tasks, with a
  deterministic idempotency key per item
  (`src/idea-lab/v1/canonical-task-proposal.ts:21-61`,
  `src/idea-lab/v1/canonical-task-plan.ts:17-37`). Intake composes that service; it does not
  fork it and does not write a job directly.
- **What intake does not own:** no driver, runner, queue of its own, retry policy, result
  channel or completion state. A batch is a proposal until the owner approves it and an
  ordinary task until the ordinary pipeline runs it.

**Full history, per batch and per task.** Every batch records who proposed it, when, from
which credential identity, and the exact submitted content by digest. Every later event —
an edit, an approval, a partial approval, a rejection, a queue admission, a run, a check, a
result, a revision, a stop — appends to the hash-chained audit store
(`appendAuditWith`, `src/audit/audit-store.ts:92-138`) and is visible in the batch view and
the per-task view. History is append-only: an edit appends a new revision with its own
digest rather than rewriting the batch, so "what was proposed, and what was approved" is
always answerable. History follows the run retention setting (decision 7) and is never
shorter-lived than the tasks it describes.

**Data model — sketch level, same rules as B.11.** Two new tables, tenant-scoped,
versioned, carrying the same `record_digest` + `auth_tag` integrity pattern as the rest of
the schema, numbered after the current last migration, additive only, `ON DELETE RESTRICT`,
with a documented down-migration that **refuses** to run while any batch exists:

```
work_batches
  id, tenant_id, project_id
  proposed_by_identity_id, proposed_by_actor_type, proposed_at
  state: proposed | approved | partially_approved | rejected | superseded
  approval_identity_id NULL, approved_at NULL, decision_reason_code NULL
  proposal jsonb            -- the strict proposal document, exactly as submitted
  queue_depth_limit,        -- recorded per batch so a later change is not retroactive
  batch_digest, auth_tag, version, created_at, updated_at
  UNIQUE (tenant_id, id)
  FK (tenant_id, project_id) -> projects

work_batch_revisions       -- append-only; a batch edit appends, never updates
  id, tenant_id, batch_id, revision
  edited_by_identity_id, edited_at, reason_code
  proposal jsonb            -- the full content as edited, by digest not by patch
  revision_digest, auth_tag
  UNIQUE (tenant_id, batch_id, revision)
  FK (tenant_id, batch_id) -> work_batches ON DELETE RESTRICT

work_batch_items           -- one row per proposed task, bound to its eventual job
  id, tenant_id, batch_id, batch_revision
  local_id, ordinal, role, depends_on_local_ids[]
  requested_worker_kind NULL, requested_model_key NULL
  acceptance_criteria text, acceptance_tests text
  job_id NULL, job_attempt_count
  item_digest, auth_tag
  UNIQUE (tenant_id, batch_id, local_id)
  FK (tenant_id, job_id) -> control_jobs(tenant_id, id)   -- nullable, ON DELETE RESTRICT
```

A `work_batch_items.job_id` is set by the materialisation transaction and is the only
binding to the canonical domain. The table holds no authority, no credential, no executor,
no route and no cost. The CLI is a source-only command facade in the style of
`src/installer/v1/private-local-installation-operator-cli.ts`: an exact argument parser
that refuses anything it does not recognise, one named operation per invocation, no
configuration path, no environment selector, no shell command, no retry loop, and a fixed
usage string. Its three operations are `submit-batch`, `batch-status` and `batches`; it
never accepts a path, a command or a secret, and its credential is read from the protected
store the installation already owns.

---

### B.15 Minimum self-hosting slice

The smallest build that lets Control Room run **its own** build plan: linear pipelines of
`build -> check -> validate`, a per-agent queue, work intake, and agents working in
isolated Git worktrees and opening pull requests. Nothing below exists yet, and the slices
are ordered so that each one is independently shippable and independently revertible.

The order is chosen by one rule: **nothing that can start work lands before the thing that
records what was asked for.** So intake lands first even though it executes nothing, and the
security slice that lets an agent write a review lands before any pipeline depends on an
agent review. Each slice keeps a no-loop default: with autonomous advance off, a stage
produces its result and the run stops for the owner. That is what makes every slice safe to
release and honest to demonstrate on its own.

Reviewer independence follows the repository convention throughout: no slice is reviewed by
the agent that built it, and the slices that add a write role or a machine credential get a
fresh independent security reviewer on the diff.

---

**S0 — Record the reuse and update the requirements.**
Ships: a `REUSE_DECISION_GATE.md` entry naming every existing record this slice set reuses
and justifying each new one (`ACR-006`), and the `PRODUCT_REQUIREMENTS.md` §12 changes for
the added project section, the added machine credential and the added intake concept
(`PROJ-003`, `ACR-001`).
*Acceptance:* the reuse entry names, at minimum, `control_requests`, `control_workflows`,
`control_jobs`, `control_attempts`, `control_leases`, `control_job_dependencies`,
`control_completion_gate_records`, `control_project_coordination_proposals`,
`control_native_task_queue`, the `control_room_queue` schema, `audit_events`, and the
intake credential; the requirement table carries the new sections and the new credential
with acceptance evidence; the private-name check passes on the whole diff.

**S1 — Work intake: propose only.**
Ships: the per-agent proposal-only credential, the `work_batches` / `work_batch_revisions`
tables and migration with its refusal rule, the batch validation path, and the `submit-batch`
/ `batch-status` / `batches` CLI. No task is created, no queue row is written, nothing runs.
*Acceptance:* a batch submitted with a valid proposal-only credential lands in state
`proposed` with **zero** `control_jobs` rows and **zero** `control_room_queue.job` rows
created; the same credential calling assign, approve, dispatch, retry, cancel or
settings-change is refused, and each refusal writes an audit event and changes no record;
an expired, revoked, or wrong-project credential is refused before any parse of the body; a
batch with a cycle, a dangling edge, a duplicate local id, more than 32 tasks, more than 64
edges, a cross-project id, or secret-shaped material is refused with a **bounded** reason
code and leaves no partial write; the `.strict()` schema rejects an extra field that tries
to add an authority, credential, endpoint, callback, effect, risk, cost or identity; the
CLI refuses an unknown flag, a path argument, an extra positional argument and a second
invocation's state; replaying one submission with the same idempotency key returns the
original batch and creates no second one, and the same key with different content is
refused; every submission and every refusal survives `AuditStore.verify` on its monthly
partition.

**S2 — Owner batch approval.**
Ships: the Pipelines-page batch view with approve / edit / reject per item, the owner
command, and the notification that reaches the owner out of band. No queue admission yet.
*Acceptance:* approving a batch creates **ordinary** proposed tasks through
`proposeWithDependencies`, each receipt carrying `startsWork: false`; the same approval
command twice creates no second task; editing a batch appends a new revision and leaves
every earlier revision readable; a rejected item is stored with its reason and is visible
in the batch view rather than dropped; an approval attempted by a non-owner identity is
refused with no record written; the notification envelope passes
`notificationEnvelopeHasNoAuthorityV1` and carries no command, action or legal response; a
repeated read, a restart and a lost acknowledgement produce exactly one notification for the
same recorded state; a batch in a non-active project is not approved into a runnable state.

**S3 — Per-agent queue, depth and order.**
Ships: depth enforcement per agent, dependency-aware dispatch, and the per-agent queue view.
*Acceptance:* depth is capped at the recorded per-batch limit and never above 20; a
submission over depth is refused with a visible reason and drops nothing; a task whose
declared dependency has not reached an accepted retained result is never dispatched and
reads as waiting, not absent; tasks for one agent are dispatched in committed order and
each finished task starts the next; two workers never receive the same task; a restart
mid-batch dispatches nothing twice and resumes from committed state; a queue whose recorded
configuration is not exactly `standard` / `retryLimit: 0` / no dead letter is **refused at
startup** rather than repaired at runtime; and the canonical delivery intent and the job row
appear in the same committed transaction or neither appears.

**S4 — Linear pipelines: build, check, validate.**
Ships: the three pipeline tables and additive `control_jobs` columns, the ordered stage
view, instantiation into ordinary tasks, and the first automatic advance. No loops yet, no
agent checker, no worktree work.
*Acceptance:* instantiating a three-stage pipeline creates a request, a workflow, a run and
one row per stage, and the same idempotency key returns the original run while a changed
template content under the same key is refused; stage N+1 does not start until stage N's
result is retained **and** the Completion Gate snapshot permits it; an unknown `stage_kind`
is refused, and the stand-or-fall CHECK refuses a row with a `stage_ordinal` but no
`stage_kind`; cross-project reads are refused, and the composite lineage foreign keys
refuse a stage row pointing at another job's attempt; the round the page shows is read from
the gate's `revisionNumber` and cannot be set by the pipeline; a run in a non-active
project stops advancing and accepts no new stage; two concurrent "start this stage"
requests produce exactly one accepted transition; a stage whose usage is unknown renders as
"unknown", never as 0.

**S5 — Agent-as-checker: identity, the role, and the guard.** *(highest-risk slice)*
Ships: a model-family / harness classification derived server-side from the protected worker
route, a producer and reviewer principal that carries the real identity on both sides, and a
restricted database role with a guard branch that admits an agent-authored review bound to a
server-created review plan.
*Acceptance:* a check stage on the same worker identity is refused with
`reviewer_not_independent`; the same agent profile, harness and family are each refused
when that axis is enabled **and both sides carry a value**; a review whose axis has **no
recorded value** is refused with a different safe code from a same-value refusal, and the
two are not allowed to be indistinguishable; once the role exists, a direct `INSERT` of an
agent-authored review not bound to a server-created plan is refused **by the database**, not
only by the service, and a review bound to a plan from a different job, run or project is
refused; the grant file for the new role contains no privilege beyond the reviewed
insert-plus-plan-join, and the effective-privilege check the other Mac-local logins run
passes for it; human owner review still works alongside agent review.

**S6 — Worktrees and pull requests.**
Ships: a `build` stage working in an isolated Git worktree, the change audit bound to its
own delivery, and a retained evidence link to the opened pull request.
*Acceptance:* the worktree lease is derived from the delivery digest, the run, the
repository identity, the device and the inode, and a second delivery cannot reuse it
(`src/harness/codex-v1/workspace.ts:74-86`); a change outside the stage's declared
`allowedPaths`, or over `maximumChangedFiles` or `maximumChangedBytes`, is refused with
`worktree_change_audit_evidence_out_of_scope`
(`src/harness/v1/worktree-change-audit.ts:127-131`); a worktree with a dirty index or status
is **never** removed (`dirty_worktree`) and one with committed work is preserved
(`workspace_committed_work_requires_preservation`,
`src/harness/codex-v1/git-workspace-port.ts:128-141`); a worktree observation that is
missing metadata, I/O-failing or Git-failing reads `unavailable`, never `absent`, so a
crash cannot be mistaken for a clean checkout; the opened pull request is stored as an
evidence reference — URL plus commit digest — and **no stage can merge**: the repository
integration path exposes no merge operation, and final integration remains a separate
maintainer action; a result without its model recorded is incomplete, and unknown usage
never renders as zero.

**S7 — Sequential advance, unattended bounds, and the history view.**
Ships: automatic advance inside a granted project policy, wall-clock and total-budget
bounds, expiry behaviour, and the full per-batch and per-run history surface.
*Acceptance:* an unattended run advances only inside the delegation policy's permitted
action set, eligible workers, risk ceiling, task and cost allowances and validity window;
a revocation, an exhausted allowance or an expiry stops the next stage and does not cancel
prior committed work; a stage whose authority expires does not start; the run stops at a
stage boundary on the deadline rather than mid-effect; advancing from an `uncertain` stage
is refused, and the run never advances past a `waiting_approval` job; an over-deadline
stage is refused rather than started; the kill switch stops every unattended action for the
install without touching committed work; the per-batch and per-task history shows who
proposed, who approved, what ran, what was checked, and what resulted, in order, with the
audit chain verifying; and no unattended merge, dependency change or external call occurs
while its switch is off.

**Definition of done for the self-hosting slice.** One recorded demonstration against a
disposable real PostgreSQL cluster and the local stack: a real agent credential submits a
real batch through the CLI, the owner approves it once, a `build` stage changes a real
repository inside a real isolated worktree and opens a real pull request, a `check` stage
on a different model family reviews it, a `validate` stage records the acceptance evidence,
and the batch and task histories show every step — with zero merges performed by the
product, every attempt retained, and nothing run twice.

**Explicitly outside the self-hosting slice**, and still subject to the guardrails above:
unattended merge, unattended dependency change, unattended external calls, unattended
provider switching, automatic acceptance of low-risk work, parallel writers, fan-out beyond
the proposal bounds, and any effect requiring an owner approval attestation. None of these
becomes available because the slice is done; each has its own prerequisite work and its own
review.

---

## Appendix — requirement traceability

| Requirement | Where this design satisfies it |
| --- | --- |
| `ACR-004`, `WORK-012`, `WORK-013` | B.3 rules 1–5; B.9 composes with the existing coordination engine |
| `ACR-007`, `DATA-001`, `NEWS-008` | B.1 reuse table — no new queue, database or authority plane |
| `WORK-002`, `WORK-004`, `WORK-005` | B.1 (ordinary tasks), B.8 (committed transitions only) |
| `WORK-006`, `WORK-008` | B.7 — serial by default, existing leases, existing admission service |
| `WORK-011` | B.6, B.10 — stage agent selection is by capability and platform, never a personal name |
| `WORK-010` | B.2, B.10 — a stage declares its role, kind and scope before it can run; the underlying work packet keeps its own platform/capability/difficulty/completion-check fields |
| `WORK-014` | B.5 (owner chooses escalation, not the agent), B.6 (cost note) |
| `RES-001`, `RES-002` | B.4 — bounded, digest-bound, secret-scanned hand-off. `RES-006` (protected file download/preview) is **not** satisfied by the hand-off; it continues to be met by the existing artifact path, which the envelope references by id and digest rather than duplicating. |
| `RES-003`, `RES-004` | B.5 — revisions as explicit related work, all attempts retained |
| `RES-005` | B.3 rule 1 and rule 3 |
| `RES-008`, `RES-009` | B.8 — reconcile before dispatch, never duplicate |
| `SEC-006`, `SEC-007` | B.3, B.4 |
| `WEB-003`, `WEB-008`, `WEB-010` | B.10 — honest states, distinct actions, hidden until supported |
| `OPS-004`, `OPS-006`, `OPS-009` | B.8 (deadline bounds), B.11 (migration rules) |
| `PUB-007` | B.3 rule 2 — independence is enforceable policy; making an *agent* the reviewer needs the slice-3 role work, which is why `PUB-007` is not satisfied until then |
| ADR-041, ADR-042, ADR-044 | B.3, B.5 |
| CR5C §2, §5, §6, §7 | B.3, B.8 |
| `PROJECT_COORDINATION_DECISION.md` | B.7, B.9 |
| `ACR-001`, `ACR-006`, `PROJ-003` | B.14 adds a machine credential and a project section, so S0 in B.15 opens the `PRODUCT_REQUIREMENTS.md` §12 changes and the `REUSE_DECISION_GATE.md` entry before any code lands |
| `WORK-001`, `WORK-002` | B.14 — an agent proposes a batch through a machine API and CLI; nothing is assigned or run until the owner approves, and the batch becomes ordinary proposed tasks through the ordinary submission path |
| `DATA-002`, `DATA-005`, `DATA-006`, `DATA-008` | B.11, B.14 — the three intake tables follow the same additive, restricted, digest-tagged and idempotent rules as the pipeline tables |
| `ACR-005` | B.14 — every intake event is appended to the existing hash-chained audit store, per batch and per task, append-only |
| ADR-053, ADR-054 | B.14 — the phone path is a notification and a deep link, never an approval; the intake credential carries a logical reference only, and no credential material is copied or returned |
| `CONN-006` | B.13 decisions 10 and 12 — a stage stores a worker id and an allowlisted model or profile, never a provider credential |
| B.13 (all thirteen) | Every decision is a setting at install, project, pipeline or stage scope, validated server-side, narrowing-only, audited, and bounded below by the guardrails the design states |
