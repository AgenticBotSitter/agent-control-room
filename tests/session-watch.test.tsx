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
import { SESSION_WATCH_PAGE_SIZE_V1, sessionWatchIdSchema, sessionWatchCursorSchemaV1, sessionWatchItemSchemaV1, sessionWatchPageSchemaV1, type SessionWatchItemV1 } from "../src/web/v1/session-watch-wire";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { SessionWatchView } from "../private-app/app/session-watch/workspace";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { request, token } from "./helpers/web-foundation";
import { at, registration } from "./native-task-fixture";
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

const item = (index = 0, state: Exclude<SessionWatchItemV1["state"], "unreadable"> = "running"): SessionWatchItemV1 => ({
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
  // The shared fixture claims as a named worker, as every S5 result producer must.
  assert.equal(page.sessions[0]!.worker, "worker:fixture"); assert.equal(page.startsWork, false);
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

// Additional healthy evidence is signed by the real store, never the provisioner's synthetic digest.
async function signedWatchSession(f: Awaited<ReturnType<typeof webNativeResultFixture>>, suffix: string) {
  const runId = `run:watch:${suffix}`, jobId = `job:watch:${suffix}`, attemptId = `attempt:watch:${suffix}`;
  await f.provisionRun(runId, jobId, attemptId);
  await f.db.query(`UPDATE control_workflows SET payload=jsonb_set(payload,'{jobIds}',payload->'jobIds' || $2::jsonb)
    WHERE tenant_id=$1 AND id='workflow:test'`, [f.scope.tenantId, JSON.stringify([jobId])]);
  await f.db.query("DELETE FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2", [f.scope.tenantId, runId]);
  await f.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, runId]);
  const { nativeTask: _nativeTask, ...base } = registration;
  await f.runs.create({ ...base, adapterId: "adapter:watch", id: runId, jobId, attemptId, nativeSessionKeyDigest: sha256Digest({ suffix }) });
  return { runId, jobId, attemptId };
}

test("mixed unreadable session data keeps healthy sessions visible", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const second = await signedWatchSession(f, "healthy"), bad = await signedWatchSession(f, "bad");
  const service = new SessionWatchServiceV1(f.db, f.scope, f.harnessKey, () => instant + 6000);
  const before = await service.read(f.identity);
  assert.equal(before.sessions.length, 3);
  assert.ok(before.sessions.every(row => row.state === "running"));
  const healthy = before.sessions.filter(row => row.sessionId !== bad.attemptId);
  assert.deepEqual(new Set(healthy.map(row => row.sessionId)), new Set(["attempt:test", second.attemptId]));
  await f.db.query("UPDATE control_attempts SET payload = payload - 'offeredAt' WHERE tenant_id=$1 AND id=$2",
    [f.scope.tenantId, bad.attemptId]);
  const saved = await f.db.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM control_attempts WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, bad.attemptId]);
  assert.equal(Object.hasOwn(saved.rows[0]!.payload, "offeredAt"), false, "trigger-enabled corruption persisted");
  const response = await service.read(f.identity);
  const page = await readSessionWatchV1(undefined, (async () => Response.json(response)) as typeof fetch);
  assert.equal(page.sessions.length, 3);
  assert.deepEqual(page.sessions.filter(row => row.sessionId !== bad.attemptId), healthy);
  const damaged = page.sessions.find(row => row.sessionId === bad.attemptId)!;
  assert.equal(damaged.state, "unreadable");
  assert.equal(damaged.taskTitle, "Session attempt:watch:bad");
  assert.equal(damaged.stage, "Session details could not be read");
  assert.equal(damaged.durationSeconds, null);
  const html = renderToStaticMarkup(createElement(SessionWatchView, { page }));
  assert.equal((html.match(/private-session-watch-heading/g) ?? []).length, 3);
  const badHtml = html.split("<li>").find(value => value.includes("Session attempt:watch:bad"))!;
  assert.match(badHtml, /unreadable/); assert.match(badHtml, /Session details could not be read/);
  assert.match(badHtml, /<dt>Run time<\/dt><dd>Unavailable<\/dd>/);
  assert.doesNotMatch(badHtml, /<dd>0s<\/dd>/);
});

function watchService(f: Awaited<ReturnType<typeof webNativeResultFixture>>, db = f.db) {
  return new SessionWatchServiceV1(db, f.scope, f.harnessKey, () => instant + 6000);
}

function assertUnreadable(page: Awaited<ReturnType<SessionWatchServiceV1["read"]>>, id: string) {
  const row = page.sessions.find(value => value.sessionId === id)!;
  assert.ok(row, `retained ${JSON.stringify(id)}`);
  assert.equal(row.state, "unreadable");
  assert.equal(row.stage, "Session details could not be read");
  assert.equal(row.runId, null); assert.equal(row.harness, null); assert.equal(row.durationSeconds, null);
  assert.equal(row.lastProgress, "Saved row updated"); assert.equal(row.expectedHeartbeatSeconds, 120);
  return row;
}

test("each stored payload failure stays within its session row", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const bad = await signedWatchSession(f, "bad");
  // Isolate shared request/workflow payloads before corruption; the original lineage stays healthy.
  await f.db.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    SELECT 'request:bad',tenant_id,project_id,state,version,'watch-bad-request',
    payload || '{"id":"request:bad","idempotencyKey":"watch-bad-request"}'::jsonb,created_at,updated_at
    FROM control_requests WHERE tenant_id=$1 AND id='request:test'`, [f.scope.tenantId]);
  await f.db.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    SELECT 'workflow:bad',tenant_id,'request:bad',project_id,definition_digest,state,version,
    payload || jsonb_build_object('id','workflow:bad','requestId','request:bad','jobIds',$2::jsonb),created_at,updated_at
    FROM control_workflows WHERE tenant_id=$1 AND id='workflow:test'`, [f.scope.tenantId, JSON.stringify([bad.jobId])]);
  await f.db.query(`UPDATE control_jobs SET workflow_id='workflow:bad',payload=jsonb_set(payload,'{workflowId}','"workflow:bad"')
    WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, bad.jobId]);
  const before = await watchService(f).read(f.identity);
  assert.ok(before.sessions.every(row => row.state === "running"));
  const healthy = before.sessions.find(row => row.sessionId === "attempt:test")!;
  for (const [table, id, field, remove] of [
    ["control_attempts", bad.attemptId, "offeredAt", true], ["control_requests", "request:bad", "title", false],
    ["control_workflows", "workflow:bad", "jobIds", false], ["control_jobs", bad.jobId, "dependsOnJobIds", false],
  ] as const) {
    const original = (await f.db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM ${table} WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, id])).rows[0]!.payload;
    try {
      await f.db.query(`UPDATE ${table} SET payload=${remove ? "payload - $3::text" : "jsonb_set(payload,ARRAY[$3::text],'null'::jsonb)"} WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, id, field]);
      const saved = (await f.db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM ${table} WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, id])).rows[0]!.payload;
      assert.equal(saved[field], remove ? undefined : null, `${table} persisted with triggers enabled`);
      const page = await watchService(f).read(f.identity);
      assert.equal(page.sessions.length, 2); assertUnreadable(page, bad.attemptId);
      assert.deepEqual(page.sessions.find(row => row.sessionId === "attempt:test"), healthy);
    } finally {
      await f.db.query(`UPDATE ${table} SET payload=$3::jsonb WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, id, JSON.stringify(original)]);
    }
  }
  await f.runs.append({ schemaVersion: "control-room-harness-event/v1", tenantId: f.scope.tenantId, runId: bad.runId,
    sequence: 1, occurredAt: at(1000), source: "adapter", sourceEventKeyDigest: sha256Digest({ event: "watch" }),
    payload: { category: "activity", activity: "test", phase: "progress", count: 1 } });
  // Transformed-row unit fault injections, not persisted engine-error evidence.
  for (const patch of [
    (row: Record<string, unknown>) => ({ ...row, run_payload: {} }),
    (row: Record<string, unknown>) => ({ ...row, run_digest: `sha256:${"0".repeat(64)}` }),
    (row: Record<string, unknown>) => ({ ...row, run_auth_tag: `hmac-sha256:${"0".repeat(64)}` }),
    ...["payload", "event_digest", "event_auth_tag"].map(field => (row: Record<string, unknown>) => ({ ...row,
      event_rows: (row.event_rows as Record<string, unknown>[]).map(event => ({ ...event, [field]: field === "payload" ? {} : "invalid" })) })),
  ]) {
    const db = transformedDatabase(f.db, (sql, rows) => sql.includes("WITH cursor") ? rows.map(row => row.session_id === bad.attemptId ? patch(row) : row) : rows);
    const page = await watchService(f, db).read(f.identity);
    assert.equal(page.sessions.length, 2); assertUnreadable(page, bad.attemptId);
    assert.deepEqual(page.sessions.find(row => row.sessionId === "attempt:test"), healthy);
  }
  for (const kind of ["query", "verifier"] as const) {
    const sentinel = new Error(`session-watch-${kind}-sentinel`);
    const db = transformedDatabase(f.db, (sql, rows) => {
      if (!sql.includes("WITH cursor")) return rows;
      if (kind === "query") throw sentinel;
      return rows.map(row => row.session_id === bad.attemptId ? { ...row,
        run_payload: new Proxy(row.run_payload as object, { get(target, key) { if (key === "schemaVersion") throw sentinel; return Reflect.get(target, key); } }) } : row);
    });
    await assert.rejects(watchService(f, db).read(f.identity), error => error === sentinel);
  }
});

test("unreadable rows remain wire valid with hostile plain columns", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const bad = await signedWatchSession(f, "bad");
  await f.runs.append({ schemaVersion: "control-room-harness-event/v1", tenantId: f.scope.tenantId, runId: bad.runId,
    sequence: 1, occurredAt: at(1000), source: "adapter", sourceEventKeyDigest: sha256Digest({ event: "hostile" }),
    payload: { category: "activity", activity: "test", phase: "progress", count: 1 } });
  const readPatch = async (patch: Record<string, unknown>, malformed = true) => watchService(f, transformedDatabase(f.db, (sql, rows) =>
    sql.includes("WITH cursor") ? rows.map(row => row.session_id === bad.attemptId ? { ...row,
      ...(malformed ? { attempt_payload: {} } : {}), ...patch } : row) : rows)).read(f.identity);
  for (const [key, title] of [["", "Session "], ["  ", "Session   "], ["<script>💫&%", "Session <script>💫&%"],
    ["a".repeat(170) + "💫" + "z".repeat(30), "Session " + "a".repeat(170) + "…"]]) {
    const page = await readPatch({ session_id: key, project_id: "bad/project", job_id: "bad/job", worker_id: " ",
      selected_model: "bad model", selected_effort: "impossible", attempt_number: null, attempt_updated_at: "infinity" });
    const row = assertUnreadable(page, key!);
    assert.equal(row.taskTitle, title); assert.equal(row.projectId, null); assert.equal(row.jobId, null);
    assert.equal(row.attemptId, null);
    for (const field of ["worker", "model", "effort", "attemptNumber", "lastProgressAt"] as const) assert.equal(row[field], null);
    const html = renderToStaticMarkup(createElement(SessionWatchView, { page }));
    const badHtml = html.split("<li>").find(value => value.includes("unreadable"))!;
    assert.doesNotMatch(badHtml, /<a |<script>|<dd>0s<\/dd>/);
    assert.match(badHtml, /Attempt Unavailable/); assert.match(badHtml, /Saved row updated · Unavailable/);
    if (key === "<script>💫&%") assert.match(badHtml, /Session &lt;script&gt;💫&amp;%/);
  }
  for (const attempt_number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", NaN]) {
    assert.equal(assertUnreadable(await readPatch({ attempt_number }), bad.attemptId).attemptNumber, null);
  }
  const retained = assertUnreadable(await readPatch({ worker_id: "worker:plain", selected_model: "gpt-test", selected_effort: "high", attempt_number: 3 }), bad.attemptId);
  assert.equal(retained.worker, "worker:plain"); assert.equal(retained.model, "gpt-test"); assert.equal(retained.effort, "high");
  assert.equal(retained.attemptNumber, 3); assert.equal(retained.lastProgressAt, at(-60_000));
  assert.equal(retained.attemptId, bad.attemptId); assert.equal(retained.projectId, "project:test"); assert.equal(retained.jobId, bad.jobId);
  // Unit variant: migration 0091 prevents persisting this selected model.
  assert.equal(assertUnreadable(await readPatch({ selected_model: "bad model" }, false), bad.attemptId).model, null);
  for (const malformed of [false, true]) {
    const row = assertUnreadable(await readPatch({ run_id: null, attempt_updated_at: "infinity" }, malformed), bad.attemptId);
    assert.equal(row.lastProgressAt, null);
  }
  for (const patch of [{ run_created_at: "infinity" }, { run_updated_at: "infinity" }, { run_last_observed_at: "infinity" }])
    assertUnreadable(await readPatch(patch, false), bad.attemptId);
  let eventRows: Record<string, unknown>[] = [];
  await watchService(f, transformedDatabase(f.db, (sql, rows) => {
    if (sql.includes("WITH cursor")) eventRows = rows.find(row => row.session_id === bad.attemptId)!.event_rows as Record<string, unknown>[];
    return rows;
  })).read(f.identity);
  for (const field of ["occurred_at", "recorded_at"]) assertUnreadable(await readPatch({
    event_rows: eventRows.map(event => ({ ...event, [field]: "infinity" })) }, false), bad.attemptId);
  assert.equal(sessionWatchItemSchemaV1.safeParse({ ...item(), durationSeconds: null }).success, false);
  assert.equal(sessionWatchItemSchemaV1.safeParse({ ...retained, extra: true }).success, false);
});

test("session pagination crosses an unreadable boundary row", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  for (const invalid of ["\0", "\ud800", "\udfff"]) {
    assert.equal(sessionWatchCursorSchemaV1.safeParse(invalid).success, false);
    let called = false;
    await assert.rejects(readSessionWatchV1(invalid, (async () => { called = true; return Response.json({}); }) as typeof fetch), /invalid_request/);
    assert.equal(called, false);
    await assert.rejects(watchService(f).read(f.identity, invalid), /invalid_request/);
  }
  for (const key of ["", " ", "%💫<>"]) assert.equal(sessionWatchCursorSchemaV1.parse(key), key);
  assert.equal(sessionWatchPageSchemaV1.safeParse({ source: "not_configured", sessions: [], nextCursor: "", observedAt, startsWork: false }).success, false);
  await f.db.query("DELETE FROM control_harness_run_events WHERE tenant_id=$1", [f.scope.tenantId]);
  await f.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1", [f.scope.tenantId]);
  await f.db.query("UPDATE control_attempts SET state='succeeded',payload=jsonb_set(payload,'{state}','\"succeeded\"') WHERE tenant_id=$1", [f.scope.tenantId]);
  assert.deepEqual((await watchService(f).read(f.identity)).sessions, []);
  await f.db.query("UPDATE control_attempts SET state='running',payload=jsonb_set(payload,'{state}','\"running\"') WHERE tenant_id=$1", [f.scope.tenantId]);
  const original = (await f.db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM control_attempts WHERE id='attempt:test' AND tenant_id=$1", [f.scope.tenantId])).rows[0]!.payload;
  await f.db.query("UPDATE control_attempts SET payload=payload - 'offeredAt' WHERE tenant_id=$1 AND id='attempt:test'", [f.scope.tenantId]);
  assertUnreadable(await watchService(f).read(f.identity), "attempt:test");
  await f.db.query("UPDATE control_attempts SET payload=$2::jsonb WHERE tenant_id=$1 AND id='attempt:test'", [f.scope.tenantId, JSON.stringify(original)]);
  for (let index = 1; index < 26; index++) {
    const suffix = String(index).padStart(2, "0");
    await f.provisionRun(`run:page:${suffix}`, `job:page:${suffix}`, `attempt:page:${suffix}`);
  }
  await f.db.query("UPDATE control_workflows SET payload=jsonb_set(payload,'{jobIds}',(SELECT jsonb_agg(id) FROM control_jobs WHERE tenant_id=$1)) WHERE tenant_id=$1 AND id='workflow:test'", [f.scope.tenantId]);
  await f.db.query("DELETE FROM control_harness_run_events WHERE tenant_id=$1", [f.scope.tenantId]);
  await f.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1", [f.scope.tenantId]);
  const ids = ["attempt:test", ...Array.from({ length: 25 }, (_, index) => `attempt:page:${String(index + 1).padStart(2, "0")}`)];
  for (const [index, id] of ids.entries()) await f.db.query(`UPDATE control_attempts SET state='running',updated_at=$3::text::timestamptz,
    payload=payload || jsonb_build_object('state','running','updatedAt',$3::text) WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, id, at(5000 - index)]);
  for (const index of [0, 12, 24]) {
    const id = ids[index]!;
    const saved = (await f.db.query<{ payload: unknown }>("SELECT payload FROM control_attempts WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, id])).rows[0]!.payload;
    await f.db.query("UPDATE control_attempts SET payload=payload - 'offeredAt' WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, id]);
    const page = await watchService(f).read(f.identity);
    assert.equal(page.sessions.length, 25); assert.equal(page.sessions[index]!.sessionId, id); assertUnreadable(page, id);
    await f.db.query("UPDATE control_attempts SET payload=$3::jsonb WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, id, JSON.stringify(saved)]);
  }
  await f.db.query("UPDATE control_attempts SET state='succeeded',payload=jsonb_set(payload,'{state}','\"succeeded\"') WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, ids[25]]);
  const fullPage = await watchService(f).read(f.identity);
  assert.equal(fullPage.sessions.length, 25); assert.equal(fullPage.nextCursor, null, "exactly 25 rows need no lookahead cursor");
  await f.db.query("UPDATE control_attempts SET state='running',payload=jsonb_set(payload,'{state}','\"running\"') WHERE tenant_id=$1 AND id=$2", [f.scope.tenantId, ids[25]]);
  // Real process readers with injected disposable DB; no network listener or worker is started.
  const hosted = createPrivateWebProcess({ origin: "https://private.example.invalid", issuer: f.accessTrust.issuer,
    audience: f.accessTrust.audience, ...f.scope, maxSessionSeconds: 604800, loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: async () => {} }, tasks: { ...f.taskKeys, harnessIntegrityKey: f.harnessKey }, clock: () => instant + 6000 });
  t.after(() => hosted.close());
  const origin = "http://127.0.0.1:3210", ownerCode = "watch-owner-code-long-enough";
  const local = createMacLocalWebProcessV1({ origin, workspaceId: f.scope.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: f.scope.tenantId,
      provider: f.accessTrust.issuer, subject: "test-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
    database: { client: f.db, close: async () => {}, isAvailable: () => true }, taskReadKeys: f.taskKeys, clock: () => instant + 6000 });
  t.after(() => local.close());
  const login = await local.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), () => new Response("unused"));
  assert.equal(login.status, 201); const cookie = login.headers.get("set-cookie")!; assert.ok(cookie);
  const readers = [
    (path: string, method = "GET") => hosted.handle(request(path, method, undefined, undefined, f.jwt), () => new Response("shell")),
    (path: string, method = "GET") => local.handle(new Request(`${origin}${path}`, { method, headers: { cookie, origin } }), () => new Response("shell")),
  ];
  let priorKey = ids[24]!;
  for (const key of [" %💫 boundary ", ""]) {
    await f.db.query(`UPDATE control_attempts SET id=$3,payload=jsonb_set(payload - 'offeredAt','{id}',to_jsonb($3::text))
      WHERE tenant_id=$1 AND id=$2`, [f.scope.tenantId, priorKey, key]);
    priorKey = key;
    for (const read of readers) {
      const transport = (async (input: RequestInfo | URL, init?: RequestInit) => read(String(input), init?.method)) as typeof fetch;
      const first = await readSessionWatchV1(undefined, transport);
      assert.equal(first.sessions.length, 25); assert.equal(first.nextCursor, key);
      assertUnreadable(first, key);
      const html = renderToStaticMarkup(createElement(SessionWatchView, { page: first }));
      assert.ok(html.includes(`href="/session-watch?after=${encodeURIComponent(key)}"`));
      const second = await readSessionWatchV1(first.nextCursor!, transport);
      assert.deepEqual(second.sessions.map(row => row.sessionId), [ids[25]]); assert.equal(second.nextCursor, null);
      assert.ok(!first.sessions.some(row => row.sessionId === ids[25]));
      assert.match(renderToStaticMarkup(createElement(SessionWatchView, { page: second, after: key })), /First page/);
      assert.equal((await read(`/session-watch?after=${encodeURIComponent(key)}`)).status, 200);
      for (const query of ["?after=x&after=y", "?extra=x", "?after=%00"]) {
        for (const path of ["/session-watch", "/api/v1/session-watch"]) assert.equal((await read(path + query)).status, 400);
      }
      assert.equal((await read("/api/v1/session-watch", "POST")).status, 400);
      assert.equal((await read("/api/v1/session-watch?after=attempt%3Amissing")).status, 400);
    }
    await assert.rejects(new SessionWatchServiceV1(f.db, { ...f.scope, workspaceId: "workspace:missing" }, f.harnessKey,
      () => instant + 6000).read(f.identity, key), /invalid_request/);
    await assert.rejects(new SessionWatchServiceV1(f.db, { tenantId: "tenant:other", workspaceId: "workspace:other" }, f.harnessKey,
      () => instant + 6000).read(f.identity, key), /access_denied/);
  }
  assert.equal((await hosted.handle(new Request("https://private.example.invalid/api/v1/session-watch"), () => new Response("unused"))).status, 401);
  const expiredJwt = token({ iat: instant / 1000 - 60, exp: instant / 1000 + 1 });
  assert.equal((await hosted.handle(request("/api/v1/session-watch", "GET", undefined, undefined, expiredJwt), () => new Response("unused"))).status, 401);
  assert.equal((await local.handle(new Request(`${origin}/api/v1/session-watch`), () => new Response("unused"))).status, 401);
});
