import { createHash, generateKeyPairSync } from "node:crypto";
import { taskAssignmentFixture } from "./task-assignment";
import { nativeLeaseEvidenceFixture } from "./native-lease-evidence";
import { binding, enrollment, instant } from "../hermes-native-fixture";
import { TaskAssignmentCoordinator } from "../../src/web/v1/task-assignment-coordinator";
import { NativeApprovalPacketStore } from "../../src/web/v1/native-approval-packet-store";
import { PinnedApprovalTrustStore } from "../../src/node-policy/v1/pinned-approval-trust";
import { signArtifact, computeArtifactBodyDigest } from "../../src/node-policy/v1/crypto";
import { sha256Digest } from "../../src/security";
import type { DatabaseClient } from "../../src/persistence/database";
import type { NativeTaskSubmission } from "../../src/persistence/native-task-submission";

export async function canonicalApprovalStorageFixture() {
  const f = await taskAssignmentFixture(), native = await nativeLeaseEvidenceFixture(); await f.assign();
  let now = instant + 9000; const clock = () => now, keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pin = { keyId: "approval-key:storage", algorithm: "ed25519", spki,
    fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` };
  const approvals = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1",
    tenantId: binding.tenantId, nodeId: binding.nodeId, nodeClass: "personal-compute", validFrom: instant,
    validUntil: enrollment.validUntil, keys: [pin] }, { security: native.trust, clock });
  const store = new NativeApprovalPacketStore(new Uint8Array(32).fill(75), [{ approvals, security: native.trust }], clock);
  const create = (db: DatabaseClient = f.db, submission?: NativeTaskSubmission) => new TaskAssignmentCoordinator(db, f.scope, f.planner, [f.route], clock,
    [{ enrollment, nodeClass: "personal-compute" }], store, submission);
  const coordinator = create(), args = [f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest] as const;
  const prepared = await coordinator.prepareNativeApproval(...args);
  const sign = <T extends object>(body: T) => signArtifact({ ...body, bodyDigest: computeArtifactBodyDigest(body) }, keys.privateKey);
  const packet = { schema: "control-room.native-task-approval-packet/v1" as const,
    approval: sign({ ...native.startConfig.request.approval.body, approvalKeyId: pin.keyId,
      jobId: prepared.request.jobId, attemptId: prepared.request.attemptId, operationDigest: prepared.request.operationDigest,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(prepared.start.deadline).toISOString() }),
    recovery: sign({ schema: "control-room.native-run-recovery-permission/v1", bindingDigest: sha256Digest(prepared.binding),
      approvalKeyId: pin.keyId, issuedAt: now, expiresAt: prepared.start.deadline + 120_000,
      operations: ["status", "stop"], nonce: "synthetic-storage-nonce" }) };
  const abort = new AbortController();
  const save = (value: unknown = packet, c = coordinator) => c.storeNativeApproval(...args, value, abort.signal);
  return { ...f, assignmentFixture: f, native, approvals, prepared, packet, abort, sign, save, create, args, coordinator, store, clock,
    setNow: (value: number) => { now = value; }, count: async () => (await f.db.query("SELECT * FROM control_native_approval_packets")).rows.length,
    close: async () => { approvals.close(); await native.close(); await f.close(); } };
}
