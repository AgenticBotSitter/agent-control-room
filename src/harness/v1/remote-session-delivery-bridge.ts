import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  type ControllerWorkerDeliveryPortV1, type ControllerWorkerDeliveryV1,
  type ControllerWorkerRouteV1 } from "./controller-worker-delivery";

const unavailable = (): never => { throw new Error("remote_worker_delivery_unavailable"); };

/**
 * A transport/session owner supplies this only after it has completed its own
 * authentication and enrollment work. Control Room deliberately does not own
 * connection creation, certificates, credentials, listener lifetime, or the
 * worker process here. The bridge has exactly one capability: hand the common
 * immutable delivery packet to the already-authenticated selected worker.
 */
export interface AuthenticatedRemoteDeliverySessionV1 {
  readonly workerId: string;
  receiveControllerWorkerDelivery(delivery: ControllerWorkerDeliveryV1,
    route: Readonly<{ kind: "remote"; workerId: string }>, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Converts an already-authenticated remote session into the topology-neutral
 * controller delivery port. It does not manufacture or persist a receipt;
 * the shared delivery and remote-admission paths retain those responsibilities.
 */
export function createAuthenticatedRemoteSessionDeliveryBridgeV1(input: Readonly<{
  session: AuthenticatedRemoteDeliverySessionV1;
}>): ControllerWorkerDeliveryPortV1 {
  try {
    if (!input || typeof input !== "object" || !input.session || typeof input.session !== "object") unavailable();
    const session = input.session;
    const workerId = controllerWorkerRouteSchemaV1.parse({ kind: "remote", workerId: session.workerId }).workerId;
    if (typeof session.receiveControllerWorkerDelivery !== "function") unavailable();
    // Bind once: a later mutable object cannot substitute a different sender.
    const send = session.receiveControllerWorkerDelivery.bind(session);
    return Object.freeze({ async receive(deliveryValue: ControllerWorkerDeliveryV1, routeValue: ControllerWorkerRouteV1,
      signal?: AbortSignal) {
      if (signal?.aborted) unavailable();
      let delivery!: ControllerWorkerDeliveryV1, route!: ControllerWorkerRouteV1;
      try {
        delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
        route = controllerWorkerRouteSchemaV1.parse(routeValue);
      } catch { unavailable(); }
      if (route.kind !== "remote" || route.workerId !== workerId || delivery.worker.workerId !== workerId || signal?.aborted) unavailable();
      return send(delivery, Object.freeze({ kind: "remote" as const, workerId }), signal);
    } });
  } catch { return unavailable(); }
}
