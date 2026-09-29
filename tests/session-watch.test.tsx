import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { HarnessRunV1 } from "../src/harness/v1/types";
import { SecurityStore, sha256Digest } from "../src/security";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { readSessionWatchV1 } from "../src/web/v1/session-watch-browser-client";
import { projectSessionWatchItemV1, projectSessionWatchStateV1, SessionWatchServiceV1 } from "../src/web/v1/session-watch-service";
import { SESSION_WATCH_PAGE_SIZE_V1, sessionWatchIdSchema, sessionWatchPageSchemaV1, type SessionWatchItemV1 } from "../src/web/v1/session-watch-wire";
import { SessionWatchView } from "../private-app/app/session-watch/workspace";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { request, token } from "./helpers/web-foundation";
import { at } from "./native-task-fixture";
import { instant } from "./hermes-native-fixture";

const observedAt = "2026-09-28T12:02:00.000Z";
const run = (patch: Partial<HarnessRunV1> = {}): HarnessRunV1 => ({
  schemaVersion: "control-room-harness/v1", id: "run:watch", tenantId: "tenant:test", projectId: "project:test",
  jobId: "job:test", attemptId: "attempt:test", nodeId: "node:test", adapterId: "adapter:test", adapterVersion: "1",
  harness: "codex", harnessVersion: "1", nativeSessionKeyDigest: `sha256:${"a".repeat(64)}`, state: "running",
  resumable: false, cancelState: "not_requested", createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:00.000Z", startedAt: "2026-09-28T12:00:00.000Z",
  lastObservedAt: "2026-09-28T12:00:00.000Z", ...patch,
});

const item = (index = 0, state: SessionWatchItemV1["state"] = "running"): SessionWatchItemV1 => ({
  sessionId: `attempt:watch:${index}`, runId: `run:watch:${index}`, projectId: "project:test", jobId: `job:watch:${index}`, taskTitle: `Session task ${index}`,
  attemptId: `attempt:watch:${index}`, attemptNumber: index + 1, worker: index % 2 ? null : "worker:local",
  harness: "codex", model: index % 2 ? null : "gpt-test", effort: "high", stage: "test progress", state,
  durationSeconds: 3661, lastProgressAt: observedAt, lastProgress: "test progress", expectedHeartbeatSeconds: 120,
});

test("session state keeps the 120-second boundary current and stalls immediately after it", () => {
  const state = (lastObservedAt: string, runState: HarnessRunV1["state"] = "running", jobState = "running") =>
    projectSessionWatchStateV1({ runState, jobState, lastObservedAt, observedAt });
  assert.equal(state("2026-09-28T12:00:00.000Z"), "running");
  assert.equal(state("2026-09-28T11:59:59.999Z"), "stalled");
  assert.equal(state("2026-09-28T12:02:00.001Z"), "stalled", "future observations never look running");
  assert.equal(state(observedAt, "disconnected"), "stalled");
  assert.equal(state(observedAt, "waiting_input"), "blocked");
  assert.equal(state("2026-09-28T10:00:00.000Z", "succeeded", "waiting_approval"), "waiting_for_review");
});

test("session projection uses saved worker, model, attempt, duration and latest progress", () => {
  const projected = projectSessionWatchItemV1({ run: run({ modelSelection: { model: "gpt-test", effort: "high" } }),
    event: { category: "activity", activity: "test", phase: "progress", count: 4 }, eventAt: observedAt,
    jobState: "running", taskTitle: "Verify owner journey", attemptId: "attempt:test", attemptNumber: 2,
    worker: "worker:local", model: null, effort: null, observedAt });
  assert.deepEqual({ state: projected.state, stage: projected.stage, worker: projected.worker, model: projected.model,
    attemptNumber: projected.attemptNumber, durationSeconds: projected.durationSeconds },
  { state: "running", stage: "test progress", worker: "worker:local", model: "gpt-test", attemptNumber: 2, durationSeconds: 120 });
});

test("session watch renders running, stalled and blocked records, honest unavailable fields, empty state and pagination", () => {
  const sessions = Array.from({ length: SESSION_WATCH_PAGE_SIZE_V1 }, (_, index) => item(index,
    index === 1 ? "stalled" : index === 2 ? "blocked" : "running"));
  const page = sessionWatchPageSchemaV1.parse({ source: "configured", sessions, nextCursor: sessions.at(-1)!.sessionId,
    observedAt, startsWork: false });
  const html = renderToStaticMarkup(createElement(SessionWatchView, { page, after: "run:prior" }));
  for (const label of ["running", "stalled", "blocked", "Attempt 25", "Next sessions", "First page", "Model unavailable", "Unavailable"])
    assert.match(html, new RegExp(label, "i"));
  assert.equal((html.match(/private-session-watch-heading/g) ?? []).length, SESSION_WATCH_PAGE_SIZE_V1);
  assert.match(html, /href="\/projects\/project%3Atest\/tasks\/job%3Awatch%3A0"/);
  const empty = renderToStaticMarkup(createElement(SessionWatchView, { page: sessionWatchPageSchemaV1.parse({
    source: "configured", sessions: [], nextCursor: null, observedAt, startsWork: false }) }));
  assert.match(empty, /does not prove that no agent process is running/i);
});

test("session watch browser read is GET-only and exposes no command body", async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Response.json({ source: "configured", sessions: [], nextCursor: null, observedAt, startsWork: false });
  }) as typeof fetch;
  await readSessionWatchV1("run:cursor", transport);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(calls[0]!.init?.body, undefined); assert.match(String(calls[0]!.input), /after=run%3Acursor/);
});

function observedDatabase(db: DatabaseClient) {
  const statements: string[] = [];
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T,>(sql: string, parameters?: unknown[]) => {
    statements.push(sql); return tx.query<T>(sql, parameters);
  } });
  const client: DatabaseClient = { query: async <T,>(sql: string, parameters?: unknown[]) => {
    statements.push(sql); return db.query<T>(sql, parameters);
  }, transaction: work => db.transaction(tx => work(wrap(tx))),
  transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check) };
  return { client, statements };
}

function transformedDatabase(db: DatabaseClient, transform: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const session = (tx: DatabaseSession): DatabaseSession => ({ query: async <T,>(sql: string, parameters?: unknown[]) => {
    const result = await tx.query<T>(sql, parameters);
    return { ...result, rows: transform(sql, result.rows as Record<string, unknown>[]) as T[] };
  } });
  return {
    query: async <T,>(sql: string, parameters?: unknown[]) => {
      const result = await db.query<T>(sql, parameters);
      return { ...result, rows: transform(sql, result.rows as Record<string, unknown>[]) as T[] };
    },
    transaction: <T,>(work: (tx: DatabaseSession) => Promise<T>) => db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: <T,>(work: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) =>
      db.transactionWithPreCommitCheck(tx => work(session(tx)), check),
  } satisfies DatabaseClient;
}

test("owner session reads stay tenant-bound and emit no task commands", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  await fixture.db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:watch-other','Other tenant')");
  await fixture.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:watch-other','tenant:watch-other','Other workspace')");
  await fixture.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    SELECT 'adapter:other','tenant:watch-other',source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days
    FROM adapter_registry WHERE tenant_id=$1 LIMIT 1`, [fixture.scope.tenantId]);
  await fixture.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,normalized_state,
    domain_state,health,authority_mode,observed_at,payload,updated_at) VALUES('project:other','tenant:watch-other','workspace:watch-other','adapter:other',
    'project:other','1','Other session','Synthetic cross-tenant session','planned','manual_project_active','healthy','control_room_native',$1,'{}',$1)`, [at()]);
  const copy = async (table: string, columns: string, values: string) => fixture.db.query(`INSERT INTO ${table}(${columns}) SELECT ${values}`);
  const replace = "replace(replace(replace(replace(replace(payload::text,'tenant:test','tenant:watch-other'),'project:test','project:other'),'request:test','request:other'),'workflow:test','workflow:other'),'job:test','job:other')::jsonb";
  await copy("control_requests", "id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at",
    `'request:other','tenant:watch-other','project:other',state,version,idempotency_key,${replace},created_at,updated_at FROM control_requests WHERE tenant_id='tenant:test' AND id='request:test'`);
  await copy("control_workflows", "id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at",
    `'workflow:other','tenant:watch-other','request:other','project:other',definition_digest,state,version,${replace},created_at,updated_at FROM control_workflows WHERE tenant_id='tenant:test' AND id='workflow:test'`);
  await copy("control_jobs", "id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at",
    `'job:other','tenant:watch-other','workflow:other','project:other',state,version,priority,required_capability,authority_digest,${replace},created_at,updated_at FROM control_jobs WHERE tenant_id='tenant:test' AND id='job:test'`);
  await copy("control_nodes", "id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at",
    `'node:other','tenant:watch-other',state,version,identity_key_id,replace(replace(payload::text,'tenant:test','tenant:watch-other'),'node:test','node:other')::jsonb,created_at,updated_at FROM control_nodes WHERE tenant_id='tenant:test' AND id='node:test'`);
  await copy("control_attempts", "id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at",
    `'attempt:other','tenant:watch-other','job:other',attempt_number,state,version,worker_id,'node:other',lease_epoch,replace(replace(replace(replace(payload::text,'tenant:test','tenant:watch-other'),'job:test','job:other'),'node:test','node:other'),'attempt:test','attempt:other')::jsonb,created_at,updated_at FROM control_attempts WHERE tenant_id='tenant:test' AND id='attempt:test'`);
  const watched = observedDatabase(fixture.db);
  const service = new SessionWatchServiceV1(watched.client, fixture.scope, fixture.harnessKey, () => instant + 6000);
  const page = await service.read(fixture.identity);
  assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0]!.state, "running");
  assert.equal(page.sessions.some(value => value.sessionId === "attempt:other"), false, "a second tenant's active session is never rendered");
  assert.equal(page.sessions[0]!.worker, null); assert.equal(page.startsWork, false);
  assert.deepEqual((await service.read(fixture.identity, page.sessions[0]!.sessionId)).sessions, [],
    "the stable cursor advances beyond the current page");
  await assert.rejects(service.read(fixture.identity, "attempt:missing"), /invalid_request/,
    "unknown cursors cannot masquerade as an empty page");
  assert.ok(watched.statements.every(sql => !/^\s*(UPDATE|DELETE)\b/i.test(sql)));
  assert.ok(watched.statements.filter(sql => /^\s*INSERT\b/i.test(sql)).every(sql => /control_web_sessions/i.test(sql)),
    "the read may register its authenticated web session but emits no task or worker command");

  await fixture.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:other','tenant:other','Other workspace')");
  await new SecurityStore(fixture.db).bootstrapOwner({ tenantId: "tenant:other", provider: fixture.accessTrust.issuer,
    subject: "other-owner", identityId: "identity:other", grantId: "grant:other", displayName: "Other owner",
    verifiedAt: at(-60_000), expiresAt: at(600_000), now: at() });
  const otherJwt = token({ sub: "other-owner", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const otherIdentity = createAccessVerifier(fixture.accessTrust)(request(undefined, undefined, undefined, undefined, otherJwt), instant + 6000);
  const other = new SessionWatchServiceV1(fixture.db, { tenantId: "tenant:other", workspaceId: "workspace:other" },
    fixture.harnessKey, () => instant + 6000);
  assert.deepEqual((await other.read(otherIdentity)).sessions, []);
});

test("session watch keeps sessions scoped to their own workspace, on the first page and the cursor page", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  const adapterRow = await fixture.db.query<{ adapter_id: string }>(
    "SELECT adapter_id FROM projects WHERE tenant_id=$1 AND id=$2", [fixture.scope.tenantId, "project:test"]);
  const adapterId = adapterRow.rows[0]!.adapter_id;
  await fixture.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:other-ws','tenant:test','Other workspace')");
  await fixture.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,normalized_state,
    domain_state,health,authority_mode,observed_at,payload,updated_at) VALUES('project:other-ws','tenant:test','workspace:other-ws',$2,
    'project:other-ws','1','Other workspace session','Synthetic same-tenant session','planned','manual_project_active','healthy','control_room_native',$1,'{}',$1)`,
  [at(), adapterId]);
  const copy = async (table: string, columns: string, values: string) => fixture.db.query(`INSERT INTO ${table}(${columns}) SELECT ${values}`);
  const replace = "replace(replace(replace(replace(payload::text,'project:test','project:other-ws'),'request:test','request:other-ws'),'workflow:test','workflow:other-ws'),'job:test','job:other-ws')::jsonb";
  const replaceRequest = `jsonb_set(${replace},'{idempotencyKey}','"native-task-fixture-request-other-ws"')`;
  await copy("control_requests", "id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at",
    `'request:other-ws','tenant:test','project:other-ws',state,version,'native-task-fixture-request-other-ws',${replaceRequest},created_at,updated_at FROM control_requests WHERE tenant_id='tenant:test' AND id='request:test'`);
  await copy("control_workflows", "id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at",
    `'workflow:other-ws','tenant:test','request:other-ws','project:other-ws',definition_digest,state,version,${replace},created_at,updated_at FROM control_workflows WHERE tenant_id='tenant:test' AND id='workflow:test'`);
  await copy("control_jobs", "id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at",
    `'job:other-ws','tenant:test','workflow:other-ws','project:other-ws',state,version,priority,required_capability,authority_digest,${replace},created_at,updated_at FROM control_jobs WHERE tenant_id='tenant:test' AND id='job:test'`);
  await copy("control_attempts", "id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at",
    `'attempt:other-ws','tenant:test','job:other-ws',attempt_number,state,version,worker_id,node_id,lease_epoch,replace(replace(payload::text,'job:test','job:other-ws'),'attempt:test','attempt:other-ws')::jsonb,created_at,updated_at FROM control_attempts WHERE tenant_id='tenant:test' AND id='attempt:test'`);
  await fixture.db.query(`UPDATE control_attempts SET state='running',payload=jsonb_set(payload,'{state}','"running"')
    WHERE tenant_id='tenant:test' AND id='attempt:other-ws'`);

  const service = new SessionWatchServiceV1(fixture.db, fixture.scope, fixture.harnessKey, () => instant + 6000);
  const page = await service.read(fixture.identity);
  assert.ok(page.sessions.length >= 1, "the owner's own workspace session is still returned");
  assert.equal(page.sessions.some(value => value.sessionId === "attempt:other-ws"), false,
    "a session in another workspace of the same tenant is never rendered on the first page");
  await assert.rejects(service.read(fixture.identity, "attempt:other-ws"), (error: unknown) =>
    error instanceof WebAccessError && error.code === "invalid_request",
  "a cursor belonging to another workspace of the same tenant is refused, not treated as a valid page boundary");
});

test("session watch refuses a same-tenant operator for both authorize and read", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  const subject = "session-watch-operator";
  await fixture.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Operator',$3,$4,'active',$5,$5)`, ["identity:session-watch-operator", fixture.scope.tenantId,
    fixture.accessTrust.issuer, sha256Digest({ provider: fixture.accessTrust.issuer, subject }), at()]);
  await fixture.db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
    allow_external_effects,require_strong_factor,created_at,updated_at) VALUES($1,$2,$3,'operator',$4::jsonb,$5::jsonb,'low',false,false,$6,$6)`,
  ["grant:session-watch-operator", fixture.scope.tenantId, "identity:session-watch-operator", JSON.stringify(["tasks.read", "projects.read"]),
    JSON.stringify(["*"]), at()]);
  const jwt = token({ sub: subject, iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const identity = createAccessVerifier(fixture.accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
  const service = new SessionWatchServiceV1(fixture.db, fixture.scope, fixture.harnessKey, () => instant + 6000);
  for (const action of [() => service.authorize(identity), () => service.read(identity)]) {
    await assert.rejects(action, (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  }
});

test("a run lineage mismatch degrades only the affected row without hiding healthy sessions", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  await fixture.provisionRun("run:bad-lineage", "job:bad-lineage", "attempt:bad-lineage");
  await fixture.db.query(`UPDATE control_workflows SET payload=jsonb_set(payload,'{jobIds}',payload->'jobIds' || $3::jsonb)
    WHERE tenant_id=$1 AND id=$2`, [fixture.scope.tenantId, "workflow:test", JSON.stringify(["job:bad-lineage"])]);
  // job:test's run is properly signed by the fixture's harness key and must still verify and render as "running";
  // job:bad-lineage's run is only ever given a synthetic (unsigned) digest by provisionRun, so it must be caught
  // by the lineage check below and degraded before it ever reaches signature verification.
  const service = new SessionWatchServiceV1(transformedDatabase(fixture.db, (sql, rows) => sql.includes("WITH cursor")
    ? rows.map(row => row.job_id === "job:bad-lineage" && row.run_id ? { ...row, run_attempt_id: "attempt:other" } : row) : rows),
  fixture.scope, fixture.harnessKey, () => instant + 6000);
  const page = await service.read(fixture.identity);
  assert.equal(page.sessions.length, 2);
  const bad = page.sessions.find(value => value.jobId === "job:bad-lineage");
  assert.equal(bad?.state, "stalled"); assert.equal(bad?.runId, null);
  const good = page.sessions.find(value => value.jobId === "job:test");
  assert.equal(good?.state, "running");
});

test("one oversized run is unavailable without hiding healthy sessions", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  await fixture.provisionRun("run:oversized", "job:oversized", "attempt:oversized");
  await fixture.db.query(`UPDATE control_workflows SET payload=jsonb_set(payload,'{jobIds}',payload->'jobIds' || $3::jsonb)
    WHERE tenant_id=$1 AND id=$2`, [fixture.scope.tenantId, "workflow:test", JSON.stringify(["job:oversized"])]);
  const service = new SessionWatchServiceV1(transformedDatabase(fixture.db, (sql, rows) => sql.includes("WITH cursor")
    ? rows.map(row => row.run_id === "run:oversized" ? { ...row, event_rows: Array.from({ length: 1025 }, () => ({})) } : row) : rows),
  fixture.scope, fixture.harnessKey, () => instant + 6000);
  const page = await service.read(fixture.identity);
  assert.equal(page.sessions.length, 2);
  assert.deepEqual(page.sessions.find(value => value.attemptId === "attempt:oversized" && value.state === "stalled")?.lastProgress,
    "canonical attempt leased");
  assert.ok(page.sessions.some(value => value.attemptId !== "attempt:oversized" && value.state === "running"));
});

test("session-watch cursor schema accepts canonical attempt and run id shapes", () => {
  for (const id of ["attempt:watch:0", "run:watch:0", "a._:-9"]) assert.equal(sessionWatchIdSchema.parse(id), id);
  for (const id of ["", "x", "attempt/watch", "attempt space"]) assert.equal(sessionWatchIdSchema.safeParse(id).success, false);
});

test("a working canonical attempt without a persisted run is shown as stalled with unavailable run evidence", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  const initial = await new SessionWatchServiceV1(fixture.db, fixture.scope, fixture.harnessKey, () => instant + 6000)
    .read(fixture.identity);
  const attemptId = initial.sessions[0]!.attemptId;
  await fixture.db.query("DELETE FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2",
    [fixture.scope.tenantId, initial.sessions[0]!.runId]);
  await fixture.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1 AND attempt_id=$2",
    [fixture.scope.tenantId, attemptId]);
  await fixture.db.query(`UPDATE control_attempts SET state='running',version=version+1,updated_at=$3::timestamptz,
    payload=payload || jsonb_build_object('state','running','version',version+1,'startedAt',$4::text,'updatedAt',$4::text)
    WHERE tenant_id=$1 AND id=$2`, [fixture.scope.tenantId, attemptId, at(3000), at(1000)]);
  const page = await new SessionWatchServiceV1(fixture.db, fixture.scope, fixture.harnessKey, () => instant + 6000)
    .read(fixture.identity);
  assert.equal(page.sessions.length, 1);
  assert.deepEqual({ state: page.sessions[0]!.state, runId: page.sessions[0]!.runId,
    harness: page.sessions[0]!.harness, stage: page.sessions[0]!.stage },
  { state: "stalled", runId: null, harness: null, stage: "run evidence unavailable" });
});
