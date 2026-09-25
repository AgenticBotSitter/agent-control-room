import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  type ControllerWorkerDeliveryV1, type ControllerWorkerRouteV1 } from "./controller-worker-delivery";

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
    const row = (await tx.query<{ id: string }>(
      "SELECT id FROM control_leases WHERE tenant_id=$1 AND attempt_id=$2 AND state='active' FOR UPDATE",
      [delivery.identity.tenantId, delivery.identity.attemptId])).rows[0];
    if (!row) unavailable();
    return id.parse(row.id);
  });
  return Object.freeze({ tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
    jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId, leaseId, inputDigest: delivery.inputDigest });
}

/**
 * Builds the CLI bridge's per-call `assertCurrent(delivery, route, signal)`
 * fence from an existing, already-reviewed `*DispatchPreparationV1` instance.
 * It re-derives the current reference from the delivery being asserted (not
 * from a closure over the original `prepare()` call, since the bridge calls
 * this three times per task, after the original `prepared` value has gone out
 * of scope) and requires a fresh `prepare()` to reproduce the exact same
 * delivery and route. It duplicates none of that class's lease/job/attempt
 * re-derivation logic; a changed or revoked lease simply makes the fresh
 * `prepare()` throw, which this function does not catch.
 */
export function createOwnerTrustedLocalCliAssertCurrentV1(db: DatabaseClient, preparation: Preparation) {
  if (!db || typeof db.transaction !== "function" || !preparation || typeof preparation.prepare !== "function") unavailable();
  return async function assertCurrent(deliveryValue: unknown, routeValue: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) unavailable();
    const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
    const route = controllerWorkerRouteSchemaV1.parse(routeValue);
    const reference = await deriveOwnerTrustedLocalCliDispatchReferenceV1(db, delivery);
    const current = await preparation.prepare(reference);
    if (current.delivery.deliveryDigest !== delivery.deliveryDigest || current.route.kind !== route.kind
      || current.route.workerId !== route.workerId) unavailable();
    if (signal?.aborted) unavailable();
  };
}
