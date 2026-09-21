import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  deliverControllerWorkerPacketV1, type ControllerWorkerDeliveryPortV1,
  type ControllerWorkerDeliveryV1, type ControllerWorkerDeliveryReceiptV1 } from "../v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1, readControllerWorkerDeliveryReceiptV1 }
  from "../v1/controller-worker-delivery-receipt-store";
import { createClaudeCodeOwnedProcessSessionV1, type AcquireClaudeCodeProcessV1,
  type ClaudeCodeProcessBindingV1, type OwnedClaudeCodeProcessSessionV1 } from "./owned-process-session";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "./task-planning-contract";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "./result-publication";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("claude_code_local_delivery_unavailable"); };

/** Installation-owned values only. A controller delivery cannot select a local profile. */
export type ClaudeCodeLocalDeliveryBindingV1 = Readonly<{
  workerId: string;
  adapterId: string;
  adapterRevision: string;
  authorityDigest: string;
  acceptanceProfileId: string;
  acceptanceProfileDigest: string;
}>;

/** The current-admission fence is deliberately synchronous: an unresolved check
 * is not permission to acquire even the injected test process. */
export interface ClaudeCodeLocalStartAuthorityV1 {
  currentAdmissionDigest(identity: ControllerWorkerDeliveryV1["identity"]): string;
  assertCurrent(identity: ControllerWorkerDeliveryV1["identity"]): void;
}

/** The shared authenticated receipt is the durable, exact one-shot reservation.
 * No additional queue, database, retry record, or process record is introduced. */
export type ClaudeCodeLocalStartReservationV1 = Readonly<{
  delivery: ControllerWorkerDeliveryV1;
  receipt: ControllerWorkerDeliveryReceiptV1;
  reservationDigest: string;
  processBinding: ClaudeCodeProcessBindingV1;
  startsWork: false;
  grantsExecutionAuthority: false;
  permitsRetry: false;
  permitsResume: false;
}>;

export type ClaudeCodeLocalDeliveryCompositionV1 = Readonly<{
  db: DatabaseClient;
  integrityKey: Uint8Array;
  binding: ClaudeCodeLocalDeliveryBindingV1;
  authority: ClaudeCodeLocalStartAuthorityV1;
  receiptPort: ControllerWorkerDeliveryPortV1;
  /** This is an existing injected owned-process seam. Production has no CLI runner here. */
  acquire: AcquireClaudeCodeProcessV1;
  /** Re-reads the canonical task/lease binding after the receipt is durable and
   * immediately before acquisition. A queue locator alone is never enough. */
  recheckBeforeAcquire(delivery: ControllerWorkerDeliveryV1,
    route: z.infer<typeof controllerWorkerRouteSchemaV1>, signal: AbortSignal): Promise<void>;
  cleanupMs: number;
  /** Installation clock used only to fence the already-bounded delivery window. */
  clock: () => number;
}>;

function current(config: ClaudeCodeLocalDeliveryCompositionV1, delivery: ControllerWorkerDeliveryV1): void {
  try { assertSynchronousFence(() => config.authority.assertCurrent(delivery.identity), unavailable); }
  catch { unavailable(); }
  if (digest.parse(config.authority.currentAdmissionDigest(delivery.identity)) !== delivery.authorityDigest) unavailable();
}

function validateBinding(config: ClaudeCodeLocalDeliveryCompositionV1, delivery: ControllerWorkerDeliveryV1,
  route: z.infer<typeof controllerWorkerRouteSchemaV1>): void {
  const binding = config.binding;
  if (binding.adapterId !== CLAUDE_CODE_LOCAL_ADAPTER_V1 || route.kind !== "local" || route.workerId !== binding.workerId
    || delivery.worker.workerId !== binding.workerId || delivery.worker.adapterId !== binding.adapterId
    || delivery.worker.adapterRevision !== binding.adapterRevision || delivery.authorityDigest !== binding.authorityDigest
    || delivery.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
    || delivery.acceptanceProfileId !== binding.acceptanceProfileId
    || delivery.acceptanceProfileDigest !== binding.acceptanceProfileDigest) unavailable();
}

function reservationFor(delivery: ControllerWorkerDeliveryV1, receipt: ControllerWorkerDeliveryReceiptV1): ClaudeCodeLocalStartReservationV1 {
  const reservationDigest = sha256Digest({ delivery, receipt });
  return Object.freeze({
    delivery, receipt, reservationDigest,
    processBinding: Object.freeze({
      processAttemptId: `claude-process:${reservationDigest.slice(7)}`,
      runId: delivery.identity.runId, attemptId: delivery.identity.attemptId,
      invocationDigest: reservationDigest,
    }),
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const,
  });
}

/**
 * Admission is exact and the shared receipt is persisted before the injected
 * process seam can be reached. A receipt is both restart evidence and the
 * durable one-shot reservation: duplicate/restart delivery only returns it.
 * This deliberately does not decode output, publish a result, invoke a CLI,
 * read local configuration, or make any unsupported operation available.
 */
export async function deliverClaudeCodeLocalTaskV1(config: ClaudeCodeLocalDeliveryCompositionV1,
  deliveryValue: unknown, routeValue: unknown, receivedAtValue: unknown, signal?: AbortSignal) {
  if (!config || !config.db || typeof config.db.transaction !== "function" || !(config.integrityKey instanceof Uint8Array)
    || config.integrityKey.length !== 32 || !config.receiptPort || typeof config.receiptPort.receive !== "function"
    || typeof config.acquire !== "function" || typeof config.recheckBeforeAcquire !== "function" || !Number.isSafeInteger(config.cleanupMs)
    || config.cleanupMs < 1 || config.cleanupMs > 5_000 || typeof config.clock !== "function" || signal?.aborted) unavailable();
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const receivedAt = z.string().datetime().refine(value => new Date(value).toISOString() === value).parse(receivedAtValue);
  const prior = await config.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, config.integrityKey, delivery.identity));
  if (prior) {
    if (sha256Digest(prior.delivery) !== sha256Digest(delivery) || canonicalJson(prior.receipt.route) !== canonicalJson(route)) unavailable();
    return Object.freeze({ reservation: reservationFor(prior.delivery, prior.receipt), state: "already_reserved" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
  let highWater = Date.parse(receivedAt);
  const fence = () => {
    const now = config.clock();
    if (!Number.isSafeInteger(now) || now < highWater || now < Date.parse(delivery.issuedAt)
      || now >= Date.parse(delivery.expiresAt)) unavailable();
    highWater = now;
    current(config, delivery);
  };
  validateBinding(config, delivery, route);
  fence();
  let receipt: ControllerWorkerDeliveryReceiptV1, persisted: Awaited<ReturnType<typeof persistControllerWorkerDeliveryReceiptV1>>;
  try {
    receipt = await deliverControllerWorkerPacketV1(config.receiptPort, delivery, route, signal);
    persisted = await config.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, config.integrityKey,
      delivery, receipt, receivedAt));
  } catch {
    // A lost acknowledgement or a crash at the durable-commit boundary cannot
    // be recast as rejection or retried into acquisition.
    return Object.freeze({ delivery, state: "delivery_uncertain" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
  if (persisted.replayed) return Object.freeze({ reservation: reservationFor(delivery, persisted.receipt), state: "already_reserved" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  const reservation = reservationFor(delivery, receipt);
  if (receipt.disposition !== "accepted") return Object.freeze({ reservation, state: "receipt_rejected" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  try {
    if (signal?.aborted) unavailable();
    // This is the final fence immediately before synchronous acquisition in the
    // owned-session factory. The async recheck detects an altered canonical
    // task/lease after receipt persistence; the repeated local fence detects an
    // authority/clock change while that recheck was in flight.
    fence();
    await config.recheckBeforeAcquire(delivery, route, signal ?? new AbortController().signal);
    if (signal?.aborted) unavailable();
    fence();
    const session = createClaudeCodeOwnedProcessSessionV1({ binding: reservation.processBinding,
      signal: signal ?? new AbortController().signal, acquire: config.acquire, cleanupMs: config.cleanupMs });
    return Object.freeze({ reservation, session, state: "reserved_session_open" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  } catch {
    return Object.freeze({ reservation, state: "delivery_uncertain" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
}

export type ClaudeCodeLocalDeliveryResultV1 = Awaited<ReturnType<typeof deliverClaudeCodeLocalTaskV1>>;
export type ClaudeCodeReservedSessionV1 = Readonly<{ reservation: ClaudeCodeLocalStartReservationV1; session: OwnedClaudeCodeProcessSessionV1 }>;
