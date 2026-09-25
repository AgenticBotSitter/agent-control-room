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
- **`connectorProfileDigest` semantics look self-consistent but were not
  fully verified.** `nativeTaskTemplateSchema`'s `superRefine`
  (`task-execution-planner.ts:59-73`) appears to require
  `connectorProfileDigest === undefined` in the *template* for
  `codexLocal`/`hermesLocal`/`claude` (with a separate, additional check at
  line 67 requiring it to equal `CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1`
  specifically for claude — these two conditions read as contradictory on a
  fast pass and need a careful, dedicated re-read of the exact ternary
  structure before writing the codex/hermes-local templates). Plan-creation
  code then does `connectorProfileDigest: template.connectorProfileDigest`
  uniformly for every adapter (lines ~528-534, ~775-781), so whatever the
  template says flows straight into the stored plan and eventually the
  delivery. Get this exactly right by reading `task-execution-planner.ts`
  lines 33-115 slowly, line by line, before writing any mac-local template —
  a wrong digest here fails closed at delivery time (good) but wastes a full
  rehearsal cycle per mistake (slow to iterate).

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
