import { z } from "zod";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../v1/controller-worker-delivery";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, type ClaudeRetainedPublicationBindingV1,
  type ClaudeTerminalResultPublicationV1 } from "./result-publication";
import { ClaudeCodeLocalDispatchPreparationV1, type ClaudeCodeLocalDispatchReferenceV1,
  type ClaudeCodeLocalPreparedDispatchV1 } from "./dispatch-preparation";
import { deliverClaudeCodeLocalTaskV1, type ClaudeCodeLocalDeliveryCompositionV1 } from "./local-delivery-composition";
import { publishClaudeCodeReservedSessionResultV1 } from "./local-worker-result";
import { createClaudeCodeTerminalResultStageV1 } from "./terminal-result-staging";
import { recoverClaudeCodeTerminalResultV1 } from "./terminal-result-recovery";
import { readControllerWorkerDeliveryReceiptV1 } from "../v1/controller-worker-delivery-receipt-store";

const unavailable = (): never => { throw new Error("claude_code_local_assigned_task_execution_unavailable"); };

export const CLAUDE_CODE_LOCAL_ASSIGNED_TASK_EXECUTION_V1 =
  "control-room.claude-code-local-assigned-task-execution/v1" as const;

/** The private, already-reviewed joining of the shared task reader, receipt
 * reservation and result publisher. It contains no CLI discovery, command,
 * profile, credential, workspace or scheduler. */
export type ClaudeCodeLocalAssignedTaskExecutionV1 = Readonly<{
  preparation: ClaudeCodeLocalDispatchPreparationV1;
  /** The executor supplies the final canonical reread for each queue pickup. */
  delivery: Omit<ClaudeCodeLocalDeliveryCompositionV1, "recheckBeforeAcquire">;
  results: DurableResultPublicationConfigurationV1;
  protectedStorage: ArtifactStoragePortV1 & ArtifactReadPortV1;
  /** Installation-owned synchronous authority fence, never inferred from a target. */
  assertAuthority(delivery: ControllerWorkerDeliveryV1): void;
  clock?: () => number;
}>;

export function retainClaudeCodeLocalResultBindingV1(prepared: ClaudeCodeLocalPreparedDispatchV1): ClaudeRetainedPublicationBindingV1 {
  if (!prepared || prepared.schema !== "control-room.claude-code-local-dispatch-preparation/v1") unavailable();
  const { identity, acceptanceProfileId, acceptanceProfileDigest, connectorProfileDigest } = prepared.delivery;
  if (connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 || !prepared.workflowId
    || !acceptanceProfileId || !acceptanceProfileDigest) unavailable();
  return Object.freeze({ ...identity, workflowId: prepared.workflowId, acceptanceProfileId, acceptanceProfileDigest });
}

function sameDelivery(left: ControllerWorkerDeliveryV1, right: ControllerWorkerDeliveryV1) {
  return left.deliveryDigest === right.deliveryDigest && left.identity.tenantId === right.identity.tenantId
    && left.identity.projectId === right.identity.projectId && left.identity.jobId === right.identity.jobId
    && left.identity.attemptId === right.identity.attemptId && left.identity.runId === right.identity.runId;
}

/**
 * Executes one already-queued Claude locator through existing receipt-first
 * delivery and result components. A replay only tries to recover protected
 * terminal evidence; it cannot acquire Claude again.
 */
export async function executeAssignedClaudeCodeLocalTaskV1(config: ClaudeCodeLocalAssignedTaskExecutionV1,
  referenceValue: ClaudeCodeLocalDispatchReferenceV1, signal?: AbortSignal): Promise<Readonly<{
  schema: typeof CLAUDE_CODE_LOCAL_ASSIGNED_TASK_EXECUTION_V1;
  prepared: ClaudeCodeLocalPreparedDispatchV1;
  state: "published_pending_review" | "recovered_pending_review" | "terminal_result_uncertain" | "not_started";
  publication?: ClaudeTerminalResultPublicationV1;
  startsWork: false;
  grantsExecutionAuthority: false;
}>> {
  if (!config || !(config.preparation instanceof ClaudeCodeLocalDispatchPreparationV1) || !config.delivery
    || !config.results || !config.protectedStorage || typeof config.protectedStorage.put !== "function"
    || typeof config.protectedStorage.read !== "function" || typeof config.assertAuthority !== "function" || signal?.aborted)
    unavailable();
  const clock = config.clock ?? Date.now;
  if (typeof clock !== "function") unavailable();
  let prepared = await config.preparation.prepare(referenceValue);
  await config.preparation.assertCurrent(referenceValue, prepared);
  // A new preparation has a fresh issued-at timestamp. If the exact run has a
  // durable receipt, recover that authenticated original packet before asking
  // the delivery composition to decide whether it may publish staged evidence.
  // A restart must never turn a changed timestamp into a new acquisition.
  const retainedReceipt = await config.delivery.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx,
    config.delivery.integrityKey, prepared.delivery.identity));
  if (retainedReceipt) {
    const recovered = Object.freeze({ ...prepared, delivery: retainedReceipt.delivery });
    await config.preparation.assertCurrent(referenceValue, recovered);
    prepared = recovered;
  }
  const now = new Date(clock()).toISOString();
  if (!z.string().datetime().safeParse(now).success || Date.parse(now) > Date.parse(prepared.delivery.expiresAt)) unavailable();
  const delivery = await deliverClaudeCodeLocalTaskV1({ ...config.delivery,
    recheckBeforeAcquire: async (candidate, route, recheckSignal) => {
      if (recheckSignal.aborted || !sameDelivery(candidate, prepared.delivery)
        || route.kind !== prepared.route.kind || route.workerId !== prepared.route.workerId) unavailable();
      await config.preparation.assertCurrent(referenceValue, prepared);
      if (recheckSignal.aborted) unavailable();
    } }, prepared.delivery, prepared.route, now, signal);
  const finish = (state: "published_pending_review" | "recovered_pending_review" | "terminal_result_uncertain" | "not_started",
    publication?: ClaudeTerminalResultPublicationV1) => Object.freeze({ schema: CLAUDE_CODE_LOCAL_ASSIGNED_TASK_EXECUTION_V1,
      prepared, state, ...(publication ? { publication } : {}), startsWork: false as const, grantsExecutionAuthority: false as const });
  if (delivery.state === "delivery_uncertain" || delivery.state === "receipt_rejected") return finish("not_started");
  const reservation = delivery.reservation;
  if (!reservation || !sameDelivery(reservation.delivery, prepared.delivery)) unavailable();
  const retainedBinding = retainClaudeCodeLocalResultBindingV1(prepared);
  const stage = createClaudeCodeTerminalResultStageV1({ storage: config.protectedStorage, retainedBinding,
    processBinding: reservation.processBinding, receivedAt: reservation.receipt.receivedAt });
  const assertAuthority = () => config.assertAuthority(reservation.delivery);
  if (delivery.state === "reserved_session_open") {
    const result = await publishClaudeCodeReservedSessionResultV1({ publication: config.results,
      reservedSession: { reservation, session: delivery.session }, retainedBinding,
      acceptedConnectorProfileDigest: reservation.delivery.connectorProfileDigest,
      signal: signal ?? new AbortController().signal, receivedAt: reservation.receipt.receivedAt,
      assertAuthority, terminalStage: stage });
    return finish("published_pending_review", result.publication);
  }
  if (delivery.state !== "already_reserved") unavailable();
  const recovered = await recoverClaudeCodeTerminalResultV1({ publication: config.results, stage, assertAuthority, signal });
  return recovered.state === "recovered_pending_review"
    ? finish("recovered_pending_review", recovered.publication) : finish("terminal_result_uncertain");
}
