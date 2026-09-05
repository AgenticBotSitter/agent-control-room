import { generateKeyPairSync } from "node:crypto";
import { taskAssignmentFixture } from "./task-assignment";
import { taskDraft } from "./web-task";
import { sha256Digest } from "../../src/security";
import { CanonicalStore } from "../../src/persistence/canonical-store";
import { prepareNativeTaskApproval } from "../../src/harness/hermes-native-v1/task-approval-binding";
import { createNativeStartAuthority, type NativeStartAuthorityDependencies, type NativeCurrentPolicy } from "../../src/harness/hermes-native-v1/start-authority";
import { HermesNativeRunAdapter } from "../../src/harness/hermes-native-v1/adapter";
import { SqliteNativeRunJournal } from "../../src/harness/hermes-native-v1/run-journal";
import type { NativeRunTransport, NativeEnrollment } from "../../src/harness/hermes-native-v1/contracts";
import { computeArtifactBodyDigest, signArtifact, SqliteLocalAdmissionStore, SqliteExecutionStateStore, SqliteEffectClaimStore,
  type OwnerApprovalAttestationBodyV1 } from "../../src/node-policy/v1";
import { enrollment as defaultEnrollment, instant, capabilityBody, response, nativeRunId, statusBody } from "../hermes-native-fixture";

export async function nativeStartAuthorityFixture(otherCommandKey?: string, configuredEnrollment?: NativeEnrollment,
  existingFixture?: Awaited<ReturnType<typeof taskAssignmentFixture>>) {
  const enrollment = configuredEnrollment ?? defaultEnrollment;
  const f = existingFixture ?? await taskAssignmentFixture();
  let assigned: Awaited<ReturnType<typeof f.assign>>["receipt"];
  if (otherCommandKey) {
    const source = await f.tasks.propose(f.identity, f.profile.projectId, taskDraft, otherCommandKey);
    const plan = await f.planner.plan(f.identity, f.profile.projectId, source.receipt.jobId, sha256Digest(taskDraft));
    assigned = (await f.coordinator.assign(f.identity, f.profile.projectId, plan.receipt.jobId, f.route.nodeId, plan.receipt.inputDigest)).receipt;
  } else assigned = (await f.assign()).receipt;
  const canonical = new CanonicalStore(f.db), plan = await f.planner.read(assigned.jobId);
  if (!plan) throw new Error("fixture plan missing");
  let now = instant + 9000, profileAvailable = true, profileChecks = 0, reads = 0, extraActive = 0;
  const prepared = prepareNativeTaskApproval({ enrollment, nodeClass: "personal-compute", now, input: plan.input,
    job: await canonical.get(f.scope.tenantId, "job", assigned.jobId), attempt: await canonical.get(f.scope.tenantId, "attempt", assigned.attemptId),
    lease: await canonical.get(f.scope.tenantId, "lease", assigned.leaseId) });
  const at = new Date(now).toISOString(), expiresAt = new Date(prepared.start.deadline).toISOString(), r = prepared.request;
  const keys = generateKeyPairSync("ed25519");
  const body: OwnerApprovalAttestationBodyV1 = { schema: "control-room.owner-approval-attestation/v1", tenantId: r.tenantId,
    nodeId: r.nodeId, projectId: r.projectId, jobId: r.jobId, attemptId: r.attemptId, operationDigest: r.operationDigest,
    risk: "low", decision: "approved", issuedAt: at, expiresAt, nonce: "c3ludGhldGljLW5vbmNl", approvalKeyId: "approval-key:test", bodyDigest: "" };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const request = { ...r, approval: signArtifact(body, keys.privateKey) };
  const ceiling: NativeCurrentPolicy["ceiling"] = { schema: "control-room.node-authority-ceiling/v1", tenantId: r.tenantId, nodeId: r.nodeId,
    version: 1, issuedAt: at, issuerKeyId: "owner-key:test", projectIds: [r.projectId], executorIds: [r.executorId], operationIds: [r.operationId],
    credentialRefs: r.credentialRefs, filesystemRoots: [], networkDestinations: [enrollment.canonicalDestination], maxRisk: "low",
    externalEffects: "approval_required", maxDurationSeconds: 60, maxConcurrentEffects: 1, bodyDigest: "" };
  ceiling.bodyDigest = computeArtifactBodyDigest(ceiling);
  const policy: NativeCurrentPolicy = { paused: false, ceiling,
    lease: { tenantId: r.tenantId, nodeId: r.nodeId, jobId: r.jobId, attemptId: r.attemptId, leaseId: r.leaseId, leaseEpoch: r.leaseEpoch,
      validFrom: at, expiresAt, authorityDigest: plan.job.authority.digest, authority: plan.job.authority, parentAuthorities: [] },
    executor: { contractVersion: "control-room-node-policy/v1", executorId: r.executorId, operationIds: [r.operationId],
      externalEffectOperationIds: [r.operationId], targetKinds: ["network"], supportsCancellation: true, supportsNetworkIdentityEnforcement: true, costMeter: "none" },
    keyAvailability: { state: "available", keyReferenceId: "key:test", observedAt: at }, activeExternalEffects: 0,
    approvalKey: { keyId: body.approvalKeyId, publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") } };
  const options = { testOnlyAllowEphemeral: true };
  const admissions = new SqliteLocalAdmissionStore(":memory:", options), executions = new SqliteExecutionStateStore(":memory:", options),
    effects = new SqliteEffectClaimStore(":memory:", options), journal = new SqliteNativeRunJournal(":memory:", options);
  const dependencies: NativeStartAuthorityDependencies = { admissions, executions, effects, clock: () => now,
    async readCurrent() { reads++; return { ...policy, activeExternalEffects: effects.countActive(r.tenantId, r.nodeId) + extraActive }; },
    // Explicit synthetic qualification seam: this does not resolve accepted host evidence.
    async assertProfileCurrent() { profileChecks++; if (!profileAvailable) throw new Error("synthetic profile unavailable"); },
  };
  const config = { enrollment, request, start: prepared.start };
  const create = (overrides: Partial<NativeStartAuthorityDependencies> = {}) => createNativeStartAuthority(config, { ...dependencies, ...overrides });
  const calls: string[] = [];
  const transport: NativeRunTransport = { async json(wire) {
    await wire.authorize(); calls.push(wire.operation);
    if (wire.operation === "capabilities") return response(capabilityBody);
    if (wire.operation === "start") return response({ run_id: nativeRunId, status: "started", replayed: false }, 202);
    return response(statusBody("running", { session_id: prepared.binding.sessionId }));
  }, async events(wire) { await wire.authorize(); calls.push("events"); } };
  const adapter = (controller: ReturnType<typeof create>, wire = transport) => new HermesNativeRunAdapter(enrollment, journal, controller.authority, wire, () => now);
  return { ...f, prepared, config, policy, dependencies, admissions, executions, effects, journal, create, calls, transport, adapter,
    setNow: (value: number) => { now = value; }, setProfile: (value: boolean) => { profileAvailable = value; },
    setExtraActive: (value: number) => { extraActive = value; }, reads: () => reads, profileChecks: () => profileChecks,
    close: async () => { journal.close(); effects.close(); executions.close(); admissions.close(); if (!existingFixture) await f.close(); } };
}
