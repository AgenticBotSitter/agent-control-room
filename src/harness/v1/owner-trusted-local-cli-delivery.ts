import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  deliverControllerWorkerPacketV1, type ControllerWorkerDeliveryPortV1,
  type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerDeliveryV1,
  type ControllerWorkerRouteV1 } from "./controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1, readControllerWorkerDeliveryReceiptV1 }
  from "./controller-worker-delivery-receipt-store";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

const text = z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 65_536);
function unavailable(): never { throw new Error("owner_trusted_local_cli_delivery_unavailable"); }

/** The narrow result shape deliberately loses provider-specific fields.  The
 * installation-owned publisher below is responsible for projecting this text
 * into the existing canonical result/review lifecycle. */
export type OwnerTrustedLocalCliExecutionV1 = Readonly<
  | { kind: "completed"; text: string }
  | { kind: "failed"; reason: string }
>;

export type OwnerTrustedLocalCliDeliveryBindingV1 = Readonly<{
  workerId: string;
  adapterId: string;
  adapterRevision: string;
}>;

export type OwnerTrustedLocalCliDeliveryV1 = Readonly<{
  db: DatabaseClient;
  integrityKey: Uint8Array;
  binding: OwnerTrustedLocalCliDeliveryBindingV1;
  /** The established, non-executing receipt endpoint. */
  receiptPort: ControllerWorkerDeliveryPortV1;
  /** Installation-owned canonical lease/revocation fence. It is called both
   * before the receipt and immediately before the process boundary. */
  assertCurrent(delivery: ControllerWorkerDeliveryV1, route: ControllerWorkerRouteV1,
    signal: AbortSignal): Promise<void>;
  /** An adapter-owned process call. It cannot choose a worker from the packet. */
  execute(input: Readonly<{ delivery: ControllerWorkerDeliveryV1; receipt: ControllerWorkerDeliveryReceiptV1;
    signal: AbortSignal }>): Promise<OwnerTrustedLocalCliExecutionV1>;
  /** An installation-owned closure over the existing result binding and
   * publisher. This bridge neither creates a result record nor a second store. */
  publish(input: Readonly<{ delivery: ControllerWorkerDeliveryV1; receipt: ControllerWorkerDeliveryReceiptV1;
    text: string; signal: AbortSignal }>): Promise<void>;
  /** Records an observed failed process without creating a result. */
  recordFailure(input: Readonly<{ delivery: ControllerWorkerDeliveryV1; receipt: ControllerWorkerDeliveryReceiptV1;
    signal: AbortSignal }>): Promise<void>;
}>;

function validBinding(binding: unknown): binding is OwnerTrustedLocalCliDeliveryBindingV1 {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const value = binding as Record<string, unknown>;
  return Object.keys(value).length === 3 && typeof value.workerId === "string" && value.workerId.length >= 3
    && typeof value.adapterId === "string" && value.adapterId.length >= 3
    && typeof value.adapterRevision === "string" && value.adapterRevision.length >= 7;
}

function validate(config: OwnerTrustedLocalCliDeliveryV1, delivery: ControllerWorkerDeliveryV1,
  route: ControllerWorkerRouteV1): void {
  if (!config || !config.db || typeof config.db.transaction !== "function" || !(config.integrityKey instanceof Uint8Array)
    || config.integrityKey.length !== 32 || !validBinding(config.binding) || !config.receiptPort
    || typeof config.receiptPort.receive !== "function" || typeof config.assertCurrent !== "function"
    || typeof config.execute !== "function" || typeof config.publish !== "function" || typeof config.recordFailure !== "function" || route.kind !== "local"
    || route.workerId !== config.binding.workerId || delivery.worker.workerId !== config.binding.workerId
    || delivery.worker.adapterId !== config.binding.adapterId || delivery.worker.adapterRevision !== config.binding.adapterRevision) unavailable();
}

function result(value: unknown): OwnerTrustedLocalCliExecutionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "completed" && Object.keys(candidate).length === 2 && typeof candidate.text === "string")
    return Object.freeze({ kind: "completed" as const, text: text.parse(candidate.text) });
  if (candidate.kind === "failed" && Object.keys(candidate).length === 2 && typeof candidate.reason === "string"
    && candidate.reason.length >= 1 && candidate.reason.length <= 240) return Object.freeze({ kind: "failed" as const, reason: candidate.reason });
  return unavailable();
}

/**
 * One Mac-local bridge for owner-trusted text CLIs. It reuses the durable
 * controller receipt as the one-shot execution fence, then calls an existing
 * canonical authority check and result publisher supplied by the host. It
 * adds no queue, scheduler, database, retry decision, or result store.
 */
export async function deliverOwnerTrustedLocalCliTaskV1(config: OwnerTrustedLocalCliDeliveryV1,
  deliveryValue: unknown, routeValue: unknown, receivedAt: string, signal = new AbortController().signal) {
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const when = z.string().datetime().refine(value => new Date(value).toISOString() === value).parse(receivedAt);
  validate(config, delivery, route);
  if (!(signal instanceof AbortSignal) || signal.aborted) return Object.freeze({ delivery, state: "delivery_cancelled" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });

  const prior = await config.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, config.integrityKey, delivery.identity));
  if (prior) {
    if (sha256Digest(prior.delivery) !== sha256Digest(delivery) || canonicalJson(prior.receipt.route) !== canonicalJson(route)) unavailable();
    return Object.freeze({ delivery, receipt: prior.receipt, state: "already_delivered" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }

  try {
    await config.assertCurrent(delivery, route, signal);
    if (signal.aborted) return Object.freeze({ delivery, state: "delivery_cancelled" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
    const receipt = await deliverControllerWorkerPacketV1(config.receiptPort, delivery, route, signal);
    // The receipt port stamps its own, later, receivedAt. The record is written
    // after that receipt exists, so it is recorded at the later of the two; the
    // store still refuses any record that precedes its receipt.
    const recordedAt = Date.parse(receipt.receivedAt) > Date.parse(when) ? receipt.receivedAt : when;
    const persisted = await config.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, config.integrityKey,
      delivery, receipt, recordedAt));
    if (persisted.replayed) return Object.freeze({ delivery, receipt: persisted.receipt, state: "already_delivered" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
    if (receipt.disposition !== "accepted") return Object.freeze({ delivery, receipt, state: "receipt_rejected" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
    await config.assertCurrent(delivery, route, signal);
    if (signal.aborted) return Object.freeze({ delivery, receipt, state: "delivery_cancelled" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
    const execution = result(await config.execute(Object.freeze({ delivery, receipt, signal })));
    if (execution.kind === "failed") {
      await config.recordFailure(Object.freeze({ delivery, receipt, signal }));
      return Object.freeze({ delivery, receipt, state: "execution_failed" as const,
        reason: execution.reason, startsWork: false as const, grantsExecutionAuthority: false as const });
    }
    // A text CLI can run for minutes. Re-check cancellation and the existing
    // canonical lease immediately before publication; an earlier pre-spawn
    // check is never permission to publish a result after revocation.
    if (signal.aborted) return Object.freeze({ delivery, receipt, state: "delivery_cancelled" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
    await config.assertCurrent(delivery, route, signal);
    if (signal.aborted) return Object.freeze({ delivery, receipt, state: "delivery_cancelled" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
    await config.publish(Object.freeze({ delivery, receipt, text: execution.text, signal }));
    return Object.freeze({ delivery, receipt, state: "published" as const, contentDigest: sha256Digest(execution.text),
      startsWork: false as const, grantsExecutionAuthority: false as const });
  } catch {
    return Object.freeze({ delivery, state: signal.aborted ? "delivery_cancelled" as const : "delivery_uncertain" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
}
