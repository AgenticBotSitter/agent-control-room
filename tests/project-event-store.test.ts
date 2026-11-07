import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fixture, now } from "./helpers/web-foundation";
import {
  encodeProjectEventCursorV1,
  encodeProjectEventOriginCursorV1,
  PROJECT_EVENT_INPUT_V1,
  ProjectEventErrorV1,
  ProjectEventStoreV1,
  type ProjectEventInputV1,
} from "../src/project-events/v1";
import { sha256Digest } from "../src/security";

// The project event store is production-wired: src/local-pilot/v1/runtime.ts
// derives the integrity key it is constructed with, and
// IdeaLabProjectEventReconcilerV1 appends through it. These proofs run against
// the shared PGlite fixture (the same one tests/project-coordination-persistence.test.ts
// uses) so the migrations, the schema ownership, and the append-only trigger
// are exactly the ones production applies.
const TENANT = "tenant:web";
const WORKSPACE = "workspace:web";
const OTHER_WORKSPACE = "workspace:other";
const ADAPTER = "adapter:project-events";
const recordedAt = new Date(now).toISOString();
const key = new Uint8Array(32).fill(37);

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
let store: ProjectEventStoreV1;

before(async () => {
  f = await fixture();
  store = new ProjectEventStoreV1(f.client, key, () => recordedAt);
  await f.db.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,project_types,supported_read_operations,
     supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'project_events_fixture','v1','control_room_native','fixture','[]','[]','[]','v1',30)`,
  [ADAPTER, TENANT]);
  await f.db.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Other workspace')`,
    [OTHER_WORKSPACE, TENANT]);
});

after(async () => { await f.db.close(); });

async function seedProject(projectId: string, workspaceId = WORKSPACE): Promise<void> {
  await f.db.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,$4,$1,'v1',$1,'ready','ready','healthy','control_room_native',$5,'{}')`,
  [projectId, TENANT, workspaceId, ADAPTER, recordedAt]);
}

function eventInput(projectId: string, index: number, over: Partial<ProjectEventInputV1> = {}): ProjectEventInputV1 {
  return {
    schemaVersion: PROJECT_EVENT_INPUT_V1,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    projectId,
    eventId: `event:project-events:${projectId}:${index}`,
    eventKind: "work",
    source: {
      kind: "job",
      sourceId: `source:project-events:${projectId}:${index}`,
      sourceVersion: `v${index}`,
      sourceEventKeyDigest: sha256Digest({ projectId, index }),
    },
    subject: { kind: "work_item", subjectId: `work:project-events:${index}` },
    safeSummary: `Project event ${index}`,
    tone: "neutral",
    occurredAt: recordedAt,
    presentationOnly: true,
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
    ...over,
  };
}

async function eventCount(projectId: string): Promise<number> {
  const counted = await f.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM control_project_events WHERE tenant_id=$1 AND project_id=$2`,
    [TENANT, projectId]);
  return Number(counted.rows[0]?.count ?? "0");
}

function safeCode(error: unknown): string | undefined {
  return error instanceof ProjectEventErrorV1 ? error.safeCode : undefined;
}

test("project event appends assign sequence one and chain the previous event digest", async () => {
  const projectId = "project:events-chain";
  await seedProject(projectId);

  const first = await store.append(eventInput(projectId, 1));
  assert.equal(first.replayed, false);
  assert.equal(first.event.sequence, 1);
  assert.equal(first.event.previousEventDigest, null);
  assert.equal(first.event.projectId, projectId);
  assert.equal(first.event.schemaVersion, "control-room-project-event/v1");

  const second = await store.append(eventInput(projectId, 2));
  assert.equal(second.replayed, false);
  assert.equal(second.event.sequence, 2);
  assert.equal(second.event.previousEventDigest, first.event.eventDigest);

  const head = await f.db.query<{ last_sequence: number | string; last_event_digest: string | null }>(
    `SELECT last_sequence,last_event_digest FROM control_project_event_stream_heads
      WHERE tenant_id=$1 AND project_id=$2`, [TENANT, projectId]);
  assert.equal(Number(head.rows[0]?.last_sequence), 2);
  assert.equal(head.rows[0]?.last_event_digest, second.event.eventDigest);
});

test("a repeated append replays the original event and performs no second insert", async () => {
  const projectId = "project:events-replay";
  await seedProject(projectId);

  const input = eventInput(projectId, 1);
  const first = await store.append(input);
  const replay = await store.append(structuredClone(input));

  assert.equal(replay.replayed, true);
  assert.equal(replay.event.eventDigest, first.event.eventDigest);
  assert.equal(replay.event.sequence, first.event.sequence);
  assert.equal(replay.event.previousEventDigest, first.event.previousEventDigest);
  assert.equal(await eventCount(projectId), 1);
});

test("a same-key append carrying a different payload is refused as a replay conflict", async () => {
  const projectId = "project:events-conflict";
  await seedProject(projectId);

  const input = eventInput(projectId, 1);
  await store.append(input);

  await assert.rejects(() => store.append({ ...structuredClone(input), safeSummary: "A different summary" }),
    (error: unknown) => safeCode(error) === "replay_conflict");
  await assert.rejects(() => store.append({ ...structuredClone(input), eventId: `event:project-events:${projectId}:other` }),
    (error: unknown) => safeCode(error) === "replay_conflict");

  assert.equal(await eventCount(projectId), 1);
});

test("append against an unknown or mismatched project is refused as project not found", async () => {
  await assert.rejects(() => store.append(eventInput("project:events-absent", 1)),
    (error: unknown) => safeCode(error) === "project_not_found");

  await seedProject("project:events-mismatched", OTHER_WORKSPACE);
  await assert.rejects(() => store.append(eventInput("project:events-mismatched", 1)),
    (error: unknown) => safeCode(error) === "project_not_found");

  assert.equal(await eventCount("project:events-absent"), 0);
  assert.equal(await eventCount("project:events-mismatched"), 0);
});

test("an event dated beyond the clock tolerance is refused as invalid input", async () => {
  const projectId = "project:events-future";
  await seedProject(projectId);

  await assert.rejects(
    () => store.append(eventInput(projectId, 1, { occurredAt: new Date(now + 31_000).toISOString() })),
    (error: unknown) => safeCode(error) === "invalid_input");
  assert.equal(await eventCount(projectId), 0);

  // The tolerance is exactly thirty seconds, so the boundary itself is accepted.
  const boundary = await store.append(eventInput(projectId, 2, { occurredAt: new Date(now + 30_000).toISOString() }));
  assert.equal(boundary.replayed, false);
  assert.equal(boundary.event.sequence, 1);
});

test("a tampered stream head is detected and refused as an integrity failure", async () => {
  const projectId = "project:events-head";
  await seedProject(projectId);
  await store.append(eventInput(projectId, 1));

  await f.db.query(`UPDATE control_project_event_stream_heads SET head_auth_tag=$3
    WHERE tenant_id=$1 AND project_id=$2`,
  [TENANT, projectId, `hmac-sha256:${"0".repeat(64)}`]);

  const scope = { tenantId: TENANT, workspaceId: WORKSPACE, projectId };
  await assert.rejects(() => store.read({ ...scope, limit: 10 }),
    (error: unknown) => safeCode(error) === "integrity_failed");
  await assert.rejects(() => store.append(eventInput(projectId, 2)),
    (error: unknown) => safeCode(error) === "integrity_failed");
});

test("a tampered event row is detected and refused as an integrity failure", async () => {
  const projectId = "project:events-row";
  await seedProject(projectId);
  await store.append(eventInput(projectId, 1));

  // The append-only trigger guards UPDATE and DELETE on the event table, so
  // the tamper is applied with the trigger suspended for that one statement
  // and the trigger is restored in the finally block.
  let suspended = false;
  try {
    await f.db.exec("BEGIN");
    await f.db.exec("SET LOCAL ROLE control_room_schema_owner");
    await f.db.exec("DROP TRIGGER control_project_events_append_only ON control_project_events");
    await f.db.exec("COMMIT");
    suspended = true;
    await f.db.query(`UPDATE control_project_events SET event_auth_tag=$3
      WHERE tenant_id=$1 AND project_id=$2 AND sequence=1`,
    [TENANT, projectId, `hmac-sha256:${"0".repeat(64)}`]);
  } finally {
    if (suspended) {
      await f.db.exec("BEGIN");
      await f.db.exec("SET LOCAL ROLE control_room_schema_owner");
      await f.db.exec(`CREATE TRIGGER control_project_events_append_only
        BEFORE UPDATE OR DELETE ON control_project_events
        FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation()`);
      await f.db.exec("COMMIT");
    }
  }

  const scope = { tenantId: TENANT, workspaceId: WORKSPACE, projectId };
  await assert.rejects(() => store.read({ ...scope, limit: 10 }),
    (error: unknown) => safeCode(error) === "integrity_failed");
  await assert.rejects(() => store.append(eventInput(projectId, 1)),
    (error: unknown) => safeCode(error) === "integrity_failed");
});

test("snapshot reads return the most recent page in ascending order with honest pagination flags", async () => {
  const projectId = "project:events-snapshot";
  await seedProject(projectId);
  for (let index = 1; index <= 3; index += 1) await store.append(eventInput(projectId, index));

  const scope = { tenantId: TENANT, workspaceId: WORKSPACE, projectId };
  const window = await store.read({ ...scope, limit: 2 });
  assert.equal(window.mode, "snapshot");
  assert.deepEqual(window.events.map(event => event.sequence), [2, 3]);
  assert.equal(window.hasMore, true);
  assert.equal(window.truncatedBefore, true);

  const whole = await store.read({ ...scope, limit: 100 });
  assert.equal(whole.mode, "snapshot");
  assert.deepEqual(whole.events.map(event => event.sequence), [1, 2, 3]);
  assert.equal(whole.hasMore, false);
  assert.equal(whole.truncatedBefore, false);
});

test("a read after a valid cursor replays only the events that follow it", async () => {
  const projectId = "project:events-replay-mode";
  await seedProject(projectId);
  const first = (await store.append(eventInput(projectId, 1))).event;
  await store.append(eventInput(projectId, 2));
  await store.append(eventInput(projectId, 3));

  const scope = { tenantId: TENANT, workspaceId: WORKSPACE, projectId };
  const replay = await store.read({ ...scope, afterCursor: encodeProjectEventCursorV1(first), limit: 100 });
  assert.equal(replay.mode, "replay");
  assert.deepEqual(replay.events.map(event => event.sequence), [2, 3]);
  assert.equal(replay.nextCursor, encodeProjectEventCursorV1(replay.events.at(-1)!));
  assert.equal(replay.hasMore, false);

  const paged = await store.read({ ...scope, afterCursor: encodeProjectEventCursorV1(first), limit: 1 });
  assert.equal(paged.mode, "replay");
  assert.deepEqual(paged.events.map(event => event.sequence), [2]);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.nextCursor, encodeProjectEventCursorV1(paged.events.at(-1)!));
});

test("a stale, tampered, or unparseable cursor resets to a snapshot read instead of throwing", async () => {
  const projectId = "project:events-reset";
  await seedProject(projectId);
  const first = (await store.append(eventInput(projectId, 1))).event;
  await store.append(eventInput(projectId, 2));

  const scope = { tenantId: TENANT, workspaceId: WORKSPACE, projectId };
  const snapshot = await store.read({ ...scope, limit: 100 });
  const stale = Buffer.from(JSON.stringify({ projectId, sequence: 99, eventDigest: first.eventDigest })).toString("base64url");
  const tampered = Buffer.from(JSON.stringify({
    projectId, sequence: 1, eventDigest: `sha256:${"0".repeat(64)}`,
  })).toString("base64url");

  for (const afterCursor of [stale, tampered, "not-a-valid-cursor"]) {
    const page = await store.read({ ...scope, afterCursor, limit: 100 });
    assert.equal(page.mode, "reset");
    assert.deepEqual(page.events.map(event => event.sequence), snapshot.events.map(event => event.sequence));
  }
});

test("an empty stream anchors its first read with an origin cursor", async () => {
  const projectId = "project:events-empty";
  await seedProject(projectId);

  const page = await store.read({ tenantId: TENANT, workspaceId: WORKSPACE, projectId, limit: 10 });
  assert.equal(page.mode, "snapshot");
  assert.deepEqual(page.events, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.truncatedBefore, false);
  assert.equal(page.nextCursor, encodeProjectEventOriginCursorV1(projectId));
});
