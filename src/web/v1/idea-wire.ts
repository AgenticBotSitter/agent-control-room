import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
import { taskCommandSchema } from "./task-wire";
import { ideaOwnerIntentSchemaV1 } from "../../idea-lab/v1/schemas";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), text = z.string().min(1).max(2000);
export const ideaParticipantSelectionSchema = z.array(z.object({ participantId: id, participantDigest: digest }).strict())
  .min(3).max(6).refine(values => new Set(values.map(value => value.participantId)).size === values.length);
export const ideaCreationOptionsSchema = z.object({ startsWork: z.literal(false), minParticipants: z.literal(3), maxParticipants: z.literal(6),
  requiredPerspectives: z.tuple([z.literal("skeptic")]),
  participants: z.array(z.object({ participantId: id, participantDigest: digest, displayName: z.string().min(1).max(120),
    perspective: z.string().min(1).max(80), harness: z.enum(["hermes", "codex", "local_model"]),
  }).strict()).min(3).max(6),
}).strict().refine(value => new Set(value.participants.map(p => p.participantId)).size === value.participants.length
  && new Set(value.participants.map(p => p.perspective)).size === value.participants.length
  && value.participants.some(p => p.perspective === "skeptic"));
export type IdeaCreationOptions = z.infer<typeof ideaCreationOptionsSchema>;
export const ideaCreateDraftSchema = z.object({ title: z.string().trim().min(1).max(120), ideaSummary: z.string().trim().min(1).max(800),
  targetCustomer: z.string().trim().min(1).max(300), maxRounds: z.number().int().min(1).max(3),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25),
  participantSelections: ideaParticipantSelectionSchema.optional(),
}).strict();
export const ideaCreateReceiptSchema = z.object({ sessionId: id, sessionDigest: digest, createdAt: z.string().datetime(),
  replayed: z.boolean(), startsWork: z.literal(false), execution: z.literal("not_requested"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,160}$/),
}).strict();
export type IdeaCreateDraft = z.infer<typeof ideaCreateDraftSchema>;
export type IdeaCreateReceipt = z.infer<typeof ideaCreateReceiptSchema>;
export const ideaStopInputSchema = z.object({ runId: id, sessionDigest: digest }).strict();
export const ideaStopReceiptSchema = z.object({ sessionId: id, sessionDigest: digest, runId: id,
  state: z.enum(["prepared", "running", "completed", "cancelled", "failed_definite", "ambiguous"]),
  cancellationRequestedAt: z.string().datetime({ offset: true }).nullable(), startsWork: z.literal(false),
}).strict();
export type IdeaStopReceipt = z.infer<typeof ideaStopReceiptSchema>;
export const ideaStartDraftSchema = z.object({ sessionDigest: digest }).strict();
export const ideaStartReceiptSchema = z.object({ sessionId: id, sessionDigest: digest, runId: id,
  state: z.enum(["prepared", "running", "completed", "cancelled", "failed_definite", "ambiguous"]),
  replayed: z.boolean(), providerContacted: z.boolean(), retryPermitted: z.literal(false),
}).strict();
export type IdeaStartReceipt = z.infer<typeof ideaStartReceiptSchema>;
/**
 * Preparing an Idea Lab round only creates ordinary proposed tasks. It never
 * contacts a provider, assigns a worker, or starts work from the browser.
 */
export const ideaRoundProposalDraftSchema = z.object({ sessionDigest: digest, projectId: id, round: z.number().int().min(1).max(3) }).strict();
export const ideaRoundProposalReceiptSchema = z.object({ sessionId: id, sessionDigest: digest, projectId: id,
  round: z.number().int().min(1).max(3), receipts: z.array(taskCommandSchema).min(3).max(6), startsWork: z.literal(false),
}).strict().refine(value => value.receipts.every(item => item.receipt.projectId === value.projectId));
export type IdeaRoundProposalReceipt = z.infer<typeof ideaRoundProposalReceiptSchema>;
/** A saved contribution receipt, not evidence that a task was started or accepted by this endpoint. */
export const ideaResultProjectionReceiptSchema = z.object({ sessionId: id, taskKey: id,
  contribution: z.object({ contributionId: id, contributionDigest: digest }).strict(), replayed: z.boolean(),
  startsWork: z.literal(false),
}).strict();
export type IdeaResultProjectionReceipt = z.infer<typeof ideaResultProjectionReceiptSchema>;
export const ideaSynthesisDraftSchema = z.union([
  z.object({ sessionDigest: digest, runId: id }).strict(),
  z.object({ sessionDigest: digest, mode: z.literal("canonical_reviewed_tasks") }).strict(),
]);
export const ideaSynthesisReceiptSchema = z.object({ sessionId: id, sessionDigest: digest, runId: id.nullable(),
  mode: z.enum(["legacy_panel", "canonical_reviewed_tasks"]), synthesisDigest: digest,
  replayed: z.boolean(), startsWork: z.literal(false) }).strict().refine(value =>
  (value.mode === "legacy_panel") === (value.runId !== null));
export type IdeaSynthesisReceipt = z.infer<typeof ideaSynthesisReceiptSchema>;
export const ideaDecisionDraftSchema = z.object({ sessionDigest: digest, synthesisDigest: digest,
  intent: ideaOwnerIntentSchemaV1 }).strict().refine(v => (v.intent.decision === "create_project") === !!v.intent.project);
export const ideaDecisionReceiptSchema = z.object({ sessionId: id, sessionDigest: digest, synthesisDigest: digest,
  decisionDigest: digest, decision: z.enum(["create_project", "save", "reject"]), projectId: id.nullable(),
  replayed: z.boolean(), startsWork: z.literal(false) }).strict().refine(v => (v.decision === "create_project") === !!v.projectId);
export type IdeaDecisionReceipt = z.infer<typeof ideaDecisionReceiptSchema>;
const summary = z.object({ sessionId: id, sessionDigest: digest, title: z.string().min(1).max(120),
  ideaSummary: text, targetCustomer: z.string().min(1).max(300), createdAt: z.string().datetime({ offset: true }) });
export const ideaPageSchema = z.object({ availability: z.enum(["configured", "not_configured"]),
  canCreate: z.boolean(),
  sessions: z.array(summary.extend({ participantCount: z.number().int().min(3).max(6), maxRounds: z.number().int().min(1).max(3) })).max(50),
  nextCursor: id.nullable(), execution: z.enum(["not_configured", "authorization_required"]), observedAt: z.string().datetime(),
}).strict().refine(page => page.availability !== "not_configured" || page.sessions.length === 0 && page.nextCursor === null && !page.canCreate);
export const ideaDetailSchema = z.object({ session: summary.extend({ participants: z.array(z.object({
  participantId: id, displayName: z.string().min(1).max(120), perspective: z.string().min(1).max(80),
})).min(3).max(6), maxRounds: z.number().int().min(1).max(3),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25) }),
contributions: z.array(z.object({ contributionId: id, sessionId: id, sessionDigest: digest, participantId: id,
  round: z.number().int().min(1).max(3), safeOpinion: text, suggestedExperiment: z.string().min(1).max(500),
  confidencePercent: z.number().int().min(0).max(100),
  sourceMode: z.enum(["injected_only", "provider_filtered", "canonical_task_result"]),
  evidenceState: z.enum(["none", "reviewed_control_room_task"]),
  providerContacted: z.boolean(), liveBotContactAuthorized: z.boolean(),
})).max(18),
synthesis: z.object({ sessionId: id, sessionDigest: digest, synthesisDigest: digest, executiveSummary: text,
  nextExperiment: z.string().min(1).max(500), overallScore: z.number().min(0).max(100),
}).nullable(),
run: z.object({ runId: id, sessionId: id, sessionDigest: digest,
  state: z.enum(["prepared", "running", "completed", "cancelled", "failed_definite", "ambiguous"]),
  messagesUsed: z.number().int().min(0).max(18), maxMessages: z.number().int().min(3).max(18),
  costUsd: z.number().min(0).max(25), providerContacted: z.boolean(), updatedAt: z.string().datetime({ offset: true }),
  cancellationRequestedAt: z.string().datetime({ offset: true }).nullable(),
  retryPermitted: z.literal(false), attempts: z.array(z.object({ participantId: id, round: z.number().int().min(1).max(3),
    state: z.enum(["provider_marked", "completed", "failed_definite", "ambiguous"]),
  }).strict()).max(18),
}).strict().nullable(),
decision: z.object({ sessionId: id, sessionDigest: digest, synthesisDigest: digest,
  decision: z.enum(["create_project", "save", "reject"]), project: z.object({ projectId: id }).optional(),
}).nullable(), canSynthesize: z.boolean(), canStart: z.boolean(), canStop: z.boolean(), canDecide: z.boolean(), canPromote: z.boolean(), execution: z.enum(["not_configured", "authorization_required"]), observedAt: z.string().datetime(),
canonicalTasks: z.object({ projectId: id, taskCount: z.number().int().min(3).max(18), preparedRounds: z.array(z.number().int().min(1).max(3)).min(1).max(3),
  tasks: z.array(z.object({ taskKey: id, participantId: id, round: z.number().int().min(1).max(3),
    contributionRecorded: z.boolean() }).strict()).min(3).max(18),
}).strict().nullable(), canProjectResults: z.boolean(), nextCanonicalRound: z.number().int().min(2).max(3).nullable(), canPrepareNextRound: z.boolean(),
}).strict().refine(value => {
  const { session, contributions, synthesis, decision, run, canonicalTasks } = value;
  return new Set(contributions.map(c => `${c.round}:${c.participantId}`)).size === contributions.length
    && (!value.canStart || value.execution === "authorization_required" && !run && !synthesis && !decision && !contributions.length && !canonicalTasks)
    && (!value.canSynthesize || !synthesis && !decision && (run
      ? run.state === "completed" && contributions.length === session.maxRounds * session.participants.length
      : !!canonicalTasks && canonicalTasks.taskCount === session.maxRounds * session.participants.length
        && contributions.length === session.maxRounds * session.participants.length
        && contributions.every(contribution => contribution.sourceMode === "canonical_task_result")))
    && (!value.canPromote || value.canDecide)
    && (!value.canDecide || !!synthesis && !decision && (!run || run.state === "completed"))
    && (!run || run.sessionId === session.sessionId && run.sessionDigest === session.sessionDigest
      && run.maxMessages === session.maxRounds * session.participants.length && run.messagesUsed <= run.maxMessages
      && run.messagesUsed === run.attempts.filter(a => a.state === "completed").length
      && (run.state !== "completed" || run.messagesUsed === run.maxMessages)
      && new Set(run.attempts.map(a => `${a.round}:${a.participantId}`)).size === run.attempts.length
      && run.attempts.every(a => a.round <= session.maxRounds && session.participants.some(p => p.participantId === a.participantId)))
    && contributions.every(c => c.sessionId === session.sessionId && c.sessionDigest === session.sessionDigest
      && c.round <= session.maxRounds && session.participants.some(p => p.participantId === c.participantId))
    && contributions.every(c => c.sourceMode === "provider_filtered" ? c.providerContacted && c.liveBotContactAuthorized && c.evidenceState === "none"
      : c.sourceMode === "canonical_task_result" ? !c.providerContacted && !c.liveBotContactAuthorized && c.evidenceState === "reviewed_control_room_task"
      : !c.providerContacted && !c.liveBotContactAuthorized && c.evidenceState === "none")
    && (!canonicalTasks || !run
      && canonicalTasks.taskCount >= session.participants.length && canonicalTasks.taskCount <= session.maxRounds * session.participants.length
      && canonicalTasks.preparedRounds.every(round => round <= session.maxRounds)
      && canonicalTasks.tasks.length === canonicalTasks.taskCount
      && new Set(canonicalTasks.tasks.map(task => task.taskKey)).size === canonicalTasks.tasks.length
      && canonicalTasks.tasks.every(task => task.round <= session.maxRounds && session.participants.some(participant => participant.participantId === task.participantId)))
    && (!value.canProjectResults || !!canonicalTasks && !run && !synthesis && !decision)
    && (value.nextCanonicalRound === null || !!canonicalTasks && !run && !synthesis && !decision
      && value.nextCanonicalRound <= session.maxRounds && canonicalTasks.preparedRounds.includes(value.nextCanonicalRound - 1)
      && canonicalTasks.tasks.filter(task => task.round === value.nextCanonicalRound! - 1).every(task => task.contributionRecorded))
    && (!value.canPrepareNextRound || value.nextCanonicalRound !== null && value.execution === "authorization_required")
    && (!synthesis || synthesis.sessionId === session.sessionId && synthesis.sessionDigest === session.sessionDigest)
    && (!decision || !!synthesis && decision.sessionId === session.sessionId && decision.sessionDigest === session.sessionDigest
      && decision.synthesisDigest === synthesis.synthesisDigest && (decision.decision === "create_project") === !!decision.project);
});
export type IdeaPage = z.infer<typeof ideaPageSchema>;
export type IdeaDetail = z.infer<typeof ideaDetailSchema>;
