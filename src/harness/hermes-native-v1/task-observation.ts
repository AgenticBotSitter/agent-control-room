import { sha256Digest } from "../../security/canonical-digest";
import { createHash } from "node:crypto";
import { snapshotSchema, bindingSchema, type NativeBinding, type NativeSnapshot } from "./contracts";
import { nativeTaskRegistrationSchema, nativeTaskSnapshotBodySchema, NATIVE_HERMES_ADAPTER_ID, NATIVE_HERMES_VERSION,
  type NativeTaskRegistration, type NativeTaskSnapshotBody } from "../v1/native-observation";
import type { HarnessRunV1 } from "../v1/types";

/** Trusted coordinator registration after admission, not authority. The receiving store checks the
 * canonical job/input/attempt/lease. Creating this value does not start a run. */
export function nativeTaskRegistration(bindingInput: NativeBinding, inputDigest: string,
  leaseId: string, leaseEpoch: number, createdAt: string): HarnessRunV1 {
  const binding = bindingSchema.parse(bindingInput);
  const registration = nativeTaskRegistrationSchema.parse({ bindingDigest: sha256Digest(binding), inputDigest,
    leaseId, leaseEpoch, deadline: new Date(binding.deadline).toISOString() });
  if (Date.parse(createdAt) >= binding.deadline) throw new Error("native_registration_expired");
  return { schemaVersion: "control-room-harness/v1", id: binding.runId, tenantId: binding.tenantId,
    projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId, nodeId: binding.nodeId,
    adapterId: NATIVE_HERMES_ADAPTER_ID, adapterVersion: "1.0.0", harness: "hermes", harnessVersion: NATIVE_HERMES_VERSION,
    nativeSessionKeyDigest: sha256Digest(binding.sessionId), state: "discovered", resumable: false,
    cancelState: "not_requested", createdAt, updatedAt: createdAt, lastObservedAt: createdAt, nativeTask: registration };
}

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
