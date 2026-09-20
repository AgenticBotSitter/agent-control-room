import { z } from 'zod';
import type { DatabaseClient } from '../../persistence/database';
import { canonicalJson, sha256Digest } from '../../security/canonical-digest';
import { assertSynchronousFence } from '../../security/synchronous-fence';
import { controllerWorkerDeliverySchemaV1, controllerWorkerRouteSchemaV1,
  deliverControllerWorkerPacketV1, type ControllerWorkerDeliveryPortV1 } from '../v1/controller-worker-delivery';
import { persistControllerWorkerDeliveryReceiptV1, readControllerWorkerDeliveryReceiptV1 }
  from '../v1/controller-worker-delivery-receipt-store';
import { parseCodexTaskActivationV1, type CodexActivationFrameV1 } from './activation-contract';
import type { CodexLocalStartAuthorityV1 } from './local-start-runtime';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error('codex_local_delivery_unavailable'); };

type ActivationEvidence = Readonly<{ frame: CodexActivationFrameV1; receivedAt: string }>;

/** The adapter binding is installation-owned. It is deliberately not taken
 * from the controller packet, so a packet cannot select a local Codex profile. */
export type CodexLocalDeliveryBindingV1 = Readonly<{
  workerId: string;
  adapterId: string;
  adapterRevision: string;
  authorityDigest: string;
  acceptanceProfileId: string;
  acceptanceProfileDigest: string;
}>;

export type CodexLocalDeliveryCompositionV1 = Readonly<{
  db: DatabaseClient;
  integrityKey: Uint8Array;
  binding: CodexLocalDeliveryBindingV1;
  /** Same current-admission fence supplied to the existing local start host. */
  authority: CodexLocalStartAuthorityV1;
  /** Already authenticated and journaled activation evidence; this adapter never creates it. */
  activationEvidence: Readonly<{ acceptedCodexActivation(queueId: string): ActivationEvidence | undefined }>;
  /** Existing one-shot initial host. The adapter has no process acquisition port. */
  host: Readonly<{ run(signal: AbortSignal): Promise<unknown> }>;
  /** Existing non-executing controller receipt endpoint. */
  receiptPort: ControllerWorkerDeliveryPortV1;
}>;

function current(config: CodexLocalDeliveryCompositionV1, queueId: string, admissionDigest: string): void {
  // Installation fencing failures are intentionally not exposed through this
  // adapter. They mean the delivery is unavailable; their internal cause is
  // not task-facing evidence.
  try { assertSynchronousFence(() => config.authority.assertCurrent(queueId), unavailable); }
  catch { unavailable(); }
  if (digest.parse(config.authority.currentAdmissionDigest(queueId)) !== admissionDigest) unavailable();
}

function activationFor(config: CodexLocalDeliveryCompositionV1, delivery: z.infer<typeof controllerWorkerDeliverySchemaV1>,
  route: z.infer<typeof controllerWorkerRouteSchemaV1>, receivedAt: string) {
  const binding = config.binding;
  if (route.kind !== 'local' || route.workerId !== binding.workerId
    || delivery.worker.workerId !== binding.workerId || delivery.worker.adapterId !== binding.adapterId
    || delivery.worker.adapterRevision !== binding.adapterRevision || delivery.authorityDigest !== binding.authorityDigest
    || delivery.acceptanceProfileId !== binding.acceptanceProfileId
    || delivery.acceptanceProfileDigest !== binding.acceptanceProfileDigest) unavailable();
  const evidence = config.activationEvidence.acceptedCodexActivation(`native-queue:${sha256Digest({
    tenantId: delivery.identity.tenantId, jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId,
  }).slice(7)}`);
  if (!evidence || !evidence.frame) unavailable();
  const frame = evidence.frame;
  if (frame.type !== 'harness.codex.dispatch.activation' || frame.direction !== 'server_to_node'
    || frame.senderKind !== 'control_room') unavailable();
  const activation = parseCodexTaskActivationV1(frame.body);
  if (activation.queueId !== frame.body.queueId || activation.tenantId !== delivery.identity.tenantId
    || activation.projectId !== delivery.identity.projectId || activation.nodeId !== delivery.identity.nodeId
    || activation.jobId !== delivery.identity.jobId || activation.attemptId !== delivery.identity.attemptId
    || activation.runId !== delivery.identity.runId || activation.prompt !== delivery.input.prompt
    || activation.instructions !== delivery.input.instructions || activation.inputDigest !== delivery.inputDigest
    || activation.connectorProfileDigest !== delivery.connectorProfileDigest
    || activation.startsWork || !activation.authorizesExactStart || activation.grantsExecutionAuthority
    || activation.permitsRetry || activation.permitsResume || activation.permitsThreadRead
    || Date.parse(receivedAt) < Date.parse(delivery.issuedAt) || Date.parse(receivedAt) > Date.parse(delivery.expiresAt)
    || Date.parse(receivedAt) < Date.parse(activation.activatedAt) || Date.parse(receivedAt) >= Date.parse(activation.activationExpiresAt)
    || Date.parse(receivedAt) >= Date.parse(frame.expiresAt)) unavailable();
  current(config, activation.queueId, activation.currentAdmissionDigest);
  return activation;
}

/**
 * Source-only bridge from the shared controller delivery record to an
 * already-composed Codex local host. It persists the controller receipt before
 * the host can acquire its injected process. Replays never call the host; a
 * failure after that receipt is deliberately reported as uncertainty.
 */
export async function deliverCodexLocalTaskV1(config: CodexLocalDeliveryCompositionV1,
  deliveryValue: unknown, routeValue: unknown, receivedAtValue: unknown, signal?: AbortSignal) {
  if (!config || !config.db || typeof config.db.transaction !== 'function' || !(config.integrityKey instanceof Uint8Array)
    || config.integrityKey.length !== 32 || !config.host || typeof config.host.run !== 'function' || signal?.aborted) unavailable();
  const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
  const route = controllerWorkerRouteSchemaV1.parse(routeValue);
  const receivedAt = z.string().datetime().refine((value: string) => new Date(value).toISOString() === value).parse(receivedAtValue);
  // Validate immutable identity first, then let an exact historical receipt
  // short-circuit an expired/revoked retry without acquiring another process.
  const prior = await config.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx, config.integrityKey, delivery.identity));
  if (prior) {
    if (sha256Digest(prior.delivery) !== sha256Digest(delivery)
      || canonicalJson(prior.receipt.route) !== canonicalJson(route)) unavailable();
    return Object.freeze({ delivery, receipt: prior.receipt, state: prior.receipt.disposition === 'accepted'
      ? 'already_delivered' as const : 'receipt_rejected' as const, startsWork: false as const,
      grantsExecutionAuthority: false as const });
  }
  const activation = activationFor(config, delivery, route, receivedAt);
  const receipt = await deliverControllerWorkerPacketV1(config.receiptPort, delivery, route, signal);
  const persisted = await config.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, config.integrityKey,
    delivery, receipt, receivedAt));
  if (persisted.replayed) return Object.freeze({ delivery, receipt: persisted.receipt, state: 'already_delivered' as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  if (receipt.disposition !== 'accepted') return Object.freeze({ delivery, receipt, state: 'receipt_rejected' as const,
    startsWork: false as const, grantsExecutionAuthority: false as const });
  try {
    if (signal?.aborted) unavailable();
    current(config, activation.queueId, activation.currentAdmissionDigest);
    const observed = await config.host.run(signal ?? new AbortController().signal);
    return Object.freeze({ delivery, receipt, state: 'started_observation' as const, observed,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  } catch {
    return Object.freeze({ delivery, receipt, state: 'delivery_uncertain' as const,
      startsWork: false as const, grantsExecutionAuthority: false as const });
  }
}
