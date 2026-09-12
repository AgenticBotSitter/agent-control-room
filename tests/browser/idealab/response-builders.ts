// Synthetic Idea Lab server for the browser fixture. Pure JS: no React, no
// DOM. A Node-side test imports this module, wraps it as a fetch transport,
// and drives the REAL product clients (create/decision/stop) plus Zod-parses
// every response against src/web/v1/idea-wire.ts. The browser entry
// (main.tsx) serves the same server over window.fetch, fail-closed.
//
// POST semantics mirror the product contracts:
// - create echoes the idempotency-key header; a repeated key replays.
// - decision requires saved synthesis; echoes the sent draft; startsWork is
//   always false (promotion never executes here).
// - start always conflicts (no fixture lab is startable).
// - stop succeeds only for the running lab with matching runId + digest.
// - synthesis always conflicts (A already has one; B/C runs are not completed).

import { labs, digests, type LabConfig } from "./fixture-data";

export interface SyntheticResponse {
  status: number;
  json: unknown;
}

const ok = (json: unknown): SyntheticResponse => ({ status: 200, json });
const fail = (status: number): SyntheticResponse => ({ status, json: { error: "synthetic" } });

const DECISION_DIGESTS: Record<string, string> = {
  save: `sha256:${"c".repeat(64)}`,
  create_project: `sha256:${"d".repeat(64)}`,
  reject: `sha256:${"e".repeat(64)}`,
};
const CREATED_DIGEST = `sha256:${"f".repeat(64)}`;

export interface IdeaLabServer {
  buildIdeaPage: () => unknown;
  buildIdeaDetail: (sessionId: string) => unknown;
  buildIdeaOptions: () => unknown;
  postCreate: (body: unknown, idempotencyKey: string) => SyntheticResponse;
  postDecision: (sessionId: string, body: unknown) => SyntheticResponse;
  postStart: (sessionId: string) => SyntheticResponse;
  postStop: (sessionId: string, body: unknown) => SyntheticResponse;
  postSynthesis: (sessionId: string) => SyntheticResponse;
}

export function createIdeaLabServer(now: string): IdeaLabServer {
  const seenCreateKeys = new Map<string, string>();
  const seenDecisionBodies = new Set<string>();
  let createdCount = 0;
  const stoppedRuns = new Set<string>();

  const labOf = (sessionId: string): LabConfig | undefined => labs[sessionId];

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

  const buildIdeaDetail = (sessionId: string) => {
    const lab = labOf(sessionId);
    if (!lab) throw new Error(`unknown lab session: ${sessionId}`);
    return {
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
        state: stoppedRuns.has(lab.run.runId) ? "cancelled" : lab.run.state,
        messagesUsed: lab.run.messagesUsed,
        maxMessages: lab.maxRounds * lab.participants.length,
        costUsd: lab.run.costUsd,
        providerContacted: lab.run.providerContacted,
        updatedAt: now,
        cancellationRequestedAt: stoppedRuns.has(lab.run.runId) ? now : lab.run.cancellationRequestedAt,
        retryPermitted: false,
        attempts: lab.run.attempts,
      } : null,
      decision: null,
      canSynthesize: lab.canSynthesize,
      canStart: lab.canStart,
      canStop: lab.canStop && !stoppedRuns.has(lab.run?.runId ?? ""),
      canDecide: lab.canDecide,
      canPromote: lab.canPromote,
      execution: "authorization_required",
      observedAt: now,
    };
  };

  const buildIdeaOptions = () => ({
    startsWork: false,
    minParticipants: 3,
    maxParticipants: 6,
    requiredPerspectives: ["skeptic"],
    participants: [
      { participantId: "idea:lab:options:p1", participantDigest: digests.sessionDigest, displayName: "Option Skeptic", perspective: "skeptic", harness: "hermes" },
      { participantId: "idea:lab:options:p2", participantDigest: digests.sessionDigest, displayName: "Option Builder", perspective: "builder", harness: "codex" },
      { participantId: "idea:lab:options:p3", participantDigest: digests.sessionDigest, displayName: "Option Customer", perspective: "customer", harness: "local_model" },
    ],
  });

  const postCreate = (body: unknown, idempotencyKey: string): SyntheticResponse => {
    if (!idempotencyKey || typeof body !== "object" || body === null) return fail(400);
    const prior = seenCreateKeys.get(idempotencyKey);
    if (prior) {
      return ok({ ...JSON.parse(prior), replayed: true });
    }
    createdCount += 1;
    const receipt = {
      sessionId: `idea:lab:created:${createdCount}`,
      sessionDigest: CREATED_DIGEST,
      createdAt: now,
      replayed: false,
      startsWork: false,
      execution: "not_requested",
      idempotencyKey,
    };
    seenCreateKeys.set(idempotencyKey, JSON.stringify(receipt));
    return ok(receipt);
  };

  const postDecision = (sessionId: string, body: unknown): SyntheticResponse => {
    const lab = labOf(sessionId);
    if (!lab) return fail(404);
    if (!lab.synthesis) return fail(409);
    const draft = body as { sessionDigest?: string; synthesisDigest?: string; intent?: { decision?: string; project?: { projectId?: string } } };
    if (!draft || typeof draft !== "object" || draft.sessionDigest !== digests.sessionDigest
      || draft.synthesisDigest !== digests.synthesisDigest || !draft.intent) return fail(400);
    const decision = draft.intent.decision;
    if (decision !== "save" && decision !== "reject" && decision !== "create_project") return fail(400);
    if ((decision === "create_project") !== !!draft.intent.project) return fail(400);
    const key = `${sessionId}:${JSON.stringify(draft)}`;
    const replayed = seenDecisionBodies.has(key);
    seenDecisionBodies.add(key);
    return ok({
      sessionId,
      sessionDigest: digests.sessionDigest,
      synthesisDigest: digests.synthesisDigest,
      decisionDigest: DECISION_DIGESTS[decision],
      decision,
      projectId: draft.intent.project?.projectId ?? null,
      replayed,
      startsWork: false,
    });
  };

  const postStart = (sessionId: string): SyntheticResponse => {
    if (!labOf(sessionId)) return fail(404);
    return fail(409);
  };

  const postStop = (sessionId: string, body: unknown): SyntheticResponse => {
    const lab = labOf(sessionId);
    if (!lab || !lab.run) return fail(404);
    const input = body as { runId?: string; sessionDigest?: string };
    if (!input || input.runId !== lab.run.runId || input.sessionDigest !== digests.sessionDigest) return fail(409);
    if (lab.run.state !== "running" || stoppedRuns.has(lab.run.runId)) return fail(409);
    stoppedRuns.add(lab.run.runId);
    return ok({
      sessionId,
      sessionDigest: digests.sessionDigest,
      runId: lab.run.runId,
      state: "cancelled",
      cancellationRequestedAt: now,
      startsWork: false,
    });
  };

  const postSynthesis = (sessionId: string): SyntheticResponse => {
    if (!labOf(sessionId)) return fail(404);
    return fail(409);
  };

  return { buildIdeaPage, buildIdeaDetail, buildIdeaOptions, postCreate, postDecision, postStart, postStop, postSynthesis };
}

// Backwards-compatible per-session builder used by earlier tests.
export function buildIdeaLabResponses(sessionId: string, now: string) {
  const server = createIdeaLabServer(now);
  if (!labs[sessionId]) throw new Error(`unknown lab session: ${sessionId}`);
  return {
    urls: {
      listUrl: "/api/v1/ideas",
      detailUrl: `/api/v1/ideas/${encodeURIComponent(sessionId)}`,
    },
    buildIdeaPage: () => server.buildIdeaPage(),
    buildIdeaDetail: () => server.buildIdeaDetail(sessionId),
  };
}
