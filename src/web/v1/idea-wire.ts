import { z } from "zod";
import { catalogProjectIdSchema as id } from "./project-wire";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), text = z.string().min(1).max(2000);
const summary = z.object({ sessionId: id, sessionDigest: digest, title: z.string().min(1).max(120),
  ideaSummary: text, targetCustomer: z.string().min(1).max(300), createdAt: z.string().datetime({ offset: true }) });
export const ideaPageSchema = z.object({ availability: z.enum(["configured", "not_configured"]),
  sessions: z.array(summary.extend({ participantCount: z.number().int().min(3).max(6), maxRounds: z.number().int().min(1).max(3) })).max(50),
  nextCursor: id.nullable(), execution: z.literal("not_configured"), observedAt: z.string().datetime(),
}).strict().refine(page => page.availability !== "not_configured" || page.sessions.length === 0 && page.nextCursor === null);
export const ideaDetailSchema = z.object({ session: summary.extend({ participants: z.array(z.object({
  participantId: id, displayName: z.string().min(1).max(120), perspective: z.string().min(1).max(80),
})).min(3).max(6), maxRounds: z.number().int().min(1).max(3) }),
contributions: z.array(z.object({ contributionId: id, sessionId: id, sessionDigest: digest, participantId: id,
  round: z.number().int().min(1).max(3), safeOpinion: text, suggestedExperiment: z.string().min(1).max(500),
  confidencePercent: z.number().int().min(0).max(100),
})).max(18),
synthesis: z.object({ sessionId: id, sessionDigest: digest, synthesisDigest: digest, executiveSummary: text,
  nextExperiment: z.string().min(1).max(500), overallScore: z.number().min(0).max(100),
}).nullable(),
decision: z.object({ sessionId: id, sessionDigest: digest, synthesisDigest: digest,
  decision: z.enum(["create_project", "save", "reject"]), project: z.object({ projectId: id }).optional(),
}).nullable(), execution: z.literal("not_configured"), observedAt: z.string().datetime(),
}).strict().refine(value => {
  const { session, contributions, synthesis, decision } = value;
  return new Set(contributions.map(c => `${c.round}:${c.participantId}`)).size === contributions.length
    && contributions.every(c => c.sessionId === session.sessionId && c.sessionDigest === session.sessionDigest
      && c.round <= session.maxRounds && session.participants.some(p => p.participantId === c.participantId))
    && (!synthesis || synthesis.sessionId === session.sessionId && synthesis.sessionDigest === session.sessionDigest)
    && (!decision || !!synthesis && decision.sessionId === session.sessionId && decision.sessionDigest === session.sessionDigest
      && decision.synthesisDigest === synthesis.synthesisDigest && (decision.decision === "create_project") === !!decision.project);
});
export type IdeaPage = z.infer<typeof ideaPageSchema>;
export type IdeaDetail = z.infer<typeof ideaDetailSchema>;
