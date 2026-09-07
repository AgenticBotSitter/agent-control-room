import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { now, request } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createIdeaDecisionClient } from "../src/web/v1/idea-decision-client";
import { ideaDetailSchema } from "../src/web/v1/idea-wire";
import { IdeaDecisionForm } from "../private-app/app/idea-decision-form";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project";
import { WebIdeaDecisionOperation } from "../src/web/v1/idea-decision-operation";
import { WebSessionAuthority } from "../src/web/v1/session-authority";
import { WebTaskService } from "../src/web/v1/task-service";
import { IdeaLabBotRunStoreV1 } from "../src/idea-lab/v1/coordinator-store";
import { buildIdeaLabBotRunV1 } from "../src/idea-lab/v1/coordinator";
import { sha256Digest } from "../src/security";
import { taskDraft } from "./helpers/web-task";
import { buildIdeaLabSessionV1, buildIdeaLabContributionV1, buildIdeaLabSynthesisV1 } from "../src/idea-lab/v1/contracts";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const pick = (source: object, names: string) => Object.fromEntries(names.split(" ").map(k => [k, (source as Record<string, unknown>)[k]]));
async function fixture() {
  const f = await taskFixture(); const { store, decision } = await seedWebIdea(f.client);
  const source = (await store.getSession(scope.tenantId, decision.sessionId))!;
  const oldContributions = await store.listContributions(scope.tenantId, source.sessionId);
  const oldSynthesis = (await store.getSynthesis(scope.tenantId, source.sessionId))!;
  const session = buildIdeaLabSessionV1({ ...scope, sessionId: "idea:undecided", ...pick(source,
    "title ideaSummary targetCustomer participants maxRounds maxDurationSeconds maxCostUsd createdByIdentityDigest createdAt") });
  await store.registerSession(session);
  const contributions = oldContributions.map(c => buildIdeaLabContributionV1(session, pick(c,
    "participantId round safeOpinion opportunityCode primaryRiskCode suggestedExperiment confidencePercent contributedAt")));
  for (const c of contributions) await store.recordContribution(c);
  const synthesis = buildIdeaLabSynthesisV1(session, contributions, pick(oldSynthesis,
    "marketDemand feasibility differentiation durability ownerFit riskPercent executiveSummary nextExperiment dissentingPerspectiveCodes synthesizedAt"));
  await store.recordSynthesis(synthesis);
  const value = { sessionDigest: session.sessionDigest, synthesisDigest: synthesis.synthesisDigest,
    intent: { decision: "create_project", safeReasonCode: "owner_selected", project: { ...decision.project!, projectId: "project:owner-selected" } } };
  return { ...f, store, session, value };
}

test("web owner decision reuses policy and permit, promotes once, and replays after time advances", async t => {
  const f = await fixture(); t.after(() => f.db.close()); let clock = now;
  const service = new WebIdeaDecisionOperation(f.client, scope, webIdeaKey, () => clock);
  const result = await service.decide(f.identity, f.session.sessionId, f.value);
  assert.equal(result.projectId, "project:owner-selected"); assert.equal(result.startsWork, false);
  assert.equal(result.replayed, false); clock += 1000;
  assert.deepEqual(await service.decide(f.identity, f.session.sessionId, f.value), { ...result, replayed: true });
  for (const table of ["control_policy_decisions", "control_idea_owner_authorizations"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.owner_decide'")).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
  assert.equal((await f.store.getProject(scope.tenantId, result.projectId!))!.lifecycleState, "active");
  const tasks = new WebTaskService(f.client, scope, () => clock, { ideaIntegrityKey: webIdeaKey });
  assert.equal((await tasks.list(f.identity, result.projectId!)).canPropose, true);
  const proposed = await tasks.propose(f.identity, result.projectId!, taskDraft, "decision-task-001");
  assert.equal(proposed.receipt.submission, "proposed"); assert.equal(proposed.receipt.startsWork, false);
  await assert.rejects(service.decide(f.identity, f.session.sessionId,
    { ...f.value, intent: { decision: "reject", safeReasonCode: "changed" } }), /conflict/);
  await new WebSessionAuthority(f.client, scope, () => clock).logout(f.identity);
  await assert.rejects(service.decide(f.identity, f.session.sessionId, f.value), /authentication_required/);
});

test("decision rejects wrong scope, stale synthesis, injected authority and operator access", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const service = new WebIdeaDecisionOperation(f.client, scope, webIdeaKey, () => now);
  await assert.rejects(new WebIdeaDecisionOperation(f.client, { ...scope, workspaceId: "workspace:missing" }, webIdeaKey, () => now)
    .decide(f.identity, f.session.sessionId, f.value), /not_found/);
  await assert.rejects(service.decide(f.identity, f.session.sessionId, { ...f.value, synthesisDigest: `sha256:${"a".repeat(64)}` }), /conflict/);
  await assert.rejects(service.decide(f.identity, f.session.sessionId, { ...f.value, ownerIdentityDigest: "spoof" }), /invalid_request/);
  await f.client.query("UPDATE control_role_grants SET role_key='operator'");
  await assert.rejects(service.decide(f.identity, f.session.sessionId, f.value), /access_denied/);
  assert.equal((await f.client.query("SELECT * FROM control_idea_owner_authorizations")).rows.length, 0);
});

test("save and reject decisions retain the outcome without creating a project or a job", async t => {
  for (const decision of ["save", "reject"] as const) await t.test(decision, async t => {
    const f = await fixture(); t.after(() => f.db.close());
    const service = new WebIdeaDecisionOperation(f.client, scope, webIdeaKey, () => now);
    const value = { ...f.value, intent: { decision, safeReasonCode: "owner_selected" } };
    const result = await service.decide(f.identity, f.session.sessionId, value);
    assert.equal(result.decision, decision); assert.equal(result.projectId, null);
    assert.equal((await service.decide(f.identity, f.session.sessionId, value)).replayed, true);
    assert.equal((await f.client.query("SELECT * FROM projects WHERE id='project:owner-selected'")).rows.length, 0);
    assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
  });
});

test("retained synthesis cannot be promoted while a panel is still prepared", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const ledger = new IdeaLabBotRunStoreV1(f.client, webIdeaKey);
  await ledger.prepare(buildIdeaLabBotRunV1({ ...scope, runId: "idea-run:not-finished", sessionId: f.session.sessionId,
    sessionDigest: f.session.sessionDigest, evidenceDigests: f.session.participants.map(p => sha256Digest(p.participantId)).sort(),
    state: "prepared", attempts: [], messagesUsed: 0, costUsd: 0, safeCode: "prepared", providerContacted: false,
    startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }));
  await assert.rejects(new WebIdeaDecisionOperation(f.client, scope, webIdeaKey, () => now)
    .decide(f.identity, f.session.sessionId, f.value), /conflict/);
  assert.equal((await f.client.query("SELECT * FROM control_idea_owner_authorizations")).rows.length, 0);
});

test("failure after promotion rolls back policy, permit, project, decision and audit together", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic audit failure");
    return tx.query<T>(sql, params);
  } });
  const db: DatabaseClient = { ...f.client, query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  await assert.rejects(new WebIdeaDecisionOperation(db, scope, webIdeaKey, () => now).decide(f.identity, f.session.sessionId, f.value));
  for (const table of ["control_policy_decisions", "control_idea_owner_authorizations"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
  assert.equal(await f.store.getDecision(scope.tenantId, f.session.sessionId), undefined);
  assert.equal((await f.client.query("SELECT * FROM projects WHERE id='project:owner-selected'")).rows.length, 0);
  assert.equal((await f.client.query("SELECT * FROM control_project_lifecycle_events WHERE project_id='project:owner-selected'")).rows.length, 0);
});

test("decision HTTP route requires an explicitly supplied operation, same origin and current owner session", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const service = new WebIdeaDecisionOperation(f.client, scope, webIdeaKey, () => now);
  const options = { ...startupConfig, database: { client: f.client, close: async () => {} },
    clock: () => now, ideaProjects: { integrityKey: webIdeaKey } };
  const unavailable = createPrivateWebProcess(options); t.after(() => unavailable.close());
  const app = createPrivateWebProcess({ ...options, ideaCreation: { ...scope,
    create: async () => { throw new Error("not used by this test"); }, decide: service.decide.bind(service) } });
  t.after(() => app.close());
  const path = `/api/v1/ideas/${encodeURIComponent(f.session.sessionId)}/decision`;
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  assert.equal((await unavailable.handle(request(path, "POST", f.value), () => new Response("shell"))).status, 503);
  const foreign = request(path, "POST", f.value); foreign.headers.set("origin", "https://other.invalid");
  assert.equal((await handle(foreign)).status, 403);
  assert.equal((await handle(request(path, "POST", { ...f.value, extra: true }))).status, 400);
  assert.equal((await handle(request(path, "POST", { ...f.value, intent: { ...f.value.intent,
    project: { ...f.value.intent.project, projectId: "project.idea:web" } } }))).status, 409);
  const detail = ideaDetailSchema.parse(await (await handle(request(`/api/v1/ideas/${encodeURIComponent(f.session.sessionId)}`))).json());
  assert.equal(detail.canDecide, true); assert.equal(detail.canPromote, true);
  const html = renderToStaticMarkup(createElement(IdeaDecisionForm, { detail }));
  for (const label of ["Create a project", "Save for later", "Reject this idea", "Save my decision"]) assert.ok(html.includes(label));
  assert.equal(renderToStaticMarkup(createElement(IdeaDecisionForm, { detail: { ...detail, canPromote: false } })).includes("Create a project"), false);
  assert.equal(ideaDetailSchema.safeParse({ ...detail, canDecide: false, canPromote: true }).success, false);
  let lost = true, calls = 0;
  const client = createIdeaDecisionClient(async (url, options) => {
    calls++; assert.equal(String(url), path); assert.equal(options?.redirect, "error");
    const response = await handle(request(path, "POST", JSON.parse(String(options?.body))));
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (lost) { lost = false; assert.equal(response.status, 201); throw new Error("synthetic lost response"); }
    return response;
  });
  await assert.rejects(client.decide(f.session.sessionId, f.value), /uncertain/); assert.equal(calls, 1);
  await assert.rejects(client.decide(f.session.sessionId, { ...f.value, intent: { decision: "reject", safeReasonCode: "changed" } }), /uncertain/);
  assert.equal(calls, 1); assert.equal((await client.retry()).replayed, true); assert.equal(client.hasPending(), false);
  const replayed = await handle(request(path, "POST", f.value)); assert.equal(replayed.status, 200);
  assert.equal((await replayed.json()).startsWork, false);
  assert.equal((await (await handle(request(`/api/v1/ideas/${encodeURIComponent(f.session.sessionId)}`))).json()).canDecide, false);
  await handle(request("/api/v1/session/logout", "POST"));
  assert.equal((await handle(request(path, "POST", f.value))).status, 401);
});

test("decision client holds a mismatched receipt and later denial without automatically retrying", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const value = { sessionDigest: digest, synthesisDigest: digest, intent: { decision: "save", safeReasonCode: "selected" } };
  let calls = 0;
  const client = createIdeaDecisionClient(async () => {
    calls++;
    return calls === 1 ? Response.json({ sessionId: "idea:wrong", sessionDigest: digest, synthesisDigest: digest,
      decisionDigest: digest, decision: "save", projectId: null, replayed: false, startsWork: false }) : new Response(null, { status: 403 });
  });
  await assert.rejects(client.decide("idea:chosen", value), /uncertain/); assert.equal(calls, 1);
  assert.equal(client.hasPending(), true); await assert.rejects(client.retry(), /access_denied/);
  assert.equal(client.hasPending(), true); assert.equal(calls, 2);
});
