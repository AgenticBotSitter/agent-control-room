import { sha256Digest } from "../security";
import type { JobEventBody } from "../node-protocol/v1";
import {
  observeExecutionDeadline,
  type ExecutionAuthorityEventV1,
  type ExecutionAuthoritySnapshotV1,
} from "../node-policy/v1";
import {
  buildTextArtifactBundle,
  buildArtifactLineageRecord,
  type ArtifactLineageRecordV1,
  type TextArtifactBundleInputV1,
  type TextArtifactBundleV1,
} from "./artifact-evidence";
import {
  ArtifactStorageError,
  type ArtifactStoragePortV1,
} from "./artifact-storage";
import {
  runSyntheticExecution,
  SyntheticExecutorCrash,
  type SyntheticExecutionEventV1,
  type SyntheticExecutionSpecV1,
} from "./synthetic-executor";

export interface ExecutionAuthorityStorePortV1 {
  load(executionId: string): ExecutionAuthoritySnapshotV1 | undefined;
  apply(executionId: string, event: ExecutionAuthorityEventV1): {
    snapshot: ExecutionAuthoritySnapshotV1;
    requestCancellation: boolean;
  };
}

export interface JobEventRecorderPortV1 {
  append(event: JobEventBody, artifactLineage?: ArtifactLineageRecordV1): void | Promise<void>;
}

export interface SyntheticCoordinatorInputV1 {
  executionId: string;
  leaseId: string;
  leaseEpoch: number;
  spec: SyntheticExecutionSpecV1;
  artifact: Omit<TextArtifactBundleInputV1, "text" | "opaqueLocator" | "createdAt">;
}

export interface SyntheticCoordinatorPortsV1 {
  authority: ExecutionAuthorityStorePortV1;
  artifacts: ArtifactStoragePortV1;
  events: JobEventRecorderPortV1;
  now(): string;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  cancellationReason?(): "operator" | "server" | "restart" | undefined;
}

export type SyntheticCoordinatorResultV1 =
  | { state: "completed"; executionId: string; bundle: TextArtifactBundleV1 }
  | { state: "cancelled"; executionId: string; safeReasonCode: "cancelled" }
  | { state: "failed"; executionId: string; safeFailureCode: string };

export class SyntheticCoordinatorError extends Error {
  readonly safeFailureCode: "admission_mismatch" | "event_recording_failed";

  constructor(safeFailureCode: SyntheticCoordinatorError["safeFailureCode"]) {
    super(safeFailureCode);
    this.name = "SyntheticCoordinatorError";
    this.safeFailureCode = safeFailureCode;
  }
}

function eventId(executionId: string, kind: string, sequence: number): string {
  return `execution:${executionId}:${kind}:${sequence}`;
}

function assertAdmission(input: SyntheticCoordinatorInputV1, snapshot: ExecutionAuthoritySnapshotV1): void {
  const matches = snapshot.state === "admitted"
    && snapshot.executionId === input.executionId
    && snapshot.identity.jobId === input.spec.jobId
    && snapshot.identity.attemptId === input.spec.attemptId
    && snapshot.identity.operationDigest === sha256Digest(input.spec)
    && snapshot.leaseEpoch === input.leaseEpoch
    && input.artifact.tenantId === snapshot.identity.tenantId
    && input.artifact.projectId === snapshot.identity.projectId
    && input.artifact.jobId === snapshot.identity.jobId
    && input.artifact.attemptId === snapshot.identity.attemptId;
  if (!matches || !input.leaseId) throw new SyntheticCoordinatorError("admission_mismatch");
}

function mapEvent(input: SyntheticCoordinatorInputV1, event: SyntheticExecutionEventV1): JobEventBody {
  return {
    jobId: input.spec.jobId,
    attemptId: input.spec.attemptId,
    leaseId: input.leaseId,
    leaseEpoch: input.leaseEpoch,
    event: event.event,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    ...(event.event === "progress" ? { progressPercent: event.progressPercent } : {}),
    ...(event.event === "checkpointed" ? { checkpointId: event.checkpointId } : {}),
    artifactManifestIds: [],
    ...(event.event === "cancelled" ? { safeReasonCode: event.safeReasonCode } : {}),
  };
}

export async function runAdmittedSyntheticExecution(
  submitted: SyntheticCoordinatorInputV1,
  ports: SyntheticCoordinatorPortsV1,
): Promise<SyntheticCoordinatorResultV1> {
  // These records contain primitive fields. Own them before invoking any port so
  // callers cannot change the admitted operation or its result attribution.
  const input: SyntheticCoordinatorInputV1 = {
    ...submitted,
    spec: { ...submitted.spec },
    artifact: { ...submitted.artifact },
  };
  const admitted = ports.authority.load(input.executionId);
  if (!admitted) throw new SyntheticCoordinatorError("admission_mismatch");
  assertAdmission(input, admitted);

  const controller = new AbortController();
  let lastSequence = 0;
  let reservedTerminalSequence: number | undefined;

  const append = async (event: JobEventBody, artifactLineage?: ArtifactLineageRecordV1): Promise<void> => {
    try {
      await ports.events.append(event, artifactLineage);
    } catch {
      throw new SyntheticCoordinatorError("event_recording_failed");
    }
  };

  const applyCancellation = (reason: "operator" | "server" | "restart", occurredAt: string): void => {
    const snapshot = ports.authority.load(input.executionId);
    if (!snapshot || ["cancelled", "completed", "failed", "expired", "cancellation_requested"].includes(snapshot.state)) {
      if (snapshot?.state === "expired" || snapshot?.state === "cancellation_requested") controller.abort();
      return;
    }
    ports.authority.apply(input.executionId, {
      eventId: eventId(input.executionId, "cancellation_requested", lastSequence + 1),
      kind: "cancellation_requested",
      occurredAt,
      reason,
    });
    controller.abort();
  };

  const refreshAuthority = (observedAt = ports.now()): void => {
    const snapshot = ports.authority.load(input.executionId);
    if (!snapshot) throw new SyntheticCoordinatorError("admission_mismatch");
    if (snapshot.state === "cancellation_requested" || snapshot.state === "expired") {
      controller.abort();
      return;
    }
    const observation = observeExecutionDeadline(snapshot, observedAt);
    if (observation.kind === "deadline_crossed") {
      ports.authority.apply(input.executionId, {
        eventId: eventId(input.executionId, "deadline_crossed", lastSequence + 1),
        kind: "deadline_crossed",
        occurredAt: observation.observedAt,
        latenessMilliseconds: observation.latenessMilliseconds,
      });
      controller.abort();
      return;
    }
    const reason = ports.cancellationReason?.();
    if (reason) applyCancellation(reason, observedAt);
  };

  const startedAt = ports.now();
  ports.authority.apply(input.executionId, {
    eventId: eventId(input.executionId, "start", 0),
    kind: "start",
    occurredAt: startedAt,
  });
  refreshAuthority();

  const recordSyntheticEvent = async (event: SyntheticExecutionEventV1): Promise<void> => {
    lastSequence = event.sequence;
    if (event.event === "completed") {
      reservedTerminalSequence = event.sequence;
      return;
    }
    if (event.event === "cancelled") {
      ports.authority.apply(input.executionId, {
        eventId: eventId(input.executionId, "cancelled", event.sequence),
        kind: "cancelled",
        occurredAt: event.occurredAt,
      });
    }
    await append(mapEvent(input, event));
  };

  const fail = async (safeFailureCode: string): Promise<SyntheticCoordinatorResultV1> => {
    const occurredAt = ports.now();
    const sequence = reservedTerminalSequence ?? lastSequence + 1;
    const snapshot = ports.authority.load(input.executionId);
    if (snapshot && !["failed", "completed", "cancelled"].includes(snapshot.state)) {
      ports.authority.apply(input.executionId, {
        eventId: eventId(input.executionId, "failed", sequence),
        kind: "failed",
        occurredAt,
        safeFailureCode,
      });
    }
    await append({
      jobId: input.spec.jobId,
      attemptId: input.spec.attemptId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      event: "failed",
      sequence,
      occurredAt,
      artifactManifestIds: [],
      safeReasonCode: safeFailureCode,
    });
    return { state: "failed", executionId: input.executionId, safeFailureCode };
  };

  let executionResult;
  try {
    executionResult = await runSyntheticExecution(input.spec, {
      signal: controller.signal,
      now: ports.now,
      sleep: async (milliseconds, signal) => {
        refreshAuthority();
        if (signal.aborted) return;
        await ports.sleep(milliseconds, signal);
        refreshAuthority();
      },
      emit: recordSyntheticEvent,
    });
  } catch (error) {
    if (error instanceof SyntheticCoordinatorError) throw error;
    return fail(error instanceof SyntheticExecutorCrash ? error.safeFailureCode : "synthetic_execution_failed");
  }

  if (executionResult.state === "cancelled") {
    return { state: "cancelled", executionId: input.executionId, safeReasonCode: "cancelled" };
  }

  refreshAuthority();
  if (controller.signal.aborted) {
    const occurredAt = ports.now();
    const sequence = reservedTerminalSequence ?? lastSequence + 1;
    ports.authority.apply(input.executionId, {
      eventId: eventId(input.executionId, "cancelled", sequence),
      kind: "cancelled",
      occurredAt,
    });
    await append({
      jobId: input.spec.jobId,
      attemptId: input.spec.attemptId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      event: "cancelled",
      sequence,
      occurredAt,
      artifactManifestIds: [],
      safeReasonCode: "cancelled",
    });
    return { state: "cancelled", executionId: input.executionId, safeReasonCode: "cancelled" };
  }

  try {
    const stored = await ports.artifacts.put({ artifactId: input.artifact.artifactId, bytes: executionResult.artifactBytes });
    const occurredAt = ports.now();
    refreshAuthority(occurredAt);
    if (controller.signal.aborted) {
      const sequence = reservedTerminalSequence ?? lastSequence + 1;
      ports.authority.apply(input.executionId, {
        eventId: eventId(input.executionId, "cancelled", sequence),
        kind: "cancelled",
        occurredAt,
      });
      await append({
        jobId: input.spec.jobId,
        attemptId: input.spec.attemptId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
        event: "cancelled",
        sequence,
        occurredAt,
        artifactManifestIds: [],
        safeReasonCode: "cancelled",
      });
      return { state: "cancelled", executionId: input.executionId, safeReasonCode: "cancelled" };
    }
    const bundle = buildTextArtifactBundle({
      ...input.artifact,
      opaqueLocator: stored.opaqueLocator,
      text: input.spec.artifactText,
      createdAt: occurredAt,
    });
    if (
      bundle.manifest.contentHash !== stored.contentHash ||
      bundle.manifest.sizeBytes !== stored.sizeBytes ||
      Buffer.compare(Buffer.from(bundle.bytes), Buffer.from(executionResult.artifactBytes)) !== 0
    ) {
      return fail("storage_verification_failed");
    }
    const sequence = reservedTerminalSequence ?? lastSequence + 1;
    ports.authority.apply(input.executionId, {
      eventId: eventId(input.executionId, "completed", sequence),
      kind: "completed",
      occurredAt,
    });
    const completedEvent: JobEventBody = {
      jobId: input.spec.jobId,
      attemptId: input.spec.attemptId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      event: "completed",
      sequence,
      occurredAt,
      artifactManifestIds: [bundle.manifest.id],
    };
    await append(completedEvent, buildArtifactLineageRecord(bundle));
    return { state: "completed", executionId: input.executionId, bundle };
  } catch (error) {
    if (error instanceof SyntheticCoordinatorError) throw error;
    const safeFailureCode = error instanceof ArtifactStorageError ? error.safeFailureCode : "storage_unavailable";
    return fail(safeFailureCode);
  }
}
