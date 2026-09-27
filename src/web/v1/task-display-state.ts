import { taskSummarySchema, type TaskSummary } from "./task-wire";

type DisplayResult = Readonly<{ artifactId: string; attemptId: string; runId: string; contentHash: string }>;
type DisplayReview = Readonly<{
  status: string;
  contentHash: string;
  matchingArtifactIds: readonly string[];
}>;

export type TaskDisplayEvidenceV1 = Readonly<{
  latestAttemptOutcome?: Readonly<{ attemptId: string; attemptState: string; runId: string; runState: string }>;
  results: readonly DisplayResult[];
  reviews: readonly DisplayReview[];
  additionalResultsOmitted: boolean;
  additionalTargetsOmitted: boolean;
}>;

export async function collectProjectedTasksV1<T, U>(input: Readonly<{
  limit: number;
  batchSize: number;
  maximumCandidates: number;
  read(offset: number, limit: number): Promise<readonly T[]>;
  project(value: T): Promise<U>;
  keep(value: U): boolean;
}>): Promise<Readonly<{ items: readonly U[]; omitted: boolean }>> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.batchSize) || input.batchSize < 1
    || !Number.isSafeInteger(input.maximumCandidates) || input.maximumCandidates < input.batchSize)
    throw new Error("task_display_page_invalid");
  const items: U[] = [];
  let offset = 0, exhausted = false;
  while (items.length <= input.limit && offset < input.maximumCandidates && !exhausted) {
    const size = Math.min(input.batchSize, input.maximumCandidates - offset);
    const values = await input.read(offset, size);
    if (values.length > size) throw new Error("task_display_page_invalid");
    offset += values.length;
    exhausted = values.length < size;
    for (const value of values) {
      const projected = await input.project(value);
      if (input.keep(projected)) items.push(projected);
      if (items.length > input.limit) break;
    }
  }
  return Object.freeze({ items: Object.freeze(items.slice(0, input.limit)),
    omitted: items.length > input.limit || !exhausted && offset >= input.maximumCandidates });
}

const activeStates = new Set<TaskSummary["state"]>(["leased", "running", "waiting_approval"]);
const compatibleAttemptStates = new Set(["leased", "running", "waiting", "succeeded"]);

/**
 * Projects a task's owner-facing state from authenticated saved evidence. This
 * never changes the canonical lifecycle record. A terminal run alone is not
 * enough: that exact attempt/run must also have a received result. Missing,
 * partial, or contradictory evidence retains the canonical state.
 */
export function projectTaskDisplayStateV1(summary: TaskSummary, evidence: TaskDisplayEvidenceV1): TaskSummary {
  let state = summary.state;
  const outcome = evidence.latestAttemptOutcome;
  if (activeStates.has(summary.state) && outcome?.runState === "succeeded"
    && compatibleAttemptStates.has(outcome.attemptState)
    && evidence.results.some(result => result.attemptId === outcome.attemptId && result.runId === outcome.runId)) state = "succeeded";

  if (state !== "succeeded") return summary;
  const accepted = evidence.results.length > 0 && !evidence.additionalResultsOmitted && !evidence.additionalTargetsOmitted
    && evidence.results.every(result => evidence.reviews.some(review => review.status === "ready"
      && review.matchingArtifactIds.includes(result.artifactId) && review.contentHash === result.contentHash));
  return taskSummarySchema.parse({ ...summary, state, ...(accepted ? { qualityStatus: "accepted" as const } : {}) });
}
