# `mac-local-default-task-provider.ts`: composition plan

**From:** Claude (lead). **Date:** 2026-09-25. **Status:** research complete, implementation in progress.

This records what I verified while tracing the composition chain, so the work
survives an interruption (a session already dropped once mid-research).

## Goal

Implement `src/web/v1/mac-local-default-task-provider.ts` satisfying
`MacLocalTaskProviderV1` (`mac-local-task-provider.ts`): exports `schema`,
`workerKinds`, `createTaskApplication({configuration, database, workerReadiness,
databaseRoles})`, which calls `createMacLocalCurrentThreeAgentTaskApplicationV1`
(`mac-local-current-three-agent-task-composition.ts`) with `{web, databaseRoles,
openDatabase, coordinator, hermes, claude, codex}`.

**Key finding: mac-local does not need the VPS installed-process ceremony.**
`task-coordinator-lifecycle.ts:78-185` shows `hermesLocal`/`claudeCodeLocal`/
`codexOwnerTrustedLocal` each need only `{deliver(target, signal): Promise<void>}`
at this layer — no brand check. The brand check
(`isClaudeCodePrivateInstalledDeliverCapabilityV1`) lives only in
`private-task-startup.ts`, which is the VPS-only bootstrap. Mac-local never
calls that validator, so all three agents can use the same lighter
"owner-trusted local CLI" bridge design, including Claude.

## The generic CLI bridge (already built, reusable for all 3 agents)

`src/harness/v1/owner-trusted-local-cli-delivery.ts` — `deliverOwnerTrustedLocalCliTaskV1(config, deliveryValue,
routeValue, receivedAt, signal)`. `config` needs:

```
{ db, integrityKey (32 bytes), binding{workerId,adapterId,adapterRevision},
  receiptPort: ControllerWorkerDeliveryPortV1,       // MISSING — must build
  assertCurrent(delivery, route, signal): Promise<void>,  // MISSING — must build
  execute(...): OwnerTrustedLocalCliExecutionV1,     // built by owner-trusted-local-cli-composition.ts's execution adapters
  publish({delivery, receipt, text, signal}): Promise<void>  // MISSING — must build
}
```

`src/harness/v1/owner-trusted-local-cli-composition.ts` supplies `execute` via
`createOwnerTrustedLocalCodexExecutionAdapterV1`/Claude/Hermes, wraps the whole
thing as `createOwnerTrustedLocalCodexDeliveryV1(base, executor, config)` etc.,
returning `{deliver}`.

Per-agent queue executors already exist and call `preparation.prepare` +
`preparation.assertCurrent` before `delivery.deliver`:
- `createCodexOwnerTrustedLocalQueueExecutorV1` (`codex-owner-trusted-local-executor.ts`)
- `createHermesLocalQueueExecutorV1` (`hermes-local-executor.ts`)
- Claude has NO such executor yet — `claude-code-local-executor.ts` instead wraps the
  heavier `executeAssignedClaudeCodeLocalTaskV1`/VPS-installed-process path. **Decision:**
  build a new, parallel `createClaudeOwnerTrustedLocalQueueExecutorV1` mirroring the
  Codex one, using the *simple* CLI bridge instead of the VPS path. Do not reuse
  `claude-code-local-executor.ts` for mac-local.

Each agent kind has a `*DispatchPreparationV1` class with the same shape:
`prepare(reference) -> prepared{delivery, route, workflowId,...}` and
`assertCurrent(reference, prepared)` (re-derives from `control_jobs` /
`control_attempts` / `control_leases` and compares a binding digest). Verified
in full for Codex: `src/harness/codex-v1/owner-trusted-local-dispatch-preparation.ts`.
Hermes: `src/harness/hermes-local-v1/dispatch-preparation.ts`. Claude:
`src/harness/claude-code-v1/dispatch-preparation.ts` (not yet read in detail —
read it before wiring Claude; expect the same shape).

## The 3 missing pieces for the CLI bridge `config`

### 1. `receiptPort` (`ControllerWorkerDeliveryPortV1`)

`receive(delivery, route, signal): Promise<ControllerWorkerDeliveryReceiptV1>`. No
existing local/loopback implementation — the only other implementations
(`codex-v1/local-delivery-composition.ts`, `claude-code-v1/local-delivery-composition.ts`)
belong to a *different*, unrelated "codex-local-v1 activation frame" protocol
(remote node/enrollment style) — do not reuse those; they solve a different
problem (node-protocol activation frames), not the owner-trusted CLI receipt.

Must build new: a same-process loopback port that constructs a receipt per
`controllerWorkerDeliveryReceiptSchemaV1`
(`src/harness/v1/controller-worker-delivery.ts:47-56`) with `disposition:
"accepted"`, `receivedAt: now`, and `receiptDigest = sha256Digest(material)`
computed by hand (the schema's `superRefine` only *validates* the digest, it
does not compute it). This is pure, deterministic, and unit-testable in
isolation — good first piece to build and review.

### 2. `assertCurrent(delivery, route, signal)` on the CLI-bridge `Base`

This is distinct from `preparation.assertCurrent(reference, prepared)` (which
the queue executor calls once, before `delivery.deliver`). The CLI bridge calls
`config.assertCurrent` **three more times** during one delivery (before receipt,
before execute, before publish) — it must be callable from `(delivery, route,
signal)` alone, with no closure over the original `reference`/`prepared`.

Design: reconstruct `reference` from `delivery.identity`
(`tenantId,projectId,jobId,attemptId`) plus a fresh lookup of the attempt's
current active `leaseId` (same tables `prepareInSession` already reads), then
call the same preparation class's own `prepare(reference)` again and compare
`sha256Digest(current.delivery) === sha256Digest(delivery)` and
`canonicalJson(current.route) === canonicalJson(route)`. This reuses the
already-reviewed, tested re-derivation logic instead of duplicating it — it
does not need `workflowId` separately because `prepare()` recomputes it
internally and it's folded into `current.delivery`'s digest via the identity
already, IF `bindingDigest` inputs are all reproduced by a fresh `prepare()`
call. **Verify this claim by reading `prepareInSession` once more before
coding** — confirm nothing about `prepare()`'s output depends on
non-reproducible state (e.g. `now`/`issuedAt`, which *do* differ per call —
`bindingDigest` deliberately excludes `issuedAt`/`identity.runId`? check: current
code's `bindingDigest` includes `identity` (has runId, deterministic) but not
`issuedAt`/`expiresAt` directly... it does include `expiresAt`. `expiresAt` is
computed as `min(lease.expiresAt, job.authority.expiresAt)`, which is
reproducible from current DB state, not wall-clock — good, this should be
stable across repeated `prepare()` calls as long as nothing changed in the DB.

Build one shared helper, e.g.
`src/harness/v1/owner-trusted-local-cli-assert-current.ts`, parameterized by
the preparation instance and a `deriveReference(delivery)` callback (differs
slightly per agent: which table columns identify the lease). Test it against
a live lease change (revoke/replace) to prove it fails closed.

### 3. `publish({delivery, receipt, text, signal})`

Must turn the CLI's raw text into a stored, reviewable result through the
*existing* canonical result/review path — never a second store.
`src/completion-gate/v1/durable-result-review-submission.ts` exports
`DurableResultReviewSubmissionServiceV1`, already used for real (not test-only)
in `claude-code-private-installation-composition.ts:101-111`:

```ts
const reviewSubmission = new DurableResultReviewSubmissionServiceV1(input.execution.results.db, { ...input.execution.results });
```

Read `durable-result-review-submission.ts`'s constructor and submit method in
full before wiring this — not yet done. Expect it needs a `resultDatabase`
client, the quality/results integrity key, and a submit method taking
identity + text + digest. This likely means the mac-local provider also needs
a `resultDatabase` (second restricted role) and `quality`/`results` protected
settings — check whether `mac-local-database-roles.ts` already has a `results`
role (it does NOT currently — role set today is only
`web/coordinator/results/queueWorker` per the rehearsal `setup.ts` fixture,
**recheck**: `captureMacLocalDatabaseRolesV1` shape needs re-verification,
I noted 4 roles from `scripts/mac-local/rehearsal/setup.ts:79`: `web,
coordinator, results, queueWorker` — good, `results` already exists as a role
name; need to open it as a `TaskCoordinatorDatabase` the same way `coordinator`
is opened in `mac-local-restricted-task-composition.ts`).

## Other required pieces (confirmed necessary, not yet built)

- **`nativeQueue: true` + `nativeSubmission`.** Required whenever any
  `*Local` field is set (`task-coordinator-lifecycle.ts:145,149,153`).
  Production factory exists:
  `src/persistence/pg-boss-native-task-submission.ts` —
  `preparePgBossNativeTaskSubmission(PgBoss, database: DatabaseSession,
  {backend:"postgres", recovery:true})`. Needs a real `pg-boss` import (`import
  PgBoss from "pg-boss"`) and the coordinator DB session. Mirrors the VPS
  wiring pattern in `private-task-startup.ts` (`createPrivateTaskBootstrap`'s
  `prepareNativeSubmission` dependency) — find the VPS's own production
  instantiation (search for where `startPrivateTaskApplication`'s module-level
  `production = createPrivateTaskBootstrap({...})` is supplied
  `prepareNativeSubmission` for the real deploy, likely in a sibling
  `private-task-startup-production.ts` or inline near the bottom of that file
  — re-check, I stopped at line 682 which only wires `openDatabase`/`install`/
  `openArtifactStorage`, not `prepareNativeSubmission`. Search
  `scripts/run-private-vps.mjs` or similar for where PgBoss is actually passed
  in.)
- **`coordinator.approvals`** (required alongside `nativeQueue`). Real class:
  `NativeApprovalPacketStore` (`src/web/v1/native-approval-packet-store.ts:84`).
  Constructor: `new NativeApprovalPacketStore(key: Uint8Array(32), trust:
  Trust[], clock?)`. `Trust = {approvals: {binding(), assertAvailable(),
  resolveApprovalKey()}, security: {currentServerTrustRevision()}}` per node.
  This looks designed for *remote* node trust negotiation; **must check**
  whether a local, single-node "trust" object can be trivial/fixed (no real
  negotiation needed since there's exactly one Mac and one owner) — read
  `native-run-contracts.ts` (`NativeEnrollment`) and
  `task-assignment-coordinator.ts`'s `validateNativeApprovalEnrollments` next.
  This is the piece most likely to need genuinely new, careful design rather
  than reuse, since no existing "local, single-node" approvals wiring exists
  yet anywhere in the repo (Hermes/Claude/Codex owner-trusted-local paths all
  assume `approvals` is supplied by the caller — none of them construct it).
- **`coordinator.routes`** — required unconditionally by
  `validateTaskAssignmentRoutes` on the VPS path; **unverified** whether
  mac-local's restricted composition (`mac-local-restricted-task-composition.ts`)
  actually requires non-empty routes, or whether local delivery
  (hermes/claude/codex-owner-trusted-local) bypasses `routes` entirely since
  their `deliver` is called directly by `nodeId`-less native queue delivery
  (`task-coordinator-lifecycle.ts:500-511` shows `hermesLocal.deliver`/etc.
  called without going through a `routes` lookup at all). **Working
  hypothesis: routes can be an empty array for a pure 3-local-agent mac
  deployment with no remote/session/codex-app-server features enabled** — but
  confirm by reading `validateTaskAssignmentRoutes`'s minimum-valid-input
  before assuming this.
- **Task-execution-planner templates + authority digest per adapter.** Needed
  by `captureNativeTaskTemplates`/`planning.integrityKey` — mac-local needs its
  own 3 templates (hermes/claude/codex), each declaring the fixed
  `executionClass`/`adapter`/`requiredCapability` matching what
  `*DispatchPreparationV1.prepareInSession` checks (e.g. Codex expects
  `plan.adapter === CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1`,
  `plan.executionClass === "text_review"`,
  `job.jobType === CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1`). Check
  `task-execution-planner.ts`'s `captureNativeTaskTemplates` for the exact
  template shape and how a job's plan gets created from a template at task-creation
  time (this is likely mostly existing/shared machinery, not new).
- **Protected config additions.** `MacLocalProtectedConfigurationV1`
  (`mac-local-protected-configuration.ts`) currently has only `{schema, port,
  workspaceId, localOwnerSession, database, enablement}` — no task integrity
  keys, no results database, no approvals key. This schema will need new
  fields (e.g. `taskPlanning: {integrityKey, reviewIntegrityKey}`,
  `approvals: {integrityKey}`, `resultDatabase`), each 32-byte key freshly
  generated once by `bootstrap-owner.ts`-equivalent tooling or the rehearsal
  `setup.ts` (which already generates several `pw()` secrets — add key
  generation there for rehearsal, and to whatever the real provisioning script
  is for the owner path).

## Suggested build order (small, independently reviewable, testable pieces)

1. `receiptPort` loopback adapter — pure function, easy unit test. ✅ good first PR.
2. `assertCurrent` reconstruction helper, generic over one `*DispatchPreparationV1`
   plus a `deriveReference(delivery)` callback. Unit test: prove it throws after
   a lease is revoked/replaced mid-flight.
3. Read `durable-result-review-submission.ts` fully; build `publish` closure.
4. Read `task-assignment-coordinator.ts` (`validateTaskAssignmentRoutes`,
   `validateNativeApprovalEnrollments`, `NativeEnrollment`) and
   `native-run-contracts.ts` to settle the `routes`/`approvals` design
   question above. This determines whether approvals needs new architecture
   or can reuse `NativeApprovalPacketStore` with a trivial local trust list.
5. Read `task-execution-planner.ts` for template shape; write the 3 mac-local
   templates.
6. Extend `MacLocalProtectedConfigurationV1` + `MacLocalDatabaseRolesV1` (if
   needed) with the new keys/roles; update `rehearsal/setup.ts` to generate
   them for local proof.
7. Write `mac-local-default-task-provider.ts` assembling everything; add the
   `vite.vps.config.ts` entry; wire `mac:up` (`scripts/mac-local/up.mjs`,
   already references `dist-vps/server/macLocalDefaultTaskProvider.js`).
8. Prove in rehearsal (port 15511, this Mac): `mac:up` starts, `/api/v1/local-workers`
   lists 3 workers, `acceptance-w6 --restart` exits 0.

Each step gets its own `claude-review.mjs` pass before merging, given the
security sensitivity (HMAC keys, lease fencing, receipt/result binding).

## Open questions to resolve before step 4 above

- Does the VPS's own real deployment ever exercise `hermesLocal`/
  `codexOwnerTrustedLocal`/`claudeCodeLocal` today, or are those fields
  currently mac-local-only additions to a shared type? If mac-local-only,
  there is no existing "real" `approvals`/`routes`/`nativeSubmission` wiring
  example to copy for this exact combination — only the pieces exist
  separately, and their combination is the actual novel design work here.

## Update (same session, continued): the "publish" step is much deeper than a callback

Tracing `publish` all the way down surfaced a full second layer that the plan
above did not budget for. Recording it precisely so it is not re-derived from
scratch:

- Claude's own path does **not** use the generic `owner-trusted-local-cli-*`
  bridge at all. It uses a completely separate, heavier machinery:
  `executeAssignedClaudeCodeLocalTaskV1` (`assigned-task-execution.ts`) ->
  `ClaudeCodeLocalRunRegistrationV1` (registers a `HarnessRunV1` via
  `HarnessRunStoreV1`) -> `deliverClaudeCodeLocalTaskV1` (session-reservation
  delivery, Claude-specific) -> `publishClaudeCodeReservedSessionResultV1`
  (`local-worker-result.ts`) -> `publishClaudeTerminalResultV1`
  (`result-publication.ts`, Claude-specific frame decoding) ->
  `publishDurableResultV1` (`artifacts/v1/durable-result-publication.ts`, the
  actual generic write). Do **not** try to reuse this whole chain for
  Codex/Hermes — the "reserved session" concept is specific to Claude Code's
  own resumable-session process model. Codex (`codex exec --json`) and Hermes
  are one-shot processes and fit the simpler generic CLI bridge
  (`owner-trusted-local-cli-delivery.ts`) instead — confirmed correct.
- What Codex/Hermes still need, mechanically mirroring Claude's smaller
  pieces:
  1. A `*LocalRunRegistrationV1(delivery, createdAt) -> HarnessRunV1` per
     adapter (~25 lines each; `local-run-registration.ts` for Claude is the
     exact template). Uses existing constants
     `CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1` / `HERMES_LOCAL_ADAPTER_V1`
     (`owner-trusted-local-task-planning-contract.ts`,
     `hermes-local-v1/task-planning-contract.ts`) — both already exist, no
     new identifiers needed. **Open question:** Claude's registration sets
     `harness: "claude", harnessVersion: CLAUDE_CODE_PACKAGE_VERSION_V1`. Is
     there an equivalent `harnessVersion` source for Codex/Hermes already
     (a version string read from the pinned executable, per
     `owner-trusted-local-enablements.ts`'s `recordedVersion`)? Likely yes —
     check before writing.
  2. A generic (non-Claude-specific) `publishOwnerTrustedLocalCliResultV1`
     that takes `{retainedBinding, text, receivedAt, assertAuthority, signal}`
     and calls `publishDurableResultV1` directly (no stream-frame decoding
     needed — the CLI bridge's `execute()` already returns plain
     `{kind:"completed", text}`). This is genuinely new but small, and is a
     strict subset of what `publishClaudeTerminalResultV1` does.
- **`publishDurableResultV1` has its own precondition** I had not accounted
  for: `verifyRecordedIdentity` (`durable-result-publication.ts:296-345+`)
  requires a matching row in `control_harness_runs` (written by
  `HarnessRunStoreV1.create`, item 1 above), `control_jobs`, `control_attempts`,
  **and `adapter_registry`** (columns `authority_mode`, `contract_version`,
  keyed by `adapter_id`). **Unresolved:** I could not find an existing
  `INSERT INTO adapter_registry` seed for `codex-owner-trusted-local-v1` /
  `hermes-macos-local-v1` / `claude-code-local` anywhere in `db/migrations/`.
  Either (a) `HarnessRunStoreV1.create()` upserts this row itself as a side
  effect (plausible — check `src/harness/v1/store.ts` before assuming a
  migration is missing), or (b) a migration/seed step needs to add these rows
  for mac-local specifically, which is exactly a "normative contract" change
  under AGENTS.md's Codex-owned category (adapter registry entries define
  authority_mode/contract_version — architecture, not local process control).
- **`connectorProfileDigest` semantics — resolved.** Re-read
  `task-execution-planner.ts:70-75`'s nested ternary slowly (my first pass
  above misparsed it, inverting the condition). Corrected reading: the
  ternary's branches are *error* conditions (they call `addIssue` when true),
  so for `codexLocal`/`hermesLocal`/`claude` the requirement is
  `connectorProfileDigest` **must be defined** (present) and
  `workspaceIntentDigest` must be undefined — the exact opposite of what I
  wrote earlier. Only `hermesNative` requires `connectorProfileDigest`
  undefined. Line 67 adds one further constraint *specific to Claude only*:
  its digest must equal the fixed constant `CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1`;
  Codex and Hermes have no such fixed-constant requirement — any valid digest
  the template author (me) picks is fine, confirmed by
  `tests/codex-owner-trusted-local-queue.test.ts:27`'s
  `connectorProfileDigest: sha256Digest("mac-local-codex-profile")`, an
  arbitrary literal. No contradiction, no blocker — templates for
  codex-owner-trusted-local and hermes-local can be written now.

## Update: generic `publish()` built and proven end-to-end

`src/harness/v1/owner-trusted-local-cli-publish.ts` — `createOwnerTrustedLocalCliPublishV1({db,
runIntegrityKey, publication, registerRun})` returns the `publish({delivery,
receipt, text, signal})` closure the CLI bridge needs. Registers the run
(`HarnessRunStoreV1.create`, replay-safe), re-derives `workflowId` from
`control_jobs` (never trusts a caller-supplied one — `ControllerWorkerDeliveryV1`
doesn't carry it), builds the `DurableResultBindingV1`, and hands off to the
existing `publishDurableResultV1` + `DurableResultReviewSubmissionServiceV1`
— no second store or review path. Proven against real Postgres in
`tests/owner-trusted-local-cli-publish.test.ts`: a fresh publish writes a
`control_native_artifact_receipts` row and a `control_native_review_plans`
row, and a same-input replay does not create a second run record.

**Known, accepted limitation (review-flagged, not fixed):** the
`assertAuthority` callback I pass to `publishDurableResultV1` only checks
`signal.aborted`, not live authority/revocation state, so a revocation that
lands *while* the multi-step publish transaction is in flight isn't caught
mid-flight. This is not a regression I introduced: the CLI bridge itself
(`deliverOwnerTrustedLocalCliTaskV1`) has the identical shape — it calls the
real `assertCurrent` (DB re-derivation) once, immediately before calling
`publish`, then never again during the publish call. Closing this fully
would mean giving the bridge a genuinely synchronous, in-memory revocation
fence (like Claude's `assertCurrentDelivery`), which is a broader design
change to the whole bridge, not specific to this piece — leaving it for a
Codex architecture call rather than solving it solo here.

## Update: templates are per-project, not global — changes the remaining shape

Traced `TaskExecutionPlanner.plan()`/`selectTemplate()`
(`task-execution-planner.ts:367-380,484-512`) to resolve how task templates
work with more than one project. Finding: a `NativeTaskTemplate`'s
`authority.projectId` is checked for an **exact match** against the task's
real project id (`task-execution-planner.ts:512`:
`template.authority.projectId !== projectId` → refused). The planner groups
its fixed `template` + `additionalTemplates` list into a
`Map<projectId, template[]>` (`this.projectTemplates`) once, at
construction — **there is no method to register a template after
construction.** Total templates are capped at 16
(`captureNativeTaskTemplates`: `additionalTemplates` max 15, plus the
primary `template`).

This means, for mac-local's 3 local adapters: every project that will ever
use Hermes/Claude/Codex needs its own 3 templates, all present in the
planner's list **at the moment `createTaskApplication()` is called** (i.e.
at `mac:up` startup) — not creatable later without rebuilding the whole task
application. Concretely, the default provider's `createTaskApplication`
needs to: read the tenant's active projects, build 3 templates per project
(`authority.projectId` = that project), and pass them all in. A new project
created after `mac:up` starts would need `mac:down && mac:up` to get task
templates — acceptable for the "one project, three tasks" W6/W7 acceptance
bar, worth calling out explicitly rather than silently, and bounds mac-local
to roughly 5 concurrently-templated projects before hitting the 16 cap
(a real, if distant, ceiling worth Codex knowing about).

Each template also needs a **registered acceptance profile**
(`completionAcceptanceProfileSchemaV1`, via `CompletionGateStoreV1.registerProfile`)
matching its `acceptanceProfileId`/`acceptanceProfileDigest` — confirmed by
building one directly to get `tests/owner-trusted-local-cli-publish.test.ts`
passing. For mac-local this likely means: one fixed, owner-approved
acceptance profile per project (or one shared profile reused across all
three adapters within a project), registered at project-creation time
alongside the templates.

## Where I'm stopping the solo build for now

Everything from here touches the exact area Codex is independently
converging on tonight (their own `TASK_PROVIDER_IMPLEMENTATION_GAP.md` on
`claude/mac-local-integration` reaches the same "needs one release-owned
task-runtime composition, protected config extension" conclusion). The
remaining pieces — enumerating active projects and building their templates,
extending `MacLocalProtectedConfigurationV1` with the ~5 new 32-byte keys
this needs (planning integrity/review, run-store, durable-result
integrity/review — `HarnessRunStoreV1`, `TaskExecutionPlanner`, and
`DurableResultPublicationConfigurationV1` each want their own, per the
existing VPS pattern in `private-task-startup.ts`), wiring routes (3 static
local entries, one per adapter — cheap, low-risk, not yet built),
constructing the structurally-required-but-inert `approvals` object
(`NativeApprovalPacketStore` with an empty trust list — proven safe to build
by `tests/codex-owner-trusted-local-queue.test.ts`'s own pattern), wiring
`nativeSubmission` via `preparePgBossNativeTaskSubmission` with a real
`pg-boss` import, and finally assembling
`mac-local-default-task-provider.ts` itself plus its `vite.vps.config.ts`
entry — all sit on top of a schema decision (the protected-config shape)
that Codex is actively drafting in parallel right now. I did not touch
`mac-local-protected-configuration.ts` to avoid two independently-designed,
incompatible shapes needing reconciliation later, which is a worse outcome
than either of us finishing it alone.

**What is safe and done, regardless of how that schema settles:** every
piece in this doc above this section — `receiptPort`, `assertCurrent`, the
Codex/Hermes run-registration mirrors, `adapter_registry` seeding, and the
generic `publish()` — is a standalone function parameterized by whatever
config it's given. None of it needs to change no matter which of us (or
neither) writes the final protected-config shape.

## Recommendation given the above

This is no longer a same-night, one-pass build. Concretely remaining, in
increasing order of how much they touch shared/normative contracts:
1. `receiptPort` loopback adapter — pure, mine to build, low risk.
2. `assertCurrent` reconstruction helper — mine to build, needs a per-agent
   `deriveReference(delivery)`, moderate risk (re-derives lease state).
3. Codex/Hermes run registration mirrors — mine to build, low risk, mechanical.
4. Generic `publishOwnerTrustedLocalCliResultV1` — mine to build, moderate
   risk (first non-Claude caller of `publishDurableResultV1`).
5. **`adapter_registry` rows for the two missing adapters, if item (b) above
   is confirmed** — this is a schema/seed-data decision with the same shape
   as an authority-mode contract; flag to Codex rather than deciding solo.
6. Task-execution-plan templates for codex-owner-trusted-local/hermes-local
   — needs the connectorProfileDigest question resolved first (item above).
7. Protected-config schema extension (new integrity keys, results database)
   — schema-shape decision, worth a lightweight Codex sanity check given it's
   the kind of thing `SECURITY_AND_AUTHORITY.md`/`CR5C_FINAL_SECURITY_CONTRACT.md`
   normally govern, even though the *fields* themselves are mac-local-only.
8. Assemble `mac-local-default-task-provider.ts`, wire `vite.vps.config.ts`,
   prove in rehearsal.

Given AGENTS.md reserves "normative contracts" and "security boundaries" for
Codex, items 5–7 above are flagged for a Codex pass (or at minimum a review
before merge) rather than a solo Claude decision, even though I now have a
concrete, correct-as-far-as-verified design for all of them. Items 1–4 are
safe to build solo with the usual review gate.

## Update: items 1–3 built and tested; the `adapter_registry` gap confirmed

Built and unit/integration-tested (rehearsal not yet re-run, but `pnpm check`
and the affected `node --test` files are green):

- `src/harness/v1/owner-trusted-local-cli-receipt-port.ts` — the loopback
  `receiptPort`. Pure, no DB.
- `src/harness/v1/owner-trusted-local-cli-assert-current.ts` — the generic
  `assertCurrent(delivery, route, signal)` for the CLI bridge, built by
  re-deriving the reference from `delivery.identity` + a fresh lookup of the
  attempt's active lease, then re-running the *existing*
  `*DispatchPreparationV1.prepare()` and comparing delivery/route digests. It
  duplicates none of the lease/job/attempt logic. Proven against a real
  Postgres-backed fixture (`ownerReviewFixture` + `TaskExecutionPlanner` +
  `TaskAssignmentCoordinator`, same as `tests/codex-owner-trusted-local-queue.test.ts`)
  to both succeed on a live lease and fail closed once it expires.
- `src/harness/codex-v1/owner-trusted-local-run-registration.ts` and
  `src/harness/hermes-local-v1/local-run-registration.ts` — mechanical
  mirrors of `ClaudeCodeLocalRunRegistrationV1`, except `harnessVersion` is a
  caller-supplied parameter (from the live pinned-executable record) rather
  than a source-level constant, since Codex/Hermes are allowed to auto-update
  and get re-pinned, unlike Claude's fixed CLI version pin.

**Confirmed, not yet built: `adapter_registry` seeding is a real, separate
gap that also affects Claude, not just Codex/Hermes.** Traced
`publishDurableResultV1`'s `verifyRecordedIdentity`
(`durable-result-publication.ts:296-350`) — it requires a row in
`adapter_registry` keyed by `(tenant_id, id=adapter_id)` with `authority_mode
IN ('control_room_native','source_scheduled','advisory')` (DDL:
`db/migrations/0001_control_room_core.sql:15-30`). `control_harness_runs.adapter_id`
(`db/migrations/0020_cr7_harness_runs.sql:10`) has **no foreign key** to
`adapter_registry` — so `HarnessRunStoreV1.create()` succeeds fine without
this row (confirmed by reading `store.ts`'s `create()` in full: no
`adapter_registry` reference anywhere), but the *publish* step still fails
without it. No migration or bootstrap code seeds this row for
`connector:claude-code-local` / `connector:codex-owner-trusted-local-v1` /
`connector:hermes-macos-local-v1` anywhere in the repo (only a *different*,
per-tenant "manual project" adapter row is seeded on demand, in
`project-service.ts:202`, using the same `INSERT ... ON CONFLICT DO NOTHING`
pattern I'd copy). This means: even Claude's own already-built local pipeline
has probably never been exercised all the way through a real `publish`, only
through `probe-adapters.ts` (which calls the raw exec adapter directly, no
queue/publish involved) — REHEARSAL_FINDINGS' "W6 acceptance passes" did not
include a real end-to-end task through review. **Next concrete step:** add a
one-time seed of 3 `adapter_registry` rows (`authority_mode:
'control_room_native'`, mirroring the manual-project INSERT shape) to
`bootstrap-owner.ts`/`bootstrapMacLocalOwnerV1`, guarded by `ON CONFLICT DO
NOTHING` the same way. This is the smallest unblocking change and is
infrastructure-shaped (same category as the owner/tenant/workspace bootstrap
I already built), not a new authority decision — the `authority_mode` value
and column shape are copied verbatim from the existing reviewed pattern, not
invented. Still worth a quick Codex glance before merge given it's a schema
INSERT touching a shared table, but this is now a small, well-scoped change,
not an open architecture question.

**DONE (2026-09-25):** built as `seedMacLocalAdapterRegistryV1`
(`src/web/v1/mac-local-owner-bootstrap.ts`), called from
`scripts/mac-local/bootstrap-owner.ts` after the owner bootstrap succeeds.
One real finding while building it: `adapter_registry.id` turned out to be a
**global** primary key (not per-tenant — the `UNIQUE(tenant_id,id)`
constraint added in migration 0007 sits alongside it, not instead of it), so
a naive `ON CONFLICT DO NOTHING` would silently no-op if these fixed ids
were ever claimed by a different tenant. Fixed to fail closed instead (read
back the row after insert, throw `mac_local_owner_bootstrap_conflict` on a
tenant mismatch) and deliberately kept it *out* of `bootstrapMacLocalOwnerV1`
itself, since that function is exercised by tests against many disposable,
unrelated tenant ids sharing one database — fine for tenant/workspace/owner
logic, fatal for a genuinely global-singleton seed. Verified end-to-end
against the running rehearsal database (port 15511): `SELECT * FROM
adapter_registry` shows all three rows for `tenant:mac-local`, and a second
`mac:bootstrap-owner` run is a clean no-op. Reviewed (APPROVE) and pushed at
`76ea7519`.
