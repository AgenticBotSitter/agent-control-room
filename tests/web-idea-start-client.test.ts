import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIdeaStartClient } from "../src/web/v1/idea-start-client";
import { ideaDetailSchema } from "../src/web/v1/idea-wire";
import { WebIdeaService } from "../src/web/v1/idea-service";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { IdeaDiscussion } from "../private-app/app/idea-workspace";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { sha256Digest } from "../src/security";

const sessionId = "idea:client-start", sessionDigest = sha256Digest("start-client");
const receipt = { sessionId, sessionDigest, runId: `idea-run:${sessionDigest.slice(7, 31)}`, state: "running",
  replayed: false, providerContacted: true, retryPermitted: false };

test("start client binds exact request and receipt, never retries a lost or wrong response", async () => {
  let calls = 0;
  const client = createIdeaStartClient(async (url, options) => {
    calls++; assert.equal(String(url), `/api/v1/ideas/${encodeURIComponent(sessionId)}/start`);
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(options?.body)), { sessionDigest }); return Response.json(receipt);
  });
  assert.deepEqual(await client.start(sessionId, { sessionDigest }), receipt); assert.equal(calls, 1);
  for (const result of [null, { ...receipt, sessionDigest: sha256Digest("other") }, { ...receipt, runId: "idea-run:other" },
    { ...receipt, retryPermitted: true }]) {
    let attempts = 0; const failed = createIdeaStartClient(async () => { attempts++; if (!result) throw new Error("lost"); return Response.json(result); });
    await assert.rejects(failed.start(sessionId, { sessionDigest }), /uncertain/); assert.equal(attempts, 1);
  }
});

test("start client refuses overlapping calls and injected admission fields", async () => {
  let release!: () => void, calls = 0; const waiting = new Promise<void>(resolve => { release = resolve; });
  const client = createIdeaStartClient(async () => { calls++; await waiting; return Response.json(receipt); });
  await assert.rejects(client.start(sessionId, { sessionDigest, admission: {} }), /invalid_request/);
  const first = client.start(sessionId, { sessionDigest });
  await assert.rejects(client.start(sessionId, { sessionDigest }), /uncertain/); assert.equal(calls, 1);
  release(); await first;
});

test("Start visibility requires configuration, untouched Idea and current owner grant", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(74);
  const saved = await new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now)
    .create(f.identity, { title: "Visible start", ideaSummary: "Help shops", targetCustomer: "Owners", maxRounds: 2,
      maxDurationSeconds: 300, maxCostUsd: 2 }, "start-visible-0001");
  const configured = new WebIdeaService(f.client, scope, key, () => now, true, true, true, true);
  const readOnly = new WebIdeaService(f.client, scope, key, () => now);
  assert.equal((await readOnly.detail(f.identity, saved.sessionId)).canStart, false);
  assert.equal((await configured.list(f.identity)).execution, "authorization_required");
  const detail = ideaDetailSchema.parse(await configured.detail(f.identity, saved.sessionId));
  assert.equal(detail.canStart, true);
  const html = renderToStaticMarkup(createElement(IdeaDiscussion, { detail }));
  for (const label of ["Start discussion", "300", "2.00", "Current bot authorization"]) assert.ok(html.includes(label));
  assert.ok(!html.includes("Starting live panels is not connected"));
  assert.equal(ideaDetailSchema.safeParse({ ...detail, execution: "not_configured" }).success, false);
  // Retain read permission but remove start, without requiring logout.
  await f.client.query("UPDATE control_role_grants SET allowed_actions='[\"idea_lab.session_read\"]'::jsonb");
  assert.equal((await configured.detail(f.identity, saved.sessionId)).canStart, false);
});
