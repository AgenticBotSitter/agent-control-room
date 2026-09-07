import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { now, request } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { WebIdeaService } from "../src/web/v1/idea-service";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" }, key = new Uint8Array(32).fill(41);
const participants = buildIdeaLabFixtureV1().session.participants;
const draft = { title: "A business idea", ideaSummary: "Help small shops answer customer questions.", targetCustomer: "Independent retailers",
  maxRounds: 2, maxDurationSeconds: 300, maxCostUsd: 2 };

test("owner saves an audited Idea session, reopens it and replays without starting a panel", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const service = new IdeaSessionCreationService(f.client, scope, key, participants, () => now);
  const first = await service.create(f.identity, draft, "idea-create-000001");
  assert.equal(first.startsWork, false); assert.equal(first.execution, "not_requested"); assert.equal(first.replayed, false);
  const later = new IdeaSessionCreationService(f.client, scope, key, participants, () => now + 1000);
  const replay = await later.create(f.identity, draft, "idea-create-000001");
  assert.equal(replay.replayed, true); assert.equal(replay.sessionDigest, first.sessionDigest);
  const saved = await new WebIdeaService(f.client, scope, key, () => now).detail(f.identity, first.sessionId);
  assert.equal(saved.session.ideaSummary, draft.ideaSummary); assert.equal(saved.contributions.length, 0);
  assert.equal(saved.decision, null);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.session_create'")).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM control_idea_sessions")).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM control_outbox")).rows.length, 0);
  await assert.rejects(service.create(f.identity, { ...draft, title: "Changed" }, "idea-create-000001"), /conflict/);
});

test("bad scope, oversized briefs and non-owner creation cannot persist a session", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const service = new IdeaSessionCreationService(f.client, scope, key, participants, () => now);
  await assert.rejects(service.create(f.identity, { ...draft, tenantId: "tenant:other" }, "idea-create-000002"), /invalid_request/);
  await assert.rejects(service.create(f.identity, { ...draft, ideaSummary: "x".repeat(1000) }, "idea-create-000002"), /invalid_request/);
  await f.client.query("UPDATE control_role_grants SET role_key='operator'");
  await assert.rejects(service.create(f.identity, draft, "idea-create-000002"), /access_denied/);
  assert.equal((await f.client.query("SELECT * FROM control_idea_sessions")).rows.length, 0);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.session_create'")).rows.length, 0);
});

test("private create endpoint saves through the supplied operation and rechecks logout", async t => {
  const f = await taskFixture();
  const service = new IdeaSessionCreationService(f.client, scope, key, participants, () => now);
  const app = createPrivateWebProcess({ ...startupConfig, ideaProjects: { integrityKey: key },
    database: { client: f.client, close: () => f.db.close() }, clock: () => now,
    ideaCreation: { ...scope, create: service.create.bind(service) } });
  t.after(() => app.close());
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const first = await handle(request("/api/v1/ideas", "POST", draft, "idea-http-00001"));
  assert.equal(first.status, 201); const receipt = await first.json();
  const replay = await handle(request("/api/v1/ideas", "POST", draft, "idea-http-00001"));
  assert.equal(replay.status, 200); assert.equal((await replay.json()).sessionId, receipt.sessionId);
  assert.equal((await handle(request(`/api/v1/ideas/${receipt.sessionId}`))).status, 200);
  const foreign = request("/api/v1/ideas", "POST", draft, "idea-http-00002"); foreign.headers.set("origin", "https://other.example");
  assert.equal((await handle(foreign)).status, 403);
  await handle(request("/api/v1/session/logout", "POST"));
  assert.equal((await handle(request("/api/v1/ideas", "POST", draft, "idea-http-00002"))).status, 401);
  assert.equal((await f.client.query("SELECT * FROM control_idea_sessions")).rows.length, 1);
});
