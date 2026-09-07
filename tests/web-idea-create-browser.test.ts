import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taskFixture } from "./helpers/web-task";
import { now, request } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { createIdeaCreationClient } from "../src/web/v1/idea-create-client";
import { IdeaCreateForm } from "../private-app/app/idea-create-form";

const draft = { title: "Shop assistant", ideaSummary: "Help shops answer questions.", targetCustomer: "Small retailers",
  maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 };
test("lost Idea save response retains the exact command and recovers one persisted session", async t => {
  const f = await taskFixture(), scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(55);
  const creation = new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now);
  const app = createPrivateWebProcess({ ...startupConfig, ideaProjects: { integrityKey: key },
    ideaCreation: { ...scope, create: creation.create.bind(creation) }, database: { client: f.client, close: () => f.db.close() }, clock: () => now });
  t.after(() => app.close()); let calls = 0; const keys: string[] = [];
  const client = createIdeaCreationClient(async (url, options) => {
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "same-origin");
    const k = new Headers(options?.headers).get("idempotency-key")!; keys.push(k);
    const result = await app.handle(request(String(url), "POST", JSON.parse(String(options?.body)), k), () => new Response());
    if (++calls === 1) throw new Error("lost response"); return result;
  }, () => "idea-browser-00001");
  const catalog = await (await app.handle(request("/api/v1/ideas"), () => new Response())).json(); assert.equal(catalog.canCreate, true);
  await assert.rejects(client.create(draft), /uncertain/); assert.equal(client.hasPending(), true);
  await assert.rejects(client.create({ ...draft, title: "Other" }), /uncertain/); assert.equal(calls, 1);
  const receipt = await client.retry(); assert.equal(receipt.replayed, true); assert.equal(client.hasPending(), false);
  assert.deepEqual(keys, ["idea-browser-00001", "idea-browser-00001"]);
  assert.equal((await f.client.query("SELECT * FROM control_idea_sessions")).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM control_outbox")).rows.length, 0);
});

test("denial after uncertainty and mismatched receipts never release the exact save", async () => {
  let calls = 0;
  const client = createIdeaCreationClient(async () => {
    calls++; return calls === 1 ? Response.json({}, { status: 503 }) : Response.json({}, { status: 403 });
  });
  await assert.rejects(client.create(draft), /uncertain/);
  await assert.rejects(client.retry(), /access_denied/); assert.equal(client.hasPending(), true);
  await assert.rejects(client.create({ ...draft, title: "Different" }), /uncertain/); assert.equal(calls, 2);
  const bad = createIdeaCreationClient(async () => Response.json({ sessionId: "idea:wrong", sessionDigest: `sha256:${"0".repeat(64)}`,
    createdAt: new Date(now).toISOString(), replayed: false, startsWork: false, execution: "not_requested", idempotencyKey: "other-key-0000" }));
  await assert.rejects(bad.create(draft), /uncertain/); assert.equal(bad.hasPending(), true);
});

test("new Idea form uses explicit field labels and does not imply a panel will start", () => {
  const html = renderToStaticMarkup(createElement(IdeaCreateForm, { close: () => {} }));
  for (const label of ["What is the idea?", "Who is it for?", "Maximum rounds", "Time limit in seconds", "Cost limit in USD", "Save idea"])
    assert.ok(html.includes(label));
  assert.ok(html.includes("does not contact bots or approve work")); assert.ok(!html.includes("Start panel"));
});
