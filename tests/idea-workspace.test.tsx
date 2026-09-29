import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { IdeaDiscussion } from "../private-app/app/idea-workspace";
import { ideaDetailSchema, type IdeaDetail } from "../src/web/v1/idea-wire";

const digest = `sha256:${"a".repeat(64)}`;
const participants = [
  { participantId: "agent:builder", displayName: "Builder", perspective: "operator" },
  { participantId: "agent:skeptic", displayName: "Skeptic", perspective: "skeptic" },
  { participantId: "agent:customer", displayName: "Customer", perspective: "customer" },
];

const failedDetail: IdeaDetail = {
  session: { sessionId: "idea:attention", sessionDigest: digest, title: "A bounded idea", ideaSummary: "Test the smallest useful offer.",
    targetCustomer: "Small teams", createdAt: "2026-09-29T12:00:00.000Z", participants, maxRounds: 2,
    maxDurationSeconds: 60, maxCostUsd: 3 },
  contributions: [{ contributionId: "contribution:builder", sessionId: "idea:attention", sessionDigest: digest,
    participantId: "agent:builder", round: 1, safeOpinion: "Start with one customer interview.",
    suggestedExperiment: "Interview one customer.", confidencePercent: 60, sourceMode: "provider_filtered",
    evidenceState: "none", providerContacted: true, liveBotContactAuthorized: true }],
  synthesis: null,
  run: { runId: "idea-run:attention", sessionId: "idea:attention", sessionDigest: digest, state: "failed_definite",
    messagesUsed: 1, maxMessages: 6, costUsd: 0.25, providerContacted: true, updatedAt: "2026-09-29T12:01:00.000Z",
    cancellationRequestedAt: null, retryPermitted: false,
    attempts: [{ participantId: "agent:builder", round: 1, state: "completed" }] },
  decision: null,
  promotionTask: null,
  canonicalTasks: null,
  canSynthesize: false,
  canStart: false,
  canStop: false,
  canDecide: false,
  canPromote: false,
  canProjectResults: false,
  nextCanonicalRound: null,
  canPrepareNextRound: false,
  execution: "authorization_required",
  observedAt: "2026-09-29T12:02:00.000Z",
};

test("Idea Lab puts limits and missing-participant honesty before the discussion recap", () => {
  const detail = ideaDetailSchema.parse(failedDetail);
  const html = renderToStaticMarkup(createElement(IdeaDiscussion, { detail }));
  const document = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  const text = document.body.textContent ?? "";
  assert.ok(text.indexOf("Discussion limits") < text.indexOf("Contribution coverage"));
  assert.ok(text.indexOf("Contribution coverage") < text.indexOf("Discussion recap"));
  assert.match(text, /3 selected participants · 2 round maximum · 6 contribution maximum/);
  assert.match(text, /5 contributions are missing or not yet reviewed/);
  assert.match(text, /Round 1: Skeptic \(skeptic\)/);
  assert.match(text, /Round 2: Builder \(operator\)/);
  assert.match(text, /ended as failed definite.*Missing contributions remain missing/u);
  assert.match(text, /Recorded provider cost: \$0\.25\. Token usage is not recorded in this view/);
  assert.equal(document.querySelector('[aria-label="Discussion limits"]')?.tagName, "SECTION");
  assert.equal(document.querySelector('[aria-label="Contribution coverage"] [role="alert"]')?.tagName, "P");
});

test("a promoted idea links the proposed task without claiming that work started", () => {
  const detail = ideaDetailSchema.parse({ ...failedDetail, run: null,
    synthesis: { sessionId: "idea:attention", sessionDigest: digest, synthesisDigest: digest,
      executiveSummary: "Demand is plausible, but the evidence is incomplete.", nextExperiment: "Interview one customer.", overallScore: 62 },
    decision: { sessionId: "idea:attention", sessionDigest: digest, synthesisDigest: digest,
      decision: "create_project", project: { projectId: "project:promoted" } },
    promotionTask: { projectId: "project:promoted", jobId: "job:first-proposal", requestId: "request:first-proposal", startsWork: false },
  });
  const document = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(IdeaDiscussion, { detail }))}</body>`).window.document;
  const link = [...document.querySelectorAll("a")].find(item => item.textContent === "Review proposed task");
  assert.equal(link?.getAttribute("href"), "/projects/project%3Apromoted/tasks/job%3Afirst-proposal");
  assert.match(document.body.textContent ?? "", /First task proposed\. It is not assigned, approved or running/);
  assert.match(document.body.textContent ?? "", /Aggregate usage and cost for ordinary tasks are unknown here/);
  assert.equal(document.querySelector('button[type="button"]'), null);
});
