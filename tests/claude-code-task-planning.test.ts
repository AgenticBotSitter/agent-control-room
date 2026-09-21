import assert from "node:assert/strict";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1,
  CLAUDE_CODE_LOCAL_CAPABILITY_V1, CLAUDE_CODE_LOCAL_JOB_TYPE_V1,
  CLAUDE_CODE_LOCAL_START_OPERATION_V1 } from "../src/harness/claude-code-v1";
import { TaskExecutionPlanner, nativeTaskTemplateSchema, type NativeTaskTemplate } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator, validateTaskAssignmentRoutes } from "../src/web/v1/task-assignment-coordinator";
import { FleetSignalStore } from "../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../src/node-fleet/v1/schemas";
import { ClaudeCodeLocalDispatchPreparationV1 } from "../src/harness/claude-code-v1/dispatch-preparation";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { ownerReviewFixture } from "./helpers/web-owner-review";
import { taskDraft } from "./helpers/web-task";

test("a local Claude task can be saved and prepared as a signed local delivery without starting Claude", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:claude",
    allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:claude"], filesystemRoots: [],
    networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:claude-local", adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, authority,
    instructions: "Return a bounded plain-text review only.", connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template, integrityKey: new Uint8Array(32).fill(74),
    reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "claude-local-plan-source");
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const replay = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  assert.equal(replay.replayed, true, "the same proposal produces one durable plan");
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.schema === "control-room.task-execution-plan/v9");
  if (!saved || saved.schema !== "control-room.task-execution-plan/v9") throw new Error("missing Claude plan");
  assert.equal(saved.adapter, CLAUDE_CODE_LOCAL_ADAPTER_V1);
  assert.equal(saved.connectorProfileDigest, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(saved.executionClass, "text_review");
  assert.equal(saved.job.jobType, CLAUDE_CODE_LOCAL_JOB_TYPE_V1);
  assert.equal(saved.job.requiredCapability, CLAUDE_CODE_LOCAL_CAPABILITY_V1);
  assert.equal(planned.receipt.startsWork, false);
  assert.equal(planned.receipt.grantsExecutionAuthority, false);

  const route = [{ nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1, maxConcurrentTasks: 3, requiredScratchBytes: 0, leaseSeconds: 60 }] as const;
  assert.doesNotThrow(() => validateTaskAssignmentRoutes(route),
    "the shared coordinator recognizes Claude's capability; private startup still keeps it unadmitted until separate proof and host composition exist");

  const signals = new FleetSignalStore(f.db);
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("claude-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 10 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6_000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("claude-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: CLAUDE_CODE_LOCAL_CAPABILITY_V1,
      probeVersion: "1.0.0", outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6_000), binding);
  await signals.ingestAuthenticated(capability, at(6_000), binding);
  const assignments = new TaskAssignmentCoordinator(f.db, f.scope, planner, route, () => instant + 8_000);
  const assigned = await assignments.assign(f.identity, binding.projectId, planned.receipt.jobId, binding.nodeId, planned.receipt.inputDigest);
  const preparation = new ClaudeCodeLocalDispatchPreparationV1(f.db, planner,
    { workerId: "worker:claude-local", adapterRevision: "source-123" }, () => instant + 9_000);
  const dispatch = await preparation.prepare({ tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: planned.receipt.jobId, attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId,
    inputDigest: planned.receipt.inputDigest });
  assert.equal(dispatch.delivery.worker.adapterId, CLAUDE_CODE_LOCAL_ADAPTER_V1);
  assert.equal(dispatch.delivery.identity.attemptId, assigned.receipt.attemptId);
  assert.equal(dispatch.route.kind, "local");
  assert.equal(dispatch.startsWork, false);
  assert.equal(dispatch.grantsExecutionAuthority, false);
  await preparation.assertCurrent({ tenantId: binding.tenantId, projectId: binding.projectId, jobId: planned.receipt.jobId,
    attemptId: assigned.receipt.attemptId, leaseId: assigned.receipt.leaseId, inputDigest: planned.receipt.inputDigest }, dispatch);

  const foreignProfile = { ...template, connectorProfileDigest: sha256Digest("foreign-claude-profile") };
  assert.throws(() => nativeTaskTemplateSchema.parse(foreignProfile), /unsupported native task template/);
});

test("one project can offer reviewed local workers without silently choosing one", async t => {
  const f = await ownerReviewFixture(); t.after(f.close);
  const make = (id: string, executor: string): NativeTaskTemplate => {
    const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: executor,
      allowedOperations: [CLAUDE_CODE_LOCAL_START_OPERATION_V1], credentialRefs: ["credential:claude"], filesystemRoots: [],
      networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "approval_required", maxRisk: "low",
      maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
    authority.digest = computeAuthorityDigest(authority);
    return { id, adapter: CLAUDE_CODE_LOCAL_ADAPTER_V1, authority, instructions: "Return bounded review text.",
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, acceptanceProfileId: f.profile.id,
      acceptanceProfileDigest: sha256Digest(f.profile) };
  };
  const first = make("template:claude-one", "executor:claude-one");
  const second = make("template:claude-two", "executor:claude-two");
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template: first, additionalTemplates: [second],
    integrityKey: new Uint8Array(32).fill(75), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7_000);
  assert.deepEqual(planner.templatesForProject(binding.projectId).map(value => value.id), [first.id, second.id]);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "claude-template-choice-source");
  await assert.rejects(() => planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft)), /conflict/);
  const planned = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft), second.id);
  const saved = await planner.read(planned.receipt.jobId);
  assert.ok(saved && saved.templateDigest === sha256Digest(second));
  assert.equal(await planner.readPreparedWorker(f.identity, binding.projectId, source.receipt.jobId), null,
    "the source proposal is not presented as prepared for a worker");
  assert.equal(await planner.readPreparedWorker(f.identity, binding.projectId, planned.receipt.jobId), "claude",
    "the prepared task exposes only a safe display category");
  await assert.rejects(() => planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft), first.id), /conflict/,
    "a later choice cannot replace the already saved task plan");
});
