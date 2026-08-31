import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CONTROL_ROOM_IDEA_ADAPTER_V1,
  IdeaLabErrorV1,
  IdeaLabProjectRegistryStoreV1,
  buildIdeaLabFixtureV1,
} from "../src/idea-lab/v1/index.ts";
import { adaptPglite } from "../src/persistence/database.ts";

const key = new Uint8Array(32).fill(0x4b);

async function setup() {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((entry) => entry.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:owner','Owner')`);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:control-room','tenant:owner','Control Room')`);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,project_types,
    supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES($1,'tenant:owner','control_room_native_ideas','control-room-idea-lab-session/v1','control_room_native','fixture',
    '["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'redaction-v1',30)`, [CONTROL_ROOM_IDEA_ADAPTER_V1]);
  return { raw, store: new IdeaLabProjectRegistryStoreV1(adaptPglite(raw), key) };
}

async function populate(store: IdeaLabProjectRegistryStoreV1) {
  const fixture = buildIdeaLabFixtureV1();
  assert.equal((await store.registerSession(fixture.session)).replayed, false);
  for (const contribution of fixture.contributions) assert.equal((await store.recordContribution(contribution)).replayed, false);
  assert.equal((await store.recordSynthesis(fixture.synthesis)).replayed, false);
  const result = await store.recordDecision(fixture.decision);
  assert.equal(result.replayed, false); assert.ok(result.project);
  return { fixture, project: result.project };
}

test("CR12B-IDEA-010 persists a complete panel and atomically promotes the owner-approved project", async () => {
  const target = await setup();
  try {
    const { fixture, project } = await populate(target.store);
    assert.equal(project.lifecycleState, "active"); assert.equal(project.version, 1);
    assert.equal((await target.store.listProjects(fixture.session.tenantId)).length, 1);
    assert.equal((await target.raw.query(`SELECT * FROM control_idea_sessions`)).rows.length, 1);
    assert.equal((await target.raw.query(`SELECT * FROM control_idea_contributions`)).rows.length, 4);
    assert.equal((await target.raw.query(`SELECT * FROM control_idea_decisions`)).rows.length, 1);
    assert.equal((await target.raw.query(`SELECT * FROM control_project_lifecycle_events`)).rows.length, 1);
  } finally { await target.raw.close(); }
});
test("CR12B-IDEA-010 supports exact replay and verifies persisted records through a fresh store instance", async () => {
  const target = await setup();
  try {
    const { fixture, project } = await populate(target.store);
    assert.equal((await target.store.registerSession(fixture.session)).replayed, true);
    for (const contribution of fixture.contributions) assert.equal((await target.store.recordContribution(contribution)).replayed, true);
    assert.equal((await target.store.recordSynthesis(fixture.synthesis)).replayed, true);
    assert.equal((await target.store.recordDecision(fixture.decision)).replayed, true);
    const reopened = new IdeaLabProjectRegistryStoreV1(adaptPglite(target.raw), key);
    assert.deepEqual(await reopened.getProject(project.tenantId, project.projectId), project);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-010 persists pause, resume, completion, archive, and reopen without losing history", async () => {
  const target = await setup();
  try {
    const { fixture, project } = await populate(target.store); let current = project;
    for (const [toState, occurredAt] of [["paused", "2026-08-31T16:09:00.000Z"], ["active", "2026-08-31T16:10:00.000Z"],
      ["completed", "2026-08-31T16:11:00.000Z"], ["archived", "2026-08-31T16:12:00.000Z"]] as const) {
      current = await target.store.transitionProject({ tenantId: current.tenantId, projectId: current.projectId,
        expectedVersion: current.version, toState, actorIdentityDigest: fixture.decision.ownerIdentityDigest,
        safeReasonCode: `owner_${toState}`, occurredAt });
    }
    assert.equal(current.lifecycleState, "archived"); assert.equal(current.version, 5);
    assert.equal((await target.store.listProjects(current.tenantId)).length, 0);
    assert.equal((await target.store.listProjects(current.tenantId, { includeArchived: true })).length, 1);
    current = await target.store.transitionProject({ tenantId: current.tenantId, projectId: current.projectId,
      expectedVersion: current.version, toState: "active", actorIdentityDigest: fixture.decision.ownerIdentityDigest,
      safeReasonCode: "owner_reopened", occurredAt: "2026-08-31T16:13:00.000Z" });
    assert.equal(current.lifecycleState, "active"); assert.equal(current.version, 6);
    assert.equal((await target.raw.query(`SELECT * FROM control_project_lifecycle_events`)).rows.length, 6);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-010 rejects invalid and stale transitions atomically", async () => {
  const target = await setup();
  try {
    const { fixture, project } = await populate(target.store);
    await assert.rejects(target.store.transitionProject({ tenantId: project.tenantId, projectId: project.projectId,
      expectedVersion: 1, toState: "archived", actorIdentityDigest: fixture.decision.ownerIdentityDigest,
      safeReasonCode: "skip_states", occurredAt: "2026-08-31T16:09:00.000Z" }), (error: unknown) => error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict");
    const paused = await target.store.transitionProject({ tenantId: project.tenantId, projectId: project.projectId,
      expectedVersion: 1, toState: "paused", actorIdentityDigest: fixture.decision.ownerIdentityDigest,
      safeReasonCode: "owner_paused", occurredAt: "2026-08-31T16:09:00.000Z" });
    await assert.rejects(target.store.transitionProject({ tenantId: project.tenantId, projectId: project.projectId,
      expectedVersion: 1, toState: "completed", actorIdentityDigest: fixture.decision.ownerIdentityDigest,
      safeReasonCode: "stale_owner", occurredAt: "2026-08-31T16:10:00.000Z" }), (error: unknown) => error instanceof IdeaLabErrorV1 && error.safeCode === "state_conflict");
    assert.equal(paused.version, 2); assert.equal((await target.raw.query(`SELECT * FROM control_project_lifecycle_events`)).rows.length, 2);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-010 append-only evidence rejects mutation and project projection tampering is detected", async () => {
  const target = await setup();
  try {
    const { project } = await populate(target.store);
    await assert.rejects(target.raw.query(`UPDATE control_idea_sessions SET payload='{}'::jsonb`));
    await assert.rejects(target.raw.query(`DELETE FROM control_project_lifecycle_events`));
    await target.raw.query(`UPDATE projects SET title='Tampered title' WHERE id=$1`, [project.projectId]);
    await assert.rejects(target.store.getProject(project.tenantId, project.projectId),
      (error: unknown) => error instanceof IdeaLabErrorV1 && error.safeCode === "integrity_failed");
  } finally { await target.raw.close(); }
});
