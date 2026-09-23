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
import { HarnessRunStoreV1 } from "../v1/store";
import type { HarnessEventPayloadV1, HarnessRunEventV1, HarnessRunV1 } from "../v1/types";
import { ClaudeCodeLocalRunRegistrationV1 } from "./local-run-registration";
import { sha256Digest } from "../../security/canonical-digest";
import { isTerminalHarnessRunState } from "../v1/lifecycle";

const unavailable = (): never => { throw new Error("claude_code_local_assigned_task_execution_unavailable"); };

export const CLAUDE_CODE_LOCAL_ASSIGNED_TASK_EXECUTION_V1 =
  "control-room.claude-code-local-assigned-task-execution/v1" as const;

/** The private, already-reviewed joining of the shared task reader, receipt
 * reservation and result publisher. It contains no CLI discovery, command,
 * profile, credential, workspace or scheduler. */
export type ClaudeCodeLocalAssignedTaskExecutionV1 = Readonly<{
  preparation: ClaudeCodeLocalDispatchPreparationV1;
  /** Existing canonical run history; this is not a Claude-specific store. */
  runs: HarnessRunStoreV1;
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
  registered: Readonly<{ run: HarnessRunV1; replayed: boolean }>;
  state: "published_pending_review" | "recovered_pending_review" | "terminal_result_uncertain" | "not_started";
  publication?: ClaudeTerminalResultPublicationV1;
  startsWork: false;
  grantsExecutionAuthority: false;
}>> {
  if (!config || !(config.preparation instanceof ClaudeCodeLocalDispatchPreparationV1) || !(config.runs instanceof HarnessRunStoreV1) || !config.delivery
    || !config.results || !config.protectedStorage || typeof config.protectedStorage.put !== "function"
    || typeof config.protectedStorage.read !== "function" || typeof config.assertAuthority !== "function" || signal?.aborted)
    unavailable();
  const clock = config.clock ?? Date.now;
  if (typeof clock !== "function") unavailable();
  let prepared = await config.preparation.prepare(referenceValue);
  await config.preparation.assertCurrent(referenceValue, prepared);
  config.assertAuthority(prepared.delivery);
  // A new preparation has a fresh issued-at timestamp. If the exact run has a
  // durable receipt, recover that authenticated original packet before asking
  // the delivery composition to decide whether it may publish staged evidence.
  // A restart must never turn a changed timestamp into a new acquisition.
  const retainedReceipt = await config.delivery.db.transaction(tx => readControllerWorkerDeliveryReceiptV1(tx,
    config.delivery.integrityKey, prepared.delivery.identity));
  if (retainedReceipt) {
    const recovered = Object.freeze({ ...prepared, delivery: retainedReceipt.delivery });
    await config.preparation.assertCurrent(referenceValue, recovered);
    config.assertAuthority(recovered.delivery);
    prepared = recovered;
  }
  const now = new Date(clock()).toISOString();
  if (!z.string().datetime().safeParse(now).success || Date.parse(now) > Date.parse(prepared.delivery.expiresAt)) unavailable();
  // The shared durable publisher verifies its result against this ordinary run
  // history. Creating it here mirrors the local Hermes path and prevents a
  // source-only Claude delivery from looking executable while being unable to
  // retain any result. An exact replay returns the same record.
  const candidate = ClaudeCodeLocalRunRegistrationV1(prepared.delivery, retainedReceipt?.receipt.receivedAt ?? now);
  const existing = await config.runs.get(candidate.tenantId, candidate.id);
  // A published run naturally has newer lifecycle state than its initial
  // registration. Compare the immutable controller binding rather than trying
  // to recreate a "discovered" row during recovery.
  if (existing && (existing.projectId !== candidate.projectId || existing.jobId !== candidate.jobId
    || existing.attemptId !== candidate.attemptId || existing.nodeId !== candidate.nodeId
    || existing.adapterId !== candidate.adapterId || existing.harness !== candidate.harness
    || existing.nativeSessionKeyDigest !== candidate.nativeSessionKeyDigest
    || existing.connectorProfileDigest !== candidate.connectorProfileDigest
    || existing.authorityDigest !== candidate.authorityDigest)) unavailable();
  const registered = existing ? { run: existing, replayed: true } : await config.runs.create(candidate);
  // An earlier pickup that could not establish any durable receipt is an
  // unresolved delivery, not permission for a restart to send the packet
  // again.  If a receipt exists, the ordinary recovery path below may inspect
  // its protected terminal evidence; without one, only owner recovery can
  // decide what happened.
  if (registered.run.state === "disconnected" && !retainedReceipt) return Object.freeze({
    schema: CLAUDE_CODE_LOCAL_ASSIGNED_TASK_EXECUTION_V1, prepared, registered,
    state: "terminal_result_uncertain" as const, startsWork: false as const, grantsExecutionAuthority: false as const,
  });
  let sequence = (await config.runs.inspect(prepared.delivery.identity.tenantId, registered.run.id))?.events.length ?? 0;
  let observedState = registered.run.state;
  // A terminal failure/cancellation consumes this exact run. Do this before a
  // delivery receipt or process session is considered, so old terminal bytes
  // cannot make a failed run look successful or cause a second Claude start.
  if (isTerminalHarnessRunState(observedState) && observedState !== "succeeded") unavailable();
  const append = async (payload: HarnessEventPayloadV1, occurredAt: string) => {
    const event: HarnessRunEventV1 = { schemaVersion: "control-room-harness-event/v1",
      tenantId: prepared.delivery.identity.tenantId, runId: registered.run.id, sequence: ++sequence, occurredAt,
      source: "control_room", sourceEventKeyDigest: sha256Digest({ purpose: "claude-code-local-lifecycle/v1",
        deliveryDigest: prepared.delivery.deliveryDigest, sequence, payload }), payload };
    const appended = await config.runs.append(event);
    observedState = appended.run.state;
  };
  const delivery = await deliverClaudeCodeLocalTaskV1({ ...config.delivery,
    recheckBeforeAcquire: async (candidate, route, recheckSignal) => {
      if (recheckSignal.aborted || !sameDelivery(candidate, prepared.delivery)
        || route.kind !== prepared.route.kind || route.workerId !== prepared.route.workerId) unavailable();
      await config.preparation.assertCurrent(referenceValue, prepared);
      config.assertAuthority(prepared.delivery);
      if (recheckSignal.aborted) unavailable();
    } }, prepared.delivery, prepared.route, now, signal);
  const finish = (state: "published_pending_review" | "recovered_pending_review" | "terminal_result_uncertain" | "not_started",
    publication?: ClaudeTerminalResultPublicationV1) => Object.freeze({ schema: CLAUDE_CODE_LOCAL_ASSIGNED_TASK_EXECUTION_V1,
      prepared, registered, state, ...(publication ? { publication } : {}), startsWork: false as const, grantsExecutionAuthority: false as const });
  if (delivery.state === "receipt_rejected") return finish("not_started");
  if (delivery.state === "delivery_cancelled") {
    // The receipt boundary was crossed but the owner/controller cancelled
    // before acquisition.  Record that exact observed outcome in the shared
    // run history; it is terminal and therefore cannot be reopened on restart.
    if (observedState === "discovered") await append({ category: "lifecycle", state: "starting" }, now);
    if (!isTerminalHarnessRunState(observedState)) await append({ category: "lifecycle", state: "cancelled",
      reasonCode: "claude_local_delivery_cancelled" }, now);
    return finish("not_started");
  }
  if (delivery.state === "delivery_uncertain") {
    // A receipt or final pre-acquisition fence became uncertain.  This is not
    // a start, a completion, or permission to resend.  The ordinary run
    // history keeps it visible as disconnected for owner recovery.
    if (observedState === "discovered") await append({ category: "lifecycle", state: "starting" }, now);
    if (!isTerminalHarnessRunState(observedState)) await append({ category: "transport", state: "disconnected",
      reasonCode: "claude_local_delivery_uncertain" }, now);
    return finish("terminal_result_uncertain");
  }
  const reservation = delivery.reservation;
  if (!reservation || !sameDelivery(reservation.delivery, prepared.delivery)) unavailable();
  const retainedBinding = retainClaudeCodeLocalResultBindingV1(prepared);
  const stage = createClaudeCodeTerminalResultStageV1({ storage: config.protectedStorage, retainedBinding,
    processBinding: reservation.processBinding, receivedAt: reservation.receipt.receivedAt });
  const assertAuthority = () => config.assertAuthority(reservation.delivery);
  const recordPublished = async () => {
    // Completed protected evidence may be recovered only into the same
    // completed history. A failed or cancelled run must never be relabelled as
    // a successful result merely because stale staged output also exists.
    if (isTerminalHarnessRunState(observedState)) {
      if (observedState !== "succeeded") unavailable();
      return;
    }
    // A controller receipt is deliberately not a start record: it may be
    // rejected or become uncertain before a process session exists. Record
    // starting only after the publisher has a reserved session, or after
    // verified protected terminal evidence is being recovered.
    if (observedState === "discovered") await append({ category: "lifecycle", state: "starting" }, reservation.receipt.receivedAt);
    if (observedState === "starting") await append({ category: "lifecycle", state: "running" }, reservation.receipt.receivedAt);
    if (observedState === "running") await append({ category: "lifecycle", state: "succeeded" }, reservation.receipt.receivedAt);
    if (observedState !== "succeeded") unavailable();
  };
  if (delivery.state === "reserved_session_open") {
    const result = await publishClaudeCodeReservedSessionResultV1({ publication: config.results,
      reservedSession: { reservation, session: delivery.session }, retainedBinding,
      acceptedConnectorProfileDigest: reservation.delivery.connectorProfileDigest,
      signal: signal ?? new AbortController().signal, receivedAt: reservation.receipt.receivedAt,
      assertAuthority, terminalStage: stage });
    await recordPublished();
    return finish("published_pending_review", result.publication);
  }
  if (delivery.state !== "already_reserved") unavailable();
  const recovered = await recoverClaudeCodeTerminalResultV1({ publication: config.results, stage, assertAuthority, signal });
  if (recovered.state !== "recovered_pending_review") return finish("terminal_result_uncertain");
  await recordPublished();
  return finish("recovered_pending_review", recovered.publication);
}
