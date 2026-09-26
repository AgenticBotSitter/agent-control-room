import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import type { HarnessRunV1 } from "../v1/types";
import { controllerWorkerDeliverySchemaV1 } from "../v1/controller-worker-delivery";
import { HERMES_LOCAL_ADAPTER_V1 } from "./task-planning-contract";

const unavailable = (): never => { throw new Error("hermes_local_run_registration_unavailable"); };
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const version = z.string().min(1).max(180);

/**
 * Creates the ordinary Control Room run record for one admitted current
 * Hermes local delivery. This is the same existing run history Codex and
 * Claude use; it supplies no queue, process, credential, workspace or
 * permission of its own. The recorded harness version is supplied by the
 * caller from the current protected enablement record, since the pinned
 * Hermes executable can change after an owner-approved re-pin.
 */
export function hermesLocalRunRegistrationV1(deliveryValue: unknown, createdAtValue: unknown,
  harnessVersionValue: unknown): HarnessRunV1 {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const createdAt = instant.parse(createdAtValue);
  const harnessVersion = version.parse(harnessVersionValue);
  if (delivery.worker.adapterId !== HERMES_LOCAL_ADAPTER_V1
    || Date.parse(createdAt) >= Date.parse(delivery.expiresAt)) unavailable();
  return Object.freeze({
    schemaVersion: "control-room-harness/v1", id: delivery.identity.runId,
    tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
    jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId,
    nodeId: delivery.identity.nodeId, adapterId: HERMES_LOCAL_ADAPTER_V1,
    adapterVersion: "1.0.0", harness: "hermes", harnessVersion,
    nativeSessionKeyDigest: sha256Digest({ purpose: "hermes-local-run-binding/v1", deliveryDigest: delivery.deliveryDigest }),
    connectorProfileDigest: delivery.connectorProfileDigest, authorityDigest: delivery.authorityDigest,
    state: "discovered", resumable: false, cancelState: "unsupported",
    createdAt, updatedAt: createdAt, lastObservedAt: createdAt,
  });
}
