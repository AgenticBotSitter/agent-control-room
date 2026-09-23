import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import { z } from "zod";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import {
  createClaudeCodeOwnedProcessSessionV1,
  type AcquireClaudeCodeProcessV1,
  type ClaudeCodeProcessBindingV1,
  type ClaudeCodeSessionDispositionV1,
  type OwnedClaudeCodeProcessSessionV1,
} from "./owned-process-session";
import type { ClaudeCodeReservedSessionV1 } from "./local-delivery-composition";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "./task-planning-contract";
import { controllerWorkerDeliveryReceiptSchemaV1, controllerWorkerDeliverySchemaV1 } from "../v1/controller-worker-delivery";
import { sha256Digest } from "../../security/canonical-digest";
import {
  CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
  publishClaudeTerminalResultV1,
  type ClaudeRetainedPublicationBindingV1,
  type ClaudeTerminalResultPublicationV1,
} from "./result-publication";
import {
  createClaudeCodeStreamDecoderV1,
  type ClaudeCodeResultFrameV1,
  type ClaudeCodeStreamDecoderStateV1,
} from "./stream-json-decode";
import { stageClaudeCodeTerminalResultInputV1, type ClaudeCodeTerminalResultStagePortV1 } from "./terminal-result-staging";

export interface ClaudeCodeLocalWorkerResultInputV1 {
  /** The shared publisher configuration already owned by Control Room. */
  publication: DurableResultPublicationConfigurationV1;
  /** Canonical task/run identity retained before process output is observed. */
  retainedBinding: ClaudeRetainedPublicationBindingV1;
  /** One fresh, already-admitted process attempt for this run. */
  processBinding: ClaudeCodeProcessBindingV1;
  /** Digest recorded by admission; it must equal the accepted Claude profile. */
  acceptedConnectorProfileDigest: string;
  /** Injected owner for an already-selected process acquisition policy. */
  acquire: AcquireClaudeCodeProcessV1;
  signal: AbortSignal;
  cleanupMs: number;
  receivedAt: string;
  /** Synchronous retained-authority fence, checked before acquisition and publication. */
  assertAuthority: () => void;
  /** Optional protected custody for restart-safe replay of this exact terminal record. */
  terminalStage?: ClaudeCodeTerminalResultStagePortV1;
}

export interface ClaudeCodeLocalWorkerResultV1 {
  readonly publication: ClaudeTerminalResultPublicationV1;
  readonly disposition: ClaudeCodeSessionDispositionV1;
  readonly decoderState: ClaudeCodeStreamDecoderStateV1;
  readonly processAttemptId: string;
  readonly sessionId: string;
  /** This coordinator never approves, completes, retries, resumes or releases capacity. */
  readonly qualityAccepted: false;
  readonly completionRecorded: false;
  readonly releasesCapacity: false;
  readonly permitsRetry: false;
  readonly permitsResume: false;
}

/**
 * Consumes the session that the local delivery bridge already reserved.  This
 * input deliberately has no acquisition seam: the only process it can touch
 * is the one session supplied by that bridge.
 */
export interface ClaudeCodeReservedSessionResultInputV1 {
  publication: DurableResultPublicationConfigurationV1;
  reservedSession: ClaudeCodeReservedSessionV1;
  retainedBinding: ClaudeRetainedPublicationBindingV1;
  acceptedConnectorProfileDigest: string;
  signal: AbortSignal;
  receivedAt: string;
  assertAuthority: () => void;
  terminalStage?: ClaudeCodeTerminalResultStagePortV1;
}

function unavailable(): never {
  throw new Error("claude_code_local_worker_result_unavailable");
}

function cleanupUncertain(): never {
  throw new Error("claude_code_local_worker_result_cleanup_uncertain");
}

const retainedBindingSchema = z.object({
  tenantId: localId,
  projectId: localId,
  jobId: localId,
  attemptId: localId,
  runId: localId,
  nodeId: localId,
  workflowId: localId,
  acceptanceProfileId: localId,
  acceptanceProfileDigest: digestSchema,
}).strict();

const processBindingSchema = z.object({
  processAttemptId: localId,
  runId: localId,
  attemptId: localId,
  invocationDigest: digestSchema,
}).strict();

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

function reservedSessionBinding(input: ClaudeCodeReservedSessionResultInputV1,
  retainedBinding: ClaudeRetainedPublicationBindingV1): ClaudeCodeProcessBindingV1 {
  const reserved = input.reservedSession;
  if (!reserved || typeof reserved !== "object" || !reserved.reservation || !reserved.session
    || typeof reserved.session.close !== "function" || !reserved.session.ready
    || typeof (reserved.session.ready as Promise<unknown>).then !== "function") unavailable();
  const reservation = reserved.reservation;
  const delivery = controllerWorkerDeliverySchemaV1.parse(reservation.delivery);
  const receipt = controllerWorkerDeliveryReceiptSchemaV1.parse(reservation.receipt);
  const processBinding = Object.freeze(processBindingSchema.parse(reservation.processBinding));
  const reservationDigest = digestSchema.parse(reservation.reservationDigest);
  if (reservationDigest !== sha256Digest({ delivery, receipt })
    || reservation.startsWork !== false || reservation.grantsExecutionAuthority !== false
    || reservation.permitsRetry !== false || reservation.permitsResume !== false
    || receipt.disposition !== "accepted" || receipt.route.kind !== "local"
    || receipt.workerId !== delivery.worker.workerId || receipt.route.workerId !== delivery.worker.workerId
    || receipt.deliveryId !== delivery.deliveryId || receipt.deliveryDigest !== delivery.deliveryDigest
    || processBinding.processAttemptId !== `claude-process:${reservationDigest.slice(7)}`
    || processBinding.runId !== delivery.identity.runId || processBinding.attemptId !== delivery.identity.attemptId
    || processBinding.invocationDigest !== reservationDigest
    || delivery.identity.tenantId !== retainedBinding.tenantId || delivery.identity.projectId !== retainedBinding.projectId
    || delivery.identity.jobId !== retainedBinding.jobId || delivery.identity.attemptId !== retainedBinding.attemptId
    || delivery.identity.runId !== retainedBinding.runId || delivery.identity.nodeId !== retainedBinding.nodeId
    || delivery.acceptanceProfileId !== retainedBinding.acceptanceProfileId
    || delivery.acceptanceProfileDigest !== retainedBinding.acceptanceProfileDigest
    || delivery.connectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1
    || delivery.worker.adapterId !== CLAUDE_CODE_LOCAL_ADAPTER_V1) unavailable();
  return processBinding;
}

async function consumeClaudeCodeSessionResultV1(input: {
  publication: DurableResultPublicationConfigurationV1;
  retainedBinding: ClaudeRetainedPublicationBindingV1;
  processBinding: ClaudeCodeProcessBindingV1;
  session: OwnedClaudeCodeProcessSessionV1;
  acceptedConnectorProfileDigest: string;
  signal: AbortSignal;
  receivedAt: string;
  assertAuthority: () => void;
  terminalStage?: ClaudeCodeTerminalResultStagePortV1;
}): Promise<ClaudeCodeLocalWorkerResultV1> {
  const decoder = createClaudeCodeStreamDecoderV1();
  let retainedSessionId: string | undefined;
  let terminalFrame: ClaudeCodeResultFrameV1 | undefined;
  let terminalFrameRawLine: string | undefined;
  let cleanupCertain = false;

  try {
    const wire = await input.session.ready;
    for (;;) {
      const line = await wire.readLine(input.signal);
      if (line === undefined) break;
      const frame = decoder.accept(line);
      if (frame.kind === "decode_error") unavailable();
      if (frame.kind === "init") retainedSessionId = frame.sessionId;
      if (frame.kind === "result") { terminalFrame = frame; terminalFrameRawLine = line; }
    }

    const decoderState = decoder.state();
    if (!retainedSessionId || !terminalFrame || !terminalFrameRawLine
      || decoderState.failed || !decoderState.initObserved || !decoderState.terminalObserved
      || decoderState.sessionId !== retainedSessionId) unavailable();
    input.session.recordTerminalResultObserved();
    try { await input.session.close(); cleanupCertain = true; } catch { cleanupUncertain(); }

    const disposition = input.session.disposition();
    const publicationInput = {
      retainedBinding: input.retainedBinding, processBinding: input.processBinding,
      retainedSession: { processAttemptId: input.processBinding.processAttemptId, sessionId: retainedSessionId,
        terminalFrameDigest: terminalFrame.frameDigest },
      disposition, terminalFrameRawLine, terminalFrame, decoderState,
      acceptedConnectorProfileDigest: input.acceptedConnectorProfileDigest,
      receivedAt: input.receivedAt, assertAuthority: input.assertAuthority,
    };
    if (input.terminalStage) await input.terminalStage.capture(stageClaudeCodeTerminalResultInputV1(publicationInput), input.signal);
    const publication = await publishClaudeTerminalResultV1(input.publication, publicationInput);
    return Object.freeze({ publication, disposition, decoderState, processAttemptId: input.processBinding.processAttemptId,
      sessionId: retainedSessionId, qualityAccepted: false, completionRecorded: false, releasesCapacity: false,
      permitsRetry: false, permitsResume: false });
  } finally {
    if (!cleanupCertain) {
      try { await input.session.close(); } catch { cleanupUncertain(); }
    }
  }
}

/** Consumes, decodes, stages and publishes one already-reserved local session. */
export async function publishClaudeCodeReservedSessionResultV1(
  input: ClaudeCodeReservedSessionResultInputV1,
): Promise<ClaudeCodeLocalWorkerResultV1> {
  if (!input || typeof input !== "object" || typeof input.assertAuthority !== "function") unavailable();
  const retainedBinding = Object.freeze(retainedBindingSchema.parse(input.retainedBinding));
  const acceptedConnectorProfileDigest = digestSchema.parse(input.acceptedConnectorProfileDigest);
  const receivedAt = instant.parse(input.receivedAt);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) unavailable();
  input.assertAuthority();
  if (acceptedConnectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1) unavailable();
  const processBinding = reservedSessionBinding(input, retainedBinding);
  input.assertAuthority();
  return consumeClaudeCodeSessionResultV1({ publication: input.publication, retainedBinding, processBinding,
    session: input.reservedSession.session, acceptedConnectorProfileDigest, signal: input.signal, receivedAt,
    assertAuthority: input.assertAuthority, terminalStage: input.terminalStage });
}

/**
 * Composes the existing Claude owned-session, bounded decoder and shared durable
 * result publisher for one already-admitted process attempt.
 *
 * This is deliberately not a launcher or scheduler. It does not discover an
 * executable, build arguments, read environment or credentials, choose a
 * workspace, retry, resume or create authority. The caller injects the narrow
 * process acquisition selected by a separately reviewed host binding. This
 * coordinator only consumes that owned stream, retains the init observation,
 * requires a clean terminal decode and certain cleanup, and then publishes the
 * exact terminal bytes through Control Room's existing result/review lifecycle.
 */
export async function publishClaudeCodeOwnedAttemptResultV1(
  input: ClaudeCodeLocalWorkerResultInputV1,
): Promise<ClaudeCodeLocalWorkerResultV1> {
  if (!input || typeof input !== "object" || typeof input.assertAuthority !== "function") unavailable();

  // Capture every retained scalar before the first await. Caller mutation may
  // not change the lineage or evidence identity of an in-flight attempt.
  const retainedBinding = Object.freeze(retainedBindingSchema.parse(input.retainedBinding));
  const processBinding = Object.freeze(processBindingSchema.parse(input.processBinding));
  const acceptedConnectorProfileDigest = digestSchema.parse(input.acceptedConnectorProfileDigest);
  const receivedAt = instant.parse(input.receivedAt);
  const assertAuthority = input.assertAuthority;
  const publicationConfiguration = input.publication;
  const signal = input.signal;
  const acquire = input.acquire;
  const cleanupMs = input.cleanupMs;

  // Refuse stale admission before the injected acquisition can be reached.
  assertAuthority();
  if (acceptedConnectorProfileDigest !== CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1) unavailable();
  if (processBinding.runId !== retainedBinding.runId
    || processBinding.attemptId !== retainedBinding.attemptId) unavailable();

  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: processBinding,
    signal,
    acquire,
    cleanupMs,
  });

  const decoder = createClaudeCodeStreamDecoderV1();
  let retainedSessionId: string | undefined;
  let terminalFrame: ClaudeCodeResultFrameV1 | undefined;
  let terminalFrameRawLine: string | undefined;
  let cleanupCertain = false;

  try {
    const wire = await session.ready;
    for (;;) {
      const line = await wire.readLine(signal);
      if (line === undefined) break;
      const frame = decoder.accept(line);
      if (frame.kind === "decode_error") unavailable();
      if (frame.kind === "init") retainedSessionId = frame.sessionId;
      if (frame.kind === "result") {
        terminalFrame = frame;
        terminalFrameRawLine = line;
      }
    }

    const decoderState = decoder.state();
    if (!retainedSessionId || !terminalFrame || !terminalFrameRawLine
      || decoderState.failed || !decoderState.initObserved || !decoderState.terminalObserved
      || decoderState.sessionId !== retainedSessionId) unavailable();

    // Only a clean, complete stream earns the owned session's terminal marker.
    session.recordTerminalResultObserved();
    try {
      await session.close();
      cleanupCertain = true;
    } catch {
      cleanupUncertain();
    }

    const disposition = session.disposition();
    const publicationInput = {
      retainedBinding,
      processBinding,
      retainedSession: {
        processAttemptId: processBinding.processAttemptId,
        sessionId: retainedSessionId,
        terminalFrameDigest: terminalFrame.frameDigest,
      },
      disposition,
      terminalFrameRawLine,
      terminalFrame,
      decoderState,
      acceptedConnectorProfileDigest,
      receivedAt,
      assertAuthority,
    };
    // Stage only fully decoded evidence after cleanup is certain, before the
    // shared publisher. A crash in this gap can recover this exact record only.
    if (input.terminalStage) await input.terminalStage.capture(stageClaudeCodeTerminalResultInputV1(publicationInput), signal);
    const publication = await publishClaudeTerminalResultV1(publicationConfiguration, publicationInput);

    return Object.freeze({
      publication,
      disposition,
      decoderState,
      processAttemptId: processBinding.processAttemptId,
      sessionId: retainedSessionId,
      qualityAccepted: false,
      completionRecorded: false,
      releasesCapacity: false,
      permitsRetry: false,
      permitsResume: false,
    });
  } finally {
    if (!cleanupCertain) {
      try {
        await session.close();
      } catch {
        // Cleanup uncertainty takes precedence over a decode/publication error:
        // callers must not infer that another attempt is safe.
        cleanupUncertain();
      }
    }
  }
}
