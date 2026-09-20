import type { NativeTaskSubmissionReference } from "../../src/persistence/native-task-submission";
import { WORKER_DELIVERY_CONTRACT_V1, captureWorkerDeliveryV1, type WorkerDeliveryV1 } from "../../src/web/v1/worker-delivery";

/**
 * Test-only delivery doubles for a unified-installation composition check.
 *
 * They intentionally do not open a socket, create an IPC endpoint, or run an
 * agent.  The lifecycle fixture below continues to use its existing signed
 * in-memory node wiring. These doubles make placement-specific receipt
 * behavior observable at the WorkerDeliveryV1 boundary: a local
 * acknowledgement is returned immediately, while a remote acknowledgement is
 * lost and can only be recovered by a later read-only reconciliation. They do
 * not replace the signed test wire, so they are not proof of exclusive
 * mounted-controller routing.
 */
export type SyntheticWorkerPlacement = "local" | "remote";

export type SyntheticWorkerDeliveryConformance = Readonly<{
  placement: SyntheticWorkerPlacement;
  delivery: WorkerDeliveryV1;
  deliveries: readonly NativeTaskSubmissionReference[];
  reconciliations: readonly NativeTaskSubmissionReference[];
}>;

export function syntheticWorkerDeliveryConformance(placement: SyntheticWorkerPlacement,
  reconcileCanonical: (reference: NativeTaskSubmissionReference, signal: AbortSignal) => Promise<{
    disposition: "not_observed" | "recorded" | "uncertain"; startsWork: false; grantsExecutionAuthority: false;
  }>, deliverCanonical?: (reference: NativeTaskSubmissionReference, signal: AbortSignal) => Promise<void>): SyntheticWorkerDeliveryConformance {
  const deliveries: NativeTaskSubmissionReference[] = [], reconciliations: NativeTaskSubmissionReference[] = [];
  const delivery = captureWorkerDeliveryV1({
    async deliver(reference, signal) {
      deliveries.push(reference);
      // Both placement doubles invoke the same existing signed test transport.
      // They differ only in whether its receipt reaches the caller immediately.
      await deliverCanonical?.(reference, signal);
      if (placement === "local") return { contract: WORKER_DELIVERY_CONTRACT_V1, disposition: "delivered" as const,
        deliveryConfirmed: true as const, startsWork: false as const, grantsExecutionAuthority: false as const };
      // The remote worker recorded the receipt, but its reply was dropped.
      // A send is never treated as permission to start work.
      return { contract: WORKER_DELIVERY_CONTRACT_V1, disposition: "unresolved" as const,
        deliveryConfirmed: false as const, startsWork: false as const, grantsExecutionAuthority: false as const };
    },
    async reconcile(reference, signal) {
      reconciliations.push(reference);
      const observed = await reconcileCanonical(reference, signal);
      return { contract: WORKER_DELIVERY_CONTRACT_V1, ...observed };
    },
  });
  return Object.freeze({ placement, delivery, deliveries, reconciliations });
}
