import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  type ControllerWorkerDeliveryPortV1, type ControllerWorkerDeliveryV1,
  type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerRouteV1 } from "./controller-worker-delivery";
import { controllerWorkerNodeDispatchBodySchemaV1 } from "./controller-worker-node-delivery";
import type { ServerNodeSession } from "../../node-control/server-node-session";
import { sha256Digest } from "../../security/canonical-digest";
import type { SignedNodeFrame } from "../../node-protocol/v1";

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

/**
 * The production-shaped counterpart to the small adapter above.  It binds the
 * existing signed node session to one enrolled worker and exposes only the
 * two phases that the session itself supports: transmit one immutable packet,
 * then accept its exact signed receipt.  It deliberately does not create a
 * connection, queue, retry loop, worker process, or database record.
 */
export interface AuthenticatedRemoteNodeSessionV1 {
  readonly workerId: string;
  readonly enrollmentDigest: string;
  readonly session: Pick<ServerNodeSession, "controllerWorkerDeliveryChannel" | "stageControllerWorkerDelivery"
    | "sendPreparedControllerWorkerDelivery" | "acceptControllerWorkerDeliveryReceipt">
    & Partial<Pick<ServerNodeSession, "recoverControllerWorkerDeliveryReceipt">>;
}

export type RemoteNodeDeliveryTransmissionV1 = Readonly<{
  queueId: string;
  enrollmentDigest: string;
  deliveryId: string;
  deliveryDigest: string;
  startsWork: false;
  grantsExecutionAuthority: false;
}>;

/**
 * Adapts an already-authenticated signed node session.  The caller retains
 * canonical receipt persistence because only the installation's PostgreSQL
 * authority may decide when a received acknowledgement is durable.
 */
export function createAuthenticatedRemoteNodeSessionDeliveryBridgeV1(input: Readonly<{
  session: AuthenticatedRemoteNodeSessionV1;
}>) {
  try {
    if (!input || typeof input !== "object" || !input.session || typeof input.session !== "object") unavailable();
    const bound = input.session;
    const workerId = controllerWorkerRouteSchemaV1.parse({ kind: "remote", workerId: bound.workerId }).workerId;
    const enrollmentDigest = /^sha256:[a-f0-9]{64}$/.test(bound.enrollmentDigest) ? bound.enrollmentDigest : unavailable();
    const session = bound.session;
    if (typeof session.controllerWorkerDeliveryChannel !== "function" || typeof session.stageControllerWorkerDelivery !== "function"
      || typeof session.sendPreparedControllerWorkerDelivery !== "function" || typeof session.acceptControllerWorkerDeliveryReceipt !== "function") unavailable();
    const queueIdFor = (delivery: ControllerWorkerDeliveryV1) => `native-queue:${sha256Digest({
      tenantId: delivery.identity.tenantId, jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId,
    }).slice(7)}`;
    return Object.freeze({
      async transmit(deliveryValue: unknown, routeValue: unknown, signal?: AbortSignal,
        persistIntent?: (frame: SignedNodeFrame<"controller.worker.delivery">) => Promise<void>): Promise<RemoteNodeDeliveryTransmissionV1> {
        if (signal?.aborted) unavailable();
        const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
        const route = controllerWorkerRouteSchemaV1.parse(routeValue);
        const channel = session.controllerWorkerDeliveryChannel();
        const activeChannel = channel ?? unavailable();
        if (route.kind !== "remote" || route.workerId !== workerId || delivery.worker.workerId !== workerId
          || delivery.identity.nodeId !== activeChannel.nodeId || signal?.aborted) unavailable();
        // `channel` is the authenticated, generation-bound view captured for
        // this transmission.  Keep the node identity as a plain immutable
        // value before either session callback runs; the session can be
        // replaced between callbacks, but that must not turn this packet into
        // a delivery for a different node.
        const channelNodeId = activeChannel.nodeId;
        const queueId = queueIdFor(delivery), deadline = Date.parse(delivery.expiresAt);
        await session.stageControllerWorkerDelivery(async (sign, current) => {
          current.assertCurrent();
          if (signal?.aborted || current.nodeId !== channelNodeId) unavailable();
          return sign(controllerWorkerNodeDispatchBodySchemaV1.parse({
            schema: "control-room.controller-worker-node-dispatch/v1", queueId, enrollmentDigest, delivery,
          }), deadline);
        });
        await session.sendPreparedControllerWorkerDelivery(async (frame, current) => {
          current.assertCurrent();
          if (signal?.aborted || frame.body.queueId !== queueId || frame.body.enrollmentDigest !== enrollmentDigest) unavailable();
          if (persistIntent) await persistIntent(frame);
          current.assertCurrent();
          if (signal?.aborted) unavailable();
          return { value: undefined, assertFresh: current.assertCurrent };
        });
        return Object.freeze({ queueId, enrollmentDigest, deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest,
          startsWork: false as const, grantsExecutionAuthority: false as const });
      },
      async acceptReceipt<T>(raw: string | Uint8Array, persist: (value: Readonly<{
        delivery: ControllerWorkerDeliveryV1;
        route: Readonly<{ kind: "remote"; workerId: string }>;
        receipt: ControllerWorkerDeliveryReceiptV1;
        assertCurrent(): void;
      }>) => Promise<T>): Promise<T> {
        if (typeof persist !== "function") unavailable();
        return session.acceptControllerWorkerDeliveryReceipt(raw, async (frame, dispatch, assertCurrent) => {
          if (dispatch.body.enrollmentDigest !== enrollmentDigest || dispatch.body.delivery.worker.workerId !== workerId) unavailable();
          assertCurrent();
          return persist(Object.freeze({ delivery: dispatch.body.delivery,
            route: Object.freeze({ kind: "remote" as const, workerId }), receipt: frame.body.receipt, assertCurrent }));
        });
      },
    });
  } catch { return unavailable(); }
}
