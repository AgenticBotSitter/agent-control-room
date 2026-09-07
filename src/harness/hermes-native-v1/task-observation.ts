import { sha256Digest } from "../../security/canonical-digest";
import { createHash } from "node:crypto";
import { snapshotSchema, type NativeSnapshot } from "./contracts";
import { nativeTaskRegistrationSchema, nativeTaskSnapshotBodySchema,
  type NativeTaskRegistration, type NativeTaskSnapshotBody } from "../v1/native-observation";
export { nativeTaskRegistration } from "../v1/native-task-registration";

/** Strip native handles, prompt/output text and configuration before the signed node protocol.
 * Final text stays in the node-private journal/artifact path. Its hash is only a producer claim. */
export function nativeTaskObservation(snapshotInput: NativeSnapshot, registration: NativeTaskRegistration): NativeTaskSnapshotBody {
  const snapshot = snapshotSchema.parse(snapshotInput), bound = nativeTaskRegistrationSchema.parse(registration);
  if (sha256Digest(snapshot.binding) !== bound.bindingDigest || new Date(snapshot.binding.deadline).toISOString() !== bound.deadline) {
    throw new Error("native_observation_binding_mismatch");
  }
  const binding = snapshot.binding;
  return nativeTaskSnapshotBodySchema.parse({ runId: binding.runId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, leaseId: bound.leaseId, leaseEpoch: bound.leaseEpoch, bindingDigest: bound.bindingDigest,
    sessionKeyDigest: sha256Digest(binding.sessionId), nativeRunKeyDigest: snapshot.nativeRunId === null ? null : sha256Digest(snapshot.nativeRunId),
    snapshotVersion: snapshot.version, observedAt: new Date(snapshot.observedAt).toISOString(),
    upstreamUpdatedAt: snapshot.upstreamUpdatedAt === null ? null : new Date(snapshot.upstreamUpdatedAt).toISOString(),
    state: snapshot.state, availability: snapshot.availability, lastActivity: snapshot.lastActivity,
    stopAttempted: snapshot.stopAttempted, safeReason: snapshot.safeReason, usage: snapshot.usage,
    result: snapshot.resultText === null ? null : { contentHash: `sha256:${createHash("sha256").update(snapshot.resultText, "utf8").digest("hex")}`, sizeBytes: Buffer.byteLength(snapshot.resultText, "utf8") } });
}
