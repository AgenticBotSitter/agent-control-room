import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { HarnessRunV1 } from "../src/harness/v1/types";
import { SecurityStore } from "../src/security";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { readSessionWatchV1 } from "../src/web/v1/session-watch-browser-client";
import { projectSessionWatchItemV1, projectSessionWatchStateV1, SessionWatchServiceV1 } from "../src/web/v1/session-watch-service";
import { SESSION_WATCH_PAGE_SIZE_V1, sessionWatchPageSchemaV1, type SessionWatchItemV1 } from "../src/web/v1/session-watch-wire";
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

test("owner session reads stay tenant-bound and emit no task commands", async t => {
  const fixture = await webNativeResultFixture(); t.after(fixture.close);
  const watched = observedDatabase(fixture.db);
  const service = new SessionWatchServiceV1(watched.client, fixture.scope, fixture.harnessKey, () => instant + 6000);
  const page = await service.read(fixture.identity);
  assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0]!.state, "running");
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
