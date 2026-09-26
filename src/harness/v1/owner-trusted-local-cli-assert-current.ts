import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  type ControllerWorkerDeliveryV1, type ControllerWorkerRouteV1 } from "./controller-worker-delivery";
import { canonicalJson } from "../../security/canonical-digest";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const unavailable = (): never => { throw new Error("owner_trusted_local_cli_assert_current_unavailable"); };

/**
 * Same shape every `*DispatchPreparationV1.prepare` accepts
 * (Codex/Hermes/Claude owner-trusted-local dispatch references).
 */
export type OwnerTrustedLocalCliDispatchReferenceV1 = Readonly<{
  tenantId: string; projectId: string; jobId: string; attemptId: string; leaseId: string; inputDigest: string;
}>;

type PreparedLike = Readonly<{ delivery: ControllerWorkerDeliveryV1; route: ControllerWorkerRouteV1 }>;
type Preparation = Readonly<{ prepare(reference: OwnerTrustedLocalCliDispatchReferenceV1): Promise<PreparedLike> }>;
/** The host generation's pinned-executable readiness (MacLocalWorkerReadinessV1). */
type Readiness = Readonly<{ isReady(workerId: string): boolean }>;

/** Everything a fresh preparation must reproduce. `issuedAt`, and the `deliveryId`
 * and `deliveryDigest` derived from it, are deliberately excluded: each
 * `prepare()` stamps the current time, so they differ on every call. The run id
 * inside `identity` binds the lease id and plan digest, and `expiresAt` comes
 * from the lease and job authority, so a replaced lease or plan still differs. */
function binding(delivery: ControllerWorkerDeliveryV1, route: ControllerWorkerRouteV1): string {
  return canonicalJson({ identity: delivery.identity, worker: delivery.worker, input: delivery.input,
    inputDigest: delivery.inputDigest, authorityDigest: delivery.authorityDigest,
    connectorProfileDigest: delivery.connectorProfileDigest, acceptanceProfileId: delivery.acceptanceProfileId,
    acceptanceProfileDigest: delivery.acceptanceProfileDigest, expiresAt: delivery.expiresAt, route });
}

/**
 * Looks up the attempt's current active lease directly, independent of any
 * one earlier preparation. This is the only piece `assertCurrent` needs that
 * a `ControllerWorkerDeliveryV1` does not already carry (it has
 * `identity.{tenantId,projectId,jobId,attemptId}` and `inputDigest`, but not
 * `leaseId`). A revoked or replaced lease means no row matches, which fails
 * closed the same way a stale `prepare()` call already does.
 */
export async function deriveOwnerTrustedLocalCliDispatchReferenceV1(db: DatabaseClient,
  delivery: ControllerWorkerDeliveryV1): Promise<OwnerTrustedLocalCliDispatchReferenceV1> {
  const leaseId = await db.transaction(async tx => {
    const rows = (await tx.query<{ id: string }>(
      "SELECT id FROM control_leases WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3 AND state='active' FOR UPDATE",
      [delivery.identity.tenantId, delivery.identity.jobId, delivery.identity.attemptId])).rows;
    // Exactly one active lease; none (revoked or expired) or several is never guessed between.
    if (rows.length !== 1) unavailable();
    return id.parse(rows[0]!.id);
  });
  return Object.freeze({ tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
    jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId, leaseId, inputDigest: delivery.inputDigest });
}

/**
 * Builds the CLI bridge's per-call `assertCurrent(delivery, route, signal)`
 * fence (docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md). Both fences
 * must pass on every call: (A) canonical task authority, re-derived through an
 * existing, already-reviewed `*DispatchPreparationV1` instance, and (B) the
 * owner enablement, meaning the pinned worker is still ready in this host generation.
 * It re-derives the current reference from the delivery being asserted (not
 * from a closure over the original `prepare()` call, since the bridge calls
 * this three times per task, after the original `prepared` value has gone out
 * of scope) and requires a fresh `prepare()` to reproduce the exact same
 * delivery and route. It duplicates none of that class's lease/job/attempt
 * re-derivation logic; a changed or revoked lease simply makes the fresh
 * `prepare()` throw, which this function does not catch.
 */
export function createOwnerTrustedLocalCliAssertCurrentV1(db: DatabaseClient, preparation: Preparation, readiness: Readiness) {
  if (!db || typeof db.transaction !== "function" || !preparation || typeof preparation.prepare !== "function"
    || !readiness || typeof readiness.isReady !== "function") unavailable();
  const ready = (workerId: string) => { if (readiness.isReady(workerId) !== true) unavailable(); };
  return async function assertCurrent(deliveryValue: unknown, routeValue: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) unavailable();
    const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
    const route = controllerWorkerRouteSchemaV1.parse(routeValue);
    if (route.kind !== "local" || route.workerId !== delivery.worker.workerId) unavailable();
    ready(delivery.worker.workerId);
    const reference = await deriveOwnerTrustedLocalCliDispatchReferenceV1(db, delivery);
    const current = await preparation.prepare(reference);
    if (binding(current.delivery, current.route) !== binding(delivery, route)) unavailable();
    // A re-pin or readiness failure that landed during the database checks still refuses.
    ready(delivery.worker.workerId);
    if (signal?.aborted) unavailable();
  };
}
