import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import type { HarnessRunV1 } from "../v1/types";
import { controllerWorkerDeliverySchemaV1 } from "../v1/controller-worker-delivery";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "./task-planning-contract";
import { CLAUDE_CODE_PACKAGE_VERSION_V1 } from "./connector-profile";

const unavailable = (): never => { throw new Error("claude_code_local_run_registration_unavailable"); };
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

/**
 * Creates the ordinary Control Room run record for one admitted local Claude
 * delivery. This is the same existing run history Hermes uses; it supplies no
 * queue, process, credential, workspace or permission of its own.
 */
export function ClaudeCodeLocalRunRegistrationV1(deliveryValue: unknown, createdAtValue: unknown): HarnessRunV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const createdAt = instant.parse(createdAtValue);
  if (delivery.worker.adapterId !== CLAUDE_CODE_LOCAL_ADAPTER_V1
    || Date.parse(createdAt) >= Date.parse(delivery.expiresAt)) unavailable();
  return Object.freeze({
    schemaVersion: "control-room-harness/v1", id: delivery.identity.runId,
    tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
    jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId,
    nodeId: delivery.identity.nodeId, adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1,
    adapterVersion: "1.0.0", harness: "claude", harnessVersion: CLAUDE_CODE_PACKAGE_VERSION_V1,
    nativeSessionKeyDigest: sha256Digest({ purpose: "claude-code-local-run-binding/v1", deliveryDigest: delivery.deliveryDigest }),
    connectorProfileDigest: delivery.connectorProfileDigest, authorityDigest: delivery.authorityDigest,
    state: "discovered", resumable: false, cancelState: "unsupported",
    createdAt, updatedAt: createdAt, lastObservedAt: createdAt,
  });
}
