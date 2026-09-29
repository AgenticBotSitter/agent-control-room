import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseSession } from "../src/persistence/database";
import { buildProjectEventV1, encodeProjectEventCursorV1, formatProjectEventSseV1, PROJECT_EVENT_INPUT_V1,
  ProjectEventStoreV1, TaskProjectEventWriterV1, taskProjectEventActionsV1, type ProjectEventInputV1 } from "../src/project-events/v1";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { mergeProjectActivityEventsV1 } from "../src/web/v1/project-activity-browser-client";

const scope = { tenantId: "tenant:timeline", workspaceId: "workspace:timeline", projectId: "project:timeline" };
const otherProjectId = "project:foreign";
const siblingWorkspaceId = "workspace:timeline-sibling";
const wrongWorkspaceProjectId = "project:wrong-workspace";
const foreignTenantId = "tenant:timeline-foreign";
const foreignWorkspaceId = "workspace:timeline-foreign";
const foreignTenantProjectId = "project:foreign-tenant";
const key = new Uint8Array(32).fill(37), now = "2026-09-28T12:00:00.000Z";

async function setup() {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,'Timeline tenant')", [scope.tenantId]);
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Timeline workspace')", [scope.workspaceId, scope.tenantId]);
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Timeline sibling workspace')",
    [siblingWorkspaceId, scope.tenantId]);
  await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,'Foreign timeline tenant')", [foreignTenantId]);
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Foreign timeline workspace')",
    [foreignWorkspaceId, foreignTenantId]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:timeline',$1,'timeline_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`, [scope.tenantId]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:timeline-foreign',$1,'timeline_foreign_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,
  [foreignTenantId]);
  for (const projectId of [scope.projectId, otherProjectId]) await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,
    source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:timeline',$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$4,'{}')`,
  [projectId, scope.tenantId, scope.workspaceId, now]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:timeline',$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$4,'{}')`,
  [wrongWorkspaceProjectId, scope.tenantId, siblingWorkspaceId, now]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:timeline-foreign',$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$4,'{}')`,
  [foreignTenantProjectId, foreignTenantId, foreignWorkspaceId, now]);
  const db = adaptPglite(raw);
  return { raw, db, store: new ProjectEventStoreV1(db, key, () => now) };
}

function input(index: number, projectId = scope.projectId): ProjectEventInputV1 {
  const sourceId = `source:timeline:${projectId}:${index}`;
  return { schemaVersion: PROJECT_EVENT_INPUT_V1, ...scope, projectId, eventId: `event:timeline:${projectId}:${index}`,
    eventKind: "work", source: { kind: "job", sourceId, sourceVersion: `version-${index}`,
      sourceEventKeyDigest: sha256Digest({ sourceId }) }, subject: { kind: "work_item", subjectId: `work:${index}` },
    safeSummary: `Timeline event ${index}`, tone: "neutral", occurredAt: now, presentationOnly: true,
    grantsApproval: false, grantsCommandAuthority: false, grantsExecutionAuthority: false };
}

test("B-093 pages backward through the verified append-only store", async () => {
  const { raw, store } = await setup();
  try {
    const events = [];
    for (let index = 1; index <= 6; index++) events.push((await store.append(input(index))).event);
    const latest = await store.read({ ...scope, limit: 2 });
    assert.deepEqual(latest.events.map(event => event.sequence), [5, 6]);
    const middle = await store.read({ ...scope, beforeCursor: encodeProjectEventCursorV1(events[4]!), limit: 2 });
    assert.deepEqual(middle.events.map(event => event.sequence), [3, 4]);
    assert.equal(middle.nextCursor, encodeProjectEventCursorV1(events[2]!)); assert.equal(middle.truncatedBefore, true);
    const oldest = await store.read({ ...scope, beforeCursor: middle.nextCursor!, limit: 2 });
    assert.deepEqual(oldest.events.map(event => event.sequence), [1, 2]); assert.equal(oldest.truncatedBefore, false);
  } finally { await raw.close(); }
});

test("B-093 resumes across reconnect with no gaps or duplicates", async () => {
  const { raw, store } = await setup();
  try {
    for (let index = 1; index <= 3; index++) await store.append(input(index));
    const snapshot = await store.read({ ...scope, limit: 100 });
    await store.append(input(4)); await store.append(input(5));
    const replay = await store.read({ ...scope, afterCursor: snapshot.nextCursor!, limit: 100 });
    assert.equal(replay.mode, "replay"); assert.deepEqual(replay.events.map(event => event.sequence), [4, 5]);
    const exactOnce = mergeProjectActivityEventsV1(snapshot.events, [...replay.events, ...replay.events], scope.projectId);
    assert.deepEqual(exactOnce.map(event => event.sequence), [1, 2, 3, 4, 5]);
    assert.throws(() => mergeProjectActivityEventsV1(snapshot.events, [buildProjectEventV1(input(6), 6,
      replay.events.at(-1)!.eventDigest, now)], scope.projectId), /project_activity_gap/);
    const frame = formatProjectEventSseV1(replay);
    assert.equal((frame.match(/^id: /gm) ?? []).length, 2); assert.doesNotMatch(frame, /project\.command|project\.approve/);
  } finally { await raw.close(); }
});

test("B-093 resets malformed, foreign, stale-compacted, and ahead cursors without cross-project data", async () => {
  const { raw, store } = await setup();
  try {
    const first = (await store.append(input(1))).event, second = (await store.append(input(2))).event;
    const foreign = buildProjectEventV1(input(1, otherProjectId), 1, null, now);
    const cases = ["", "malformed-cursor", encodeProjectEventCursorV1(foreign),
      Buffer.from(JSON.stringify({ projectId: scope.projectId, sequence: 99, eventDigest: first.eventDigest })).toString("base64url")];
    for (const cursor of cases) {
      const page = await store.read({ ...scope, afterCursor: cursor, limit: 100 });
      assert.equal(page.mode, "reset"); assert.deepEqual(page.events.map(event => event.eventId), [first.eventId, second.eventId]);
      assert.ok(page.events.every(event => event.projectId === scope.projectId));
    }
    await raw.exec("DROP TRIGGER control_project_events_append_only ON control_project_events");
    await raw.query("DELETE FROM control_project_events WHERE tenant_id=$1 AND project_id=$2 AND sequence=1", [scope.tenantId, scope.projectId]);
    const compacted = await store.read({ ...scope, afterCursor: encodeProjectEventCursorV1(first), limit: 100 });
    assert.equal(compacted.mode, "reset"); assert.deepEqual(compacted.events.map(event => event.sequence), [2]);
  } finally { await raw.close(); }
});

test("B-093 resets a genuine cursor whose sequence is ahead of the authenticated head", async () => {
  const { raw, store } = await setup();
  try {
    const first = (await store.append(input(1))).event;
    const second = (await store.append(input(2))).event;
    const selected = await raw.query<{ tenant_id: string; workspace_id: string; project_id: string;
      last_sequence: number | string; last_event_digest: string | null; head_auth_tag: string;
      updated_at: string | Date }>(`SELECT tenant_id,workspace_id,project_id,last_sequence,last_event_digest,head_auth_tag,updated_at
        FROM control_project_event_stream_heads WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]);
    const saved = selected.rows[0]!;
    const authenticatedHead = {
      ...saved,
      last_sequence: 1,
      last_event_digest: first.eventDigest,
      head_auth_tag: hmacSha256Tag(key, { kind: "project_event_head", tenantId: scope.tenantId,
        workspaceId: scope.workspaceId, projectId: scope.projectId, lastSequence: 1,
        lastEventDigest: first.eventDigest, updatedAt: new Date(saved.updated_at).toISOString() }),
    };
    const session: DatabaseSession = Object.freeze({
      query: async <T>(statement: string, params: unknown[] = []) => {
        if (/FROM control_project_event_stream_heads WHERE tenant_id=\$1 AND project_id=\$2\s*$/m.test(statement)) {
          return { rows: [authenticatedHead as T] };
        }
        const result = await raw.query<T>(statement, params);
        if (/ORDER BY sequence DESC LIMIT \$3/.test(statement)) {
          return { rows: result.rows.filter(row => Number((row as { sequence: number | string }).sequence) <= 1) };
        }
        return { rows: result.rows };
      },
    });

    const page = await store.read({ ...scope, afterCursor: encodeProjectEventCursorV1(second), limit: 100 }, session);
    assert.equal(page.mode, "reset");
    assert.deepEqual(page.events.map(event => event.sequence), [1]);
    assert.equal(page.nextCursor, encodeProjectEventCursorV1(first));
  } finally { await raw.close(); }
});

test("B-093 refuses projects outside the requested tenant and workspace at the store layer", async () => {
  const { raw, store } = await setup();
  try {
    for (const projectId of [foreignTenantProjectId, wrongWorkspaceProjectId]) {
      await assert.rejects(store.read({ ...scope, projectId, limit: 100 }), (error: unknown) => {
        assert.equal((error as { safeCode?: unknown })?.safeCode, "project_not_found");
        return true;
      });
    }
  } finally { await raw.close(); }
});

test("B-093 anchors an empty stream so a bounded first replay cannot skip a burst", async () => {
  const { raw, store } = await setup();
  try {
    const reset = await store.read({ ...scope, afterCursor: "malformed-cursor", limit: 100 });
    assert.equal(reset.mode, "reset"); assert.deepEqual(reset.events, []);
    assert.match(formatProjectEventSseV1(reset), /retry: 1000\n\nid:\nevent: stream\.reset/);
    const empty = await store.read({ ...scope, limit: 100 });
    assert.equal(empty.mode, "snapshot"); assert.ok(empty.nextCursor);
    for (let index = 1; index <= 101; index++) await store.append(input(index));
    const first = await store.read({ ...scope, afterCursor: empty.nextCursor!, limit: 100 });
    assert.equal(first.mode, "replay"); assert.equal(first.hasMore, true);
    assert.deepEqual(first.events.map(event => event.sequence), Array.from({ length: 100 }, (_, index) => index + 1));
    const second = await store.read({ ...scope, afterCursor: first.nextCursor!, limit: 100 });
    assert.deepEqual(second.events.map(event => event.sequence), [101]); assert.equal(second.hasMore, false);
    assert.equal(mergeProjectActivityEventsV1(first.events, second.events, scope.projectId).length, 101);
  } finally { await raw.close(); }
});

test("task and project lifecycle actions append exactly once, roll back atomically, and resume in order", async () => {
  const { raw, db, store } = await setup();
  try {
    const writer = new TaskProjectEventWriterV1(store);
    const privateSentinel = "PRIVATE-PROMPT-MUST-NOT-APPEAR";
    for (const [index, action] of taskProjectEventActionsV1.entries()) {
      const lifecycle = { ...scope, subjectId: action.startsWith("project_")
        ? scope.projectId : `job:lifecycle:${index}`, action, sourceId: `source:lifecycle:${index}`,
        sourceVersion: `action-${index}`, occurredAt: now,
        ...(index === 0 ? { privateText: privateSentinel } : {}) };
      await db.transaction(tx => writer.appendInSession(tx, lifecycle));
    }
    const snapshot = await store.read({ ...scope, limit: 6 });
    assert.deepEqual(snapshot.events.map(event => event.sequence), [6, 7, 8, 9, 10, 11]);
    assert.equal(snapshot.events.length, 6);
    const older = await store.read({ ...scope, beforeCursor: encodeProjectEventCursorV1(snapshot.events[0]!), limit: 10 });
    assert.deepEqual(older.events.map(event => event.sequence), [1, 2, 3, 4, 5]);
    assert.doesNotMatch(JSON.stringify([...older.events, ...snapshot.events]), new RegExp(privateSentinel));
    assert.ok([...older.events, ...snapshot.events].every(event => event.presentationOnly
      && !event.grantsApproval && !event.grantsCommandAuthority && !event.grantsExecutionAuthority));
    const cursor = encodeProjectEventCursorV1(snapshot.events.at(-1)!);

    await assert.rejects(db.transaction(async tx => {
      await writer.appendInSession(tx, { ...scope, subjectId: "job:rolled-back", action: "task_failed",
        sourceId: "source:rolled-back", sourceVersion: "rollback-v1", occurredAt: now });
      throw new Error("force rollback");
    }), /force rollback/);
    const replay = await store.read({ ...scope, afterCursor: cursor, limit: 10 });
    assert.deepEqual(replay.events, []);
    assert.equal((await raw.query<{ count: string }>("SELECT count(*)::text AS count FROM control_project_events WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, scope.projectId])).rows[0]?.count, String(taskProjectEventActionsV1.length));
  } finally { await raw.close(); }
});
