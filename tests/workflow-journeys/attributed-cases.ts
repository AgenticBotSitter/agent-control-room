/**
 * Attributed synthetic cases for the issue #208 workflow journeys.
 *
 * These are newly authored cases for this packet — not the retired donor cases
 * and not a copy of any retired driver. Every case carries its own attribution:
 * the publishing surface it was observed on, the observation time, and the
 * public product surface it exercises. No case carries provider, credential,
 * live-feed, publication or installation authority.
 */

export interface JourneyOutcomeV1 {
  journey: string;
  steps: { step: string; detail: string }[];
  findings: string[];
}

/** Source attribution shared by one or more attributed article cases. */
export interface AttributedSourceV1 {
  label: string;
  canonicalUrl: string;
  sourceId: string;
  observedAt: string;
}

export interface AttributedArticleCaseV1 {
  caseId: string;
  /** Product-facing article action, as enumerated by src/web/v1/news-wire.ts. */
  actionId: "research_brief" | "setup_guide" | "product_comparison" | "news_article_draft";
  /** Acceptable deliverable kinds for this action, read from the news action catalog. */
  deliverableKinds: string[];
  goal: string;
  /** Attributed source story. `review_only` stories may only request `research_brief`. */
  source: AttributedSourceV1;
  storyTitle: string;
  storySummary: string;
  verificationState: "verified" | "review_only";
  /** Longer than the 120-character task-title bound when true. */
  titleExceedsTaskBound: boolean;
  evidenceDigest: string;
}

const digest = (label: string): string => `sha256:${label.repeat(64).slice(0, 64)}`;

export const ATTRIBUTED_IDEA_PANEL_V1 = {
  caseId: "case:idea-panel:attributed-v1",
  attribution: {
    observedOn: "Control Room private product shell (/ideas), issue #208 packet",
    authoredFor: "public issue #208 workflow integration",
    donorRelationship: "new case; the retired donor driver is not copied or reopened",
  },
  session: {
    sessionId: "idea-session:attributed-workflow-v1",
    title: "Predictive maintenance scheduling for small machine shops",
    ideaSummary: "A bounded panel weighs whether a scheduling assistant that watches machine telemetry can reduce unplanned downtime for owner-operated machine shops.",
    targetCustomer: "Owner-operators of 5-25 person machine shops running mixed-vintage CNC equipment.",
    maxRounds: 2,
    maxDurationSeconds: 600,
    maxCostUsd: 4,
    participants: [
      { participantId: "bot:buyer", displayName: "Buyer Lens", perspective: "customer", harness: "hermes", modelClass: "reasoning", platform: "windows" },
      { participantId: "bot:market", displayName: "Market Scout", perspective: "market", harness: "hermes", modelClass: "research", platform: "linux" },
      { participantId: "bot:red-team", displayName: "Red Team", perspective: "skeptic", harness: "codex", modelClass: "reasoning", platform: "macos" },
      { participantId: "bot:floor", displayName: "Floor Operator", perspective: "operations", harness: "local_model", modelClass: "planning", platform: "windows" },
    ] as const,
    /** Round-2 participant whose provider outcome is lost in the partial-failure journey. */
    interruptedParticipantId: "bot:red-team",
  },
} as const;

export const ATTRIBUTED_ARTICLE_CASES_V1: readonly AttributedArticleCaseV1[] = [
  {
    caseId: "case:article:research-brief-v1",
    actionId: "research_brief",
    deliverableKinds: ["report"],
    goal: "Check the claims in this article, separate measured results from vendor claims, and cite primary sources.",
    source: {
      label: "Shop Floor Systems Review",
      canonicalUrl: "https://shop-floor-review.example.invalid/2026/09/telemetry-adoption",
      sourceId: "source:attributed:shop-floor-review",
      observedAt: "2026-09-16T09:00:00.000Z",
    },
    storyTitle: "Telemetry adoption rises in mid-size machine shops",
    storySummary: "A vendor-sponsored survey reports that mid-size machine shops adopted telemetry on 62 percent of machines, but the sample and definitions are not published.",
    verificationState: "review_only",
    titleExceedsTaskBound: false,
    evidenceDigest: digest("b"),
  },
  {
    caseId: "case:article:setup-guide-v1",
    actionId: "setup_guide",
    deliverableKinds: ["setup_guide"],
    goal: "Write a setup guide for the documented retention configuration, including the steps the article omits.",
    source: {
      label: "Reliability Engineering Notes",
      canonicalUrl: "https://reliability-notes.example.invalid/2026/08/opcua-retention",
      sourceId: "source:attributed:reliability-notes",
      observedAt: "2026-09-16T09:05:00.000Z",
    },
    storyTitle: "Retention windows that survive a controller replacement",
    storySummary: "The article describes two retention configurations and documents the recovery behaviour of each after a controller swap.",
    verificationState: "verified",
    titleExceedsTaskBound: false,
    evidenceDigest: digest("c"),
  },
  {
    caseId: "case:article:product-comparison-v1",
    actionId: "product_comparison",
    deliverableKinds: ["comparison"],
    goal: "Compare the three condition-monitoring approaches the article names, on the criteria a shop owner can actually verify.",
    source: {
      label: "Maintenance Trade Weekly",
      canonicalUrl: "https://maintenance-weekly.example.invalid/2026/09/monitoring-approaches",
      sourceId: "source:attributed:maintenance-weekly",
      observedAt: "2026-09-16T09:10:00.000Z",
    },
    storyTitle: "Three condition-monitoring approaches compared: vibration, acoustic and current-signature monitoring across mixed-vintage CNC equipment, and what each method measures",
    storySummary: "A practical comparison of vibration, acoustic and current-signature monitoring with published cost ranges.",
    verificationState: "verified",
    titleExceedsTaskBound: true,
    evidenceDigest: digest("d"),
  },
  {
    caseId: "case:article:draft-v1",
    actionId: "news_article_draft",
    deliverableKinds: ["article_draft"],
    goal: "Draft an attributed article about the scheduling experiment, keeping every claim tied to a cited source.",
    source: {
      label: "Machine Shop Operations Journal",
      canonicalUrl: "https://shop-ops-journal.example.invalid/2026/07/unplanned-downtime",
      sourceId: "source:attributed:shop-ops-journal",
      observedAt: "2026-09-16T09:15:00.000Z",
    },
    storyTitle: "Unplanned downtime cost per hour, revisited with a published method",
    storySummary: "The journal republishes its downtime cost method with a worked example and the assumptions behind each input.",
    verificationState: "verified",
    titleExceedsTaskBound: false,
    evidenceDigest: digest("e"),
  },
] as const;