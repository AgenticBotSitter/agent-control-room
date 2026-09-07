import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), text = z.string().min(1).max(2000);
export const ideaCreateDraftSchema = z.object({ title: z.string().trim().min(1).max(120), ideaSummary: z.string().trim().min(1).max(800),
  targetCustomer: z.string().trim().min(1).max(300), maxRounds: z.number().int().min(1).max(3),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25),
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
const summary = z.object({ sessionId: id, sessionDigest: digest, title: z.string().min(1).max(120),
  ideaSummary: text, targetCustomer: z.string().min(1).max(300), createdAt: z.string().datetime({ offset: true }) });
export const ideaPageSchema = z.object({ availability: z.enum(["configured", "not_configured"]),
  canCreate: z.boolean(),
  sessions: z.array(summary.extend({ participantCount: z.number().int().min(3).max(6), maxRounds: z.number().int().min(1).max(3) })).max(50),
  nextCursor: id.nullable(), execution: z.literal("not_configured"), observedAt: z.string().datetime(),
}).strict().refine(page => page.availability !== "not_configured" || page.sessions.length === 0 && page.nextCursor === null && !page.canCreate);
export const ideaDetailSchema = z.object({ session: summary.extend({ participants: z.array(z.object({
  participantId: id, displayName: z.string().min(1).max(120), perspective: z.string().min(1).max(80),
})).min(3).max(6), maxRounds: z.number().int().min(1).max(3) }),
contributions: z.array(z.object({ contributionId: id, sessionId: id, sessionDigest: digest, participantId: id,
  round: z.number().int().min(1).max(3), safeOpinion: text, suggestedExperiment: z.string().min(1).max(500),
  confidencePercent: z.number().int().min(0).max(100),
  sourceMode: z.enum(["injected_only", "provider_filtered"]), providerContacted: z.boolean(), liveBotContactAuthorized: z.boolean(),
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
}).nullable(), canStop: z.boolean(), execution: z.literal("not_configured"), observedAt: z.string().datetime(),
}).strict().refine(value => {
  const { session, contributions, synthesis, decision, run } = value;
  return new Set(contributions.map(c => `${c.round}:${c.participantId}`)).size === contributions.length
    && (!run || run.sessionId === session.sessionId && run.sessionDigest === session.sessionDigest
      && run.maxMessages === session.maxRounds * session.participants.length && run.messagesUsed <= run.maxMessages
      && run.messagesUsed === run.attempts.filter(a => a.state === "completed").length
      && (run.state !== "completed" || run.messagesUsed === run.maxMessages)
      && new Set(run.attempts.map(a => `${a.round}:${a.participantId}`)).size === run.attempts.length
      && run.attempts.every(a => a.round <= session.maxRounds && session.participants.some(p => p.participantId === a.participantId)))
    && contributions.every(c => c.sessionId === session.sessionId && c.sessionDigest === session.sessionDigest
      && c.round <= session.maxRounds && session.participants.some(p => p.participantId === c.participantId))
    && contributions.every(c => c.sourceMode === "provider_filtered" ? c.providerContacted && c.liveBotContactAuthorized
      : !c.providerContacted && !c.liveBotContactAuthorized)
    && (!synthesis || synthesis.sessionId === session.sessionId && synthesis.sessionDigest === session.sessionDigest)
    && (!decision || !!synthesis && decision.sessionId === session.sessionId && decision.sessionDigest === session.sessionDigest
      && decision.synthesisDigest === synthesis.synthesisDigest && (decision.decision === "create_project") === !!decision.project);
});
export type IdeaPage = z.infer<typeof ideaPageSchema>;
export type IdeaDetail = z.infer<typeof ideaDetailSchema>;
