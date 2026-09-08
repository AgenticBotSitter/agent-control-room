import assert from "node:assert/strict";
import test from "node:test";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { syntheticCleanupEvidence } from "./helpers/native-cleanup-evidence";
import { currentSignal } from "./helpers/managed-native-session";
import { taskDraft } from "./helpers/web-task";
import { qualityText } from "./helpers/native-quality-completion";
import { capabilityBody, response, statusBody } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import { TaskQualityCoordinator } from "../src/web/v1/task-quality-coordinator";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { createNativeStartAuthority, type NativeCurrentPolicy } from "../src/harness/hermes-native-v1/start-authority";
import { createNativeTaskSettlement } from "../src/harness/hermes-native-v1/task-settlement";
import { readNativeSettlementHistory } from "../src/harness/hermes-native-v1/settlement-history";

test("two independent approved tasks turn over the same canonical and local stores without raising capacity", async t => {
  const root = await nativeNodeRuntimeFixture(undefined, { queue: true, unassigned: true }); t.after(root.close);
  const x = root.x, f = x.f, local = x.local, tenantId = f.scope.tenantId, nodeId = root.config.enrollment.nodeId;
  assert.equal(f.route.maxConcurrentTasks, 2); assert.equal(local.policy.ceiling.maxConcurrentEffects, 1);
  await x.verify();
  assert.equal(root.runtime.hasAcceptedDispatch(), false); assert.throws(() => root.runtime.queueId);
  const a = await root.connect("initial", root.runtime, "queue");
  const deliver = async (queued: typeof root.queued, inputDigest: string, connection: typeof a) => {
    await x.manager.deliverApproved({ schema: "control-room.native-task-submission/v1", tenantId,
      projectId: queued.projectId, jobId: queued.jobId, attemptId: queued.attemptId, queueId: queued.queueId,
      packetDigest: queued.packetDigest, inputDigest }, currentSignal());
    await root.pump(connection);
  };
  await deliver(root.queued, x.task.inputDigest, a);
  assert.equal(root.runtime.queueId, root.queued.queueId);
  await x.admin(() => root.runtime.start(currentSignal())); await root.pump(a);
  root.advance(); root.setResult(qualityText);
  await x.admin(() => root.runtime.poll(currentSignal())); await root.pump(a);
  assert.equal(local.effects.countActive(tenantId, nodeId), 1);
  const draft = { ...taskDraft, title: "Independent second research task" };
  const planned = await x.admin(async () => {
    const source = await f.tasks.propose(f.identity, x.task.projectId, draft, "independent-second-task");
    return f.planner.plan(f.identity, x.task.projectId, source.receipt.jobId, sha256Digest(draft));
  });
  const args = [f.identity, x.task.projectId, planned.receipt.jobId, planned.receipt.inputDigest] as const;
  const assign = () => x.admin(() => f.coordinator.assign(args[0], args[1], args[2], nodeId, args[3]));
  const activeLeases = () => x.admin(async () => (await f.db.query<{ id: string }>(
    "SELECT id FROM control_leases WHERE state='active' AND node_id=$1 ORDER BY id", [nodeId])).rows.map(row => row.id));
  assert.equal((await activeLeases()).length, 2);
  await assert.rejects(assign());

  const submission = new NativeResultSubmissionService(f.db, f.ownerConfig);
  const quality = new TaskQualityCoordinator(f.db, f.scope, { ...f.ownerConfig, scenarios: [] }, f.clock);
  const inspect = (runId: string) => x.admin(() => f.db.transaction(tx => submission.inspectSubmitted(tx, tenantId, runId)));
  const release = async (runId: string) => {
    const saved = await inspect(runId);
    const result = await x.admin(() => quality.reconcile({ tenantId, projectId: saved.run.projectId, jobId: saved.run.jobId,
      runId, targetDigest: saved.snapshot.targetDigest, contentHash: saved.result.receipt.contentHash }, currentSignal(), () => {}));
    assert.equal(result.disposition, "waiting_review");
    assert.ok("capacity" in result && result.capacity);
    return saved;
  };
  const savedA = await release(x.registration.id), seededLease = await activeLeases();
  assert.equal(seededLease.length, 1); assert.equal(local.effects.countActive(tenantId, nodeId), 1);
  const assigned = await assign(); assert.equal((await activeLeases()).length, 2);
  const prepared = await x.admin(() => f.coordinator.prepareNativeApproval(...args));
  const packet = { schema: "control-room.native-task-approval-packet/v1" as const,
    approval: f.sign({ ...f.packet.approval.body, jobId: prepared.request.jobId, attemptId: prepared.request.attemptId,
      operationDigest: prepared.request.operationDigest, issuedAt: new Date(f.clock()).toISOString(),
      expiresAt: new Date(prepared.start.deadline).toISOString(), nonce: "synthetic-independent-second-approval" }),
    recovery: f.sign({ ...f.packet.recovery.body, bindingDigest: sha256Digest(prepared.binding), issuedAt: f.clock(),
      expiresAt: prepared.start.deadline + 120_000, nonce: "synthetic-independent-second-recovery" }) };
  const queued = await x.admin(async () => {
    await f.coordinator.storeNativeApproval(...args, packet, currentSignal());
    return f.coordinator.enqueueNativeTask(...args, sha256Digest(packet), currentSignal());
  });
  const plan = await x.admin(() => f.planner.read(planned.receipt.jobId)); assert.ok(plan);
  const policy: NativeCurrentPolicy = { ...local.policy,
    lease: { tenantId, nodeId, jobId: plan.job.id, attemptId: prepared.request.attemptId,
      leaseId: prepared.request.leaseId, leaseEpoch: prepared.request.leaseEpoch, validFrom: assigned.receipt.acquiredAt,
      expiresAt: new Date(prepared.start.deadline).toISOString(), authorityDigest: plan.job.authority.digest,
      authority: plan.job.authority, parentAuthorities: [] } };
  const localB = { ...local.dependencies, clock: f.clock,
    readCurrent: async () => ({ ...policy, activeExternalEffects: local.effects.countActive(tenantId, nodeId) }) };
  // Pre-effect policy check only: calling adapter.start would reserve a native run
  // even on refusal. Do not consume B's exact run merely to probe occupied capacity.
  const preflight = createNativeStartAuthority({ enrollment: prepared.enrollment,
    request: { ...prepared.request, approval: packet.approval }, start: prepared.start }, localB);
  await assert.rejects(preflight.authority.check("start", prepared.binding)); preflight.close();
  assert.equal(local.journal.load(prepared.binding.runId), undefined);
  assert.equal(local.effects.load(prepared.binding.effectClaimKey), undefined);
  const cleanupA = syntheticCleanupEvidence({ enrollment: root.config.enrollment, binding: f.prepared.binding,
    runs: local.journal, effects: local.effects, security: f.native.trust, clock: f.clock }); t.after(cleanupA.close);
  await createNativeTaskSettlement(cleanupA.config, { ...cleanupA.deps, effects: local.effects,
    executions: local.executions, runtime: root.runtime }).settle(currentSignal());
  assert.equal(local.effects.countActive(tenantId, nodeId), 0);
  const retainedA = readNativeSettlementHistory(f.prepared.binding,
    { effects: local.effects, executions: local.executions, runs: local.journal }, currentSignal());

  const bCalls: string[] = [], nativeId = `run_${"3".repeat(32)}`, secondText = qualityText.replace("A useful synthetic", "A distinct second-task synthetic");
  const second = root.createUnassigned({ ...root.dependencies, local: localB,
    recovery: { ...root.dependencies.recovery, async readCurrent() {
      return { approvalKey: policy.approvalKey!, credentialAvailable: true, recoveryAllowed: true };
    } }, transport: { async json(wire) {
      await wire.authorize(); bCalls.push(wire.operation);
      if (wire.operation === "capabilities") return response(capabilityBody);
      if (wire.operation === "start") return response({ run_id: nativeId, status: "started", replayed: false }, 202);
      return response(statusBody("completed", { run_id: nativeId, session_id: prepared.binding.sessionId, output: secondText }));
    }, async events() { throw new Error("synthetic second task has no event polling"); } } });
  const b = await root.connect("initial", second, "queue");
  assert.equal(second.hasAcceptedDispatch(), false); assert.throws(() => second.queueId);
  const lateA = a.nodeSent.findLast(raw => JSON.parse(raw).type === "harness.native.snapshot"); assert.ok(lateA);
  await assert.rejects(a.server.receive(lateA, new TextEncoder().encode(qualityText), currentSignal()));
  await assert.rejects(root.runtime.start(currentSignal()));
  assert.equal(bCalls.length, 0);
  await deliver(queued, args[3], b);
  assert.equal(second.queueId, queued.queueId);
  assert.equal(root.dependencies.runs, local.journal);
  const firstB = await x.admin(() => second.start(currentSignal())); await root.pump(b);
  assert.equal(firstB.nativeRunId, nativeId); assert.equal(local.effects.countActive(tenantId, nodeId), 1);
  assert.deepEqual(bCalls, ["capabilities", "start"]);
  await x.admin(() => second.start(currentSignal())); assert.deepEqual(bCalls, ["capabilities", "start"]);
  root.advance(); await x.admin(() => second.poll(currentSignal())); await root.pump(b);
  const savedB = await release(prepared.binding.runId);
  assert.notEqual(savedA.run.id, savedB.run.id); assert.notEqual(savedA.run.jobId, savedB.run.jobId);
  assert.notEqual(savedA.run.attemptId, savedB.run.attemptId);
  assert.notEqual(savedA.result.receipt.contentHash, savedB.result.receipt.contentHash);
  assert.deepEqual(await f.config.storage.read(savedA.result.receipt.artifactId), new TextEncoder().encode(qualityText));
  assert.deepEqual(await f.config.storage.read(savedB.result.receipt.artifactId), new TextEncoder().encode(secondText));
  assert.equal(savedA.snapshot.status, "pending"); assert.equal(savedB.snapshot.status, "pending");
  const cleanupB = syntheticCleanupEvidence({ enrollment: root.config.enrollment, binding: prepared.binding,
    runs: local.journal, effects: local.effects, security: f.native.trust, clock: f.clock }); t.after(cleanupB.close);
  await createNativeTaskSettlement(cleanupB.config, { ...cleanupB.deps, effects: local.effects,
    executions: local.executions, runtime: second }).settle(currentSignal());
  assert.equal(local.effects.countActive(tenantId, nodeId), 0);
  assert.deepEqual(await activeLeases(), seededLease);
  assert.deepEqual(readNativeSettlementHistory(f.prepared.binding,
    { effects: local.effects, executions: local.executions, runs: local.journal }, currentSignal()), retainedA);
  assert.equal((await inspect(x.registration.id)).snapshot.status, "pending");
  assert.deepEqual(bCalls, ["capabilities", "start", "status"]);
  assert.deepEqual(local.calls, ["capabilities", "start", "status"]);
  assert.equal(f.route.maxConcurrentTasks, 2); assert.equal(local.policy.ceiling.maxConcurrentEffects, 1);
});
