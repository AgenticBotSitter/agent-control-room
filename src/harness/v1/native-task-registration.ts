import { sha256Digest } from "../../security/canonical-digest";
import { bindingSchema, type NativeBinding } from "./native-run-contracts";
import { nativeTaskRegistrationSchema, NATIVE_HERMES_ADAPTER_ID, NATIVE_HERMES_VERSION, nativeTaskProtocolId } from "./native-observation";
import type { HarnessRunV1 } from "./types";

/** Pure intake evidence conversion. The receiving store verifies canonical bindings;
 * constructing this value neither imports a native runtime nor starts a run. */
export function nativeTaskRegistration(bindingInput: NativeBinding, inputDigest: string,
  leaseId: string, leaseEpoch: number, createdAt: string): HarnessRunV1 {
  const binding = bindingSchema.parse(bindingInput);
  for (const id of [binding.tenantId, binding.nodeId, binding.projectId, binding.jobId, binding.attemptId, binding.runId]) nativeTaskProtocolId.parse(id);
  const registration = nativeTaskRegistrationSchema.parse({ bindingDigest: sha256Digest(binding), inputDigest,
    leaseId, leaseEpoch, deadline: new Date(binding.deadline).toISOString() });
  if (Date.parse(createdAt) >= binding.deadline) throw new Error("native_registration_expired");
  return { schemaVersion: "control-room-harness/v1", id: binding.runId, tenantId: binding.tenantId,
    projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId, nodeId: binding.nodeId,
    adapterId: NATIVE_HERMES_ADAPTER_ID, adapterVersion: "1.0.0", harness: "hermes", harnessVersion: NATIVE_HERMES_VERSION,
    nativeSessionKeyDigest: sha256Digest(binding.sessionId), state: "discovered", resumable: false,
    cancelState: "not_requested", createdAt, updatedAt: createdAt, lastObservedAt: createdAt, nativeTask: registration };
}
