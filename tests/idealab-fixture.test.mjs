// Node-side smoke test for the Idea Lab browser fixture. Exercises the
// response builders from response-builders.ts and Zod-parses each output
// against the wire schemas in src/web/v1/idea-wire.ts. This test is the
// empirical guard for the fixture's contract with PrivateIdeaWorkspace:
// revert any enum or shape in response-builders.ts and at least one subtest
// must fail.

import test from "node:test";
import assert from "node:assert/strict";

import { labs } from "./browser/idealab/fixture-data.ts";
import { buildIdeaLabResponses } from "./browser/idealab/response-builders.ts";
import { ideaPageSchema, ideaDetailSchema } from "../src/web/v1/idea-wire.ts";

const NOW = new Date().toISOString();
const SESSION_IDS = Object.keys(labs);

test("idealab-fixture: page parses and lists both labs newest-first", () => {
  const builder = buildIdeaLabResponses(SESSION_IDS[0], NOW);
  const page = ideaPageSchema.parse(builder.buildIdeaPage());
  assert.equal(page.sessions.length, 2);
  assert.equal(page.nextCursor, null);
  assert.ok(page.sessions[0].sessionId >= page.sessions[1].sessionId);
  assert.deepEqual(
    page.sessions.map(s => s.sessionId).sort(),
    [...SESSION_IDS].sort(),
  );
});

for (const sessionId of SESSION_IDS) {
  test(`idealab-fixture: ${sessionId} detail parses against ideaDetailSchema`, () => {
    const builder = buildIdeaLabResponses(sessionId, NOW);
    const detail = ideaDetailSchema.parse(builder.buildIdeaDetail());
    assert.equal(detail.session.sessionId, sessionId);
  });
}

test("idealab-fixture: detail URLs are distinct per lab", () => {
  const urls = SESSION_IDS.map(id => buildIdeaLabResponses(id, NOW).urls.detailUrl);
  assert.equal(new Set(urls).size, SESSION_IDS.length);
});

test("idealab-fixture: completed lab keeps its partial-participant gap visible", () => {
  const builder = buildIdeaLabResponses("idea:lab:completed-synthesis", NOW);
  const detail = ideaDetailSchema.parse(builder.buildIdeaDetail());
  const completedAttempts = detail.run.attempts.filter(a => a.state === "completed").length;
  assert.equal(detail.run.state, "completed");
  assert.equal(detail.run.messagesUsed, completedAttempts);
  assert.ok(detail.contributions.length < completedAttempts);
  assert.ok(detail.synthesis !== null);
  assert.equal(detail.canDecide, true);
});

test("idealab-fixture: running lab shows its unsettled turn", () => {
  const builder = buildIdeaLabResponses("idea:lab:running-gap", NOW);
  const detail = ideaDetailSchema.parse(builder.buildIdeaDetail());
  assert.equal(detail.run.state, "running");
  assert.ok(detail.run.attempts.some(a => a.state === "provider_marked"));
  assert.equal(detail.synthesis, null);
  assert.equal(detail.canStop, true);
});

test("idealab-fixture: unknown session id throws instead of emitting wire", () => {
  assert.throws(() => buildIdeaLabResponses("idea:lab:does-not-exist", NOW));
});
