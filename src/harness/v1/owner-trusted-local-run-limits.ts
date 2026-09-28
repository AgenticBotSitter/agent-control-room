export const MAC_LOCAL_TASK_RUN_LIMITS_V1 = "control-room.mac-local-task-run-limits/v1" as const;

export const MIN_TASK_RUN_WALL_TIME_MS = 1_000;
export const MAX_TASK_RUN_WALL_TIME_MS = 3_600_000;
export const MIN_TASK_RUN_OUTPUT_BYTES = 16_384;
export const MAX_TASK_RUN_OUTPUT_BYTES = 16_777_216;
/** One second of CPU is the smallest useful per-run CPU allowance. */
export const MIN_TASK_RUN_CPU_TIME_MS = 1_000;
export const MAX_TASK_RUN_CPU_TIME_MS = 3_600_000;
/** 64 MiB is below any real local CLI's floor, so the bound is never
 * configured so low that every ordinary task dies on it. */
export const MIN_TASK_RUN_RESIDENT_BYTES = 67_108_864;
export const MAX_TASK_RUN_RESIDENT_BYTES = 1_073_741_824;

export type MacLocalTaskRunLimitsV1 = Readonly<{
  schema: typeof MAC_LOCAL_TASK_RUN_LIMITS_V1;
  wallTimeMs: number;
  outputBytes: number;
  /** Cumulative user+system CPU time for the whole run process group. */
  cpuTimeMs: number;
  /** Peak resident set size of the whole run process group. */
  maxResidentBytes: number;
}>;

/** The resource half of the model, as a single frozen record. Enforcers take
 * this rather than the whole owner file so a limit can never be assembled
 * from two sources that disagree. */
export type MacLocalTaskRunResourcesV1 = Readonly<{
  cpuTimeMs: number;
  maxResidentBytes: number;
}>;

export const DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1: MacLocalTaskRunLimitsV1 = Object.freeze({
  schema: MAC_LOCAL_TASK_RUN_LIMITS_V1,
  wallTimeMs: 120_000,
  outputBytes: 1_048_576,
  // 60 s of CPU: generous for a text task, but it stops an unbounded spin.
  cpuTimeMs: 60_000,
  // 1 GiB resident for one run group.
  maxResidentBytes: 1_073_741_824,
});

/** The enforced pair projected from the defaults. Used when a caller
 * supplies no explicit resources, so an ordinary run stays bounded rather
 * than unbounded. */
export const DEFAULT_TASK_RUN_RESOURCES_V1: MacLocalTaskRunResourcesV1 = Object.freeze({
  cpuTimeMs: DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1.cpuTimeMs,
  maxResidentBytes: DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1.maxResidentBytes,
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
  if (keys.length !== 5 || !["schema", "wallTimeMs", "outputBytes", "cpuTimeMs", "maxResidentBytes"].every(key => Object.hasOwn(record, key))
    || record.schema !== MAC_LOCAL_TASK_RUN_LIMITS_V1) invalid();
  return Object.freeze({
    schema: MAC_LOCAL_TASK_RUN_LIMITS_V1,
    wallTimeMs: boundedInteger(record.wallTimeMs, MIN_TASK_RUN_WALL_TIME_MS, MAX_TASK_RUN_WALL_TIME_MS),
    outputBytes: boundedInteger(record.outputBytes, MIN_TASK_RUN_OUTPUT_BYTES, MAX_TASK_RUN_OUTPUT_BYTES),
    cpuTimeMs: boundedInteger(record.cpuTimeMs, MIN_TASK_RUN_CPU_TIME_MS, MAX_TASK_RUN_CPU_TIME_MS),
    maxResidentBytes: boundedInteger(record.maxResidentBytes, MIN_TASK_RUN_RESIDENT_BYTES, MAX_TASK_RUN_RESIDENT_BYTES),
  });
}

/** Projects the enforced pair. Any other shape, or a value outside the
 * enforced bounds, is refused rather than clamped: a limit the supervisor
 * cannot honour must not silently become a different limit. */
export function captureMacLocalTaskRunResourcesV1(value: unknown): MacLocalTaskRunResourcesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "cpuTimeMs") || !Object.hasOwn(record, "maxResidentBytes")) invalid();
  return Object.freeze({
    cpuTimeMs: boundedInteger(record.cpuTimeMs, MIN_TASK_RUN_CPU_TIME_MS, MAX_TASK_RUN_CPU_TIME_MS),
    maxResidentBytes: boundedInteger(record.maxResidentBytes, MIN_TASK_RUN_RESIDENT_BYTES, MAX_TASK_RUN_RESIDENT_BYTES),
  });
}

/** The process-table sampling cadence shared by the supervisor. */
export const TASK_RUN_RESOURCE_SAMPLE_INTERVAL_MS = 250;

/** Names the single limit a stopped run was stopped for. Recorded in the run
 * record so the reason is never only a generic failure string. */
export const taskRunResourceLimitNames = ["cpu_time", "resident_memory"] as const;
export type TaskRunResourceLimitNameV1 = (typeof taskRunResourceLimitNames)[number];
