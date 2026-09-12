// Pure response builders for the Idea Lab browser fixture. No React, no DOM:
// a Node-side test imports this module and Zod-parses each response against
// src/web/v1/idea-wire.ts. The browser entry (main.tsx) serves the same
// builders over window.fetch.

import { labs, digests, type LabConfig } from "./fixture-data";

export interface IdeaLabResponseBuilder {
  urls: { listUrl: string; detailUrl: string };
  buildIdeaPage: () => unknown;
  buildIdeaDetail: () => unknown;
}

export function buildIdeaLabResponses(sessionId: string, now: string): IdeaLabResponseBuilder {
  const lab = labs[sessionId];
  if (!lab) throw new Error(`unknown lab session: ${sessionId}`);

  const listUrl = "/api/v1/ideas";
  const detailUrl = `/api/v1/ideas/${encodeURIComponent(sessionId)}`;

  const sessionSummary = (cfg: LabConfig) => ({
    sessionId: cfg.sessionId,
    sessionDigest: digests.sessionDigest,
    title: cfg.title,
    ideaSummary: cfg.ideaSummary,
    targetCustomer: cfg.targetCustomer,
    createdAt: now,
    participantCount: cfg.participants.length,
    maxRounds: cfg.maxRounds,
  });

  // The browser client requires sessions sorted descending by sessionId and
  // nextCursor === null unless exactly 50 sessions are returned.
  const buildIdeaPage = () => ({
    availability: "configured",
    canCreate: true,
    sessions: Object.values(labs)
      .sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1))
      .map(sessionSummary),
    nextCursor: null,
    execution: "authorization_required",
    observedAt: now,
  });

  const buildIdeaDetail = () => ({
    session: {
      ...sessionSummary(lab),
      participants: lab.participants,
      maxDurationSeconds: lab.maxDurationSeconds,
      maxCostUsd: lab.maxCostUsd,
    },
    contributions: lab.contributions.map(c => ({
      contributionId: c.contributionId,
      sessionId: lab.sessionId,
      sessionDigest: digests.sessionDigest,
      participantId: c.participantId,
      round: c.round,
      safeOpinion: c.safeOpinion,
      suggestedExperiment: c.suggestedExperiment,
      confidencePercent: c.confidencePercent,
      sourceMode: c.sourceMode,
      providerContacted: c.providerContacted,
      liveBotContactAuthorized: c.liveBotContactAuthorized,
    })),
    synthesis: lab.synthesis ? {
      sessionId: lab.sessionId,
      sessionDigest: digests.sessionDigest,
      synthesisDigest: digests.synthesisDigest,
      executiveSummary: lab.synthesis.executiveSummary,
      nextExperiment: lab.synthesis.nextExperiment,
      overallScore: lab.synthesis.overallScore,
    } : null,
    run: lab.run ? {
      runId: lab.run.runId,
      sessionId: lab.sessionId,
      sessionDigest: digests.sessionDigest,
      state: lab.run.state,
      messagesUsed: lab.run.messagesUsed,
      maxMessages: lab.maxRounds * lab.participants.length,
      costUsd: lab.run.costUsd,
      providerContacted: lab.run.providerContacted,
      updatedAt: now,
      cancellationRequestedAt: lab.run.cancellationRequestedAt,
      retryPermitted: false,
      attempts: lab.run.attempts,
    } : null,
    decision: null,
    canSynthesize: lab.canSynthesize,
    canStart: lab.canStart,
    canStop: lab.canStop,
    canDecide: lab.canDecide,
    canPromote: lab.canPromote,
    execution: "authorization_required",
    observedAt: now,
  });

  return { urls: { listUrl, detailUrl }, buildIdeaPage, buildIdeaDetail };
}
