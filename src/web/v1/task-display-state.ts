import { taskSummarySchema, type TaskSummary } from "./task-wire";

type DisplayResult = Readonly<{ artifactId: string; attemptId: string; runId: string; contentHash: string }>;
type DisplayReview = Readonly<{
  status: string;
  contentHash: string;
  matchingArtifactIds: readonly string[];
  additionalEvidenceOmitted: boolean;
}>;

export type TaskDisplayEvidenceV1 = Readonly<{
  latestAttemptOutcome?: Readonly<{ attemptId: string; attemptState: string; runId: string; runState: string }>;
  /** Authenticated reason the latest attempt ended, when the canonical attempt
   * record carries one. Read from the saved record, never inferred. */
  latestAttemptFailureCode?: string;
  results: readonly DisplayResult[];
  reviews: readonly DisplayReview[];
  additionalResultsOmitted: boolean;
  additionalTargetsOmitted: boolean;
}>;

/** The one cancellation reason a person on this Mac caused by choosing it: they
 * rejected a bot's returned result on the Workers page. The gateway records it
 * as the attempt's safe failure code when it applies that decision, so this is
 * the owner's own recorded choice and not an inference. Any other cancelled
 * task keeps the plain cancelled wording. */
export const OWNER_REJECTED_FAILURE_CODE_V1 = "result_rejected";

/**
 * Marks a cancelled task the owner closed by rejecting what a bot returned.
 *
 * Deliberately independent of the result/review store: that store answers
 * "did the owner accept this?", which a connector-only Mac never configures. A
 * rejected result is proved by the canonical attempt's own recorded reason, so
 * gating this on the result store would leave the owner's own decision
 * unreadable on exactly the installation that records it.
 *
 * Only a cancelled task whose newest attempt carries this reason may be marked,
 * and the canonical state is never changed.
 */
export function projectOwnerRejectionV1(summary: TaskSummary, latestAttemptFailureCode: string | undefined): TaskSummary {
  if (summary.state !== "cancelled" || latestAttemptFailureCode !== OWNER_REJECTED_FAILURE_CODE_V1) return summary;
  return taskSummarySchema.parse({ ...summary, ownerRejected: true as const });
}

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
  const projected = projectOwnerRejectionV1(summary, evidence.latestAttemptFailureCode);
  let state = projected.state;
  const outcome = evidence.latestAttemptOutcome;
  if (activeStates.has(projected.state) && outcome?.runState === "succeeded"
    && compatibleAttemptStates.has(outcome.attemptState)
    && evidence.results.some(result => result.attemptId === outcome.attemptId && result.runId === outcome.runId)) state = "succeeded";

  if (state !== "succeeded") return projected;
  const accepted = evidence.results.length > 0 && !evidence.additionalResultsOmitted && !evidence.additionalTargetsOmitted
    && evidence.reviews.every(review => !review.additionalEvidenceOmitted)
    && evidence.results.every(result => evidence.reviews.some(review => review.status === "ready"
      && review.matchingArtifactIds.includes(result.artifactId) && review.contentHash === result.contentHash));
  return taskSummarySchema.parse({ ...projected, state, ...(accepted ? { qualityStatus: "accepted" as const } : {}) });
}
