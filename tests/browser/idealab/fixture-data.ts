// Shared synthetic data for the Idea Lab browser fixture. Extracted so a
// Node-side test can validate the wire shapes without spinning up the
// browser. The fixture itself (main.tsx) imports this module plus
// response-builders.ts and serves the built responses over window.fetch.
//
// Two generic lab configurations:
//   labA — completed run, full attempts, one visible contribution gap,
//          synthesis saved, ready for owner decision.
//   labB — running run, one settled turn plus one provider-marked turn,
//          no synthesis yet, stoppable.

export interface LabParticipant {
  participantId: string;
  displayName: string;
  perspective: string;
}

export interface LabContribution {
  contributionId: string;
  participantId: string;
  round: number;
  safeOpinion: string;
  suggestedExperiment: string;
  confidencePercent: number;
  sourceMode: "injected_only" | "provider_filtered";
  providerContacted: boolean;
  liveBotContactAuthorized: boolean;
}

export interface LabAttempt {
  participantId: string;
  round: number;
  state: "provider_marked" | "completed" | "failed_definite" | "ambiguous";
}

export interface LabConfig {
  sessionId: string;
  title: string;
  ideaSummary: string;
  targetCustomer: string;
  maxRounds: number;
  maxDurationSeconds: number;
  maxCostUsd: number;
  participants: LabParticipant[];
  contributions: LabContribution[];
  run: {
    runId: string;
    state: "prepared" | "running" | "completed" | "cancelled" | "failed_definite" | "ambiguous";
    messagesUsed: number;
    costUsd: number;
    providerContacted: boolean;
    cancellationRequestedAt: string | null;
    attempts: LabAttempt[];
  } | null;
  synthesis: {
    executiveSummary: string;
    nextExperiment: string;
    overallScore: number;
  } | null;
  canSynthesize: boolean;
  canStart: boolean;
  canStop: boolean;
  canDecide: boolean;
  canPromote: boolean;
}

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function participant(session: string, n: number, displayName: string, perspective: string): LabParticipant {
  return { participantId: `${session}:p${n}`, displayName, perspective };
}

function contribution(
  session: string, participantId: string, round: number, n: number,
  safeOpinion: string, mode: LabContribution["sourceMode"],
): LabContribution {
  const synthetic = mode === "injected_only";
  return {
    contributionId: `${session}:c${n}`,
    participantId, round, safeOpinion,
    suggestedExperiment: `Prototype the smallest version with round-${round} scope.`,
    confidencePercent: 60 + n * 5,
    sourceMode: mode,
    providerContacted: !synthetic,
    liveBotContactAuthorized: !synthetic,
  };
}

// Lab A: 3 participants x 2 rounds. All six attempts completed, but only five
// contributions were retained — participant 3 has no round-2 contribution, so
// the panel renders "No contribution saved for this round." Partial failure
// stays visible while synthesis and the owner decision stay available.
const labAId = "idea:lab:completed-synthesis";
const labAParticipants = [
  participant(labAId, 1, "Ada Skeptic", "skeptic"),
  participant(labAId, 2, "Bruno Builder", "builder"),
  participant(labAId, 3, "Cara Customer", "customer"),
];

const labA: LabConfig = {
  sessionId: labAId,
  title: "Synthetic lab A — completed panel ready for decision",
  ideaSummary: "A disposable idea with a complete six-turn panel, saved synthesis and an available owner decision.",
  targetCustomer: "Contributors validating the Idea Lab journey",
  maxRounds: 2,
  maxDurationSeconds: 300,
  maxCostUsd: 5,
  participants: labAParticipants,
  contributions: [
    contribution(labAId, labAParticipants[0].participantId, 1, 1, "Synthetic opinion round 1 from the skeptic.", "injected_only"),
    contribution(labAId, labAParticipants[1].participantId, 1, 2, "Synthetic opinion round 1 from the builder.", "injected_only"),
    contribution(labAId, labAParticipants[2].participantId, 1, 3, "Synthetic opinion round 1 from the customer.", "injected_only"),
    contribution(labAId, labAParticipants[0].participantId, 2, 4, "Synthetic opinion round 2 from the skeptic.", "injected_only"),
    contribution(labAId, labAParticipants[1].participantId, 2, 5, "Synthetic opinion round 2 from the builder.", "injected_only"),
    contribution(labAId, labAParticipants[2].participantId, 2, 6, "Synthetic opinion round 2 from the customer.", "injected_only"),
  ],
  run: {
    runId: `${labAId}:run1`,
    state: "completed",
    messagesUsed: 6,
    costUsd: 0,
    providerContacted: false,
    cancellationRequestedAt: null,
    attempts: [
      { participantId: labAParticipants[0].participantId, round: 1, state: "completed" },
      { participantId: labAParticipants[1].participantId, round: 1, state: "completed" },
      { participantId: labAParticipants[2].participantId, round: 1, state: "completed" },
      { participantId: labAParticipants[0].participantId, round: 2, state: "completed" },
      { participantId: labAParticipants[1].participantId, round: 2, state: "completed" },
      { participantId: labAParticipants[2].participantId, round: 2, state: "completed" },
    ],
  },
  synthesis: {
    executiveSummary: "Synthetic recap: five of six turns retained; the missing turn is shown, not hidden.",
    nextExperiment: "Re-run round 2 for the customer seat and compare coverage.",
    overallScore: 72,
  },
  canSynthesize: false,
  canStart: false,
  canStop: false,
  canDecide: true,
  canPromote: true,
};

// Lab B: 3 participants x 1 round. One settled turn, one provider-marked turn
// with no settled result yet, run still open and stoppable.
const labBId = "idea:lab:running-gap";
const labBParticipants = [
  participant(labBId, 1, "Dev Skeptic", "skeptic"),
  participant(labBId, 2, "Erin Explorer", "explorer"),
  participant(labBId, 3, "Finn Founder", "founder"),
];

const labB: LabConfig = {
  sessionId: labBId,
  title: "Synthetic lab B — running panel with an unsettled turn",
  ideaSummary: "A disposable idea used to prove an unsettled turn stays visible while the run is open.",
  targetCustomer: "Contributors validating the Idea Lab journey",
  maxRounds: 1,
  maxDurationSeconds: 300,
  maxCostUsd: 5,
  participants: labBParticipants,
  contributions: [
    contribution(labBId, labBParticipants[0].participantId, 1, 1, "Synthetic opinion round 1 from the skeptic.", "injected_only"),
  ],
  run: {
    runId: `${labBId}:run1`,
    state: "running",
    messagesUsed: 1,
    costUsd: 0,
    providerContacted: false,
    cancellationRequestedAt: null,
    attempts: [
      { participantId: labBParticipants[0].participantId, round: 1, state: "completed" },
      { participantId: labBParticipants[1].participantId, round: 1, state: "provider_marked" },
    ],
  },
  synthesis: null,
  canSynthesize: false,
  canStart: false,
  canStop: true,
  canDecide: false,
  canPromote: false,
};

export const digests = { sessionDigest: DIGEST_A, synthesisDigest: DIGEST_B };

// Lab C: 3 participants x 2 rounds. Five turns settled, the sixth failed
// definitely — the panel shows the failure and the missing contribution, and
// offers no synthesis or decision. A genuine partial-failure state: the gap
// stays visible instead of unlocking a decision on incomplete evidence.
const labCId = "idea:lab:partial-failure";
const labCParticipants = [
  participant(labCId, 1, "Gail Skeptic", "skeptic"),
  participant(labCId, 2, "Hugo Hacker", "hacker"),
  participant(labCId, 3, "Ivy Investor", "investor"),
];

const labC: LabConfig = {
  sessionId: labCId,
  title: "Synthetic lab C — failed turn stays visible, no decision offered",
  ideaSummary: "A disposable idea used to prove a failed turn blocks synthesis and decision instead of hiding.",
  targetCustomer: "Contributors validating the Idea Lab journey",
  maxRounds: 2,
  maxDurationSeconds: 300,
  maxCostUsd: 5,
  participants: labCParticipants,
  contributions: [
    contribution(labCId, labCParticipants[0].participantId, 1, 1, "Synthetic opinion round 1 from the skeptic.", "injected_only"),
    contribution(labCId, labCParticipants[1].participantId, 1, 2, "Synthetic opinion round 1 from the hacker.", "injected_only"),
    contribution(labCId, labCParticipants[2].participantId, 1, 3, "Synthetic opinion round 1 from the investor.", "injected_only"),
    contribution(labCId, labCParticipants[0].participantId, 2, 4, "Synthetic opinion round 2 from the skeptic.", "injected_only"),
    contribution(labCId, labCParticipants[1].participantId, 2, 5, "Synthetic opinion round 2 from the hacker.", "injected_only"),
  ],
  run: {
    runId: `${labCId}:run1`,
    state: "failed_definite",
    messagesUsed: 5,
    costUsd: 0,
    providerContacted: false,
    cancellationRequestedAt: null,
    attempts: [
      { participantId: labCParticipants[0].participantId, round: 1, state: "completed" },
      { participantId: labCParticipants[1].participantId, round: 1, state: "completed" },
      { participantId: labCParticipants[2].participantId, round: 1, state: "completed" },
      { participantId: labCParticipants[0].participantId, round: 2, state: "completed" },
      { participantId: labCParticipants[1].participantId, round: 2, state: "completed" },
      { participantId: labCParticipants[2].participantId, round: 2, state: "failed_definite" },
    ],
  },
  synthesis: null,
  canSynthesize: false,
  canStart: false,
  canStop: false,
  canDecide: false,
  canPromote: false,
};

export const labs: Record<string, LabConfig> = { [labAId]: labA, [labBId]: labB, [labCId]: labC };
