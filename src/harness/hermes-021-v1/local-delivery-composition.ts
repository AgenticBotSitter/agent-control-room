import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1, deliverControllerWorkerPacketV1,
  type ControllerWorkerDeliveryV1, type ControllerWorkerRouteV1 } from "../v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1 } from "../v1/controller-worker-delivery-receipt-store";
import { acceptHermes021MacosLocalDeliveryV1, hermes021MacosLocalBindingSchemaV1,
  runAdmittedHermes021MacosLocalTaskV1, type Hermes021MacosLocalPrivatePortV1,
  type Hermes021MacosTaskOutcomeV1, type Hermes021MacosTaskPolicyPortV1 } from "./macos-local-worker";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const unavailable = (): never => { throw new Error("hermes_021_macos_local_delivery_unavailable"); };

export type Hermes021MacosLocalDeliveryCompositionV1 = Readonly<{
  db: DatabaseClient;
  integrityKey: Uint8Array;
  binding: z.infer<typeof hermes021MacosLocalBindingSchemaV1>;
  policy: Hermes021MacosTaskPolicyPortV1;
  privatePort: Hermes021MacosLocalPrivatePortV1;
}>;

/**
 * Topology-neutral delivery composed with Marvin's local execution seam.
 * It records the accepted receipt before contacting Hermes. An exact replay
 * after a restart returns `already_delivered`; it deliberately does not run
 * Marvin again because the original invocation may already have happened.
 * It neither creates a task, lease, queue nor an execution permission.
 */
export async function deliverHermes021MacosLocalTaskV1(config: Hermes021MacosLocalDeliveryCompositionV1,
  deliveryValue: unknown, routeValue: unknown, receivedAtValue: unknown, signal?: AbortSignal) {
  if (!config || !(config.integrityKey instanceof Uint8Array) || config.integrityKey.length !== 32
    || !config.db || typeof config.db.transaction !== "function" || signal?.aborted) unavailable();
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const receivedAt = instant.parse(receivedAtValue);
  const binding = hermes021MacosLocalBindingSchemaV1.parse(config.binding);
  if (route.kind !== "local" || route.workerId !== binding.workerId || delivery.worker.workerId !== binding.workerId) unavailable();
  const receipt = await deliverControllerWorkerPacketV1({ receive: async (packet: ControllerWorkerDeliveryV1,
    packetRoute: ControllerWorkerRouteV1) => acceptHermes021MacosLocalDeliveryV1(packet, packetRoute, binding,
      config.policy, receivedAt) }, delivery, route, signal);
  const persisted = await config.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, config.integrityKey,
    delivery, receipt, receivedAt));
  if (persisted.replayed) return Object.freeze({ delivery, receipt: persisted.receipt, state: "already_delivered" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  const outcome: Hermes021MacosTaskOutcomeV1 = await runAdmittedHermes021MacosLocalTaskV1(delivery, route, binding,
    config.policy, config.privatePort, signal);
  return Object.freeze({ delivery, receipt, state: "completed_delivery" as const, outcome,
    startsWork: false as const, grantsExecutionAuthority: false as const });
}
