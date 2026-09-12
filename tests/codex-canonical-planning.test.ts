import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { CODEX_APP_SERVER_ADAPTER, CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE,
  CODEX_START_OPERATION } from "../src/harness/codex-v1/delivery-contract";
import { createCodexOwnerPermitIssuer } from "../src/harness/codex-v1/owner-permit";
import type { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { jobRecordSchema } from "../src/domain/v1";
import { readNativeTaskQueueIntentInSession } from "../src/web/v1/native-task-queue";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute } from "../src/web/v1/task-assignment-coordinator";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

async function setup() {
  const f = await ownerReviewFixture();
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_START_OPERATION], credentialRefs: ["credential:codex"], filesystemRoots: ["/synthetic/project"],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:codex", adapter: CODEX_APP_SERVER_ADAPTER, authority,
    instructions: "Use the assigned workspace only and return bounded text evidence.",
    connectorProfileDigest: sha256Digest("codex-profile"), workspaceIntentDigest: sha256Digest("codex-workspace"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(81),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "codex-planning-source-001");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route: TaskAssignmentRoute = { nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CODEX_APP_SERVER_CAPABILITY, maxConcurrentTasks: 8, requiredScratchBytes: 100, leaseSeconds: 60 };
  const signals = new FleetSignalStore(f.db);
  const common = { schemaVersion: "1.0.0" as const, tenantId: binding.tenantId, nodeId: binding.nodeId, sequence: 1,
    observedAt: at(6000), expiresAt: at(120_000), trust: "reported" as const };
  const telemetry: FleetSignalEnvelope = { ...common, fingerprint: sha256Digest("codex-telemetry"), kind: "telemetry",
    source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 20 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { ...common, expiresAt: at(300_000), fingerprint: sha256Digest("codex-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: CODEX_APP_SERVER_CAPABILITY,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6000), binding);
  await signals.ingestAuthenticated(capability, at(6000), binding);
  const approvalKeys = generateKeyPairSync("ed25519"), approvalKeyId = "approval-key:codex-test";
  const publicKeySpki = approvalKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const approvals = { binding: () => ({ tenantId: binding.tenantId, nodeId: binding.nodeId, nodeClass: "personal-compute" }),
    assertAvailable() {}, async resolveApprovalKey(keyId: string) {
      return keyId === approvalKeyId ? new Uint8Array(Buffer.from(publicKeySpki, "base64url")) : undefined;
    } } as unknown as PinnedApprovalTrustStore;
  const codexIntegrityKey = new Uint8Array(32).fill(83);
  const codexConfig = { integrityKey: codexIntegrityKey, enrollments: [{ tenantId: binding.tenantId, nodeId: binding.nodeId, nodeClass: "personal-compute",
      enrollmentDigest: sha256Digest("codex-enrollment"), connectorProfileDigest: template.connectorProfileDigest!,
      workspaceIntentDigest: template.workspaceIntentDigest!, credentialRef: authority.credentialRefs[0],
      filesystemRoot: authority.filesystemRoots[0], validUntil: instant + 180_000, approvalKeyId, approvals,
      security: { currentServerTrustRevision: () => "trust-revision:codex-test" } }] };
  const assignment = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], () => instant + 8000, [], undefined, undefined, codexConfig);
  return { ...f, authority, template, planner, planned, route, assignment, approvalKeys, publicKeySpki, codexIntegrityKey, codexConfig };
}

test("owner planning and assignment produce one canonical Codex reservation without starting work", async () => {
  const f = await setup();
  try {
    const saved = await f.planner.read(f.planned.receipt.jobId);
    assert.equal(saved?.schema, "control-room.task-execution-plan/v3");
    assert.equal(saved?.job.jobType, CODEX_APP_SERVER_JOB_TYPE);
    assert.equal(saved?.job.requiredCapability, CODEX_APP_SERVER_CAPABILITY);
    assert.equal(saved?.job.authority.digest, f.authority.digest);
    if (saved?.schema !== "control-room.task-execution-plan/v3") assert.fail("missing Codex plan");
    assert.equal(saved.connectorProfileDigest, f.template.connectorProfileDigest);
    assert.equal(saved.workspaceIntentDigest, f.template.workspaceIntentDigest);
    const options = await f.assignment.options(f.identity, binding.projectId, saved!.job.id);
    assert.deepEqual(options.candidates.map(candidate => candidate.nodeId), [binding.nodeId]);
    const assigned = await f.assignment.assign(f.identity, binding.projectId, saved!.job.id, binding.nodeId, saved!.job.inputDigest);
    assert.equal(assigned.receipt.leaseState, "active");
    assert.equal(assigned.receipt.startsWork, false);
    assert.equal(assigned.receipt.grantsExecutionAuthority, false);
    const current = jobRecordSchema.parse(await new CanonicalStore(f.db).get(binding.tenantId, "job", saved!.job.id));
    assert.equal(current.state, "leased");
    const replay = await f.assignment.assign(f.identity, binding.projectId, saved.job.id, binding.nodeId, saved.job.inputDigest);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, assigned.receipt);
    const approval = await f.assignment.prepareCodexOwnerPermit(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest);
    const issuer = createCodexOwnerPermitIssuer(approval.input, { publicKeySpki: f.publicKeySpki, timeoutMs: 1000,
      clock: () => instant + 8000, assertOwnerConsentCurrent: () => approval.assertCurrent(),
      sign: async bytes => sign(null, bytes, f.approvalKeys.privateKey) });
    assert.match(issuer.reviewDigest, /^sha256:[a-f0-9]{64}$/);
    const permit = await issuer.issue(new AbortController().signal);
    const queued = await f.assignment.enqueueCodexTask(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest,
      permit, new AbortController().signal);
    assert.equal(queued.startsWork, false); assert.equal(queued.grantsExecutionAuthority, false);
    const intent = await f.db.transaction(tx => readNativeTaskQueueIntentInSession(tx, f.codexIntegrityKey,
      { tenantId: binding.tenantId, projectId: binding.projectId, jobId: saved.job.id,
        attemptId: assigned.receipt.attemptId, inputDigest: saved.job.inputDigest }));
    assert.equal(intent?.jobId, saved.job.id);
    await assert.rejects(f.assignment.enqueueCodexTask(f.identity, binding.projectId, saved.job.id, saved.job.inputDigest,
      permit, new AbortController().signal));
  } finally { await f.close(); }
});

test("Codex templates cannot borrow Hermes network authority or bypass explicit assignment", async () => {
  const f = await setup();
  try {
    const wrong = structuredClone(f.template);
    wrong.authority.networkPolicy = "allowlist";
    wrong.authority.allowedNetworkDestinations = ["https://agent.example.test:443"];
    wrong.authority.filesystemRoots = [];
    wrong.authority.digest = computeAuthorityDigest(wrong.authority);
    assert.throws(() => new TaskExecutionPlanner(f.db, f.scope, { template: wrong,
      integrityKey: new Uint8Array(32).fill(82), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }),
    /unsupported native task template/);
    await assert.rejects(f.assignment.assign(f.identity, binding.projectId, f.planned.receipt.jobId,
      "node:other", f.planned.receipt.inputDigest));
    assert.equal((await f.planner.read(f.planned.receipt.jobId))?.job.state, "proposed");
    const assigned = await f.assignment.assign(f.identity, binding.projectId, f.planned.receipt.jobId,
      binding.nodeId, f.planned.receipt.inputDigest);
    const wrongConfig = { ...f.codexConfig, enrollments: f.codexConfig.enrollments.map(value => ({ ...value,
      connectorProfileDigest: sha256Digest("wrong-connector") })) };
    const wrongCoordinator = new TaskAssignmentCoordinator(f.db, f.scope, f.planner, [f.route], () => instant + 8000,
      [], undefined, undefined, wrongConfig);
    await assert.rejects(wrongCoordinator.prepareCodexOwnerPermit(f.identity, binding.projectId, assigned.receipt.jobId,
      assigned.receipt.inputDigest));
  } finally { await f.close(); }
});
