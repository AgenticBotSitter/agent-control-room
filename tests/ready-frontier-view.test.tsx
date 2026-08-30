import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadyFrontierPortfolioView, ReadyFrontierProjectView } from "../app/components/ready-frontier-view.tsx";
import { buildReadyFrontierAutomationProjectionFixtureV1, buildReadyFrontierCycleProjectionFixtureV1,
  buildReadyFrontierNoRelayProjectionFixtureV1,
  buildReadyFrontierPromotionProjectionFixtureV1 } from "../src/ready-frontier/v1/index.ts";

test("CR11B-AUTO-010 portfolio view explains cross-project proposals without controls", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  const html = renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "available", projection }} />);
  assert.match(html, /What|Authenticated proposal frontier|Highest-ranked proposal/);
  assert.match(html, /Document the Unreal setup/); assert.match(html, /Research a verified AI release/);
  assert.match(html, /Draft a source-backed article/); assert.match(html, /Proposal only/);
  assert.match(html, /internal handoff cannot claim, lease, message, dispatch, or execute work/);
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea/);
});

test("CR11B-AUTO-010 Project Workspace renders proposed, blocked, review, deferred, and suppression truth", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  const html = renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "available", projection }}
    projectId="project.blooms.content-ops" />);
  assert.match(html, /Ready frontier/); assert.match(html, /Proposed/); assert.match(html, /Blocked/);
  assert.match(html, /Needs review/); assert.match(html, /Deferred/); assert.match(html, /Draft a source-backed article/);
  assert.match(html, /Waiting for review evidence/); assert.match(html, /Standing policy state unavailable/);
  assert.doesNotMatch(html, /candidate\.content|intentDigest|evidenceDigest|<button|<form/);
});

test("CR11B-AUTO-020 views show honest repository policy and pending materialization truth without controls", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1(), automation = buildReadyFrontierAutomationProjectionFixtureV1();
  const portfolio = renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "available", projection }} automation={automation} />);
  assert.match(portfolio, /Repository simulation active/); assert.match(portfolio, /Production policy/);
  assert.match(portfolio, /Not enrolled/); assert.match(portfolio, /Ready handoff not requested/);
  const project = renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "available", projection }} automation={automation}
    projectId="project.blooms.content-ops" />);
  assert.match(project, /Eligible in repository simulation/); assert.match(project, /materialization not requested/);
  assert.match(project, /no production policy is enrolled/i);
  assert.doesNotMatch(`${portfolio}${project}`, /<button|<form|<input|<select|<textarea/);
});

test("CR11B-AUTO-030 views show ready-policy truth and no internal-handoff controls", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  const automation = buildReadyFrontierAutomationProjectionFixtureV1();
  const promotion = buildReadyFrontierPromotionProjectionFixtureV1();
  const portfolio = renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "available", projection }}
    automation={automation} promotion={promotion} />);
  assert.match(portfolio, /Ready policy/); assert.match(portfolio, /Ready handoff not requested/);
  assert.match(portfolio, /internal handoff cannot claim, lease, message, dispatch, or execute work/);
  const project = renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "available", projection }}
    automation={automation} promotion={promotion} projectId="project.blooms.content-ops" />);
  assert.match(project, /repository ready-policy fixture is active/); assert.match(project, /no ready handoff was requested/);
  assert.doesNotMatch(`${portfolio}${project}`, /<button|<form|<input|<select|<textarea/);
});

test("CR11B-AUTO-040 views show honest no-relay and blocked-activation truth without controls", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  const automation = buildReadyFrontierAutomationProjectionFixtureV1();
  const promotion = buildReadyFrontierPromotionProjectionFixtureV1();
  const noRelay = buildReadyFrontierNoRelayProjectionFixtureV1();
  const portfolio = renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "available", projection }}
    automation={automation} promotion={promotion} noRelay={noRelay} />);
  assert.match(portfolio, /No-relay simulation/); assert.match(portfolio, /Not Run/);
  assert.match(portfolio, /Blocked · no simulation evidence/); assert.match(portfolio, /cannot activate production/);
  const project = renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "available", projection }}
    automation={automation} promotion={promotion} noRelay={noRelay} projectId="project.blooms.content-ops" />);
  assert.match(project, /Project fake acknowledgements/); assert.match(project, /production activation remains blocked/i);
  assert.doesNotMatch(`${portfolio}${project}`, /<button|<form|<input|<select|<textarea/);
});

test("CR11B-AUTO-010 frontier views fail honestly for empty, unavailable, stale, and out-of-scope state", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  assert.match(renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "empty" }} />), /No authenticated proposal cycle/);
  assert.match(renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "unavailable", safeCode: "integrity_failed" }} />),
    /failed its integrity check/);
  assert.match(renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "unavailable", safeCode: "source_stale" }}
    projectId="project.blooms.content-ops" />), /source observations are stale/);
  assert.match(renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "available", projection }}
    projectId="project.foreign" />), /not present in the authenticated proposal cycle/);
});
