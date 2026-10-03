// 0290: the text a worker is actually handed, per job.
//
// The canonical domain stores ONE request per workflow, and a pipeline run's
// three stage jobs share it, so `objective` cannot differ per stage. Reading
// the request objective therefore gave every stage the same instructions, and
// the fleet gateway -- the only route the installed Mac uses since da1fc5f6a
// ("Offer to other machines") -- reads exactly that column. This module is the
// one place that composes, stores and reads the authoritative per-job text.
//
// Three rules hold everywhere this module is used:
//
//   1. AUTHOR ONCE. `recordTaskHandoffInSession` inserts in the same transaction
//      that creates the job. There is no UPDATE path anywhere in the product,
//      and 0290's trigger refuses one at the database, so what a worker was
//      told cannot change under a claim.
//
//   2. VERIFY ON READ. A row whose `instructions_digest` does not reproduce its
//      own text is not sent to anyone; the reader falls back to the legacy
//      request objective. A row that no authorisation vouches for is worse than
//      no row, because it would look authenticated and be taken on trust.
//
//   3. FALL BACK, NEVER FAIL. A job with no handoff row -- every proposal
//      proposed before this migration, and any row the reader cannot verify --
//      still resolves, to the request objective it always used. Nothing about
//      existing tasks changes shape, and no read of a task can start failing
//      because a hand-off row is missing.
import { sha256Digest } from "../../security";
import type { DatabaseSession } from "../../persistence/database";

/** The exact material a hand-off row is digested over. Byte-identical in the
 * writer and the reader, and the digest is stored beside the text so the two
 * sides can disagree loudly instead of silently disagreeing quietly. */
export function taskHandoffDigestV1(input: Readonly<{
  jobId: string; title: string; instructions: string;
  acceptanceCriteria: string | null; acceptanceTests: string | null;
  stageKind: string | null; stageOrdinal: number | null;
}>): string {
  return sha256Digest({
    jobId: input.jobId, title: input.title, instructions: input.instructions,
    acceptanceCriteria: input.acceptanceCriteria, acceptanceTests: input.acceptanceTests,
    stageKind: input.stageKind, stageOrdinal: input.stageOrdinal,
  });
}

export type TaskHandoffV1 = Readonly<{
  title: string; instructions: string;
  acceptanceCriteria: string | null; acceptanceTests: string | null;
  stageKind: string | null; stageOrdinal: number | null;
}>;

/** What a delivery reader resolves for one job: the hand-off where one exists
 * and verifies, and the caller's fallback where it does not. `title` is null on
 * the fallback so the reader keeps whatever title it already had. */
export type TaskHandoffResolvedV1 = Readonly<{
  title: string | null; instructions: string;
  acceptanceCriteria: string | null; acceptanceTests: string | null;
  stageKind: string | null; stageOrdinal: number | null;
}>;

const column = (value: string | null | undefined) => value === undefined || value === null || value === "" ? null : value;

/** Inserts the job's hand-off text. Call inside the transaction that creates the
 * job, so the two either both exist or neither does. A job is created once, so
 * an existing row means this transaction is not the one that created the job;
 * that is refused rather than overwritten. */
export async function recordTaskHandoffInSession(tx: DatabaseSession, input: Readonly<{
  tenantId: string; projectId: string; jobId: string; authoredByIdentityId: string;
  title: string; instructions: string; now: string;
  acceptanceCriteria?: string | null; acceptanceTests?: string | null;
  stageKind?: string | null; stageOrdinal?: number | null;
}>): Promise<TaskHandoffV1> {
  const acceptanceCriteria = column(input.acceptanceCriteria), acceptanceTests = column(input.acceptanceTests);
  const stageKind = column(input.stageKind), stageOrdinal = input.stageOrdinal ?? null;
  const digest = taskHandoffDigestV1({ jobId: input.jobId, title: input.title, instructions: input.instructions,
    acceptanceCriteria, acceptanceTests, stageKind, stageOrdinal });
  // The insert is conditional on the row not existing, so a replayed propose
  // that re-runs this statement against the job it already made is inert
  // rather than a primary-key failure the caller would see as a crash. The
  // session contract exposes only `rows`, so the insert reports its own
  // success through RETURNING rather than a driver rowCount.
  const inserted = await tx.query<{ job_id: string }>(
    `INSERT INTO control_task_handoffs(tenant_id,job_id,project_id,title,instructions,acceptance_criteria,
      acceptance_tests,stage_kind,stage_ordinal,instructions_digest,authored_by_identity_id,created_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
     WHERE NOT EXISTS (SELECT 1 FROM control_task_handoffs WHERE tenant_id=$1 AND job_id=$2)
     RETURNING job_id`,
    [input.tenantId, input.jobId, input.projectId, input.title, input.instructions, acceptanceCriteria,
      acceptanceTests, stageKind, stageOrdinal, digest, input.authoredByIdentityId, input.now]);
  if (inserted.rows.length === 0) {
    const prior = await readTaskHandoffByIdInSession(tx, input.tenantId, input.jobId);
    if (!prior) throw new Error("task_handoff_write_conflict");
    if (prior.instructions !== input.instructions || prior.title !== input.title)
      throw new Error("task_handoff_write_conflict");
    return prior;
  }
  return Object.freeze({ title: input.title, instructions: input.instructions, acceptanceCriteria,
    acceptanceTests, stageKind, stageOrdinal });
}

type HandoffRow = { title: string; instructions: string; acceptance_criteria: string | null;
  acceptance_tests: string | null; stage_kind: string | null; stage_ordinal: string | number | null;
  instructions_digest: string };

function verified(row: HandoffRow, jobId: string): TaskHandoffV1 | undefined {
  const stageOrdinal = row.stage_ordinal === null ? null : Number(row.stage_ordinal);
  const value = { title: row.title, instructions: row.instructions,
    acceptanceCriteria: row.acceptance_criteria, acceptanceTests: row.acceptance_tests,
    stageKind: row.stage_kind, stageOrdinal };
  // A row that does not verify against its own stored digest is not read. See
  // rule 2 at the top of this file.
  if (taskHandoffDigestV1({ jobId, ...value }) !== row.instructions_digest) return undefined;
  return Object.freeze(value);
}

export async function readTaskHandoffByIdInSession(tx: DatabaseSession, tenantId: string,
  jobId: string): Promise<TaskHandoffV1 | undefined> {
  const row = (await tx.query<HandoffRow>(
    `SELECT title,instructions,acceptance_criteria,acceptance_tests,stage_kind,stage_ordinal,instructions_digest
     FROM control_task_handoffs WHERE tenant_id=$1 AND job_id=$2`, [tenantId, jobId])).rows[0];
  return row ? verified(row, jobId) : undefined;
}

/** The same verification as `verified`, for a hand-off already joined onto a
 * statement the caller was making anyway. Null columns are a job with no row
 * (every task proposed before 0290), and `fallback` stands in. An unverified row
 * falls back too, for the reason given at the top of this file. */
export function verifiedTaskHandoffInstructionsV1(row: Readonly<{
  jobId: string; title: string | null; instructions: string | null;
  acceptanceCriteria: string | null; acceptanceTests: string | null;
  stageKind: string | null; stageOrdinal: string | number | null; instructionsDigest: string | null;
}>, fallback: string): TaskHandoffResolvedV1 {
  const fallbackValue: TaskHandoffResolvedV1 = { title: null, instructions: fallback,
    acceptanceCriteria: null, acceptanceTests: null, stageKind: null, stageOrdinal: null };
  const { instructions, instructionsDigest: digest } = row;
  if (instructions === null || digest === null) return fallbackValue;
  return verified({ title: row.title ?? "", instructions, acceptance_criteria: row.acceptanceCriteria,
    acceptance_tests: row.acceptanceTests, stage_kind: row.stageKind, stage_ordinal: row.stageOrdinal,
    instructions_digest: digest }, row.jobId) ?? fallbackValue;
}

/** The ceiling, and it is the COLUMN's bound rather than this module's
 * preference. `control_task_handoffs.instructions` is
 * `CHECK (length(instructions) BETWEEN 1 AND 4000)` (0290, line 57), and this
 * composed string is what is written into it, inside the same transaction that
 * creates the job. A composition over the ceiling therefore aborts task
 * creation with a raw `violates check constraint` -- refusing an ordinary,
 * within-limits owner approval because of a defect in this file.
 *
 * It was not ordinary before. `total` was 16,000, four times the column it
 * feeds, while every field that reaches here is individually within its own
 * schema limit: `taskDraftSchema` allows instructions up to 4,000 and criteria
 * and tests up to 2,000 each, so the composition of a maximum input is over the
 * column and the owner's approval failed at the database. The two names below
 * are the SAME bound and are derived from one another rather than restated,
 * because the gap between the two numbers was the bug. */
const HANDOFF_INSTRUCTIONS_LIMIT_V1 = 4_000;

/** The worker's instruction text with the approved acceptance requirements
 * appended, as DATA the worker must satisfy. This is what the gateway delivers.
 *
 * The requirements are appended to a copy of the instructions rather than
 * replacing them, and the copy is what is sent: a worker always sees the task
 * it was given AND what "done" means.
 *
 * What is truncated, and what is never returned, is decided by the ceiling
 * above: whole blocks are dropped from the end, and what comes back is never
 * longer than the column accepts. The truncation notice is charged from the
 * FIRST byte rather than appended to whatever happens to fit, so a composition
 * that fits only without the notice is still recognised as truncated -- and the
 * task text is shortened to make room for the notice rather than the
 * requirements being dropped with nothing to say so, because a worker told
 * nothing is worse than a worker told it was told something shorter. */
export const TASK_HANDOFF_LIMITS_V1 = Object.freeze({
  /** `control_task_handoffs.instructions`'s own CHECK bound. Read it in 0290; the
   * two numbers are the same number and have to stay the same number. */
  instructions: HANDOFF_INSTRUCTIONS_LIMIT_V1,
  /** What the owner-facing wire schemas allow for the two requirement fields.
   * They are not applied here: the ceiling above already bounds the composition,
   * and a second, independent cap on the same text is a third number to keep
   * true. `task-handoff-instructions-bound-postgres.test.ts` proves a composition
   * of inputs at these maxima is still within the column. */
  criteria: 2_000,
  tests: 2_000,
  /** The composed text's ceiling. THE SAME BOUND as `instructions`, derived
   * rather than restated. */
  total: HANDOFF_INSTRUCTIONS_LIMIT_V1,
  /** Appended whenever anything was dropped, so no worker is left believing it
   * has no acceptance requirements when the owner approved some. */
  truncationNotice: "\n\n[acceptance requirements truncated to fit the delivery limit]",
} as const);

export function composeWorkerInstructionsV1(handoff: Readonly<{ instructions: string;
  acceptanceCriteria: string | null; acceptanceTests: string | null }>): string {
  // The bound is read from the exported limits ON EVERY CALL, not captured in
  // a module-level copy. That is deliberate and load-bearing: it means a
  // mutation that loosens the ceiling cannot hide behind a second copy of the
  // number that still reads 4,000, which is exactly the mutation
  // `task-handoff-instructions-bound-postgres.test.ts` was checked against.
  const ceiling = TASK_HANDOFF_LIMITS_V1.instructions;
  const blocks: string[] = [handoff.instructions];
  if (handoff.acceptanceCriteria) blocks.push(`Acceptance criteria the owner approved:\n${handoff.acceptanceCriteria}`);
  if (handoff.acceptanceTests) blocks.push(`Acceptance tests the owner approved:\n${handoff.acceptanceTests}`);
  const composed = blocks.join("\n\n");
  if (composed.length <= ceiling) return composed;
  // Over the column's bound: drop WHOLE blocks from the end, so nothing is cut
  // mid-sentence except the task text when it alone is nearly the whole bound.
  // `budget` is the ceiling less the notice, and the notice is counted from the
  // first kept block rather than appended afterwards, because "fits exactly" and
  // "fits with the notice" are different questions and only the second one is
  // the contract.
  const budget = ceiling - TASK_HANDOFF_LIMITS_V1.truncationNotice.length;
  const kept: string[] = [handoff.instructions.slice(0, budget)];
  for (const block of blocks.slice(1)) {
    const candidate = [...kept, block].join("\n\n");
    if (candidate.length > budget) break;
    kept.push(block);
  }
  return `${kept.join("\n\n")}${TASK_HANDOFF_LIMITS_V1.truncationNotice}`;
}

