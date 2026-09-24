import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
  CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1, CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import { deliverVerifiedCodexOwnerTrustedLocalQueueTaskV1 } from "../src/web/v1/codex-owner-trusted-local-queue-delivery";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import type { NativeTaskSubmission } from "../src/persistence/native-task-submission";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

test("a managed local Codex plan uses the shared approval queue and exposes only a verified locator", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:codex",
    allowedOperations: [CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:codex"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:codex-local-queue", adapter: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text review only.", connectorProfileDigest: sha256Digest("mac-local-codex-profile"),
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(44),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints,
    localAdapterAdmission: { enabledAdapters: [CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1] } }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "codex-local-queue-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v13");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v13") throw new Error("missing Codex local plan");
  assert.equal(saved.job.jobType, CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1);

  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 3, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  const signals = new FleetSignalStore(f.db);
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("codex-local-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("codex-local-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "fixture" } };
  await signals.ingestAuthenticated(telemetry, at(6_000), binding);
  await signals.ingestAuthenticated(capability, at(6_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const queuedReferences: Parameters<NativeTaskSubmission["enqueueInSession"]>[1][] = [];
  const submissions: NativeTaskSubmission = { async enqueueInSession(_tx, reference) { queuedReferences.push(reference); } };
  const queuedCoordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000,
    [], new NativeApprovalPacketStore(new Uint8Array(32).fill(45), []), submissions);
  const queued = await queuedCoordinator.enqueueCodexOwnerTrustedLocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(queued.replayed, false);
  assert.equal(queuedReferences.length, 1);
  const located = await queuedCoordinator.locateApprovedCodexOwnerTrustedLocalQueueDelivery(queuedReferences[0]!, new AbortController().signal);
  assert.equal(located.kind, "codex-owner-trusted-local");
  assert.equal(located.leaseId, assigned.receipt.leaseId);
  assert.deepEqual(located.task, { projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, inputDigest: planned.receipt.inputDigest });
  const shared = await queuedCoordinator.locateQueuedHarnessDelivery(queuedReferences[0]!, new AbortController().signal);
  assert.equal(shared.kind, "codex-owner-trusted-local", "the ordinary queue selects the managed local Codex route");
  let delivered = 0;
  await deliverVerifiedCodexOwnerTrustedLocalQueueTaskV1({ reference: queuedReferences[0]!, target: located,
    signal: new AbortController().signal, deliver: async target => {
      delivered++; assert.equal(target.startsWork, false); assert.equal(target.grantsExecutionAuthority, false);
    } });
  assert.equal(delivered, 1, "the queue forwards only the rechecked locator; it does not start Codex itself");
  const replay = await queuedCoordinator.enqueueCodexOwnerTrustedLocalTask(f.identity, binding.projectId, planned.receipt.jobId,
    planned.receipt.inputDigest, new AbortController().signal);
  assert.equal(replay.replayed, true);
  assert.equal(queuedReferences.length, 1, "replay does not create a second queue submission");
});
