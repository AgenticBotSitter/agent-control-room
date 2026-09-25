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
  - Record it in `task-runtime.json` as `hermes.destination` in canonical form, `https://<host>:<port>`
    with an explicit port and no path, validated with `parseCanonicalHttpsDestination`. Add it as a required `--hermes-destination` argument to
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

## 10. First-start decisions (answers PACKAGE4_FIRST_START_DECISION_NEEDED.md, 2026-09-25)

**1. Zero projects: start the website without the task host.**
- When the tenant has no active project, `mac:up` starts the existing website-only host.
  It does not construct the task provider. The status page and `GET /api/v1/local-workers`
  must say, truthfully, that task workers are **not started**:
  "create your first project, then run `mac:down && mac:up`". They must not report
  workers as ready or operational.
- Once at least one active project exists, `mac:up` starts the full task host (section 4's
  restart-per-new-project limitation).
- There is no fake or placeholder project, and no relaxation of `TaskExecutionPlanner`.
- The project creation time comes from `control_manual_project_heads.created_at`, joined to
  `projects`. That is approved.
- The owner guide states the first-start sequence. `mac:up` prints the same instruction when
  it starts website-only.
- **Follow-up (not package 4):** remove both the restart and the ~5-project cap by resolving a
  project's templates per request. The coordinator already constructs a planner per call.
  Track this as its own package, with an Opus review. The owner intends years of use, so the
  cap must not become permanent.

**2. The Hermes destination is `https://opencode.ai:443`.**
- Source (non-secret): Hermes's own provider table (`hermes_cli/auth.py`) gives `opencode-go`
  the base URL `https://opencode.ai/zen/go/v1`. The `OPENCODE_GO_BASE_URL` override is
  commented out in the main Hermes environment file and absent from the `cr` profile.
  Claude read the variable's name and origin only, never a credential value.
- Codex runs `mac:prepare-task-runtime --hermes-profile cr --hermes-provider opencode-go
  --hermes-model space-bunny-free --hermes-destination https://opencode.ai:443`.
- If the owner later sets `OPENCODE_GO_BASE_URL`, Hermes tasks fail closed on the allowlist
  until the prepare step is re-run. That is acceptable. Record it in the owner guide.

**3. Storage telemetry: approve a real, bounded measurement.**
- Each telemetry refresh calls `fs.statfs` on the protected artifact directory
  (`<protected>/runtime/artifacts`) and reports `bavail * bsize` as
  `availableStorageBytes: { quality: "observed", value }`.
- This is a real observation of the same volume the results are written to.
- If `statfs` fails, report `quality: "unavailable"` with no value, so assignment refuses.
  Never estimate or default a value.
- It uses one syscall per refresh interval and needs no new authority or permission.
- `evaluateFleetEligibility` and `requiredScratchBytes: 0` are unchanged.
- Add one test proving that a failed `statfs` refuses assignment.

**4a. Node fingerprint: stable across re-pins.**
- Each worker node's `softwareFingerprint` becomes
  `sha256Digest({ purpose: "mac-local-worker-node", nodeId, workerId, adapterId })`.
  This is the worker's identity, not its executable version.
- Version currency is already enforced where it matters: `adapterRevision` changes on
  `mac:repin`, so `assertCurrent` fails in-flight deliveries (section 6).
- A differing existing row is still refused. With the stable fingerprint, a difference now
  means a different layout or tampering, never a routine CLI update.

**4b. Unspendable key trust root: add a protected Mac-side pin.**
- The canonical database is on the VPS. Other local processes and roles share that server,
  so the database alone is not the whole trust root.
- When `mac:bootstrap-owner` creates the three key rows, it also writes their public key
  fingerprints to `<protected>/config/node-keys.json` (0600, exact keys, schema-versioned).
- At provider start, each `control_node_keys` row for the three worker nodes must match that
  file exactly. Refuse to start on:
  - a missing file while the rows exist;
  - rows missing while the file exists;
  - any mismatch.
- The first bootstrap creates both. Do not auto-repair either side; a mismatch is a
  stop-and-report.
- This detects a restored or pre-seeded *different* key. Migration 0008's immutability
  trigger remains the in-database protection.

**5. Database role isolation. SUPERSEDED by section 11: it is a W7 blocker, not a limitation.**
- Finding confirmed: the provisioner grants the broad `control_room_application` to all four
  local logins. `mac:check-database` proves identity and connectivity only.
- *(Withdrawn. The original rationale, "not a W7 blocker", was wrong. The preflights already
  require exact per-login roles. See section 11.)*

## 11. Package 5: exact database roles (decided 2026-09-25 after the package 4 rehearsal)

**Correction to 10.5.** Claude called broad membership an acceptable W7 limitation. That was
wrong. The existing preflights already require each login to inherit **exactly one** narrow
role (`verifySession`: exactly two member roles, the login and its role). The queue-worker
preflight (`verifyPgBossNativeWorkerPermissions`) also requires exact queue-table privileges.
The package 4 rehearsal therefore stopped at `native_queue_worker_start_failed`, which is
correct. Codex was right not to weaken it. **No preflight changes in package 5.**

The pattern already exists. Real-PostgreSQL tests (`tests/postgres-production-*.test.mjs`,
`tests/vps-built-*.test.mjs`, `scripts/test-pg17-restore.ts`) apply the narrow role files.
Package 5 wires the Mac-local provisioning into that pattern. It invents no new grants.

**A. Mapping, one narrow role per login, no `control_room_application`:**

| Login | Inherits only | Role file(s) |
|---|---|---|
| `control_room_web` | `control_room_private_web` | `private_web_roles.sql` |
| `control_room_coordinator` | `control_room_task_coordinator` | `task_coordinator_roles.sql` + `native_queue_producer_roles.sql` |
| `control_room_results` | `control_room_native_results` | `native_results_roles.sql` |
| `control_room_queue_worker` | `control_room_native_queue_worker` | `native_queue_worker_roles.sql` |

- Order:
  1. migrations;
  2. `production_roles.sql`;
  3. the offline pg-boss 12.30.0 install of `control_room_queue` with the fixed
     `native-task-delivery` queue (the same offline step the rehearsal fixture now uses;
     startup never creates it);
  4. the four role files;
  5. login membership.
- The role files say "fresh role only". Make the VPS-local provision step idempotent by
  **checking and refusing**, not by re-running blindly:
  - an existing narrow role whose effective privileges differ from the file's is a
    stop-and-report;
  - a login that already has any extra membership (for example `control_room_application`)
    gets it revoked only in the reviewed live step (C). The provisioner never silently
    rewrites membership.
- `mac:check-database` adds, per login, the matching existing preflight
  (`verifyPrivateWebDatabase`-equivalent / coordinator / results /
  `verifyNativeQueueWorkerDatabase`). It also adds one denied write per login: a statement
  outside its grants must fail with `permission denied`. Output says "least privilege: ok"
  only after those pass.

**B. Rehearsal (disposable real PG17, Mac):**
- fresh cluster → A's order;
- all four preflights pass with no fixture shortcuts; `mac:up` with one project;
- `/api/v1/local-workers` lists three ready workers;
- one harmless task per worker reaches pending review exactly once;
- negative tests: re-grant `control_room_application` to one login and prove its preflight
  refuses; drop one queue grant and prove the queue-worker preflight refuses.
- This also qualifies `native_queue_worker_roles.sql` and `native_queue_producer_roles.sql`
  on real PostgreSQL. Update their "PGlite only / unqualified" header comments with the
  test that proves it.

**C. Live (VPS, only after B passes and an Opus review):**
1. Read-only audit first (VPS operator, sanitized): which of the four narrow NOLOGIN roles
   exist; each local login's memberships; whether `control_room_queue` exists.
2. Then one VPS-local, transactional script:
   - install the queue schema if absent;
   - create the missing narrow roles from the files;
   - `GRANT <narrow> TO <login>`, then `REVOKE control_room_application FROM <login>`.
3. Nothing else changes: not other projects' roles, not `pg_hba`, not the migrator,
   application or scheduler logins.
4. Rollback is the reverse membership change. The narrow roles stay; they are inert
   without members.
5. Then the Mac runs `mac:check-database` over the direct route (W1). It must print least
   privilege ok for all four.

**D. Result inspection (package 6, separate):** after package 5, prove with one test per
agent that owner review can inspect, accept and request a revision on each current run shape.
The run records come from `codexOwnerTrustedLocalRunRegistrationV1`,
`ClaudeCodeLocalRunRegistrationV1` and `hermesLocalRunRegistrationV1` via
`createOwnerTrustedLocalCliPublishV1`. Fix the inspection source only where a test shows a
refusal. Don't widen what it accepts beyond those three shapes. Opus review.

**Model/effort:**
- package 5 A+B: Codex Terra, high effort (security-relevant grants);
- the review and the live step C: Opus-class, high effort;
- package 6: Terra medium, with an Opus review of the diff.

## 12. First-owner setup under exact roles (answers PACKAGE5_FIRST_OWNER_DECISION_NEEDED.md, 2026-09-25)

**Decision: first-owner setup is a one-time, VPS-local step run as `postgres` over the Unix socket.
The Mac never holds an installer credential, and `mac:up` never writes owner rows.**

This follows the existing precedent. `scripts/bootstrap-private-vps-owner.mjs` is an explicit,
one-time production write command with a separately approved connection and no automatic retry.
It also matches where privileged database work already runs after W1: migrations are applied
VPS-local as `postgres` (SECURE_DB_ROUTE "Migrations"), never from the Mac. Rejected options:
- the migrator on every `mac:up`, which makes an installer credential routine;
- granting the web role `INSERT` on `tenants`;
- seeding rows in tests.

**A. What moves into the one-time setup.** Everything the narrow roles cannot and should not do
at first install, in one transaction:
- `tenants`, `workspaces`, the owner identity and its role grant (from
  `bootstrapMacLocalOwnerV1`);
- the three `adapter_registry` rows;
- the three worker `control_nodes` rows and their unspendable `control_node_keys` rows (8.B).
  The key pair is generated in memory and the private key is dropped, on the VPS;
- `CompletionGateStoreV1.provisionTenant`;
- anything else the package 5 rehearsal shows a narrow role is refused at first start. List
  each addition in the rehearsal report. Don't widen a narrow role to avoid adding it here.

**B. Inputs: a non-secret manifest from the Mac.**
- New command: `mac:first-owner-manifest <protected-root> <out-file>`. It writes a
  schema-versioned JSON (`control-room.mac-local-first-owner-manifest/v1`) with only:
  - tenant, workspace, identity and grant ids;
  - display names;
  - the owner subject digest;
  - adapter ids and the three worker node ids;
  - `createdAt`.
- `assertNoSecretMaterial` is applied, the keys are exact, and nothing else goes in: no
  password, host, key or path.
- The owner hands the file to the VPS operator (for example through R2). It's safe to share.

**C. The VPS command.** `scripts/mac-local/first-owner-vps.mjs --manifest <file>`, run from the
Mac-local integration branch worktree on the VPS, as `runuser -u postgres` over the socket:
- one bounded transaction;
- **check and refuse** on any existing row that differs (tenant, workspace, identity, adapter,
  node, key). Matching rows are kept. Nothing is ever overwritten;
- no automatic retry. On uncertainty it prints the same "do not automatically retry" message as
  the VPS precedent;
- output: a receipt with row counts, created or kept, and the three **public** key
  fingerprints. They are public, not secret.

**D. The Mac's key pin (updates 10.4b).**
- New one-time command: `mac:pin-node-keys <protected-root>`, run by Codex right after C.
- It reads the three key rows through the coordinator login (read-only) and compares them with
  the fingerprints in C's receipt, supplied as an argument or file. Only if all three match does
  it write `<protected>/config/node-keys.json`.
- It is never run automatically. `mac:up` refuses when the pin is missing, as 10.4b already
  requires.

**E. Repeat starts (`mac:up`).** Order:
1. `mac:check-database`: the preflights and denied-write probes. These already need the owner
   binding, so on a fresh install they fail until C has run. That is correct.
2. A read-only binding verification through the narrow roles:
   - tenant, workspace, owner identity and grant, adapters, nodes and keys all exist;
   - they match the protected configuration;
   - the keys match the pin.
3. The website or task host.

- `bootstrap-owner.ts` becomes verify-only, or is removed from `mac:up`. No write path remains in
  `mac:up`.
- A missing binding prints: "first-owner setup has not been run; see OWNER_GUIDE_MAC.md". It
  does not attempt setup.

**F. Installer secrets leave the Mac.**
- After W1 and package 5 go live, the Mac's protected root keeps only the four local-login
  passwords.
- The migrator, application and scheduler passwords were generated on the Mac for the old SSH
  provisioning flow. They aren't needed there: VPS-local work uses `postgres` peer auth.
- In the 11.C live step:
  - the VPS operator rotates those three passwords VPS-side (nothing on the VPS runs the
    Control Room app, per the W1 inventory);
  - Codex then removes the Mac copies.
- This is not a deletion of anything in use. Record it in `MAC_LOCAL_EVIDENCE.md`.

**F2. Rehearsal (extends 11.B).** On a fresh disposable PG17:
1. roles;
2. `mac:first-owner-manifest`;
3. C, run locally as the cluster superuser, standing in for the VPS `postgres` peer;
4. `mac:pin-node-keys`;
5. `mac:up` passes all preflights;
6. three ready workers;
7. one task per worker reaches pending review exactly once.

Negative checks:
- running C twice keeps every row;
- C with one altered manifest id refuses;
- `mac:up` without C refuses with the setup message;
- a tampered key row fails the pin.

**Review note.** Codex's run of `claude-review.mjs` did not produce a verdict: it returned
"Not logged in". Package 5 therefore has **no** review verdict yet. The required Opus review will
be run by Claude in a separate session that didn't write the code, and recorded with its log.

## 13. Section 12 contract gaps (answers PACKAGE5_SECTION12_CONTRACT_GAPS.md, 2026-09-25)

**Gap 1: completion-gate genesis. The Mac precomputes it; the checkpoint is written only after
commit.**

The genesis integrity row is a pure function of the tenant id and `keys.review`:
- `revision: 1`, `recordCount: 0`;
- `stateDigest = sha256Digest({ tenantId, records: [] })`;
- `stateAuthTag = hmacSha256Tag(keys.review, { module: "completion-gate", tenantId, revision: 1,
  recordCount: 0, stateDigest })`.

That is exactly what `provisionTenant` computes for an empty tenant (`store.ts:119`). A MAC tag
over public values is not secret: the same tag sits in the database, readable by roles. So it may
travel in the manifest, and the key never leaves the Mac.

- **Store API (additive; `provisionTenant` unchanged):**
  - `CompletionGateStoreV1.genesisIntegrityV1(tenantId)` returns
    `{ revision, recordCount, stateDigest, stateAuthTag }` using the store's own private
    helpers;
  - `completeProvisionedTenantV1(tenantId)` is the Mac-side finisher (below).
  - A unit test proves that `genesisIntegrityV1` equals the row `provisionTenant` writes, for
    the same key and tenant.
- **Manifest (amends 12.B):** add `completionGateGenesis: { revision, recordCount, stateDigest,
  stateAuthTag }`. `assertNoSecretMaterial` still applies. The tag is not key material.
- **VPS command (12.C):** inserts that row verbatim, in the same transaction. Repeat run:
  - an existing identical row is kept;
  - any difference, including a higher revision, is kept untouched and reported
    (`completion_gate_state_advanced`);
  - it never rewrites a row.
- **Mac finisher (extends 12.D):** rename the D command `mac:complete-first-owner`. After the
  key pin passes, it runs `completeProvisionedTenantV1` through the coordinator login:
  1. It reads the integrity row. It **refuses** if the row is missing, or if revision ≠ 1,
     count ≠ 0, the digest differs, or the tag fails verification with `keys.review`.
  2. It checks the completion-gate records for the tenant are empty.
  3. Only then does it `checkpointInitialize` the revision 1 checkpoint.
  4. If a checkpoint already exists: keep it when it's identical; refuse when it differs.

  This command writes no database rows.
- **Why it's recoverable and fails closed:**
  - the checkpoint is written only **after** the VPS transaction has committed and been
    verified, so no orphaned checkpoint can exist;
  - a crash after commit and before the checkpoint is fixed by re-running
    `mac:complete-first-owner`;
  - `mac:up` refuses while either the pin or the checkpoint is missing;
  - it never trust-on-first-use accepts a later revision. A revision > 1 with no checkpoint
    is a stop-and-report.
- The coordinator role needs `SELECT` on `control_completion_gate_integrity` and
  `control_completion_gate_records`. If the reviewed role file lacks either, stop and report;
  don't add it silently.
- Keep Codex's removal of automatic completion-gate initialization from the task provider.

**Gap 2: worker ids go in the manifest.**
- Amend 12.B: `nodes` is an exact array of three `{ nodeId, workerId, adapterId }` entries,
  taken from protected enablement. These are public ids, not secrets.
- The VPS computes `softwareFingerprint` with the unchanged 10.4a formula, and `mac:up`
  verifies against enablement as before.
- Don't infer a worker id from a node id, and don't put derived fingerprints in the manifest.

**Gap 3: time fields, comparison policy and receipt.**
- **Time:** every row the VPS command creates uses the manifest's `createdAt` for
  `created_at`, `updated_at` and `enrolled_at`. The rows are therefore reproducible.
- **Repeat comparison:**
  - *identity* columns must match exactly: ids, tenant and workspace bindings, names,
    subject digest, adapter ids, node platform, policy version, hardware and software
    fingerprints, and key algorithm, public material and fingerprint;
  - *operational* columns (`updated_at`, `version`, any `*_lock`, `state`, `last_seen*`) are
    not compared, because the running system legitimately changes them. They are
    reported;
  - the exact identity and operational column lists live in code, one constant per table,
    with a test that fails if a table gains a column that isn't classified.
- **Receipt:** exact keys:
  `{ schema: "control-room.mac-local-first-owner-receipt/v1", manifestDigest, tenantId, created,
  kept, fingerprints: { [nodeId]: digest } }`.
  - `manifestDigest = sha256Digest(manifest)` binds the receipt to its input;
  - `mac:complete-first-owner` refuses a receipt whose `manifestDigest` or `tenantId` doesn't
    match the manifest the Mac generated. The Mac keeps a copy of the manifest in
    `<protected>/config`.
  - `created + kept` must equal the fixed row total.

**Rehearsal (amends 12.F2):**
- step 4 becomes `mac:complete-first-owner`;
- extra negative checks:
  - a manifest with an altered genesis tag, so the finisher refuses;
  - a receipt with the wrong `manifestDigest`, so the finisher refuses;
  - re-running the finisher, which keeps the checkpoint;
  - deleting the checkpoint after the tenant has advanced, so the finisher refuses and
    `mac:up` refuses.

## 14. Local task approval and submission (Claude review, 2026-09-25)

**Finding 1: no signed approval packet is needed for Mac-local tasks. Don't build a test-only
signer.**
- The three local approve paths, `TaskAssignmentCoordinator.enqueueHermesLocalTask`,
  `enqueueClaudeCodeLocalTask` and `enqueueCodexOwnerTrustedLocalTask`, authorize through the
  owner's website session (`WebSessionAuthority`) and `actor.require("tasks.approve", projectId,
  true)`. The `true` means owner-only.
- The local owner session is the owner. It uses a loopback origin, the owner code and an
  in-memory session. That is the approval, and it is the intended trust model (critical path
  decision 3: the owner's own agents on the owner's own Mac).
- Signed native approval packets belong to the **remote** path (`enqueueNativeTask`,
  `enqueueCodexTask`), which the provider deliberately configures with `enrollments: []`.

**Finding 2 (blocker): the website cannot submit a Mac-local task at all.**
- `task-http.ts` submission calls `lifecycle.submission.enqueue`, which is
  `enqueueNativeTask`: the remote, signed-packet path.
- With `enrollments: []` it can never succeed. Nothing in `src` calls the three local enqueue
  methods.
- So even with every role correct, the owner could not start a task. This is why no end-to-end
  local journey exists.

**Decision: a Mac-local submission operation. The same route shape, with no new authority.**
- In the Mac-local task application, `submission.enqueue` dispatches **by the stored job's type**
  (never by a request field): Hermes local, Claude Code local, or Codex owner-trusted local go to
  the matching `enqueue*LocalTask`. Any other type is `conflict`.
- The remote path is not reachable from Mac-local.
- **Confirm what you saw.** Each local enqueue derives `packetDigest` server-side from the plan,
  authority, attempt, lease and route. Add a read-only `preview` to the same operation, returning
  that exact `packetDigest` for the current lease. The UI shows it and posts it back as
  `expectedPacketDigest`. The enqueue refuses unless it matches, as `expectedInputDigest` already
  works.
  - Either expose each local method's digest computation as a pure helper, or return the digest
    from a read in the same session.
  - Don't duplicate the formula in the route.
- `submission.read` and `readDelivery` stay as they are; the local deliveries already have
  `locate*` readers.
- **Tests:**
  - one per agent: owner session, preview, submit, then queued exactly once, with a replay
    returning the same receipt;
  - a mismatched `expectedPacketDigest` is refused;
  - a non-owner or missing session is refused;
  - a remote job type on Mac-local is refused;
  - dispatch ignores any client-supplied kind.

**Then the Package 5 journey (section 9's done condition):**
- on disposable PG17 with exact roles: project, proposal, plan, assignment, then preview and
  submit per agent;
- the worker runs a **fake pinned executable**. The rehearsal already builds `fake-workers` and
  pins their versions, so it runs the production process adapters with a test executable, not a
  code seam;
- the result reaches pending review exactly once per agent;
- record the evidence in `PACKAGE5_REHEARSAL_STATUS.md`.

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
