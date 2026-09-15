// Item 1 proof: the real restricted private-web role can perform an allowed
// coordinator lifecycle action and still cannot exceed its authority.
// Applies db/roles/private_web_roles.sql for real, drops to the role with
// SET ROLE, then drives the production CanonicalStore path.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { adaptPglite } from "../src/persistence/database";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { coordinatorLifecycleRequestDigestV1 } from "../src/project-coordination/v1/schemas";

const NOW = "2026-09-10T12:00:00.000Z";
const TENANT = "tenant:test";
const DIGEST_A = `sha256:${"a".repeat(64)}`;

async function seed() {
  const db = new PGlite();
  for (const file of (await readdir("db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Test workspace')");
  await db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:owner','tenant:test','human','Owner','test','${DIGEST_A}','active','${NOW}','${NOW}'),
          ('identity:coord-a','tenant:test','human','Coord A','test','sha256:${"b".repeat(64)}','active','${NOW}','${NOW}')`);
  await db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:test','tenant:test','identity:owner','owner','[\"*\"]','[\"*\"]','critical',true,false,'${NOW}','${NOW}')`);
  await db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:test','tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`);
  await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES('project:alpha','tenant:test','workspace:test','adapter:test','project:alpha','1','Alpha','Seed','running','seed','healthy','control_room_native','${NOW}','{}','${NOW}')`);
  await db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:alpha','active',1,'${NOW}','${NOW}')`);
  // Real restricted role, exactly as the operator setup grants it.
  await db.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await db.exec(`CREATE ROLE coord_web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_private_web TO coord_web_test;
    SET SESSION AUTHORIZATION coord_web_test;
    SET search_path = pg_catalog, public;`);
  return db;
}

function appointment(key: string) {
  const operation = "appoint" as const;
  const appointment = {
    tenantId: TENANT,
    projectId: "project:alpha",
    ownerIdentityId: "identity:owner",
    coordinatorIdentityId: "identity:coord-a",
    coordinatorActorType: "human" as const,
    occurredAt: NOW,
  };
  return {
    operation,
    appointment,
    idempotencyKey: key,
    requestDigest: coordinatorLifecycleRequestDigestV1({ operation, appointment, expectedVersion: 0 }),
    expectedVersion: 0,
  };
}

test("the restricted private-web role appoints a coordinator and cannot exceed its authority", async (t) => {
  const db = await seed();
  t.after(async () => { await db.exec("RESET SESSION AUTHORIZATION").catch(() => {}); void db.close(); });
  const store = new CanonicalStore(adaptPglite(db));
  // Allowed lifecycle action succeeds under the restricted role.
  const receipt = await store.assignProjectCoordinatorV1(appointment("role-proof-key-001"));
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.operation, "appoint");
  // Authority boundary: the role can neither delete, escalate, nor read
  // operator internals.
  await assert.rejects(db.query("DELETE FROM tenants WHERE true"), /permission denied|not permitted/);
  await assert.rejects(db.query("UPDATE tenants SET display_name='x' WHERE id='tenant:test'"), /permission denied|not permitted/);
  await assert.rejects(db.query("SELECT * FROM control_room_schema_migrations"), /permission denied|not permitted|does not exist/);
  await assert.rejects(
    db.query("UPDATE control_idempotency SET request_digest='sha256:${\"0\".repeat(64)}' WHERE true"),
    /permission denied|not permitted/);
});
