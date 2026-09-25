import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { HERMES_LOCAL_ADAPTER_V1, HERMES_LOCAL_CAPABILITY_V1, HERMES_LOCAL_JOB_TYPE_V1,
  HERMES_LOCAL_START_OPERATION_V1 } from "../src/harness/hermes-local-v1";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1,
  CLAUDE_CODE_LOCAL_START_OPERATION_V1 } from "../src/harness/claude-code-v1";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
  CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1, CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { CODEX_APP_SERVER_ADAPTER, CODEX_APP_SERVER_JOB_TYPE, CODEX_START_OPERATION } from "../src/harness/codex-v1/delivery-contract";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute } from "../src/web/v1/task-assignment-coordinator";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";
import { request, token, trust } from "./helpers/web-foundation";
import { taskSubmissionDraftSchema } from "../src/web/v1/task-submission-wire";

type Fixture = Awaited<ReturnType<typeof ownerReviewFixture>>;

async function signals(f: Fixture, capabilityProbeId: string, seed: string) {
  const store = new FleetSignalStore(f.db);
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest(`${seed}-telemetry`),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest(`${seed}-capability`),
    kind: "capability", source: "probe_runner", payload: { probeId: capabilityProbeId, probeVersion: "1.0.0", outcome: "pass", reasonCode: "fixture" } };
  await store.ingestAuthenticated(telemetry, at(6_000), binding);
  await store.ingestAuthenticated(capability, at(6_000), binding);
}

/** Builds one assigned job for the named local adapter and returns a
 * `TaskAssignmentCoordinator` wired with a durable (in-memory) queue, ready
 * for `previewMacLocalTask`/`enqueueMacLocalTask`. */
async function setupLocalJob(f: Fixture, kind: "hermes-local" | "claude-code-local" | "codex-owner-trusted-local", seed: number) {
  const authority: NativeTaskTemplate["authority"] = kind === "hermes-local"
    ? { projectId: binding.projectId, allowedExecutor: "executor:marvin", allowedOperations: [HERMES_LOCAL_START_OPERATION_V1],
      credentialRefs: ["credential:marvin"], filesystemRoots: [], networkPolicy: "allowlist",
      allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required", maxRisk: "low",
      maxDurationSeconds: 120, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" }
    : kind === "claude-code-local"
      ? { projectId: binding.projectId, allowedExecutor: "executor:claude", allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1],
        credentialRefs: ["credential:claude"], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
        effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" }
      : { projectId: binding.projectId, allowedExecutor: "executor:codex", allowedOperations: [CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1],
        credentialRefs: ["credential:codex"], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
        effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const adapter = kind === "hermes-local" ? HERMES_LOCAL_ADAPTER_V1
    : kind === "claude-code-local" ? CLAUDE_CODE_LOCAL_ADAPTER_V1 : CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1;
  const capabilityProbeId = kind === "hermes-local" ? HERMES_LOCAL_CAPABILITY_V1
    : kind === "claude-code-local" ? CLAUDE_CODE_LOCAL_CAPABILITY_V1 : CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1;
  const connectorProfileDigest = kind === "claude-code-local" ? CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 : sha256Digest(`mac-local-${kind}-profile`);
  const template: NativeTaskTemplate = { id: `template:mac-local-submission-${kind}`, adapter, authority,
    instructions: "Return a bounded plain-text result.", connectorProfileDigest,
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(seed),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints, localAdapterAdmission: { enabledAdapters: [adapter] } },
  () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, `mac-local-submission-${kind}-source`);
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route: readonly TaskAssignmentRoute[] = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId, maxConcurrentTasks: 3, requiredScratchBytes: 0, leaseSeconds: 60 }];
  await signals(f, capabilityProbeId, `${kind}-${seed}`);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const queuedReferences: Parameters<NativeTaskSubmission["enqueueInSession"]>[1][] = [];
  const submission: NativeTaskSubmission = { async enqueueInSession(_tx, reference) { queuedReferences.push(reference); } };
  const coordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(seed + 1), []), submission);
  return { coordinator, projectId: binding.projectId, jobId: planned.receipt.jobId, inputDigest: planned.receipt.inputDigest,
    leaseId: assigned.receipt.leaseId, queuedReferences };
}

/** A non-owner identity: `operator` role, granted `tasks.approve` explicitly,
 * so a refusal proves the owner-only fence, not merely a missing action. */
async function operatorIdentity(f: Fixture) {
  const now = new Date(instant).toISOString();
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:mac-local-operator','tenant:test','human','Non-owner operator',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "mac-local-operator" }), now]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:mac-local-operator','tenant:test','identity:mac-local-operator','operator',$1::jsonb,$2::jsonb,'low',false,false,$3,$3)`,
  [JSON.stringify(["tasks.read", "tasks.approve"]), JSON.stringify([binding.projectId]), now]);
  const jwt = token({ sub: "mac-local-operator", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  return createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
}

for (const kind of ["hermes-local", "claude-code-local", "codex-owner-trusted-local"] as const) {
  test(`mac-local submission (${kind}): preview then submit queues exactly once, and a replay returns the same receipt`, async t => {
    const f = await ownerReviewFixture(); t.after(f.close);
    const rig = await setupLocalJob(f, kind, 90);
    const preview = await rig.coordinator.previewMacLocalTask(f.identity, rig.projectId, rig.jobId, rig.inputDigest);
    assert.equal(preview.projectId, rig.projectId); assert.equal(preview.jobId, rig.jobId);
    assert.match(preview.packetDigest, /^sha256:[0-9a-f]{64}$/);
    // The preview never dispatches by a client-supplied kind: this exact same
    // (identity, projectId, jobId, inputDigest, packetDigest, signal) shape is
    // used for every adapter, and only the stored job's own type decides
    // which local method actually runs.
    const queued = await rig.coordinator.enqueueMacLocalTask(f.identity, rig.projectId, rig.jobId, rig.inputDigest,
      preview.packetDigest, new AbortController().signal);
    assert.equal(queued.replayed, false);
    assert.equal(queued.packetDigest, preview.packetDigest);
    assert.equal(rig.queuedReferences.length, 1);
    const replay = await rig.coordinator.enqueueMacLocalTask(f.identity, rig.projectId, rig.jobId, rig.inputDigest,
      preview.packetDigest, new AbortController().signal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.queueId, queued.queueId);
    assert.equal(replay.packetDigest, queued.packetDigest);
    assert.equal(rig.queuedReferences.length, 1, "replay does not create a second queue submission");
  });

  test(`mac-local submission (${kind}): a mismatched expectedPacketDigest is refused before any write`, async t => {
    const f = await ownerReviewFixture(); t.after(f.close);
    const rig = await setupLocalJob(f, kind, 100);
    await assert.rejects(() => rig.coordinator.enqueueMacLocalTask(f.identity, rig.projectId, rig.jobId, rig.inputDigest,
      sha256Digest("a-different-packet-than-the-preview"), new AbortController().signal), (error: unknown) =>
      error instanceof WebAccessError && error.code === "conflict");
    assert.equal(rig.queuedReferences.length, 0, "a digest mismatch must not queue anything");
  });

  test(`mac-local submission (${kind}): a non-owner session is refused`, async t => {
    const f = await ownerReviewFixture(); t.after(f.close);
    const rig = await setupLocalJob(f, kind, 110);
    const operator = await operatorIdentity(f);
    await assert.rejects(() => rig.coordinator.previewMacLocalTask(operator, rig.projectId, rig.jobId, rig.inputDigest),
      (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
    await assert.rejects(() => rig.coordinator.enqueueMacLocalTask(operator, rig.projectId, rig.jobId, rig.inputDigest,
      sha256Digest("irrelevant"), new AbortController().signal),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
    // The job-type read happens only after the owner check: a missing job looks
    // the same as an existing one to a non-owner.
    await assert.rejects(() => rig.coordinator.previewMacLocalTask(operator, rig.projectId, `${rig.jobId}x`, rig.inputDigest),
      (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
    assert.equal(rig.queuedReferences.length, 0);
  });
}

test("mac-local submission: a remote/native job type is refused, never reaching enqueueNativeTask", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_START_OPERATION], credentialRefs: ["credential:codex"], filesystemRoots: ["/synthetic/project"],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:mac-local-submission-remote-codex", adapter: CODEX_APP_SERVER_ADAPTER, authority,
    instructions: "Use the assigned workspace only and return bounded text evidence.",
    connectorProfileDigest: sha256Digest("codex-profile"), workspaceIntentDigest: sha256Digest("codex-workspace"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(120),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "mac-local-submission-remote-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.job.jobType === CODEX_APP_SERVER_JOB_TYPE, "fixture must produce a remote Codex job type");
  const coordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, [],
    () => instant + 8_000, [], new NativeApprovalPacketStore(new Uint8Array(32).fill(121), []),
    { async enqueueInSession() { throw new Error("must not be reached for a remote job type"); } });
  await assert.rejects(() => coordinator.previewMacLocalTask(f.identity, binding.projectId, planned.receipt.jobId, planned.receipt.inputDigest),
    (error: unknown) => error instanceof WebAccessError && error.code === "conflict");
  await assert.rejects(() => coordinator.enqueueMacLocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, sha256Digest("irrelevant"), new AbortController().signal),
  (error: unknown) => error instanceof WebAccessError && error.code === "conflict");
});

test("mac-local submission: the wire draft schema has no field that could select a dispatch kind", () => {
  assert.deepEqual(Object.keys(taskSubmissionDraftSchema.shape).sort(), ["expectedInputDigest", "expectedPacketDigest"]);
  assert.equal(taskSubmissionDraftSchema.safeParse({ expectedInputDigest: sha256Digest("a"), expectedPacketDigest: sha256Digest("b"),
    kind: "codex-owner-trusted-local" }).success, false, "an extra client-supplied kind must be rejected, not silently accepted");
});
