// Migration 0086: the real restricted private-web role may register exactly the
// fixed Mac-local "Owner review" profile through the production completion-gate
// store, and nothing looser. Applies db/roles/private_web_roles.sql for real and
// drops to a login that inherits only that role.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { adaptPglite } from "../src/persistence/database";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/rollback-checkpoint";
import { createMacLocalOwnerReviewProfileV1 } from "../src/web/v1/mac-local-owner-review-profile";

const NOW = "2026-09-25T12:00:00.000Z";
const digest = (c: string) => `sha256:${c.repeat(64)}`;

async function seed(revokedOwner = false) {
  const pg = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(f => f.endsWith(".sql")).sort())
    await pg.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await pg.exec(`
    INSERT INTO tenants(id,display_name) VALUES('tenant:a','A'),('tenant:b','B');
    INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:a','tenant:a','A');
    INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at) VALUES
      ('identity:owner','tenant:a','human','Owner','test','${digest("a")}','active','${NOW}','${NOW}'),
      ('identity:agent','tenant:a','agent','Agent','test','${digest("b")}','active','${NOW}','${NOW}'),
      ('identity:other','tenant:b','human','Other','test','${digest("c")}','active','${NOW}','${NOW}'),
      ('identity:nonowner','tenant:a','human','Nonowner','test','${digest("d")}','active','${NOW}','${NOW}');
    INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,revoked_at,created_at,updated_at)
      VALUES('grant:owner','tenant:a','identity:owner','owner','["*"]','["*"]','high',${revokedOwner ? `'${NOW}'` : "NULL"},'${NOW}','${NOW}');
    INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES('adapter:test','tenant:a','control-room-manual','1.0.0','control_room_native','disabled','v1',30);
    INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES('project:alpha','tenant:a','workspace:a','adapter:test','project:alpha','1','Alpha','Seed','running','seed','healthy','control_room_native','${NOW}','{}','${NOW}');
    INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES('tenant:a','project:alpha','active',1,'${NOW}','${NOW}');`);
  const db = adaptPglite(pg);
  const key = new Uint8Array(32).fill(7);
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  // First-owner setup runs with operator authority, before the web login exists.
  await new CompletionGateStoreV1(db, key, checkpoints).provisionTenant("tenant:a");
  await pg.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await pg.exec(`CREATE ROLE web_login_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_private_web TO web_login_test;
    SET SESSION AUTHORIZATION web_login_test;
    SET search_path = pg_catalog, public;`);
  return { pg, store: new CompletionGateStoreV1(db, key, checkpoints) };
}

const fixed = () => createMacLocalOwnerReviewProfileV1({ tenantId: "tenant:a", projectId: "project:alpha",
  ownerIdentityId: "identity:owner", projectCreatedAt: NOW });

test("the web login registers the fixed owner-review profile, and a restart replays it", async t => {
  const { pg, store } = await seed(); t.after(() => pg.close());
  const first = await store.registerProfile(fixed());
  assert.equal(first.replayed, false);
  const again = await store.registerProfile(fixed());
  assert.equal(again.replayed, true);
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_completion_gate_records WHERE kind='profile'");
  assert.equal(rows.rows[0]?.n, 1);
});

for (const [name, change] of [
  ["automatic low-risk disposition", (p: Record<string, unknown>) => ({ ...p, automaticLowRiskDisposition: true })],
  ["more revision rounds", (p: Record<string, unknown>) => ({ ...p, maximumRevisionRounds: 5 })],
  ["fewer reviewers", (p: Record<string, unknown>) => ({ ...p, minimumIndependentReviews: 0 })],
  ["no producer separation", (p: Record<string, unknown>) => ({ ...p, verificationRequiresProducerSeparation: false })],
  ["a different name", (p: Record<string, unknown>) => ({ ...p, name: "Relaxed review" })],
  ["a different id", (p: Record<string, unknown>) => ({ ...p, id: "profile:other" })],
  ["an agent author", (p: Record<string, unknown>) => ({ ...p, createdBy: { actorId: "identity:agent", actorType: "human" } })],
  ["a same-tenant non-owner author", (p: Record<string, unknown>) => ({ ...p, createdBy: { actorId: "identity:nonowner", actorType: "human" } })],
  ["another tenant's author", (p: Record<string, unknown>) => ({ ...p, createdBy: { actorId: "identity:other", actorType: "human" } })],
  ["an unknown author", (p: Record<string, unknown>) => ({ ...p, createdBy: { actorId: "identity:ghost", actorType: "human" } })],
] as const) test(`the web login cannot register a profile with ${name}`, async t => {
  const { pg, store } = await seed(); t.after(() => pg.close());
  await assert.rejects(store.registerProfile(change(fixed() as unknown as Record<string, unknown>)));
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_completion_gate_records");
  assert.equal(rows.rows[0]?.n, 0);
});

test("the web login cannot use a revoked owner grant", async t => {
  const { pg, store } = await seed(true); t.after(() => pg.close());
  await assert.rejects(store.registerProfile(fixed()), /private quality insert rejected/);
});

test("a long project id admits only its own digest-form profile id", async t => {
  const { pg, store } = await seed(); t.after(() => pg.close());
  const longId = `project:${"l".repeat(160)}`;
  await pg.exec(`RESET SESSION AUTHORIZATION;
    INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES('${longId}','tenant:a','workspace:a','adapter:test','${longId}','1','Long','Seed','running','seed','healthy','control_room_native','${NOW}','{}','${NOW}');
    INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES('tenant:a','${longId}','active',1,'${NOW}','${NOW}');
    SET SESSION AUTHORIZATION web_login_test; SET search_path = pg_catalog, public;`);
  const profile = createMacLocalOwnerReviewProfileV1({ tenantId: "tenant:a", projectId: longId,
    ownerIdentityId: "identity:owner", projectCreatedAt: NOW });
  assert.match(profile.id, /^profile:mac-local-owner-review:[a-f0-9]{32}$/u);
  await assert.rejects(store.registerProfile({ ...profile, id: `profile:mac-local-owner-review:${"0".repeat(32)}` }));
  assert.equal((await store.registerProfile(profile)).replayed, false);
});

test("the web login still cannot register a review target", async t => {
  const { pg } = await seed(); t.after(() => pg.close());
  await assert.rejects(pg.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,parent_id,
    record_digest,record_auth_tag,payload,occurred_at) VALUES('target:x','tenant:a','project:alpha','target','k','s',NULL,
    '${digest("d")}','hmac-sha256:${"e".repeat(64)}','{"id":"target:x","tenantId":"tenant:a","projectId":"project:alpha"}','${NOW}')`),
    /private quality insert rejected/);
});
