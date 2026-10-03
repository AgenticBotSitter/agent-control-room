import assert from "node:assert/strict";
import test from "node:test";
import { createElement, act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { IdeaDecisionForm } from "../private-app/app/idea-decision-form";
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
  canFinishRound: false,
  unfinishedRound: null,
  preparationExpired: false,
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

test("M3-IDEA-01: a partial promotion keeps the exact retry and locks the owner choice", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://qa.invalid/" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const before = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let committed = false;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => { committed = true; return new Response(null, { status: 403 }); } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const detail: IdeaDetail = { ...failedDetail,
    synthesis: { sessionId: failedDetail.session.sessionId, sessionDigest: digest, synthesisDigest: digest,
      nextExperiment: "Review evidence.", executiveSummary: "Review evidence before work.", overallScore: 50 },
    canPromote: true, canDecide: true };
  try {
    await act(async () => { root.render(createElement(IdeaDecisionForm, { detail })); });
    const select = dom.window.document.querySelector("select")!;
    await act(async () => { select.value = "create_project";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await act(async () => { dom.window.document.querySelector("form")!.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(committed, true);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /The decision may have been saved/);
    assert.equal(dom.window.document.querySelector("fieldset")!.disabled, true);
    assert.equal(dom.window.document.querySelector('button[type="submit"]')!.textContent, "Check this exact decision again");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("M3-IDEA-01: promotion refusals retain the exact body across status codes and concurrent retries", async () => {
  const { createIdeaDecisionClient } = await import("../src/web/v1/idea-decision-client");
  const promotion = { sessionDigest: digest, synthesisDigest: digest, intent: { decision: "create_project",
    safeReasonCode: "owner_selected", project: { projectId: "project:idea", title: "Idea", workspaceName: "Idea",
      summary: "Read evidence.", projectKind: "business_validation", priority: 50 } },
    promotionTask: { title: "Check evidence", instructions: "Read evidence." } };
  for (const status of [400, 401, 403, 404, 409]) {
    const sent: string[] = [];
    const client = createIdeaDecisionClient(async (_url, init) => {
      sent.push(String(init?.body));
      return sent.length === 1 ? new Response(null, { status }) : Response.json({ sessionId: "idea:retry",
        sessionDigest: digest, synthesisDigest: digest, decisionDigest: digest, decision: "create_project", projectId: "project:idea",
        firstTask: { receipt: { jobId: "job:first", projectId: "project:idea", requestId: "request:first",
          createdAt: "2026-10-01T00:00:00.000Z", submission: "proposed", startsWork: false }, replayed: true },
        replayed: true, startsWork: false });
    });
    await assert.rejects(client.decide("idea:retry", promotion));
    assert.equal(client.hasPending(), true);
    await assert.rejects(client.decide("idea:retry", { sessionDigest: digest, synthesisDigest: digest,
      intent: { decision: "reject", safeReasonCode: "owner_selected" } }), /uncertain/);
    const retries = await Promise.allSettled(Array.from({ length: 50 }, () => client.retry()));
    assert.equal(retries.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(client.hasPending(), false);
    assert.equal(sent.length, 2);
    assert.equal(sent[0], sent[1]);
  }
});

const partialRoundDetail: IdeaDetail = {
  ...failedDetail, run: null, contributions: [],
  canonicalTasks: { projectId: "project:partial", taskCount: 1, preparedRounds: [1],
    tasks: [{ taskKey: "idea-task:partial", participantId: "agent:builder", round: 1, contributionRecorded: false }] },
  canFinishRound: true,
  unfinishedRound: 1,
};

test("an unfinished round offers one action that finishes it, and says what was not saved", () => {
  const detail = ideaDetailSchema.parse(partialRoundDetail);
  const document = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(IdeaDiscussion, { detail }))}</body>`).window.document;
  const text = document.body.textContent ?? "";
  assert.match(text, /Round 1 is unfinished/);
  assert.match(text, /Only 1 of 3 tasks for this round were saved\. Nothing was started\./);
  // Exactly one action, and it is the finish control. A "next round" control
  // must not also appear: this is not round two.
  const section = document.querySelector('[aria-label="Unfinished round"]');
  assert.equal(section?.getAttribute("aria-label"), "Unfinished round");
  assert.equal(document.querySelector('[aria-label="Next discussion round"]'), null);
  assert.equal(document.querySelectorAll('button[type="button"]').length, 1);
  // The status is announced, not buried in a details toggle.
  assert.equal(section?.querySelector('[role="alert"]')?.tagName, "P");
});

test("a finished round offers no resume action", () => {
  const detail = ideaDetailSchema.parse({ ...partialRoundDetail,
    canonicalTasks: { projectId: "project:partial", taskCount: 3, preparedRounds: [1], tasks: participants.map(
      participant => ({ taskKey: `idea-task:${participant.participantId}`, participantId: participant.participantId,
        round: 1, contributionRecorded: false })) },
    canFinishRound: false, unfinishedRound: null });
  const document = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(IdeaDiscussion, { detail }))}</body>`).window.document;
  assert.equal(document.querySelector('[aria-label="Unfinished round"]'), null);
  assert.equal(document.querySelectorAll('button[type="button"]').length, 0);
});

test("the resume action is refused by the wire when no round is actually unfinished", () => {
  // canFinishRound with no unfinished round would be a control the server
  // refuses, which is exactly the strand this feature exists to remove.
  assert.equal(ideaDetailSchema.safeParse({ ...partialRoundDetail, canFinishRound: true, unfinishedRound: null }).success, false);
  assert.equal(ideaDetailSchema.safeParse({ ...partialRoundDetail, canFinishRound: false, unfinishedRound: 1 }).success, false);
  // Offering both a resume and a next-round action is refused: one obvious action.
  assert.equal(ideaDetailSchema.safeParse({ ...partialRoundDetail, canPrepareNextRound: true,
    nextCanonicalRound: 2 }).success, false);
  // A partial round with no resumable state at all is not representable.
  assert.equal(ideaDetailSchema.safeParse({ ...partialRoundDetail,
    canonicalTasks: { ...partialRoundDetail.canonicalTasks!, taskCount: 3, tasks: participants.map(
      participant => ({ taskKey: `idea-task:${participant.participantId}`, participantId: participant.participantId,
        round: 1, contributionRecorded: false })) },
    canFinishRound: false, unfinishedRound: 1 }).success, false);
});


test("an elapsed window offers no preparation, and says why", () => {
  // The wire refuses ANY action while the window has closed. A visible control
  // whose POST the operation would refuse is the whole M3-IDEA-U03 defect.
  const expired = { ...partialRoundDetail, canFinishRound: true, preparationExpired: true };
  assert.equal(ideaDetailSchema.safeParse(expired).success, false,
    "an action offered after the window closed must not be representable");
  assert.equal(ideaDetailSchema.safeParse({ ...expired, canFinishRound: false }).success, true,
    "an unfinished round with no action is representable, so the owner can see it");

  // And the rendered page says the window closed rather than showing nothing.
  const detail = ideaDetailSchema.parse({ ...expired, canFinishRound: false });
  const document = new JSDOM(`<!doctype html><body>${renderToStaticMarkup(createElement(IdeaDiscussion, { detail }))}</body>`).window.document;
  assert.match(document.body.textContent ?? "", /The preparation window has closed, so this round cannot be finished/);
  assert.equal(document.querySelectorAll('button[type="button"]').length, 0);
});

test("R6S: unknown bills and unconfirmed stops remain explicit in the owner view", { timeout: 2000 }, () => {
  const detail = ideaDetailSchema.parse({ ...failedDetail,
    run: { ...failedDetail.run, state: "ambiguous", safeCode: "stop_unconfirmed", costUsd: null } });
  const html = renderToStaticMarkup(createElement(IdeaDiscussion, { detail }));
  assert.match(html, /Provider cost is unknown/);
  assert.match(html, /Reported cost: unknown/);
  assert.match(html, /Stop unconfirmed: the gateway has not proved that the provider call ended/);
  assert.doesNotMatch(html, /Reported cost: \$0\.00/);
});
