// Deterministic "needs breakdown / needs more info" gate for proposed batch
// tasks. Pure text heuristics only: no database, no model call, no state.
// A flag here is a plain-language hint the owner can dismiss or act on; it
// grants nothing and blocks nothing by itself. The owner service enforces the
// actual gate (an unresolved flag refuses approval of that item).
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "./schemas";

export const INTAKE_FLAG_KINDS_V1 = ["needs_breakdown", "needs_more_info"] as const;
export type IntakeFlagKindV1 = (typeof INTAKE_FLAG_KINDS_V1)[number];
export type IntakeFlagV1 = Readonly<{ kind: IntakeFlagKindV1; reasonCode: string }>;
type ProposalTaskV1 = WorkBatchProposalV1["tasks"][number];

const BULLET_LINE = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+\S/u;
const BULLET_PREFIX = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/u;
const SEQUENTIAL_JOIN = /\band then\b|\bafter that\b|\bonce that.s done\b/giu;
const VAGUE_PHRASES = ["tbd", "to be decided", "etc", "and so on", "as needed", "as appropriate",
  "some stuff", "various things", "miscellaneous", "whatever is needed", "make it good", "make it better",
  "clean up as needed", "handle edge cases"];

function lines(text: string): string[] {
  return text.split(/\r?\n/u);
}
function bulletLines(text: string): string[] {
  return lines(text).filter(line => BULLET_LINE.test(line));
}
function stripBulletPrefix(line: string): string {
  return line.replace(BULLET_PREFIX, "").trim();
}
function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}
function containsVaguePhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return VAGUE_PHRASES.some(phrase => lower.includes(phrase));
}

/** Cheap, deterministic rules only. Never calls a model and never mutates the
 * proposal. Reason codes are stable strings the UI translates to plain text. */
export function computeIntakeFlagsV1(task: Pick<ProposalTaskV1,
  "instructions" | "acceptanceCriteria" | "acceptanceTests">): readonly IntakeFlagV1[] {
  const flags: IntakeFlagV1[] = [];
  const instructionBullets = bulletLines(task.instructions);
  const criteriaBullets = bulletLines(task.acceptanceCriteria);
  const sequentialJoins = (task.instructions.match(SEQUENTIAL_JOIN) ?? []).length;
  if (instructionBullets.length >= 3 || criteriaBullets.length >= 3)
    flags.push({ kind: "needs_breakdown", reasonCode: "multiple_listed_deliverables" });
  else if (sequentialJoins >= 2)
    flags.push({ kind: "needs_breakdown", reasonCode: "multiple_sequential_steps" });
  // Vague hedge-words are a precise signal ("tbd", "as needed"...); a plain
  // word count is not — plenty of real tasks have a short, exact criterion.
  // Only the emptiest possible text (a couple of words, no real sentence) is
  // additionally treated as too short to tell a worker when it is done.
  const vague = containsVaguePhrase(task.acceptanceCriteria) || containsVaguePhrase(task.acceptanceTests);
  const tooShort = wordCount(task.acceptanceCriteria) < 3 || wordCount(task.acceptanceTests) < 2;
  if (vague) flags.push({ kind: "needs_more_info", reasonCode: "vague_language_used" });
  if (tooShort) flags.push({ kind: "needs_more_info", reasonCode: "acceptance_detail_too_short" });
  return flags;
}

export const INTAKE_FLAG_REASON_TEXT_V1: Record<string, string> = {
  multiple_listed_deliverables: "This task lists several separate deliverables. It may go faster and be easier to check as smaller tasks.",
  multiple_sequential_steps: "This task describes several steps done one after another. It may go faster as smaller tasks.",
  vague_language_used: "The acceptance criteria or tests use vague wording (like “tbd” or “as needed”) instead of something checkable.",
  acceptance_detail_too_short: "The acceptance criteria or tests look too short to tell a worker exactly when this task is done.",
};

export type SuggestedSplitTaskV1 = Readonly<{ localId: string; title: string; instructions: string;
  acceptanceCriteria: string; acceptanceTests: string }>;
type ProposalEdgeV1 = WorkBatchProposalV1["edges"][number];

/** A conservative, mechanical split: only offered when the instructions and
 * acceptance criteria both list the same number of bulleted lines, so each
 * generated part gets its own concrete criterion. Never offered otherwise —
 * the owner edits the proposal directly instead. Never applied automatically:
 * the caller only uses this to prefill a revision the owner must still save. */
export function computeSuggestedSplitV1(task: Pick<ProposalTaskV1, "localId" | "title" | "instructions"
  | "acceptanceCriteria" | "acceptanceTests">): readonly SuggestedSplitTaskV1[] | null {
  const instructionBullets = bulletLines(task.instructions);
  const criteriaBullets = bulletLines(task.acceptanceCriteria);
  if (instructionBullets.length < 2 || instructionBullets.length !== criteriaBullets.length) return null;
  const testsBullets = bulletLines(task.acceptanceTests);
  return instructionBullets.map((line, index) => Object.freeze({
    localId: `${task.localId}-${index + 1}`,
    title: `${task.title} (part ${index + 1} of ${instructionBullets.length})`,
    instructions: stripBulletPrefix(line),
    acceptanceCriteria: stripBulletPrefix(criteriaBullets[index]!),
    acceptanceTests: testsBullets[index] ? stripBulletPrefix(testsBullets[index]!) : task.acceptanceTests,
  }));
}

/** Builds the revised proposal a "use suggested split" tap would save: the
 * flagged task is replaced by its split parts, chained in bullet order, with
 * the original task's own incoming/outgoing edges reattached to the first and
 * last part. Returns null when no split is available (nothing to apply). This
 * never talks to the server; the caller still must save the result as an
 * ordinary revision for it to take effect. */
export function applySuggestedSplitV1(proposal: WorkBatchProposalV1, localId: string): WorkBatchProposalV1 | null {
  const task = proposal.tasks.find(candidate => candidate.localId === localId);
  const split = task ? computeSuggestedSplitV1(task) : null;
  if (!task || !split) return null;
  const incoming = proposal.edges.filter(edge => edge.toLocalId === localId);
  const outgoing = proposal.edges.filter(edge => edge.fromLocalId === localId);
  const untouched = proposal.edges.filter(edge => edge.toLocalId !== localId && edge.fromLocalId !== localId);
  const chain: ProposalEdgeV1[] = split.slice(1).map((part, index) => ({ fromLocalId: split[index]!.localId, toLocalId: part.localId }));
  const edges: ProposalEdgeV1[] = [...untouched, ...chain,
    ...incoming.map(edge => ({ fromLocalId: edge.fromLocalId, toLocalId: split[0]!.localId })),
    ...outgoing.map(edge => ({ fromLocalId: split[split.length - 1]!.localId, toLocalId: edge.toLocalId }))];
  const tasks = proposal.tasks.flatMap(candidate => candidate.localId === localId
    ? split.map(part => ({ ...candidate, ...part })) : [candidate]);
  const parsed = workBatchProposalSchemaV1.safeParse({ ...proposal, tasks, edges });
  return parsed.success ? parsed.data : null;
}
