// Read-only projection of the operator surface into an honest capacity view.
//
// Two canonical evidence sources are reused, never re-derived:
//   - `src/operator-surfaces/v1` (the server-bound operator projection) carries
//     worker state, reported capacity slots, capability state, bottleneck
//     utilization and the canonical attention records.
//   - `scripts/public-model-outcomes.mjs` is the canonical public parser for
//     self-reported model, effort and cost fields. It is Node-only (it imports
//     `node:url`), so this module mirrors its "exactly once, never guessed"
//     field rules instead of importing it. `REPORTED_EFFORTS_V1` mirrors that
//     script's effort vocabulary exactly, including `unknown`, which the script
//     treats as a valid reported effort. One deliberate divergence, in the
//     stricter direction: the script keeps a record whose effort is outside the
//     vocabulary, groups it under `unknown` and flags it invalid, while this
//     module drops that record from the sample count entirely rather than
//     reporting its model under a guessed effort.
//
// Nothing here schedules, assigns, reserves or authorizes work. A missing,
// stale or incomplete measurement is reported as unavailable rather than
// filled in with a plausible value.
import { fetchOperatorSurfaceSnapshotV1 } from "../../operator-surfaces/v1/http-client";
import type { BottleneckProjectionV1, FleetWorkerSummaryV1, OperatorSurfaceSnapshotV1 } from "../../operator-surfaces/v1/types";

export const OPERATOR_CAPACITY_VIEW_V1 = "control-room-operator-capacity-view/v1" as const;

/** An observation older than this is not fresh enough to measure capacity. */
export const CAPACITY_FRESHNESS_MINUTES_V1 = 30;

/** Below this many samples a comparison shows observations without a winner. */
export const COMPARABLE_MINIMUM_V1 = 5;

/** Mirrors the canonical effort vocabulary in `scripts/public-model-outcomes.mjs`. */
export const REPORTED_EFFORTS_V1: readonly string[] = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown",
]);

export type CapacityUnavailableReasonV1 =
  | "not_reported"
  | "observation_stale"
  | "observation_missing"
  | "source_unavailable"
  | "evidence_not_served";

export type CapacityEvidenceV1<T> = Readonly<
  | { evidence: "measured"; value: T }
  | { evidence: "inferred"; value: T; basis: string }
  | { evidence: "unavailable"; reasonCode: CapacityUnavailableReasonV1 }
>;

/**
 * A worker's own capacity is either reported and usable or unavailable: it is
 * never inferred, because inferring a slot count would invent a measurement.
 */
export type CapacityMeasurementV1 = Readonly<
  | { evidence: "measured"; value: { availableSlots: number; totalSlots: number } }
  | { evidence: "unavailable"; reasonCode: CapacityUnavailableReasonV1 }
>;

/** Read-only copy of a bottleneck row; the blocked ids are frozen for the view. */
export interface OperatorCapacityBottleneckV1 {
  resourceKey: string;
  utilizationPercent: number;
  blockedWorkItemIds: readonly string[];
  explanation: string;
}

export interface OperatorCapacityWorkerV1 {
  workerId: string;
  platform: FleetWorkerSummaryV1["platform"];
  state: FleetWorkerSummaryV1["state"];
  lastObservedAt: string;
  /**
   * `self_reported` when this row carries its own reported capacity; freshness
   * is a separate question and never changes attribution.
   */
  attribution: "self_reported" | "unattributed";
  /** Whether this row's own reported capacity is usable, and if not, why not. */
  capacity: CapacityMeasurementV1;
  capability: CapacityEvidenceV1<FleetWorkerSummaryV1["capabilityState"]>;
}

/** Worker rows excluded from every total, grouped by the reason they are excluded. */
export interface OperatorCapacityExclusionsV1 {
  /** Rows that do not report their own capacity, so no total can be attributed to them. */
  unattributed: Readonly<{ count: number; workerIds: readonly string[] }>;
  /** Rows that do report their own capacity but whose observation is not fresh enough to count. */
  notFresh: Readonly<{ count: number; workerIds: readonly string[] }>;
}

/**
 * One submitted outcome. Every field except `model` and `effort` is optional and
 * is treated as unknown unless it is reported with a valid value.
 */
export interface ReportedModelOutcomeRecordV1 {
  model: string;
  effort: string;
  reworkCount?: number;
  rejected?: boolean;
  elapsedMinutes?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicrousd?: number;
}

export interface ModelOutcomeSummaryV1 {
  samples: number;
  comparable: boolean;
  comparableMinimum: number;
  /** Share of counted samples that reported at least one rework round. */
  reworkRate?: number;
  /** Total rework rounds every counted sample reported. */
  reworkRounds?: number;
  rejectionRate?: number;
  medianElapsedMinutes?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMicrousd?: number;
  /** Field names no counted sample reported; the view names them instead of guessing. */
  unreported: readonly string[];
}

export interface OperatorCapacityViewV1 {
  schema: typeof OPERATOR_CAPACITY_VIEW_V1;
  tenantId: string;
  generatedAt: string;
  freshnessMinutes: number;
  workers: readonly OperatorCapacityWorkerV1[];
  capacity: CapacityEvidenceV1<{ availableSlots: number; totalSlots: number; reportingWorkers: number }>;
  excluded: OperatorCapacityExclusionsV1;
  activeWork: CapacityEvidenceV1<Readonly<{ leased: number; running: number; waitingApproval: number }>>;
  queuePressure: CapacityEvidenceV1<readonly OperatorCapacityBottleneckV1[]>;
  reviewDelay: CapacityEvidenceV1<Readonly<{ openReviews: number; oldestCreatedAt?: string }>>;
  idle: CapacityEvidenceV1<Readonly<{ idleWorkers: number }>>;
  modelOutcomes: CapacityEvidenceV1<ModelOutcomeSummaryV1>;
  boundary: Readonly<{ readOnly: true; canAssign: false; canSchedule: false; canAuthorize: false }>;
}

export const OPERATOR_CAPACITY_BOUNDARY_V1 = Object.freeze({
  readOnly: true, canAssign: false, canSchedule: false, canAuthorize: false,
} as const);

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sumCounts(values: readonly (number | undefined)[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || (value ?? -1) < 0) return undefined;
    total += value as number;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function medianOf(values: readonly number[]): number | undefined {
  const known = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!known.length) return undefined;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2;
}

/**
 * The row's own capacity report, or undefined when the row carries none. This is
 * the attribution test on its own: a row that reports its own slots is
 * self-reported even when its observation is too old to count.
 */
function reportsOwnCapacity(worker: FleetWorkerSummaryV1): { availableSlots: number; totalSlots: number } | undefined {
  if (worker.capacityState !== "reported") return undefined;
  const availableSlots = count(worker.availableSlots), totalSlots = count(worker.totalSlots);
  if (availableSlots === undefined || totalSlots === undefined || availableSlots > totalSlots) return undefined;
  return { availableSlots, totalSlots };
}

/** Freshness is the second, separate filter applied to an attributed row. */
function capacityEvidenceOf(worker: FleetWorkerSummaryV1, observedAtMs: number | undefined, generatedMs: number): CapacityMeasurementV1 {
  const reported = reportsOwnCapacity(worker);
  if (!reported) return { evidence: "unavailable", reasonCode: "not_reported" };
  if (worker.telemetryState === "missing" || observedAtMs === undefined) return { evidence: "unavailable", reasonCode: "observation_missing" };
  // A future observation cannot be older than the snapshot, so only a real lag is stale.
  if (worker.telemetryState === "stale" || generatedMs - observedAtMs > CAPACITY_FRESHNESS_MINUTES_V1 * 60_000)
    return { evidence: "unavailable", reasonCode: "observation_stale" };
  return { evidence: "measured", value: reported };
}

function workerCapability(worker: FleetWorkerSummaryV1): CapacityEvidenceV1<FleetWorkerSummaryV1["capabilityState"]> {
  return worker.capabilityState === "unavailable"
    ? { evidence: "unavailable", reasonCode: "not_reported" }
    : { evidence: "measured", value: worker.capabilityState };
}

/**
 * Summarizes self-reported model and effort outcomes. A field that any counted
 * sample leaves unreported is not summarized at all: the summary names it in
 * `unreported` and leaves the value undefined.
 */
export function summarizeReportedModelOutcomesV1(records: readonly ReportedModelOutcomeRecordV1[] = []): CapacityEvidenceV1<ModelOutcomeSummaryV1> {
  if (!Array.isArray(records)) return { evidence: "unavailable", reasonCode: "evidence_not_served" };
  const samples = records.filter(record => record && typeof record.model === "string" && record.model.trim().length > 0
    && typeof record.effort === "string" && REPORTED_EFFORTS_V1.includes(record.effort.trim().toLowerCase()));
  if (!samples.length) return { evidence: "unavailable", reasonCode: "evidence_not_served" };

  const reworkCounts = samples.map(sample => count(sample.reworkCount));
  const rejections = samples.map(sample => typeof sample.rejected === "boolean" ? (sample.rejected ? 1 : 0) : undefined);
  const elapsed = samples.map(sample => typeof sample.elapsedMinutes === "number" && Number.isFinite(sample.elapsedMinutes) && sample.elapsedMinutes >= 0 ? sample.elapsedMinutes : undefined);
  const inputTokens = samples.map(sample => count(sample.inputTokens));
  const outputTokens = samples.map(sample => count(sample.outputTokens));
  const costMicrousd = samples.map(sample => count(sample.costMicrousd));

  const complete = (values: readonly (number | undefined)[]) => values.length > 0 && values.every(value => value !== undefined);
  const unreported: string[] = [];
  const rework = complete(reworkCounts);
  if (!rework) unreported.push("reworkCount");
  const rejected = complete(rejections);
  if (!rejected) unreported.push("rejected");
  const timed = complete(elapsed);
  if (!timed) unreported.push("elapsedMinutes");
  const withInput = complete(inputTokens);
  if (!withInput) unreported.push("inputTokens");
  const withOutput = complete(outputTokens);
  if (!withOutput) unreported.push("outputTokens");
  const withCost = complete(costMicrousd);
  if (!withCost) unreported.push("costMicrousd");

  // A rate is a share of counted samples, never an average round count: one
  // sample reporting three rework rounds is one reworked sample, and its extra
  // rounds are reported separately as `reworkRounds`.
  const reworkTotal = rework ? sumCounts(reworkCounts) : undefined;
  const reworkedSamples = rework ? reworkCounts.filter(value => (value as number) > 0).length : undefined;
  const rejectionTotal = rejected ? sumCounts(rejections) : undefined;
  return { evidence: "measured", value: Object.freeze({
    samples: samples.length,
    comparable: samples.length >= COMPARABLE_MINIMUM_V1,
    comparableMinimum: COMPARABLE_MINIMUM_V1,
    reworkRate: reworkedSamples === undefined ? undefined : reworkedSamples / samples.length,
    reworkRounds: reworkTotal,
    rejectionRate: rejectionTotal === undefined ? undefined : rejectionTotal / samples.length,
    medianElapsedMinutes: timed ? medianOf(elapsed as number[]) : undefined,
    inputTokens: withInput ? sumCounts(inputTokens) : undefined,
    outputTokens: withOutput ? sumCounts(outputTokens) : undefined,
    costMicrousd: withCost ? sumCounts(costMicrousd) : undefined,
    unreported: Object.freeze(unreported),
  }) };
}

export function projectOperatorCapacityViewV1(input: {
  snapshot: OperatorSurfaceSnapshotV1;
  modelOutcomeEvidence?: readonly ReportedModelOutcomeRecordV1[];
}): OperatorCapacityViewV1 {
  const { snapshot } = input;
  const generatedMs = instant(snapshot.generatedAt) ?? 0;
  const fleet = Array.isArray(snapshot.fleet) ? snapshot.fleet : [];
  const workers = fleet.map(worker => {
    const observedAtMs = instant(worker.lastObservedAt);
    const capacity = capacityEvidenceOf(worker, observedAtMs, generatedMs);
    return Object.freeze({
      workerId: worker.workerId, platform: worker.platform, state: worker.state,
      lastObservedAt: worker.lastObservedAt,
      attribution: reportsOwnCapacity(worker) ? "self_reported" as const : "unattributed" as const,
      capacity, capability: workerCapability(worker),
    });
  });

  const attributed = workers.filter(worker => worker.capacity.evidence === "measured");
  const unattributedRows = workers.filter(worker => worker.attribution === "unattributed");
  const notFreshRows = workers.filter(worker => worker.attribution === "self_reported" && worker.capacity.evidence !== "measured");
  const availableSlots = sumCounts(attributed.map(worker => worker.capacity.evidence === "measured" ? worker.capacity.value.availableSlots : undefined));
  const totalSlots = sumCounts(attributed.map(worker => worker.capacity.evidence === "measured" ? worker.capacity.value.totalSlots : undefined));
  const capacity: OperatorCapacityViewV1["capacity"] = attributed.length && availableSlots !== undefined && totalSlots !== undefined
    ? { evidence: "measured", value: Object.freeze({ availableSlots, totalSlots, reportingWorkers: attributed.length }) }
    : { evidence: "unavailable", reasonCode: "not_reported" };

  const activeWork: OperatorCapacityViewV1["activeWork"] = Array.isArray(snapshot.activeWork)
    ? { evidence: "measured", value: Object.freeze({
      leased: snapshot.activeWork.filter(item => item.state === "leased").length,
      running: snapshot.activeWork.filter(item => item.state === "running").length,
      waitingApproval: snapshot.activeWork.filter(item => item.state === "waiting_approval").length,
    }) }
    : { evidence: "unavailable", reasonCode: "source_unavailable" };

  // Utilization is the projection's own estimate over canonical blocked-work ids;
  // it is reported as inferred, never as a measurement of real machine load.
  const activeBottlenecks = Array.isArray(snapshot.bottlenecks) ? snapshot.bottlenecks.filter(item => item && typeof item.resourceKey === "string") : [];
  const queuePressure: OperatorCapacityViewV1["queuePressure"] = Array.isArray(snapshot.bottlenecks)
    ? { evidence: "inferred", basis: "bottleneck utilization projected from canonical blocked work ids",
      value: Object.freeze(activeBottlenecks.map(item => Object.freeze({ resourceKey: item.resourceKey,
        utilizationPercent: item.utilizationPercent, blockedWorkItemIds: Object.freeze([...item.blockedWorkItemIds]),
        explanation: item.explanation }))) }
    : { evidence: "unavailable", reasonCode: "source_unavailable" };

  const openReviews = Array.isArray(snapshot.actionInbox)
    ? snapshot.actionInbox.filter(item => item.kind === "review" && item.state === "open") : undefined;
  const reviewInstants = openReviews?.map(item => instant(item.createdAt));
  // The oldest recorded time is reported only when every open review records one,
  // so the value is never the oldest of a subset presented as the oldest overall.
  const oldest = reviewInstants !== undefined && reviewInstants.length > 0 && reviewInstants.every(value => value !== undefined)
    ? Math.min(...(reviewInstants as number[])) : undefined;
  const reviewDelay: OperatorCapacityViewV1["reviewDelay"] = openReviews
    ? { evidence: "measured", value: Object.freeze({ openReviews: openReviews.length,
      ...(oldest === undefined ? {} : { oldestCreatedAt: new Date(oldest).toISOString() }) }) }
    : { evidence: "unavailable", reasonCode: "source_unavailable" };

  // Fleet state is an observation of a worker's reported state, not measured idle minutes.
  const idle: OperatorCapacityViewV1["idle"] = fleet.length
    ? { evidence: "inferred", basis: "worker state observations, not measured idle minutes",
      value: Object.freeze({ idleWorkers: fleet.filter(worker => worker.state === "idle").length }) }
    : { evidence: "unavailable", reasonCode: "observation_missing" };

  return Object.freeze({
    schema: OPERATOR_CAPACITY_VIEW_V1,
    tenantId: snapshot.tenantId,
    generatedAt: snapshot.generatedAt,
    freshnessMinutes: CAPACITY_FRESHNESS_MINUTES_V1,
    workers: Object.freeze(workers),
    capacity,
    excluded: Object.freeze({
      unattributed: Object.freeze({ count: unattributedRows.length, workerIds: Object.freeze(unattributedRows.map(worker => worker.workerId)) }),
      notFresh: Object.freeze({ count: notFreshRows.length, workerIds: Object.freeze(notFreshRows.map(worker => worker.workerId)) }),
    }),
    activeWork, queuePressure, reviewDelay, idle,
    modelOutcomes: summarizeReportedModelOutcomesV1(input.modelOutcomeEvidence ?? []),
    boundary: OPERATOR_CAPACITY_BOUNDARY_V1,
  });
}

export type OperatorCapacityReadV1 =
  | { state: "available"; view: OperatorCapacityViewV1 }
  | { state: "unavailable"; code: "authentication_required" | "operator_surface_unavailable" | "invalid_response" | "request_failed" };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Reads the server-bound operator projection and projects it. A failed read
 * never yields a substituted view; the caller receives an unavailable state.
 */
export async function readOperatorCapacityViewV1(input: {
  fetcher?: FetchLike;
  modelOutcomeEvidence?: readonly ReportedModelOutcomeRecordV1[];
  signal?: AbortSignal;
} = {}): Promise<OperatorCapacityReadV1> {
  const read = await fetchOperatorSurfaceSnapshotV1(input.fetcher ?? fetch, input.signal);
  if (read.state === "available") {
    try {
      return { state: "available", view: projectOperatorCapacityViewV1({
        snapshot: read.snapshot, modelOutcomeEvidence: input.modelOutcomeEvidence }) };
    } catch {
      return { state: "unavailable", code: "invalid_response" };
    }
  }
  if (read.state === "unavailable") return { state: "unavailable", code: read.code };
  // The reader never resolves while loading, so a loading state here means the read
  // did not finish: that is a failed request, not a missing projection.
  return { state: "unavailable", code: "request_failed" };
}
