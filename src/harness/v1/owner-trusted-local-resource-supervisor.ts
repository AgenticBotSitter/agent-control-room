import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { captureMacLocalTaskRunResourcesV1, MAX_TASK_RUN_CPU_TIME_MS,
  MAX_TASK_RUN_RESIDENT_BYTES, MIN_TASK_RUN_CPU_TIME_MS, MIN_TASK_RUN_RESIDENT_BYTES,
  TASK_RUN_RESOURCE_SAMPLE_INTERVAL_MS, type MacLocalTaskRunResourcesV1,
  type TaskRunResourceLimitNameV1 } from "./owner-trusted-local-run-limits";

/**
 * Per-run CPU and memory enforcement for a local executor process group.
 *
 * Why a supervisor and not `setrlimit` alone: measured on macOS 26.6,
 * `ulimit -t` delivers SIGXCPU at the soft limit and SIGKILL at the hard
 * limit, but a child that *catches* SIGXCPU keeps running past both, so
 * `setrlimit` is advisory on this platform (see reports/M13-decisions.md D1).
 * macOS also ignores RLIMIT_AS/RLIMIT_RSS entirely. The sampler is therefore
 * the authority: it reads the child's whole process group and, on the first
 * sample at or past a limit, calls `stop`. Terminating the group (TERM, then
 * KILL, then confirming absence) stays with the caller, which already owns
 * that escalation for its own deadline and cancellation paths.
 *
 * Every observable failure is fail-closed: an unreadable process table stops
 * the run rather than leaving it unmonitored (D3).
 */

const SAMPLE_TIMEOUT_MS = 2_000;
const SYSTEM_PATH = "/usr/bin:/bin";
const executeFile = promisify(execFile);

/** One measurement of the whole run group. */
export type TaskRunResourceSampleV1 = Readonly<{
  /** Cumulative user+system CPU across the group, milliseconds. */
  cpuTimeMs: number;
  /** Resident bytes summed across the group at this instant. */
  residentBytes: number;
  /** Processes observed in the group. Zero means the group is gone. */
  processes: number;
}>;

/** A run stopped by one of the two resource limits, never by wall clock. */
export type TaskRunResourceBreachV1 = Readonly<{
  /** Which limit stopped the run. For `cause:
   * "measurement_unavailable"` this is "unknown": no bound was crossed,
   * the run simply could not be measured, and claiming a specific limit
   * would put a bound in the run record that was never crossed. */
  limit: TaskRunResourceLimitNameV1 | "unknown";
  /** The first sample at or past the limit. Resolution is one sample. */
  measuredCpuTimeMs: number;
  measuredResidentBytes: number;
  limitCpuTimeMs: number;
  limitResidentBytes: number;
  /** Why the supervisor stopped it: a breach, or an unreadable sample. */
  cause: "exceeded" | "measurement_unavailable";
}>;

export type TaskRunResourceSupervisorV1 = Readonly<{
  /** The limit that stopped the run, or undefined if the run was not
   * stopped by a resource limit. Read after the run settles. */
  breach(): TaskRunResourceBreachV1 | undefined;
  /** Stops sampling. Call exactly once the child has closed. */
  close(): void;
}>;

function unavailable(): never { throw new Error("task_run_resource_supervisor_unavailable"); }

function groupExists(child: ChildProcess): boolean {
  if (!child.pid || child.pid < 1) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

/** `ps` reports CPU as [hh:]mm:ss.ss. Only the two rightmost fields matter
 * and both are fixed-width with two decimals, so this parses exactly. */
/** `ps` prints CPU time as `MM:SS.CC` where MM is TOTAL MINUTES, unbounded:
 * rows such as `9:24.42`, `144:06.26` and `295:12.09` were all read
 * directly from /bin/ps on this host. It is minutes, not hours: `9:24.42`
 * is 9m24s, and reading it as 9h24m would over-report by 60x. Seconds are
 * zero-padded to two digits and the fraction is centiseconds. */
const PS_TIME = /^(\d+):(\d{2})\.(\d{2})$/u;

export function parsePsTimeToMillisecondsV1(value: string): number | undefined {
  const match = PS_TIME.exec(value.trim());
  if (match === null) return undefined;
  const minutes = Number(match[1]), seconds = Number(match[2]), centis = Number(match[3]);
  if (!Number.isSafeInteger(minutes) || seconds > 59) return undefined;
  const ms = minutes * 60_000 + seconds * 1_000 + centis * 10;
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** One line of `ps -e -o pid=,pgid=,time=,rss=`. */
export function parsePsGroupRowV1(line: string): Readonly<{ pid: number; pgid: number; cpuTimeMs: number; rssKilobytes: number }> | undefined {
  const fields = line.trim().split(/\s+/u);
  if (fields.length !== 4) return undefined;
  const [pid, pgid, time, rss] = fields as [string, string, string, string];
  if (!/^\d+$/u.test(pid) || !/^\d+$/u.test(pgid) || !/^\d+$/u.test(rss)) return undefined;
  const cpuTimeMs = parsePsTimeToMillisecondsV1(time);
  if (cpuTimeMs === undefined) return undefined;
  return { pid: Number(pid), pgid: Number(pgid), cpuTimeMs, rssKilobytes: Number(rss) };
}

export type ProcessTableReader = (processGroupId: number) => Promise<readonly string[]>;

const readProcessTable: ProcessTableReader = async processGroupId => {
  // Same call shape as the reviewed-executable identity check: promisified
  // execFile with an explicit utf8 encoding. The raw overload types stdout as a
  // Readable, which would turn an unreadable table into a crash rather than the
  // refusal this module promises.
  let stdout: string;
  try {
    ({ stdout } = await executeFile("ps", ["-e", "-o", "pid=,pgid=,time=,rss="], { windowsHide: true,
      timeout: SAMPLE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
      env: { PATH: SYSTEM_PATH, LANG: "en_US.UTF-8", NODE_ENV: "production" } }));
  } catch { return unavailable(); }
  if (typeof stdout !== "string") unavailable();
  return selectProcessGroupRowsV1(stdout.split("\n"), processGroupId);
};

/** Keeps this group's rows, and fails closed on a row whose group cannot be
 * determined.
 *
 * A `-g` selector is a macOS/BSD extension, so the filter is done here.
 *
 * The fail-closed rule is deliberately narrow. A row that is unreadable but
 * *provably not ours* is dropped: a `ps` table legitimately contains rows in
 * shapes this parser does not model, and refusing every sample because the
 * host has one long-lived process would disable enforcement outright. But a
 * row whose pgid cannot be read at all is AMBIGUOUS - it might be ours, and
 * dropping it would under-count the group and could hide a real breach - so it
 * is kept and `summarizeProcessGroupV1` refuses the whole sample. */
export function selectProcessGroupRowsV1(lines: readonly string[], processGroupId: number): readonly string[] {
  return lines.filter((line: string) => {
    if (line.trim().length === 0) return false;
    const fields = line.trim().split(/\s+/u);
    const pgid = fields.length >= 2 ? Number(fields[1]) : Number.NaN;
    if (Number.isSafeInteger(pgid)) return pgid === processGroupId;
    // The pgid is unreadable, so the row could belong to any group,
    // including ours: keep it and let the sample be refused.
    return true;
  });
}

/** Sums the group. An unparsable line for this group is a refusal, never a
 * lower total: a malformed table must not read as "under the limit". */
export function summarizeProcessGroupV1(lines: readonly string[]): TaskRunResourceSampleV1 {
  let cpuTimeMs = 0, residentBytes = 0, processes = 0;
  for (const line of lines) {
    const row = parsePsGroupRowV1(line);
    if (row === undefined) return unavailable();
    cpuTimeMs += row.cpuTimeMs; residentBytes += row.rssKilobytes * 1024; processes += 1;
  }
  return Object.freeze({ cpuTimeMs, residentBytes, processes });
}

export function detectResourceBreachV1(sample: TaskRunResourceSampleV1,
  resources: MacLocalTaskRunResourcesV1): Readonly<{ limit: TaskRunResourceLimitNameV1 }> | undefined {
  // CPU first: a spinning child is the more common runaway, and reporting the
  // limit it actually crossed first is the more useful record.
  if (sample.cpuTimeMs >= resources.cpuTimeMs) return Object.freeze({ limit: "cpu_time" as const });
  if (sample.residentBytes >= resources.maxResidentBytes) return Object.freeze({ limit: "resident_memory" as const });
  return undefined;
}

export type TaskRunResourceSupervisorOptionsV1 = Readonly<{
  readProcessTable?: ProcessTableReader;
  intervalMs?: number;
  now?: () => number;
}>;

/**
 * Starts sampling one run group. `stop(reason)` is called at most once, on the
 * first sample that reaches a limit or on the first unreadable sample.
 */
export function startTaskRunResourceSupervisorV1(child: ChildProcess, resourcesValue: unknown,
  stop: (breach: TaskRunResourceBreachV1) => void, options: TaskRunResourceSupervisorOptionsV1 = {}):
  TaskRunResourceSupervisorV1 {
  const resources = captureMacLocalTaskRunResourcesV1(resourcesValue);
  if (typeof stop !== "function") unavailable();
  const read = options.readProcessTable ?? readProcessTable;
  const intervalMs = options.intervalMs ?? TASK_RUN_RESOURCE_SAMPLE_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) unavailable();
  if (!child.pid || child.pid < 1) unavailable();
  const processGroupId: number = child.pid;
  let settled = false, last: TaskRunResourceSampleV1 | undefined, breach: TaskRunResourceBreachV1 | undefined;
  let inFlight = false;
  // One unmeasurable sample is not a measurement: a run whose table cannot be
  // read is stopped rather than left unmonitored (decision D3). Refuse closed
  // and report the last known value, never a fabricated zero.
  const refuse = () => {
    if (settled) return;
    settled = true; clearInterval(timer);
    breach = Object.freeze({ limit: "unknown" as const, measuredCpuTimeMs: last?.cpuTimeMs ?? 0,
      measuredResidentBytes: last?.residentBytes ?? 0, limitCpuTimeMs: resources.cpuTimeMs,
      limitResidentBytes: resources.maxResidentBytes, cause: "measurement_unavailable" as const });
    stop(breach);
  };
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (settled || inFlight || !groupExists(child)) return;
    inFlight = true;
    void read(processGroupId).then(lines => {
      if (settled) return;
      let sample: TaskRunResourceSampleV1;
      try { sample = summarizeProcessGroupV1(lines); }
      catch { refuse(); return; }
      last = sample;
      if (sample.processes === 0) return;
      const hit = detectResourceBreachV1(sample, resources);
      if (!hit) return;
      settled = true; clearInterval(timer);
      breach = Object.freeze({ limit: hit.limit, measuredCpuTimeMs: sample.cpuTimeMs,
        measuredResidentBytes: sample.residentBytes, limitCpuTimeMs: resources.cpuTimeMs,
        limitResidentBytes: resources.maxResidentBytes, cause: "exceeded" as const });
      stop(breach);
    }).catch(() => {
      refuse();
    }).finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref?.();
  return Object.freeze({
    breach: () => breach,
    close: () => { settled = true; clearInterval(timer); },
  });
}

export const taskRunResourceBoundsV1 = Object.freeze({
  cpuTimeMs: Object.freeze({ minimum: MIN_TASK_RUN_CPU_TIME_MS, maximum: MAX_TASK_RUN_CPU_TIME_MS }),
  maxResidentBytes: Object.freeze({ minimum: MIN_TASK_RUN_RESIDENT_BYTES, maximum: MAX_TASK_RUN_RESIDENT_BYTES }),
});

/** The bounded, non-secret projection of a breach that every executor result
 * carries. `reason` is a fixed token so a caller can branch on it; the
 * measured numbers travel beside it so the run record can state which limit
 * was hit and by how much, without parsing a message. */
export type TaskRunResourceStopV1 = Readonly<{
  /** "unknown" only when `cause` is "measurement_unavailable": the run was
   * stopped because it could not be measured, not because a bound was crossed. */
  limit: TaskRunResourceLimitNameV1 | "unknown";
  reason: "cpu_time_exceeded" | "memory_exceeded" | "measurement_unavailable";
  measuredCpuTimeMs: number;
  measuredResidentBytes: number;
  limitCpuTimeMs: number;
  limitResidentBytes: number;
  cause: "exceeded" | "measurement_unavailable";
}>;

export function taskRunResourceStopV1(breach: TaskRunResourceBreachV1): TaskRunResourceStopV1 {
  return Object.freeze({
    limit: breach.limit, cause: breach.cause,
    reason: breach.cause === "measurement_unavailable" ? "measurement_unavailable"
      : breach.limit === "cpu_time" ? "cpu_time_exceeded" : "memory_exceeded",
    measuredCpuTimeMs: breach.measuredCpuTimeMs, measuredResidentBytes: breach.measuredResidentBytes,
    limitCpuTimeMs: breach.limitCpuTimeMs, limitResidentBytes: breach.limitResidentBytes,
  });
}

/** Validates an untrusted resource record on a caller-supplied result. A
 * result that claims a breach must carry a complete, in-bounds one. */
export function captureTaskRunResourceStopV1(value: unknown): TaskRunResourceStopV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 7) return unavailable();
  if (record.limit !== "cpu_time" && record.limit !== "resident_memory" && record.limit !== "unknown") return unavailable();
  if (record.reason !== "cpu_time_exceeded" && record.reason !== "memory_exceeded"
    && record.reason !== "measurement_unavailable") return unavailable();
  if (record.cause !== "exceeded" && record.cause !== "measurement_unavailable") return unavailable();
  for (const key of ["measuredCpuTimeMs", "limitCpuTimeMs"] as const) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0
      || (record[key] as number) > MAX_TASK_RUN_CPU_TIME_MS * 1000) return unavailable();
  }
  for (const key of ["measuredResidentBytes", "limitResidentBytes"] as const) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0
      || (record[key] as number) > Number.MAX_SAFE_INTEGER) return unavailable();
  }
  return taskRunResourceStopV1(breachFromStopRecord(record));
}

function breachFromStopRecord(record: Record<string, unknown>): TaskRunResourceBreachV1 {
  return { limit: record.limit as TaskRunResourceLimitNameV1, cause: record.cause as "exceeded" | "measurement_unavailable",
    measuredCpuTimeMs: record.measuredCpuTimeMs as number, measuredResidentBytes: record.measuredResidentBytes as number,
    limitCpuTimeMs: record.limitCpuTimeMs as number, limitResidentBytes: record.limitResidentBytes as number };
}
