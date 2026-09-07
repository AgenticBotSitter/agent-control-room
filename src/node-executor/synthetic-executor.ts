import { assertNoSecretMaterial } from "../security/redaction";

export interface SyntheticExecutionSpecV1 {
  schema: "control-room.synthetic-execution/v1";
  jobId: string;
  attemptId: string;
  steps: number;
  checkpointEverySteps: number;
  stepDelayMilliseconds: number;
  artifactText: string;
  crashAfterStep?: number;
}

export interface SyntheticExecutionPortsV1 {
  signal: AbortSignal;
  now(): string;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  emit(event: SyntheticExecutionEventV1): void | Promise<void>;
}

export type SyntheticExecutionEventV1 = {
  schema: "control-room.synthetic-execution-event/v1";
  jobId: string;
  attemptId: string;
  sequence: number;
  occurredAt: string;
} & (
  | { event: "started" }
  | { event: "progress"; completedSteps: number; totalSteps: number; progressPercent: number }
  | { event: "checkpointed"; completedSteps: number; checkpointId: string }
  | { event: "completed"; completedSteps: number }
  | { event: "cancelled"; completedSteps: number; safeReasonCode: "cancelled" }
);

export type SyntheticExecutionResultV1 =
  | { state: "succeeded"; completedSteps: number; artifactBytes: Uint8Array; checkpointIds: string[] }
  | { state: "cancelled"; completedSteps: number; checkpointIds: string[]; safeReasonCode: "cancelled" };

export class SyntheticExecutorCrash extends Error {
  readonly safeFailureCode = "synthetic_crash" as const;
  readonly completedSteps: number;

  constructor(completedSteps: number) {
    super(`synthetic crash after step ${completedSteps}`);
    this.name = "SyntheticExecutorCrash";
    this.completedSteps = completedSteps;
  }
}

type EventPayload = SyntheticExecutionEventV1 extends infer Event
  ? Event extends SyntheticExecutionEventV1
    ? Omit<Event, "schema" | "jobId" | "attemptId" | "sequence" | "occurredAt">
    : never
  : never;

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/\s/u.test(value) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateSpec(spec: SyntheticExecutionSpecV1): Uint8Array {
  if (!spec || typeof spec !== "object") {
    throw new Error("spec must be an object");
  }
  if (spec.schema !== "control-room.synthetic-execution/v1") {
    throw new Error("unknown synthetic execution spec schema");
  }
  if (!isBoundedIdentifier(spec.jobId)) {
    throw new Error("jobId must be a non-empty identifier of at most 200 characters without whitespace or control characters");
  }
  if (!isBoundedIdentifier(spec.attemptId)) {
    throw new Error("attemptId must be a non-empty identifier of at most 200 characters without whitespace or control characters");
  }
  if (!Number.isInteger(spec.steps) || spec.steps < 1 || spec.steps > 100) {
    throw new Error("steps must be an integer from 1 through 100");
  }
  if (
    !Number.isInteger(spec.checkpointEverySteps) ||
    spec.checkpointEverySteps < 1 ||
    spec.checkpointEverySteps > spec.steps
  ) {
    throw new Error("checkpointEverySteps must be an integer from 1 through steps");
  }
  if (
    !Number.isInteger(spec.stepDelayMilliseconds) ||
    spec.stepDelayMilliseconds < 0 ||
    spec.stepDelayMilliseconds > 60_000
  ) {
    throw new Error("stepDelayMilliseconds must be an integer from 0 through 60000");
  }
  if (typeof spec.artifactText !== "string") {
    throw new Error("artifactText must be a string");
  }
  // Reject excessive code-unit length before allocating the UTF-8 result. Every
  // supported runtime supplies TextEncoder; browser demos need no Node polyfill.
  if (spec.artifactText.length > 65_536) {
    throw new Error("artifactText encodes to more than 65536 UTF-8 bytes");
  }
  const artifactBytes = new TextEncoder().encode(spec.artifactText);
  if (artifactBytes.byteLength > 65_536) throw new Error("artifactText encodes to more than 65536 UTF-8 bytes");
  assertNoSecretMaterial(spec.artifactText, "artifactText");
  if (
    spec.crashAfterStep !== undefined &&
    (!Number.isInteger(spec.crashAfterStep) || spec.crashAfterStep < 1 || spec.crashAfterStep > spec.steps)
  ) {
    throw new Error("crashAfterStep must be an integer from 1 through steps");
  }
  return artifactBytes;
}

export async function runSyntheticExecution(
  spec: SyntheticExecutionSpecV1,
  ports: SyntheticExecutionPortsV1,
): Promise<SyntheticExecutionResultV1> {
  // A caller editing its form while a callback yields must not alter validated
  // step limits, identity or result text of an already-started simulation.
  spec = { ...spec };
  const artifactBytes = validateSpec(spec);

  let sequence = 0;
  let completedSteps = 0;
  const checkpointIds: string[] = [];

  const emit = async (payload: EventPayload): Promise<void> => {
    sequence += 1;
    await ports.emit({
      schema: "control-room.synthetic-execution-event/v1",
      jobId: spec.jobId,
      attemptId: spec.attemptId,
      sequence,
      occurredAt: ports.now(),
      ...payload,
    } as SyntheticExecutionEventV1);
  };

  const cancel = async (): Promise<SyntheticExecutionResultV1> => {
    await emit({ event: "cancelled", completedSteps, safeReasonCode: "cancelled" });
    return { state: "cancelled", completedSteps, checkpointIds, safeReasonCode: "cancelled" };
  };

  if (ports.signal.aborted) {
    return cancel();
  }

  await emit({ event: "started" });

  while (completedSteps < spec.steps) {
    if (ports.signal.aborted) {
      return cancel();
    }

    await ports.sleep(spec.stepDelayMilliseconds, ports.signal);

    if (ports.signal.aborted) {
      return cancel();
    }

    completedSteps += 1;
    await emit({
      event: "progress",
      completedSteps,
      totalSteps: spec.steps,
      progressPercent: Math.floor((completedSteps * 100) / spec.steps),
    });

    // Reporting may yield to cancellation, including on the final step where
    // there is no next loop iteration to observe the signal.
    if (ports.signal.aborted) return cancel();

    if (spec.crashAfterStep === completedSteps) {
      throw new SyntheticExecutorCrash(completedSteps);
    }

    if (completedSteps % spec.checkpointEverySteps === 0 || completedSteps === spec.steps) {
      const checkpointId = `checkpoint:${spec.attemptId}:${completedSteps}`;
      checkpointIds.push(checkpointId);
      await emit({ event: "checkpointed", completedSteps, checkpointId });
    }
  }

  if (ports.signal.aborted) return cancel();
  await emit({ event: "completed", completedSteps });
  return {
    state: "succeeded",
    completedSteps,
    artifactBytes,
    checkpointIds,
  };
}
