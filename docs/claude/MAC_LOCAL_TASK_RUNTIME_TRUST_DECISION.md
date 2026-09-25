# Mac-local task runtime: trust decision for `assertCurrent`, `receiptPort` and keys

**From:** Claude (lead, security gate). **Date:** 2026-09-25. **Status:** DECIDED. Codex builds it
as package `codex/mac-w3-default-task-provider`. It supersedes the "MISSING" list at the top of
`docs/claude/DEFAULT_TASK_PROVIDER_PLAN.md`: `publish()` and all three delivery factories already exist.

This adds **no new authority**. Every check below re-uses a fence that already exists and has been
reviewed. If building any part of it seems to need a new authority source, stop and ask. Do not invent one.

## 1. `assertCurrent(delivery, route, signal)`: two existing fences, both required

The CLI bridge calls this three times: before the receipt, before spawn, and before publish. Each call
must pass **both** fences, and each fence fails closed.

**A. Canonical task authority.** This re-uses the agent's own `*DispatchPreparationV1`.
1. From `delivery.identity`, read the attempt's lease in `control_leases`. Match on the same tenant
   and attempt, with `state = 'active'`. There must be exactly one such lease; zero or several → throw.
   Read `inputDigest` from the job row. Build the agent's existing
   `*DispatchReferenceV1 { tenantId, projectId, jobId, attemptId, leaseId, inputDigest }`.
2. Call `preparation.prepare(reference)`. It already refuses a lease that isn't active or has expired,
   a job or attempt that isn't `leased`, a plan or adapter mismatch, and expired job authority.
3. Require **all** of the following:
   - `current.delivery.identity.runId === delivery.identity.runId`. The run id is derived from the
     lease id plus the plan digest, so a replaced lease or plan fails here.
   - `worker`, `input`, `inputDigest`, `authorityDigest`, `connectorProfileDigest`, `acceptanceProfileId`,
     `acceptanceProfileDigest` and `expiresAt` are equal.
   - `canonicalJson(current.route) === canonicalJson(route)`.
   - Do **not** compare `issuedAt`, `deliveryId` or `deliveryDigest`. Every `prepare()` stamps
     `issuedAt` with the current time, and the other two are derived from it, so they change on every
     call. (Correction, same day: an earlier draft said to compare `deliveryId`, which would refuse
     every real task. The helper built on 2026-09-25 compared `deliveryDigest`, with the same effect;
     its tests passed only because they froze the clock.)
4. Build one shared helper, `src/harness/v1/owner-trusted-local-cli-assert-current.ts`. Give it the
   preparation instance as a parameter. Use it for all three agents. Do not write three copies.

**B. Owner enablement.** This is the mac-local stand-in for the VPS "current admission digest",
per critical-path decision 5.
- The worker's current readiness from the host's existing `workerReadiness.read()` must be `ready`.
  That covers the pinned executable path and recorded version still matching the enablement record.
- `delivery.worker` must equal the exact adapter registry binding for that worker kind.
- An owner re-pin, an executable change or a revoked enablement between calls must make the next
  call throw.

**Required tests** (fake executables, disposable PostgreSQL):
- The lease is revoked, and then separately replaced, between receipt and spawn: no spawn happens.
- The same thing happens between the end of the process and publish: nothing is published.
- The worker becomes not-ready between receipt and spawn: no spawn happens.
- A delivery for worker X is sent to worker Y's bridge: refused.

## 2. `receiptPort`: in-process, not an authority

**Status:** already built as `src/harness/v1/owner-trusted-local-cli-receipt-port.ts` (commit `cc4c59fa`)
and reviewed against this section: it grants nothing and mints only the standard receipt. The binding
check below is done by the delivery bridge's own `validate()` before the port is called, so the port
itself refuses only a non-local route or a worker mismatch.

- It's a same-process loopback `ControllerWorkerDeliveryPortV1`. It returns
  `disposition: "accepted"` only if all of these hold:
  - `route.kind === "local"`;
  - `route.workerId` equals the binding's worker;
  - `delivery.worker` equals the binding.
- Otherwise it returns `"rejected"`. `receiptDigest` is computed exactly as the receipt schema validates it.
- The one-shot execution fence is the **persisted, integrity-keyed receipt** that the bridge already
  writes. The port itself grants nothing.
- Do **not** reuse `codex-v1/local-delivery-composition.ts` or `claude-code-v1/local-delivery-composition.ts`.
  They implement a different, remote activation protocol.

## 3. Keys: a new protected file, not new fields

- Leave `MacLocalProtectedConfigurationV1` at its six keys.
- Add a separate owner-only, data-only file: `Protected/config/task-runtime.json` (0600, not a
  symlink), schema `control-room.mac-local-task-runtime/v1`, validated with an exact-keys check.
- It holds six 32-byte keys, base64url-encoded, **one per role**: `planning`, `review`, `harness`,
  `results`, `approvals` and `deliveryReceipt`. No two roles share a key. (Correction, same day: an
  earlier draft said one independent key per consumer. That would make startup refuse, because the
  existing code requires some consumers to share a key: `validateTaskQualityKeys` insists that the
  quality key equals the planner's review key and the website review key, that the quality harness
  key equals the website harness key, and that the quality results key equals the website results key.)
  The provider maps each role to its consumers:
  - `planning`: the planner's `integrityKey`;
  - `review`: the planner's `reviewIntegrityKey`, `quality.integrityKey`, the website review key and the
    durable result review key;
  - `harness`: the run store (`runIntegrityKey`), `quality.harnessIntegrityKey` and the website harness key;
  - `results`: the durable result `integrityKey`, `quality.results.integrityKey` and the website results key;
  - `approvals`: `NativeApprovalPacketStore`;
  - `deliveryReceipt`: the CLI bridge's receipt `integrityKey`.
- It also holds the protected Hermes run settings: profile, provider and model. These are data, not a
  source pin.
- Keys are generated once, by `pnpm mac:prepare-task-runtime` (built in package 3), with `crypto.randomBytes(32)`.
  - Any two identical keys → refuse.
  - A key of the wrong length → refuse.
  - The file exists but is invalid → refuse. Never regenerate over it.
  - `mac:up` never rewrites an existing file.
- It's never printed, logged, or put into task input.

## 4. The rest of the provider (reuse only)

- **Queue:** use `nativeQueue` plus `preparePgBossNativeTaskSubmission` on the coordinator role, the
  same way as the existing installed queue (`installed-native-queue.ts`).
- **Approvals:** use `NativeApprovalPacketStore` with the approvals key and an **empty remote-trust
  list**, as `tests/codex-owner-trusted-local-queue.test.ts` does. The owner's approval goes through the
  existing website approval route. If the journey's approve step can't complete with an empty trust
  list, stop and ask. Don't add a trust entry.
- **Routes:** three static local entries, one per worker.
- **Templates:** build three per active project when the provider starts.
  - Accepted limitation for W7: a project created after `mac:up` needs `mac:down && mac:up` before
    it can get tasks.
  - The 16-template cap limits this to about 5 projects.
  - State both points in `OWNER_GUIDE_MAC.md`. Refuse with a clear error instead of dropping
    templates silently.
- **Publish:** use the existing `createOwnerTrustedLocalCliPublishV1` with the results role.
  - Accepted limitation for this phase: a revocation that lands *during* the publish transaction is
    not caught mid-flight. Fence A runs immediately before publish.
  - Record this in `MAC_LOCAL_EVIDENCE.md` limitations.
- **Build entry:** add `macLocalDefaultTaskProvider` to `vite.vps.config.ts`, so that `up.mjs`'s
  existing `dist-vps/server/macLocalDefaultTaskProvider.js` path exists.

## 5. Rollback checkpoint: a protected file on the Mac (decided 2026-09-25)

The review system (`CompletionGateStoreV1`, the planner and the result services) needs an
`AwaitableRollbackCheckpointStoreV1`. Its contract says the checkpoint must be stored **outside the
database it protects**, so that restoring an old copy of the database is detected, not silently accepted.
The only production implementation is the etcd store, which this deployment doesn't run. The in-memory
store is test-only and must not be used.

**Decision:** a protected checkpoint file on the Mac, `<protected>/state/rollback-checkpoints.json`.
The database it protects is the VPS PostgreSQL, so this file is on a different machine. That's the
independent placement the contract asks for, and the etcd store exists to provide.

- **Store rules:**
  - `read` returns the scope's checkpoint.
  - `initialize` succeeds only for an absent scope at revision 1.
  - `advance` is a compare-and-swap: the stored checkpoint's digest must equal the expected digest,
    the scope must match, and the revision must be exactly one higher. Anything else throws.
- **Durability:** each write goes to a new private temporary file, is fsynced, is renamed over the
  target, and the directory is fsynced before the call returns. A failed write leaves the old file intact.
- **One writer:**
  - Calls are serialized inside the process.
  - An exclusive lock file holds the owning process id. A lock held by a live process refuses.
  - A lock left by a dead process is taken over, so a launchd crash-restart recovers.
- **Protection:** the directory is 0700 and the file 0600, with no symlinks. Content never appears in
  an error.
- **Failure is closed.** The review system initializes a checkpoint only for an empty review history,
  and every later read and write must match it. So each of these makes reviews refuse, never
  silently continue:
  - the file is lost while the database has state;
  - a Mac backup restores an older copy of the file;
  - the VPS database is restored to an earlier point.
- **Backup and restore rules:**
  1. Don't restore `rollback-checkpoints.json` by itself from a Mac backup.
  2. The M8 drill restores into a scratch database and never touches this file.
  3. A real VPS disaster recovery, or a lost or rolled-back checkpoint file, needs an owner-attended
     re-anchor: re-read the restored database's integrity row and re-initialize the checkpoint from it,
     after the owner confirms in an attached Terminal that the restore was intended. That command is
     **not** part of W7. Until it exists, recovery is a Claude-reviewed manual procedure, and the
     site stays refusing, which is the safe state.
- **Accepted limit:** this protects against a rollback or restore on the VPS side. Like the rest of the
  owner-trusted local model (critical path decision 3), it doesn't defend against a malicious process
  running as the owner on the Mac, which could edit both the file and the keys.

## 6. Package 4 composition map (answers Marvin's four questions, 2026-09-25)

Nothing here is a new authority. Every field comes from protected configuration that already exists,
from `task-runtime.json`, or from an existing class. Follow
`tests/codex-owner-trusted-local-queue.test.ts`, which is the **local** agent pattern. Don't follow
`tests/helpers/private-agent-task-composition.ts`: that's the remote-node (VPS) pattern with signed
node enrollments.

**The provider's call.** `createTaskApplication({ configuration, database, workerReadiness, databaseRoles, protectedRoot })`
calls `createMacLocalCurrentThreeAgentTaskApplicationV1` with:

- `web`: `{ tenantId: configuration.localOwnerSession.tenantId, workspaceId: configuration.workspaceId, tasks, database }`.
  - **Tenant (question 4):** the task lifecycle's tenant **is** the website's local owner tenant.
    The composition already refuses any mismatch between web, coordinator and Hermes.
  - `tasks` carries the same review, harness and results keys as the quality configuration below.
- `databaseRoles` and `openDatabase`: passed through. **Pools (question 4):**
  `createMacLocalRestrictedTaskApplicationV1` already opens the coordinator and results roles and closes
  them on failure. The provider doesn't open those two pools for the lifecycle.
- `coordinator` (**question 1: a new object built by the provider**, with no pools):
  - `scope: { tenantId, workspaceId }` (as above);
  - `planning`:
    - `template` and `additionalTemplates`: three per active project, capped at 16 (section 4);
    - `integrityKey: keys.planning`, `reviewIntegrityKey: keys.review`, `checkpoints:` the section 5 store;
    - `localAdapterAdmission: { enabledAdapters: [the three local adapter ids] }`;
  - `routes`: one per worker. Each takes `nodeId` from `enablement.nodeId`, `executorId` from its
    template's `authority.allowedExecutor`, and `capabilityProbeId` from the adapter's capability
    constant, with `maxConcurrentTasks: 1`, `requiredScratchBytes: 0`, and `leaseSeconds` at least the
    adapter deadline;
  - `approvals: { enrollments: [], store: new NativeApprovalPacketStore(keys.approvals, []) }`. Local
    agents enqueue through their own `enqueue*OwnerTrustedLocalTask` path, as in the Codex local-queue
    test, so no owner-signed remote approval packet is involved;
  - `quality`:
    - `integrityKey: keys.review`, `harnessIntegrityKey: keys.harness`,
      `results.integrityKey: keys.results`;
    - `checkpoints:` the same store, `scenarios: []`;
  - `nativeQueue: true`, and `nativeSubmission` from `preparePgBossNativeTaskSubmission` (the
    `installed-native-queue.ts` pattern). The host's existing `startQueueWorker` runs the queue worker.
- `hermes`, `claude`, `codex`: one queue executor each (see below).

**Dispatch preparations (question 2): built in the provider**, one per agent:
- `CodexOwnerTrustedLocalDispatchPreparationV1`, `ClaudeCodeLocalDispatchPreparationV1` and
  `HermesLocalDispatchPreparationV1`.
- Each takes a **provider-owned** read pool opened with `openDatabase(databaseRoles.coordinator)`,
  closed in the returned `close()`.
- Each takes a **read-only** `TaskExecutionPlanner` built with the same templates and keys (it's only
  used for `readInSession`).
- Each takes `{ workerId, adapterRevision }` from the enablement record. `adapterRevision` is the
  worker's `sha256Digest({ executablePath, recordedVersion })`, so a re-pin changes the revision and an
  in-flight delivery then fails `assertCurrent`, as intended.

**The per-worker base (question 3):**
- `db`: the provider-owned coordinator pool; `integrityKey: keys.deliveryReceipt`;
  `binding: { workerId, adapterId, adapterRevision }`;
- `receiptPort: createOwnerTrustedLocalCliReceiptPortV1()`;
- `assertCurrent: createOwnerTrustedLocalCliAssertCurrentV1(db, preparation, workerReadiness)`;
- `publish: createOwnerTrustedLocalCliPublishV1(...)`:
  - `runIntegrityKey: keys.harness`, publication integrity `keys.results` and review `keys.review`;
  - local artifact storage under `<protected>/runtime/artifacts` (0700);
  - `registerRun`: the existing `codexOwnerTrustedLocalRunRegistrationV1`,
    `hermesLocalRunRegistrationV1` or `ClaudeCodeLocalRunRegistrationV1`.

Then `createOwnerTrustedLocal{Codex,Claude,Hermes}DeliveryV1(base, executor, execution configuration)`
(Hermes uses `task-runtime.json`'s `hermes` settings), wrapped by the queue executors:
- `createCodexOwnerTrustedLocalQueueExecutorV1` and `createHermesLocalQueueExecutorV1`, which exist.
- **Claude is the one missing piece of code.** `createClaudeCodeLocalQueueExecutorV1` runs the heavier
  VPS `executeAssignedClaudeCodeLocalTaskV1` path. Add a mirror of the Codex executor,
  `createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId, preparation, delivery })`, using
  `claudeCodeLocalQueueTargetToDispatchReferenceV1`. Don't reuse the VPS executor for mac-local.

**Fleet signals (not yet on anyone's list):**
- `TaskAssignmentCoordinator.assign` needs a recent `telemetry` signal and a `capability` pass for the
  node before it assigns.
- On the Mac, the host records them through `FleetSignalStore.ingestAuthenticated`: one `capability`
  pass per **ready** worker (from the existing pinned-executable verification) and one `telemetry`
  signal.
- It refreshes them on an interval shorter than their expiry, and stops refreshing a worker that
  becomes unready, so assignment then refuses it.
- This derives only from existing readiness. If assignment needs anything beyond that, stop and ask.

**Wiring order in `mac:up`:** `mac:prepare-task-runtime` (idempotent), then the provider. On a fresh
install, call `CompletionGateStoreV1.provisionTenant` once; it refuses by itself if review state already
exists.

## 7. Fresh-install decisions (answers PACKAGE4_FRESH_INSTALL_FINDINGS.md, 2026-09-25)

**1. The local node record.**
- `mac:bootstrap-owner` also creates, idempotently, one `control_nodes` row for `enablement.nodeId`:
  - `state: 'active'`, `platform: "macos"`, `policyVersion: "mac-local/v1"`;
  - `identityKeyId: "local-owner:<nodeId>"`;
  - `hardwareFingerprint = sha256Digest({ purpose: "mac-local-node", nodeId })`;
  - `softwareFingerprint = ` the enablement record's digest.
- No raw hardware or host identity goes in.
- It creates **no** `control_node_keys` row, no enrollment challenge and no grant. The node therefore has
  no key, so the remote node protocol can never authenticate a frame as this node. Package 4 needs a
  test that proves a remote frame for this node is refused.
- An existing row that matches is kept. One that differs is refused, not overwritten.
- This row only lets `FleetSignalStore` record the readiness-derived signals from section 6. It grants
  nothing on its own.

**2. Review profiles for each project.**
- When the provider builds a project's three templates, it also registers one fixed local profile per
  project, if it's absent, with `CompletionGateStoreV1.registerProfile`:
  - `id: "profile:mac-local-owner-review"`, `name: "Owner review"`, `targetKind: "document"`;
  - `requiredVerificationScenarioIds: ["scenario:mac-local-text"]`, `minimumIndependentReviews: 1`;
  - `reviewerSeparation: { actor: true }` with every other field false;
  - `verificationRequiresProducerSeparation: true`, `minimumRisk: "low"`, `maximumRevisionRounds: 3`;
  - `automaticLowRiskDisposition: false`, so the owner's accept is always required;
  - `createdBy:` the local owner principal, `createdAt:` the project's own creation time.
- The content is deterministic, so its digest is the same on every restart.
- An existing profile with the same id and a different digest is refused.
- `quality.scenarios` gets the one matching `AutomaticDocumentScenario`, `scenario:mac-local-text`:
  non-empty UTF-8 text within the result size cap. Copy the descriptor shape from
  `tests/helpers/native-quality-completion.ts`.
- This sits within section 4's limit of three templates per project, 16 in total, with a restart needed
  for a new project.

**3. Hermes settings on first run.**
- `mac:up` doesn't take the settings.
- `mac:prepare-task-runtime` is a separate one-time setup step, before the first `mac:up`.
- If `task-runtime.json` is missing, `mac:up` fails with the exact prepare command to run. It never
  generates the file itself, and a valid existing file is untouched.
- The owner's current choice is on record (profile `cr`, provider `opencode-go`, model
  `space-bunny-free`), so Codex may run the prepare step with those values. Add them to the owner guide.

## 8. Contract-conflict decisions (answers PACKAGE4_SECTION7_CONTRACT_CONFLICT.md, 2026-09-25)

These replace the conflicting parts of sections 6 and 7. None of them changes
`TaskAssignmentCoordinator`, the remote node protocol, or any existing check.

**A. One node per worker (replaces "three routes on `mac-1`").**
- The enablement record's `nodeId: "mac-1"` stays the machine identity.
- Assignment uses three local node rows, one per worker: `mac-1.hermes`, `mac-1.claude` and
  `mac-1.codex`.
- There's one route per worker node, so `validateTaskAssignmentRoutes` keeps its one-route-per-node rule.
- The dispatch preparations never compare the attempt's node with the enablement's; they use
  `attempt.nodeId`. So a worker's deliveries carry its own node.
- Fleet signals are recorded per worker node: a capability pass while that worker is ready, plus
  telemetry.

**B. An unspendable identity key (replaces "no `control_node_keys` row").**
- `mac:bootstrap-owner` creates, for each worker node, one `control_node_keys` row
  (`algorithm: ed25519`, `state: active`, no `valid_until`).
- Its public key comes from a key pair generated in memory whose **private key is never exported,
  written, logged or returned**. The function returns only the public SPKI and fingerprint, and the
  private key object is dropped.
- The node row's `identityKeyId` names that key.
- The existing assignment key check then passes unchanged, and no one can ever sign a frame as the node.
- Keep Codex's remote-frame refusal test and extend it: a frame signed by a freshly generated key is
  refused for every worker node.
- Idempotent: an existing matching row is kept, and a differing one is refused.
- A "dummy" signing key would be one someone could use. This one can't be used, by construction, which
  is why it differs from the forbidden option.

**C. Profile ids per project (replaces the single `profile:mac-local-owner-review`).**
- The id is `profile:mac-local-owner-review:<projectId>`, or, if the id grammar or length doesn't allow
  that, `profile:mac-local-owner-review:` plus the first 32 hex characters of `sha256(projectId)`.
- Everything else in section 7.2 is unchanged.

**D. Template credential and network fields.**
- `credentialRefs` is exactly one fixed label per adapter: `credential:owner-cli:hermes`,
  `credential:owner-cli:claude-code` or `credential:owner-cli:codex`.
  - It's a label, not a secret.
  - It names the grant the owner already made in critical path decision 3: each agent runs with the
    owner's existing sign-in for that CLI.
- Hermes needs `networkPolicy: "allowlist"` with exactly one `allowedNetworkDestinations` entry: the
  canonical HTTPS origin of the model provider endpoint that the owner's chosen Hermes profile uses.
  - Record it in `task-runtime.json` as `hermes.destination`, validated with
    `parseCanonicalHttpsDestination`. Add it as a required `--hermes-destination` argument to
    `mac:prepare-task-runtime`.
  - The file hasn't been created on the real Mac yet, so the v1 schema can still change.
  - Codex reads the origin from the non-secret base-URL field of the `cr` profile's provider
    configuration. It reads no credential field; if the origin can't be read without touching a
    credential, it asks the owner.
  - Don't make up a destination.
- Claude and Codex keep `networkPolicy: "none"` with no destinations, as the planner requires.

**E. The Claude queue executor must mirror Codex's exactly (review finding from Marvin).**
- Call `preparation.assertCurrent(reference, prepared)` again **after** `delivery.deliver` returns
  `published`, before returning `delivered`.
- Throw the distinct `*_queue_delivery_unresolved` error when publication isn't confirmed, as
  `codex-owner-trusted-local-executor.ts` does. Don't use `unavailable`, which means "never ran".
- Add Marvin's two tests (commit `e1e928ef` on `codex/mac-w3-p4`):
  - an aborted signal is refused before `prepare()`;
  - a lease revoked between the two checks isn't acknowledged.

## 9. Review and done

- Split the work into packages of no more than about 800 lines, in this order:
  1. fence A plus fence B helper and tests;
  2. receipt port;
  3. `task-runtime.json` loader and generator;
  4. provider assembly plus build entry.
- Each package goes through `claude-review.mjs`. Packages 1 and 3 need an Opus review.
- **Done when**, on the rehearsal database:
  - `mac:up` starts;
  - `GET /api/v1/local-workers` lists all three workers as ready;
  - one fake-executable task per worker reaches pending review exactly once.
