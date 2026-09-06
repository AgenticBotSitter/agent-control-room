import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { nativeQualityCompletionFixture } from "./native-quality-completion";
import { TaskExecutionPlanner } from "../../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator } from "../../src/web/v1/task-assignment-coordinator";
import { WebTaskReviewService } from "../../src/web/v1/task-review-service";
import { PortableNodeBridge, SqliteBridgeJournal } from "../../src/node-bridge";
import { NativeDispatchIntakeHandler } from "../../src/node-bridge/native-dispatch-handler";
import { ServerNodeSession } from "../../src/node-control/server-node-session";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame, type SignedNodeFrame } from "../../src/node-protocol/v1";
import { NATIVE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import { prepareNativeExecutionHandoff } from "../../src/harness/hermes-native-v1/execution-handoff";
import { nativeTaskObservation, nativeTaskRegistration } from "../../src/harness/hermes-native-v1/task-observation";
import { SqliteNativeRunJournal } from "../../src/harness/hermes-native-v1/run-journal";
import { type NativeStartAuthorityDependencies, type NativeCurrentPolicy } from "../../src/harness/hermes-native-v1/start-authority";
import { SqliteLocalAdmissionStore, SqliteExecutionStateStore, SqliteEffectClaimStore } from "../../src/node-policy/v1";
import { resolvePinnedApprovalKey } from "../../src/node-policy/v1/pinned-approval-trust";
import { NativeResultSubmissionService } from "../../src/completion-gate/v1/native-result-submission";
import { nativeReviewRevision } from "../../src/completion-gate/v1/native-review-plan";
import { NativeTaskResultService } from "../../src/node-control/native-task-result-service";
import { sha256Digest } from "../../src/security";
import type { CompletionRevisionV1 } from "../../src/completion-gate/v1";
import type { JobRecord, AttemptRecord, LeaseRecord } from "../../src/domain/v1";
import { capabilityBody, response, statusBody } from "../hermes-native-fixture";

export const revisedText = "# Result\nA revised synthetic document answers the original task.\n# Evidence\nThe requested evidence now includes explicit supporting details.\n";
export const revisionFeedback = "Please improve the evidence.";

/** Two actual synthetic native jobs share one control-plane DB, result storage, keys and gate.
 * Child local admission stores are fresh disposable fixtures, not a live node recovery claim.
 * This preparation stops before native review registration and before the fake child start.
 */
export async function nativeRevisedExecutionFixture() {
  const original = await nativeQualityCompletionFixture(), { f } = original;
  const cleanup: (() => void | Promise<void>)[] = [original.close];
  const close = async () => { for (const fn of cleanup.reverse()) await fn(); };
  try {
    const seededStates = async () => ({ job: await f.canonical.get(f.scope.tenantId, "job", "job:test"),
      attempt: await f.canonical.get(f.scope.tenantId, "attempt", "attempt:test"),
      lease: await f.canonical.get(f.scope.tenantId, "lease", "lease:test") });
    assert.notEqual(original.registration.jobId, "job:test"); assert.notEqual(original.registration.attemptId, "attempt:test");
    assert.notEqual(original.registration.nativeTask!.leaseId, "lease:test");
    const sourceBefore = await original.states(), seededBefore = await seededStates();
    await original.verify();
    const changeReview = (await original.review("changes_requested")).receipt;
    const planner = new TaskExecutionPlanner(f.db, f.scope, f.plannerConfig, f.clock, f.ownerConfig);
    const planned = await planner.revise(f.identity, original.registration.projectId, original.registration.jobId,
      { runId: original.registration.id, targetId: original.target.id, targetDigest: original.request.targetDigest,
        contentHash: original.artifact.contentHash, reviewId: changeReview.reviewId, feedback: revisionFeedback }, new AbortController().signal);
    const plan = await planner.read(planned.receipt.jobId);
    assert.ok(plan?.schema === "control-room.task-execution-plan/v2");
    // Test precondition only: one unrelated seeded reservation + original execution +
    // this child require three slots. No reservation is removed and no turnover is implemented.
    assert.equal((await f.db.query("SELECT id FROM control_leases WHERE state='active' AND node_id=$1", [f.route.nodeId])).rows.length, 2);
    const childRoute = { ...f.route, maxConcurrentTasks: 3 };
    const coordinator = new TaskAssignmentCoordinator(f.db, f.scope, planner, [childRoute], f.clock,
      [{ enrollment: f.prepared.enrollment, nodeClass: "personal-compute" }], f.store);
    const assigned = await coordinator.assign(f.identity, plan.projectId, plan.job.id, f.route.nodeId, plan.job.inputDigest);
    const args = [f.identity, plan.projectId, plan.job.id, plan.job.inputDigest] as const;
    const prepared = await coordinator.prepareNativeApproval(...args), abort = new AbortController();
    const timestamp = () => new Date(f.clock()).toISOString();
    const packet = { schema: "control-room.native-task-approval-packet/v1" as const,
      approval: f.sign({ ...f.packet.approval.body, jobId: prepared.request.jobId, attemptId: prepared.request.attemptId,
        operationDigest: prepared.request.operationDigest, issuedAt: timestamp(), expiresAt: new Date(prepared.start.deadline).toISOString(),
        nonce: "synthetic-revised-child-approval" }),
      recovery: f.sign({ ...f.packet.recovery.body, bindingDigest: sha256Digest(prepared.binding),
        issuedAt: f.clock(), expiresAt: prepared.start.deadline + 120_000, nonce: "synthetic-revised-child-recovery" }) };
    await coordinator.storeNativeApproval(...args, packet, abort.signal);

    const options = { testOnlyAllowEphemeral: true };
    const admissions = new SqliteLocalAdmissionStore(":memory:", options), executions = new SqliteExecutionStateStore(":memory:", options),
      effects = new SqliteEffectClaimStore(":memory:", options), runs = new SqliteNativeRunJournal(":memory:", options);
    cleanup.push(() => { runs.close(); effects.close(); executions.close(); admissions.close(); });
    const policy: NativeCurrentPolicy = { ...original.local.policy,
      lease: { tenantId: plan.tenantId, nodeId: prepared.request.nodeId, jobId: plan.job.id, attemptId: prepared.request.attemptId,
        leaseId: prepared.request.leaseId, leaseEpoch: prepared.request.leaseEpoch, validFrom: timestamp(),
        expiresAt: new Date(prepared.start.deadline).toISOString(), authorityDigest: plan.job.authority.digest,
        authority: plan.job.authority, parentAuthorities: [] },
      approvalKey: await resolvePinnedApprovalKey(f.approvals, f.approvals.binding(), packet.approval.body.approvalKeyId) };
    const local: NativeStartAuthorityDependencies = { admissions, executions, effects, clock: f.clock,
      readCurrent: async () => ({ ...policy, activeExternalEffects: effects.countActive(plan.tenantId, prepared.request.nodeId) }),
      // Same explicit synthetic qualification seam as nativeStartAuthorityFixture.
      assertProfileCurrent: async () => {} };

    const journal = new SqliteBridgeJournal(":memory:"), serverKeys = generateKeyPairSync("ed25519");
    cleanup.push(() => journal.close());
    const spki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const handler = new NativeDispatchIntakeHandler(prepared.enrollment, journal,
      { approvals: f.approvals, security: f.native.trust }, f.clock); cleanup.push(() => handler.close());
    const features = [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"];
    const bridge = new PortableNodeBridge({ tenantId: plan.tenantId, nodeId: prepared.request.nodeId, keyId: "key:test", features }, journal,
      { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
      new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: spki,
        state: "active", principalState: "active", validFrom: new Date(f.clock() - 60_000).toISOString() }; } }, journal,
      new FixedWindowProtocolRateLimiter(100, 60)), undefined, undefined, handler); cleanup.push(() => bridge.close());
    const incoming: string[] = [], outgoing: string[] = [];
    const session = new ServerNodeSession({ tenantId: plan.tenantId, nodeId: prepared.request.nodeId, nodeKeyId: "key:test",
      serverId: "server:revised", serverKeyId: "key:revised-server", serverPublicKeySpki: spki, transportIdentity: "transport:revised",
      features, maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }, { authentication: f.auth, clock: f.clock,
      async sign(frame) { return signNodeFrame(frame, serverKeys.privateKey); }, async send(raw) { outgoing.push(raw); } });
    cleanup.push(() => session.disconnect());
    await bridge.open({ async send(raw) { incoming.push(raw); }, async close() {} },
      { now: timestamp(), transportIdentity: "transport:revised-server" });
    await session.acceptHello(incoming.shift()!);
    for (let count = 0; count < 20 && (outgoing.length || incoming.length); count++) {
      while (incoming.length) await session.receive(incoming.shift()!);
      while (outgoing.length) await bridge.receive(outgoing.shift()!, timestamp());
    }
    assert.ok(session.nativeDeliveryChannel()); assert.equal(incoming.length + outgoing.length, 0);
    await coordinator.enqueueNativeTask(...args, sha256Digest(packet), abort.signal);
    await coordinator.stageQueuedNativeDelivery(...args, sha256Digest(packet), session, abort.signal);
    await coordinator.transmitQueuedNativeDelivery(...args, sha256Digest(packet), session, abort.signal);
    const dispatch = JSON.parse(outgoing[0]) as SignedNodeFrame<"harness.native.dispatch">;
    await bridge.receive(outgoing.shift()!, timestamp());
    await f.store.receiveDeliveryReceipt(f.db, session, incoming.shift()!, abort.signal);
    const calls: string[] = [], providerRunId = `run_${"2".repeat(32)}`;
    let resultText: string | undefined;
    const handoff = await prepareNativeExecutionHandoff({ queueId: dispatch.body.queueId, enrollment: prepared.enrollment, serverActorId: "server:revised" },
      { deliveries: journal, runs, approvals: f.approvals, security: { currentServerTrustRevision: () => f.native.trust.currentServerTrustRevision(),
        async resolveServerKey() { return new Uint8Array(Buffer.from(spki, "base64url")); } }, local, clock: f.clock,
      transport: { async json(wire) {
        await wire.authorize(); calls.push(wire.operation);
        if (wire.operation === "capabilities") return response(capabilityBody);
        if (wire.operation === "start") return response({ run_id: providerRunId, status: "started", replayed: false }, 202);
        return response(statusBody(resultText === undefined ? "running" : "completed", { run_id: providerRunId,
          session_id: prepared.binding.sessionId, ...(resultText === undefined ? {} : { output: resultText, usage: { input_tokens: 20, output_tokens: 10 } }) }));
      }, async events(wire) { await wire.authorize(); calls.push("events"); } } }, abort.signal);
    cleanup.push(() => handoff.close());
    const registration = nativeTaskRegistration(prepared.binding, plan.job.inputDigest, prepared.request.leaseId, prepared.request.leaseEpoch, timestamp());
    await f.runs.create(registration);
    assert.deepEqual(await original.states(), sourceBefore); assert.deepEqual(await seededStates(), seededBefore);
    const submission = new NativeResultSubmissionService(f.db, f.ownerConfig);
    const register = () => planner.bindReview(plan.job.id, registration.id, f.harnessKey, submission);
    const receiveOptions = () => ({ receivedAt: timestamp(), transportIdentity: "transport:revised", expectedConnectionId: bridge.status().connectionId! });
    async function publish() {
      await bridge.publishNativeSnapshot(nativeTaskObservation(handoff.snapshot(), registration.nativeTask!), timestamp());
      const raw = incoming.shift()!;
      await session.acceptNativeSnapshot(raw, (frame, assertCurrent) => f.runs.recordNativeSnapshot(frame.tenantId, frame.actorId, frame.body, assertCurrent));
      await bridge.receive(outgoing.shift()!, timestamp()); return raw;
    }
    async function deliver(text = revisedText, submit = true) {
      await handoff.start(); await publish();
      f.setNow(f.clock() + 1000); await handoff.poll(); await publish();
      f.setNow(f.clock() + 1000); resultText = text; await handoff.poll(); const raw = await publish();
      const bytes = new TextEncoder().encode(text);
      const resultService = new NativeTaskResultService(f.auth, f.runs, f.results, submit ? submission : undefined);
      const { receipt: artifact } = await resultService.ingest(raw, bytes, receiveOptions());
      return { artifact, raw, bytes, text };
    }
    const childStates = async () => ({ job: await f.canonical.get(plan.tenantId, "job", plan.job.id) as JobRecord,
      attempt: await f.canonical.get(plan.tenantId, "attempt", assigned.receipt.attemptId) as AttemptRecord,
      lease: await f.canonical.get(plan.tenantId, "lease", assigned.receipt.leaseId) as LeaseRecord });
    return { original, f, config: f.ownerConfig, scenario: original.scenario, identity: f.identity, jwt: f.jwt, scope: f.scope,
      source: { jobId: original.registration.jobId, runId: original.registration.id, artifact: original.artifact,
        target: original.target, targetDigest: original.request.targetDigest }, changeReview, planned, plan, prepared, packet, assigned,
      registration, submission, register, deliver, handoff, receiveOptions, childStates, sourceStates: original.states, seededStates,
      counters: () => ({ sourceCalls: [...original.local.calls], childCalls: [...calls],
        sourceEffects: original.local.effects.countFull(), childEffects: effects.countFull() }), close };
  } catch (error) { await close(); throw error; }
}

export async function nativeRevisedResultFixture(text = revisedText) {
  const x = await nativeRevisedExecutionFixture();
  try {
    const reviewPlan = await x.register(), delivered = await x.deliver(text);
    const context = await x.f.db.transaction(tx => x.submission.inspectSubmitted(tx, x.plan.tenantId, x.registration.id));
    assert.equal(context.plan.schema, "control-room.native-review-plan/v2");
    if (context.plan.schema !== "control-room.native-review-plan/v2") throw new Error("missing revised native plan");
    const revision = await x.f.reviewStore.getRecord(x.plan.tenantId,
      nativeReviewRevision(context.plan, context.snapshot.target).id, "revision") as CompletionRevisionV1;
    const child = { jobId: x.plan.job.id, runId: x.registration.id, attemptId: x.registration.attemptId,
      leaseId: x.prepared.request.leaseId, artifact: delivered.artifact, artifactId: delivered.artifact.artifactId,
      target: context.snapshot.target, targetDigest: context.snapshot.targetDigest, revision,
      logicalSubjectId: context.snapshot.target.subjectId, rootTargetId: context.snapshot.target.rootTargetId };
    const request = { tenantId: x.plan.tenantId, runId: child.runId, targetDigest: child.targetDigest, contentHash: child.artifact.contentHash };
    const review = (decision: "accepted" | "changes_requested" = "accepted") => new WebTaskReviewService(x.f.db, x.f.scope, x.f.ownerConfig, x.f.clock)
      .record(x.f.identity, x.plan.projectId, child.jobId, { artifactId: child.artifactId, targetId: child.target.id,
        targetDigest: child.targetDigest, contentHash: child.artifact.contentHash, decision,
        feedback: decision === "accepted" ? "" : "Please further improve the revised evidence." }, "revised-child-review-001");
    return { ...x, child, request, reviewPlan, delivered, review };
  } catch (error) { await x.close(); throw error; }
}
