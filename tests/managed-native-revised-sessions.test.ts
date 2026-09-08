import assert from "node:assert/strict";
import test from "node:test";
import { managedNativeSessionFixture, currentSignal, type ManagedNativePreparedContext } from "./helpers/managed-native-session";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";
import { revisedText, revisionFeedback } from "./helpers/native-revised-result";
import { TaskExecutionPlanner } from "../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { nativeReviewRevision } from "../src/completion-gate/v1/native-review-plan";
import { SqliteNativeRunJournal } from "../src/harness/hermes-native-v1/run-journal";
import { type NativeStartAuthorityDependencies, type NativeCurrentPolicy } from "../src/harness/hermes-native-v1/start-authority";
import { SqliteLocalAdmissionStore, SqliteExecutionStateStore, SqliteEffectClaimStore } from "../src/node-policy/v1";
import { resolvePinnedApprovalKey } from "../src/node-policy/v1/pinned-approval-trust";
import { signNodeFrame, signedNodeFrameSchema } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security";
import { capabilityBody, response, statusBody } from "./hermes-native-fixture";

/** Original completed result, review, persisted v2 plan and canonical assignment are privileged
 * synthetic setup. The child has NO server session, run record, review binding or result yet.
 * Approval/admission scaffolding mirrors native-revised-result.ts, not a new execution protocol. */
async function revisedPreparation() {
  const original = await nativeQualityCompletionFixture(), { f } = original;
  const cleanup: (() => void | Promise<void>)[] = [original.close];
  try {
    const sourceStates = await original.states();
    await original.verify(); const changeReview = (await original.review("changes_requested")).receipt;
    const planner = new TaskExecutionPlanner(f.db, f.scope, f.plannerConfig, f.clock, f.ownerConfig);
    const planned = await planner.revise(f.identity, original.registration.projectId, original.registration.jobId,
      { runId: original.registration.id, targetId: original.target.id, targetDigest: original.request.targetDigest,
        contentHash: original.artifact.contentHash, reviewId: changeReview.reviewId, feedback: revisionFeedback }, currentSignal());
    const plan = await planner.read(planned.receipt.jobId);
    assert.ok(plan?.schema === "control-room.task-execution-plan/v2");
    // Explicit existing fixture precondition: seeded reservation + original + child, not a
    // real reservation-turnover assertion. Neither existing reservation is removed or edited.
    assert.equal((await f.db.query("SELECT id FROM control_leases WHERE state='active' AND node_id=$1", [f.route.nodeId])).rows.length, 2);
    const route = { ...f.route, maxConcurrentTasks: 3 };
    const coordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, [route], f.clock,
      [{ enrollment: f.prepared.enrollment, nodeClass: "personal-compute" }], f.store);
    const assigned = await coordinator.assign(f.identity, plan.projectId, plan.job.id, route.nodeId, plan.job.inputDigest);
    const args = [f.identity, plan.projectId, plan.job.id, plan.job.inputDigest] as const;
    const prepared = await coordinator.prepareNativeApproval(...args), timestamp = () => new Date(f.clock()).toISOString();
    const packet = { schema: "control-room.native-task-approval-packet/v1" as const,
      approval: f.sign({ ...f.packet.approval.body, jobId: prepared.request.jobId, attemptId: prepared.request.attemptId,
        operationDigest: prepared.request.operationDigest, issuedAt: timestamp(), expiresAt: new Date(prepared.start.deadline).toISOString(),
        nonce: "synthetic-managed-revised-approval" }),
      recovery: f.sign({ ...f.packet.recovery.body, bindingDigest: sha256Digest(prepared.binding), issuedAt: f.clock(),
        expiresAt: prepared.start.deadline + 120_000, nonce: "synthetic-managed-revised-recovery" }) };
    const options = { testOnlyAllowEphemeral: true };
    const admissions = new SqliteLocalAdmissionStore(":memory:", options), executions = new SqliteExecutionStateStore(":memory:", options),
      effects = new SqliteEffectClaimStore(":memory:", options), journal = new SqliteNativeRunJournal(":memory:", options);
    const closeLocal = async () => { journal.close(); effects.close(); executions.close(); admissions.close(); };
    cleanup.push(closeLocal);
    const policy: NativeCurrentPolicy = { ...original.local.policy,
      lease: { tenantId: plan.tenantId, nodeId: prepared.request.nodeId, jobId: plan.job.id, attemptId: prepared.request.attemptId,
        leaseId: prepared.request.leaseId, leaseEpoch: prepared.request.leaseEpoch, validFrom: timestamp(),
        expiresAt: new Date(prepared.start.deadline).toISOString(), authorityDigest: plan.job.authority.digest,
        authority: plan.job.authority, parentAuthorities: [] },
      approvalKey: await resolvePinnedApprovalKey(f.approvals, f.approvals.binding(), packet.approval.body.approvalKeyId) };
    const dependencies: NativeStartAuthorityDependencies = { admissions, executions, effects, clock: f.clock,
      readCurrent: async () => ({ ...policy, activeExternalEffects: effects.countActive(plan.tenantId, prepared.request.nodeId) }),
      // Existing explicit synthetic qualification seam; no host/provider qualification is claimed.
      assertProfileCurrent: async () => {} };
    const calls: string[] = [], providerRunId = `run_${"2".repeat(32)}`;
    const context: ManagedNativePreparedContext = {
      f: { ...f, planner, route, coordinator, prepared, packet, args, close: original.close,
        save: (value: unknown = packet, c = coordinator) => c.storeNativeApproval(...args, value, currentSignal()) },
      providerRunId, resultText: revisedText,
      local: { prepared, policy, dependencies, journal, effects, executions, calls, setNow: f.setNow, close: closeLocal,
        transport: { async json(wire) {
          await wire.authorize(); calls.push(wire.operation);
          if (wire.operation === "capabilities") return response(capabilityBody);
          if (wire.operation === "start") return response({ run_id: providerRunId, status: "started", replayed: false }, 202);
          return response(statusBody("running", { run_id: providerRunId, session_id: prepared.binding.sessionId }));
        }, async events(wire) { await wire.authorize(); calls.push("events"); } },
      },
    };
    assert.deepEqual(await original.states(), sourceStates);
    return { context, original, plan, planned, changeReview, assigned, effects };
  } catch (error) { for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* Preserve preparation failure. */ } } throw error; }
}

test("new managed child connection registers and delivers the actual v2 result under restricted roles without modifying original execution", async t => {
  const prepared = await revisedPreparation();
  // The manager helper takes ownership of this prepared original DB and child local fixtures.
  const x = await managedNativeSessionFixture(prepared.context); t.after(x.close);
  const { original, plan } = prepared;
  await x.verify();
  const sourceBefore = await x.admin(original.states), sourceCalls = [...original.local.calls], sourceEffects = original.local.effects.countFull();
  const sourceEvidence = () => x.admin(async () => ({
    run: (await x.f.db.query("SELECT * FROM control_harness_runs WHERE id=$1", [original.registration.id])).rows,
    events: (await x.f.db.query("SELECT * FROM control_harness_run_events WHERE run_id=$1 ORDER BY sequence", [original.registration.id])).rows,
    receipt: (await x.f.db.query("SELECT * FROM control_native_artifact_receipts WHERE run_id=$1", [original.registration.id])).rows,
  }));
  const evidenceBefore = await sourceEvidence();
  assert.notEqual(x.registration.jobId, original.registration.jobId); assert.notEqual(x.registration.id, original.registration.id);
  assert.notEqual(x.registration.attemptId, original.registration.attemptId);
  assert.notEqual(x.registration.nativeTask!.leaseId, original.registration.nativeTask!.leaseId);
  assert.equal((await x.counts()).runs.length, 0);
  const c = await x.attach(); await x.handshake(c);
  assert.ok(original.sent[0]); assert.notEqual(JSON.parse(c.hello).connectionId, original.sent[0].connectionId);
  const native = await x.dispatch(c), childBefore = await x.states();
  assert.equal((await x.counts()).runs.length, 0);
  const registered = await x.receiver.register(x.request, currentSignal());
  assert.equal(registered.replayed, false); assert.equal(registered.receipt.runId, x.registration.id);
  const planRow = await x.resultDb.query<{ plan: { schema: string; jobId: string } }>("SELECT plan FROM control_native_review_plans WHERE run_id=$1", [x.registration.id]);
  assert.equal(planRow.rows[0].plan.schema, "control-room.native-review-plan/v2");
  assert.equal(planRow.rows[0].plan.jobId, plan.job.id);
  for (const phase of ["start", "running"] as const) {
    const wire = await native.produce(phase); await c.handle.progress(wire.raw, undefined, currentSignal()); await c.peer.acknowledge();
  }
  const wire = await native.produce("completed"), bytes = new TextEncoder().encode(revisedText);
  const result = await c.handle.progress(wire.raw, bytes, currentSignal()); await c.peer.acknowledge();
  assert.equal(result.runId, x.registration.id); assert.equal(result.state, "succeeded"); assert.equal(result.submission!.qualityAccepted, false);
  assert.equal(wire.body.jobId, plan.job.id); assert.equal(wire.body.attemptId, prepared.assigned.receipt.attemptId);
  const inspector = new NativeResultSubmissionService(x.resultDb, x.f.ownerConfig);
  const submitted = await x.resultDb.transaction(tx => inspector.inspectSubmitted(tx, plan.tenantId, x.registration.id));
  assert.equal(submitted.plan.schema, "control-room.native-review-plan/v2");
  assert.equal(submitted.snapshot.target.subjectId, original.target.subjectId);
  assert.equal(submitted.snapshot.target.rootTargetId, original.target.rootTargetId);
  assert.equal(submitted.snapshot.target.revisionNumber, original.target.revisionNumber + 1);
  assert.equal(submitted.snapshot.target.producer.actorId, x.registration.nodeId);
  assert.equal(submitted.snapshot.status, "pending");
  if (submitted.plan.schema !== "control-room.native-review-plan/v2") throw new Error("missing revised result plan");
  const expectedRevision = nativeReviewRevision(submitted.plan, submitted.snapshot.target), revisionId = expectedRevision.id;
  const revision = await x.admin(() => x.f.reviewStore.getRecord(plan.tenantId, revisionId, "revision"));
  assert.deepEqual(revision, expectedRevision);
  assert.equal(expectedRevision.fromTargetId, original.target.id); assert.equal(expectedRevision.toTargetId, submitted.snapshot.target.id);
  const counts = await x.counts(); assert.equal(counts.runs.length, 1); assert.equal(counts.artifacts.length, 1); assert.equal(counts.receipts.length, 1);
  assert.equal(counts.artifacts[0].job_id, plan.job.id); assert.equal(counts.artifacts[0].attempt_id, x.registration.attemptId);
  assert.deepEqual(await x.f.config.storage.read(counts.artifacts[0].id as string), bytes);
  assert.deepEqual(await x.states(), childBefore); assert.deepEqual(await x.admin(original.states), sourceBefore);
  assert.deepEqual(await sourceEvidence(), evidenceBefore); assert.deepEqual(original.local.calls, sourceCalls);
  assert.deepEqual(original.local.effects.countFull(), sourceEffects);
  assert.equal((await x.admin(() => x.f.reviewStore.snapshot(plan.tenantId, original.target.id))).status, "superseded");
  assert.equal(x.local.calls.filter(value => value === "start").length, 1);
  assert.ok(x.observed.some(row => row.login === "managed_auth_test" && row.sql.includes("INSERT INTO node_protocol_replay")));
  assert.ok(x.observed.some(row => row.login === "managed_evidence_test" && row.sql.includes("INSERT INTO control_harness_runs")));
  assert.ok(x.observed.some(row => row.login === "managed_result_test" && row.sql.includes("INSERT INTO control_native_review_plans")));
  const previous = signedNodeFrameSchema.parse(JSON.parse(wire.raw));
  const { signature, bodyDigest, ...unsigned } = previous; void signature; void bodyDigest;
  const fresh = signNodeFrame({ ...unsigned, sequence: c.peer.journal.nextOutboundSequence(previous.connectionId),
    messageId: "message:managed-child-result-replay", nonce: "managed_child_replay_12345678901234567890" }, x.f.keys.privateKey);
  const now = new Date(x.f.clock()).toISOString(), calls = [...x.local.calls];
  assert.equal(c.peer.journal.stageOutbound(fresh, true, now), "staged"); c.peer.journal.markSent(fresh.messageId, now);
  const replay = await c.handle.progress(JSON.stringify(fresh), bytes, currentSignal()); await c.peer.acknowledge();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.submission, result.submission);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(x.local.calls, calls);
  assert.deepEqual(await sourceEvidence(), evidenceBefore); assert.deepEqual(await x.admin(original.states), sourceBefore);
  // Reconnect the revised child without repeating its dispatch or native start.
  const next = await x.attach(); await x.handshake(next);
  const sentBeforeRecovery = next.peer.state.sends;
  assert.deepEqual(await next.handle.recover(x.request, currentSignal()), { recovered: true, grantsExecutionAuthority: false });
  assert.equal(next.peer.state.sends, sentBeforeRecovery);
  const connectionId = JSON.parse(next.hello).connectionId;
  assert.notEqual(connectionId, previous.connectionId);
  const recovered = signNodeFrame({ ...unsigned, connectionId,
    sequence: next.peer.journal.nextOutboundSequence(connectionId),
    messageId: "message:recovered-child-result", nonce: "recovered_child_result_12345678901234567890" }, x.f.keys.privateKey);
  assert.equal(next.peer.journal.stageOutbound(recovered, true, now), "staged");
  next.peer.journal.markSent(recovered.messageId, now);
  const recoveredResult = await next.handle.progress(JSON.stringify(recovered), bytes, currentSignal());
  assert.equal(next.peer.outgoing.length, 1);
  const recoveredAck = JSON.parse(next.peer.outgoing[0]);
  assert.equal(recoveredAck.type, "protocol.ack");
  assert.equal(recoveredAck.causationId, recovered.messageId);
  await next.peer.acknowledge();
  assert.equal(recoveredResult.replayed, true); assert.deepEqual(recoveredResult.submission, result.submission);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(x.local.calls, calls);
  assert.deepEqual(await x.states(), childBefore); assert.deepEqual(await sourceEvidence(), evidenceBefore);
  assert.deepEqual(await x.admin(original.states), sourceBefore);
});
