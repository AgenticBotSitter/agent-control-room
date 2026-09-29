import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const functionStatement = /CREATE(?: OR REPLACE)? FUNCTION\s+([a-z0-9_]+)\s*\([^)]*\)\s+RETURNS[\s\S]*?\$\$[\s\S]*?\$\$\s*;/giu;
const hardenedSearchPath = /SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp(?=\s+(?:AS|\$\$))/iu;

test("self-hosting SECURITY DEFINER and trigger functions put pg_temp last", async () => {
  const names = (await readdir("db/migrations"))
    .filter(name => /^0(?:09[3-9]|1\d{2})_.*\.sql$/u.test(name))
    .sort();
  const missing = [];
  for (const name of names) {
    const source = await readFile(`db/migrations/${name}`, "utf8");
    for (const match of source.matchAll(functionStatement)) {
      const statement = match[0];
      if (/RETURNS\s+trigger\b/iu.test(statement) || /SECURITY\s+DEFINER/iu.test(statement)) {
        if (!hardenedSearchPath.test(statement)) missing.push(`${name}:${match[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `unsafe function search_path: ${missing.join(", ")}`);
});

test("production restricted roles cannot create temporary database objects", async () => {
  const [provision, roles, databaseAcl] = await Promise.all([
    readFile("db/roles/production_provision.sql", "utf8"),
    readFile("db/roles/production_roles.sql", "utf8"),
    readFile("db/roles/private_web_database.sql", "utf8")]);
  for (const source of [provision, roles, databaseAcl]) {
    assert.match(source, /REVOKE\s+(?:CREATE,\s*)?TEMPORARY\s+ON\s+DATABASE\s+%I\s+FROM\s+PUBLIC/iu);
  }
  const expectedRoles = new Map([
    [roles, ["control_room_application", "control_room_reader", "control_room_backup",
      "control_room_schedule_admissions", "control_room_github_broker", "control_room_work_intake"]],
    [provision, ["control_room_application", "control_room_app", "control_room_schedule_admissions",
      "control_room_scheduler", "control_room_github_broker", "control_room_work_intake",
      "control_room_work_intake_agent"]],
  ]);
  for (const [source, roleNames] of expectedRoles) {
    for (const role of roleNames) {
      assert.match(source,
        new RegExp(`REVOKE\\s+TEMPORARY\\s+ON\\s+DATABASE\\s+%I\\s+FROM\\s+${role}\\b`, "u"));
    }
  }
});

const boundTenant = table =>
  `${table}.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b)`;

test("work-intake login is bound to one owner-written tenant", async () => {
  const [migration, grants] = await Promise.all([readFile("db/migrations/0093_work_batch_intake.sql", "utf8"),
    readFile("db/roles/production_table_grants.sql", "utf8")]);
  const normalize = source => source.replace(/\s+/gu, " ").trim();
  assert.match(normalize(migration), new RegExp(normalize(`CREATE TABLE work_intake_tenant_binding (
    singleton boolean PRIMARY KEY CHECK (singleton),
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT
  ); REVOKE ALL ON work_intake_tenant_binding FROM PUBLIC;`).replace(/[()]/gu, "\\$&"), "u"));
  assert.match(normalize(grants), /REVOKE ALL ON work_intake_tenant_binding FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions, control_room_github_broker; GRANT SELECT ON work_intake_tenant_binding TO control_room_application, control_room_reader, control_room_backup, control_room_work_intake;/u);
  // Every role that evaluates the intake policies can read the binding and nothing more.
  const roleFiles = (await readdir("db/roles")).filter(name => name.endsWith(".sql")).sort();
  for (const file of roleFiles) {
    const source = await readFile(`db/roles/${file}`, "utf8");
    assert.doesNotMatch(source, /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*\bwork_intake_tenant_binding\b/u, file);
    for (const [, role] of source.matchAll(/GRANT EXECUTE ON FUNCTION is_work_intake_session\(\) TO (control_room_[a-z_]+);/gu))
      assert.match(source, new RegExp(`GRANT SELECT ON work_intake_tenant_binding TO ${role};`, "u"), `${file} ${role}`);
  }
});

test("work-intake shared-ledger policies remain restrictive, session-scoped and tenant-bound", async () => {
  const migration = await readFile("db/migrations/0093_work_batch_intake.sql", "utf8");
  const policy = name => migration.match(new RegExp(`CREATE POLICY\\s+${name}\\b[\\s\\S]*?;`, "u"))?.[0] ?? "";
  const normalize = source => source.replace(/\s+/gu, " ").trim();
  const idempotency = policy("control_idempotency_work_intake_scope");
  const audit = policy("audit_events_work_intake_scope");
  assert.equal(normalize(idempotency), normalize(`
    CREATE POLICY control_idempotency_work_intake_scope ON control_idempotency
      AS RESTRICTIVE FOR ALL
      USING (NOT public.is_work_intake_session()
        OR (${boundTenant("control_idempotency")}
          AND operation_scope ~ '^work-batches\\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'))
      WITH CHECK (NOT public.is_work_intake_session()
        OR (${boundTenant("control_idempotency")}
          AND operation_scope ~ '^work-batches\\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'));`));
  assert.equal(normalize(audit), normalize(`
    CREATE POLICY audit_events_work_intake_scope ON audit_events
      AS RESTRICTIVE FOR ALL
      USING (NOT public.is_work_intake_session()
        OR (${boundTenant("audit_events")} AND id ~ '^audit:work-intake[-:]' AND action IN (
          'work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')))
      WITH CHECK (NOT public.is_work_intake_session()
        OR (${boundTenant("audit_events")} AND id ~ '^audit:work-intake[-:]' AND action IN (
          'work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')));`));
});

test("work-intake proposal tables stay confined to the bound tenant's registered intake identities", async () => {
  const migration = await readFile("db/migrations/0093_work_batch_intake.sql", "utf8");
  const policy = name => migration.match(new RegExp(`CREATE POLICY\\s+${name}\\b[\\s\\S]*?;`, "u"))?.[0] ?? "";
  const normalize = source => source.replace(/\s+/gu, " ").replace(/\( /gu, "(").trim();
  const bound = (table, identity) => `(${boundTenant(table)} AND EXISTS (
    SELECT 1 FROM public.control_identities i
    WHERE i.tenant_id=${table}.tenant_id AND i.id=${table}.${identity}
      AND i.actor_type='agent' AND i.auth_provider='work-intake'))`;
  for (const [table, identity] of [["work_batches", "proposed_by_identity_id"],
    ["work_batch_revisions", "edited_by_identity_id"]]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`, "u"));
    assert.equal(normalize(policy(`${table}_existing_access`)), normalize(`
      CREATE POLICY ${table}_existing_access ON ${table}
        AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);`));
    assert.equal(normalize(policy(`${table}_work_intake_scope`)), normalize(`
      CREATE POLICY ${table}_work_intake_scope ON ${table}
        AS RESTRICTIVE FOR ALL
        USING (NOT public.is_work_intake_session() OR ${bound(table, identity)})
        WITH CHECK (NOT public.is_work_intake_session() OR ${bound(table, identity)});`));
  }
  assert.doesNotMatch(migration, /FORCE ROW LEVEL SECURITY/u);
});

test("the real-Postgres harness supplies the required work-intake bootstrap credential", async () => {
  const harness = await readFile("tests/support/attack-kit/real-postgres.ts", "utf8");
  assert.match(harness,
    /control_room_work_intake_agent:\s*randomBytes\(24\)\.toString\("base64url"\)/u);
  assert.match(harness,
    /CONTROL_ROOM_WORK_INTAKE_PASSWORD:\s*ROLE_PASSWORDS\.control_room_work_intake_agent/u);
});
