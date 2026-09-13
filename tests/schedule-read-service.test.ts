import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DOMAIN_CONTRACT_VERSION } from "../src/domain/v1";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { readProjectScheduleStatus } from "../src/schedules/read-service";
import { privateWebReadTables } from "../src/web/v1/private-database-preflight";
import { fixture, now, origin, request, trust, token } from "./helpers/web-foundation";

test("authenticated project schedule route reads retained records without dispatch or write permission", async t => {
  const f = await fixture();
  let close = () => f.db.close();
  t.after(() => close());
  const identity = createAccessVerifier(trust)(request(), now);
  const created = await f.service.create(identity, { title: "Schedule fixture", summary: "Disposable" }, "schedule-project-create-01");
  const projectId = created.project.projectId;
  const empty = await f.service.create(identity, { title: "Empty schedule fixture", summary: "Disposable" },
    "schedule-project-create-empty-01");
  const at = new Date(now).toISOString();
  const schedule = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "schedule", id: "schedule:web",
    tenantId: "tenant:web", projectId, state: "active", scheduleType: "once", expression: at, timezone: "UTC",
    targetType: "job", targetId: "job:synthetic", idempotencyWindowSeconds: 60, version: 0, createdAt: at, updatedAt: at };
  await f.db.query(`INSERT INTO control_schedules(id,tenant_id,project_id,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,'active',0,$4::jsonb,$5,$5)`, [schedule.id, schedule.tenantId, projectId, JSON.stringify(schedule), at]);
  await f.db.query(`INSERT INTO control_schedule_occurrences(tenant_id,schedule_id,occurrence_key,target_type,target_id,
    definition_digest,scheduled_for,local_time,state,created_at) VALUES($1,$2,$3,'job',$4,$5,$6,$7,'cancelled',$6)`,
  [schedule.tenantId, schedule.id, "schedule:web:cancelled", schedule.targetId, `sha256:${"a".repeat(64)}`, at, at]);
  const before = (await f.db.query("SELECT count(*)::int AS n FROM control_outbox")).rows;
  await f.db.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.db.exec("SET ROLE control_room_private_web");
  for (const table of ["control_schedules", "control_schedule_occurrences"] as const) {
    assert.ok(privateWebReadTables.includes(table));
    const result = await f.db.query<{ can_read: boolean; can_write: boolean }>(
      "SELECT has_table_privilege(current_user,$1,'SELECT') AS can_read, has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write", [table]);
    assert.equal(result.rows[0].can_read, true); assert.equal(result.rows[0].can_write, false);
  }
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: f.client, close: () => f.db.close() }, loadKeys: async () => trust.keys, clock: () => now });
  close = () => app.close();
  const call = (path: string, method = "GET", jwt = token()) => app.handle(request(path, method, undefined,
    "schedule-request-01", jwt), () => new Response("unexpected", { status: 500 }));
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/schedules`;
  const emptyPath = `/api/v1/projects/${encodeURIComponent(empty.project.projectId)}/schedules`;
  const emptyStatus = await call(emptyPath); assert.equal(emptyStatus.status, 200);
  assert.deepEqual((await emptyStatus.json()).schedules, []);
  await f.db.exec("RESET ROLE; REVOKE SELECT ON control_schedule_occurrences FROM control_room_private_web; SET ROLE control_room_private_web");
  assert.notEqual((await call(emptyPath)).status, 200);
  await f.db.exec("RESET ROLE; GRANT SELECT ON control_schedule_occurrences TO control_room_private_web; SET ROLE control_room_private_web");
  const first = await call(path); assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.schedules[0].nextOccurrenceAt, at);
  assert.equal(body.schedules[0].occurrences[0].state, "cancelled");
  assert.equal(body.automaticExecutionEnabled, false);
  assert.deepEqual(await (await call(path)).json(), body);
  assert.equal((await call(path, "POST")).status, 400);
  assert.equal((await call(`${path}?tenantId=tenant:other`)).status, 400);
  assert.equal((await call("/api/v1/projects/project%3Aabsent/schedules")).status, 404);
  assert.equal((await call(path, "GET", token({ sub: "other-owner" }))).status, 403);
  await f.db.exec("RESET ROLE");
  assert.deepEqual((await f.db.query("SELECT count(*)::int AS n FROM control_outbox")).rows, before);
  await f.db.exec("REVOKE SELECT ON control_schedules FROM control_room_private_web; SET ROLE control_room_private_web");
  assert.notEqual((await call(path)).status, 200);
});

test("database projection refuses mirror and scope mismatches instead of returning an empty list", async () => {
  const tx = { query: async () => ({ rows: [{ id: "schedule:bad", tenant_id: "tenant:other", payload: {} }] }) };
  await assert.rejects(readProjectScheduleStatus(tx as never, { tenantId: "tenant:test", projectId: "project:test" },
    "2026-09-04T12:00:00.000Z"));
});
