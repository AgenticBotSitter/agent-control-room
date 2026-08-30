import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadyFrontierPortfolioView, ReadyFrontierProjectView } from "../app/components/ready-frontier-view.tsx";
import { buildReadyFrontierCycleProjectionFixtureV1 } from "../src/ready-frontier/v1/index.ts";

test("CR11B-AUTO-010 portfolio view explains cross-project proposals without controls", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  const html = renderToStaticMarkup(<ReadyFrontierPortfolioView data={{ state: "available", projection }} />);
  assert.match(html, /What|Authenticated proposal frontier|Highest-ranked proposal/);
  assert.match(html, /Document the Unreal setup/); assert.match(html, /Research a verified AI release/);
  assert.match(html, /Draft a source-backed article/); assert.match(html, /Proposal only/);
  assert.match(html, /cannot create, approve, ready, claim, lease, dispatch, or execute work/);
  assert.doesNotMatch(html, /<button|<form|<input|<select|<textarea/);
});

test("CR11B-AUTO-010 Project Workspace renders proposed, blocked, review, deferred, and suppression truth", () => {
  const projection = buildReadyFrontierCycleProjectionFixtureV1();
  const html = renderToStaticMarkup(<ReadyFrontierProjectView data={{ state: "available", projection }}
    projectId="project.blooms.content-ops" />);
  assert.match(html, /Ready frontier/); assert.match(html, /Proposed/); assert.match(html, /Blocked/);
  assert.match(html, /Needs review/); assert.match(html, /Deferred/); assert.match(html, /Draft a source-backed article/);
  assert.match(html, /Waiting for review evidence/); assert.match(html, /Owner review has not been requested/);
  assert.doesNotMatch(html, /candidate\.content|intentDigest|evidenceDigest|<button|<form/);
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
