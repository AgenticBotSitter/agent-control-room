export const MAC_LOCAL_TASK_RUN_LIMITS_V1 = "control-room.mac-local-task-run-limits/v1" as const;

export const MIN_TASK_RUN_WALL_TIME_MS = 1_000;
export const MAX_TASK_RUN_WALL_TIME_MS = 3_600_000;
export const MIN_TASK_RUN_OUTPUT_BYTES = 16_384;
export const MAX_TASK_RUN_OUTPUT_BYTES = 16_777_216;

export type MacLocalTaskRunLimitsV1 = Readonly<{
  schema: typeof MAC_LOCAL_TASK_RUN_LIMITS_V1;
  wallTimeMs: number;
  outputBytes: number;
}>;

export const DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1: MacLocalTaskRunLimitsV1 = Object.freeze({
  schema: MAC_LOCAL_TASK_RUN_LIMITS_V1,
  wallTimeMs: 120_000,
  outputBytes: 1_048_576,
});

const invalid = (): never => { throw new Error("mac_local_task_run_limits_invalid"); };

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

/** Strictly validates the data-only limits accepted by every local harness. */
export function captureMacLocalTaskRunLimitsV1(value: unknown): MacLocalTaskRunLimitsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.length !== 3 || !["schema", "wallTimeMs", "outputBytes"].every(key => Object.hasOwn(record, key))
    || record.schema !== MAC_LOCAL_TASK_RUN_LIMITS_V1) invalid();
  return Object.freeze({
    schema: MAC_LOCAL_TASK_RUN_LIMITS_V1,
    wallTimeMs: boundedInteger(record.wallTimeMs, MIN_TASK_RUN_WALL_TIME_MS, MAX_TASK_RUN_WALL_TIME_MS),
    outputBytes: boundedInteger(record.outputBytes, MIN_TASK_RUN_OUTPUT_BYTES, MAX_TASK_RUN_OUTPUT_BYTES),
  });
}
