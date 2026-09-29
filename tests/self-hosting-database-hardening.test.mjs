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

test("work-intake shared-ledger policies remain restrictive and session-scoped", async () => {
  const migration = await readFile("db/migrations/0093_work_batch_intake.sql", "utf8");
  const policy = name => migration.match(new RegExp(`CREATE POLICY\\s+${name}\\b[\\s\\S]*?;`, "u"))?.[0] ?? "";
  const normalize = source => source.replace(/\s+/gu, " ").trim();
  const idempotency = policy("control_idempotency_work_intake_scope");
  const audit = policy("audit_events_work_intake_scope");
  assert.equal(normalize(idempotency), normalize(`
    CREATE POLICY control_idempotency_work_intake_scope ON control_idempotency
      AS RESTRICTIVE FOR ALL
      USING (NOT public.is_work_intake_session()
        OR operation_scope ~ '^work-batches\\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
      WITH CHECK (NOT public.is_work_intake_session()
        OR operation_scope ~ '^work-batches\\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$');`));
  assert.equal(normalize(audit), normalize(`
    CREATE POLICY audit_events_work_intake_scope ON audit_events
      AS RESTRICTIVE FOR ALL
      USING (NOT public.is_work_intake_session()
        OR (id ~ '^audit:work-intake[-:]' AND action IN (
          'work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')))
      WITH CHECK (NOT public.is_work_intake_session()
        OR (id ~ '^audit:work-intake[-:]' AND action IN (
          'work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')));`));
});

test("the real-Postgres harness supplies the required work-intake bootstrap credential", async () => {
  const harness = await readFile("tests/support/attack-kit/real-postgres.ts", "utf8");
  assert.match(harness,
    /control_room_work_intake_agent:\s*randomBytes\(24\)\.toString\("base64url"\)/u);
  assert.match(harness,
    /CONTROL_ROOM_WORK_INTAKE_PASSWORD:\s*ROLE_PASSWORDS\.control_room_work_intake_agent/u);
});

test("the 0094 rollback preserves the S1 trigger search_path hardening", async () => {
  const down = await readFile("db/down/0094_work_batch_owner_approval.sql", "utf8");
  const restored = down.match(/CREATE OR REPLACE FUNCTION\s+guard_initial_work_batch_revision_insert\s*\([^)]*\)\s+RETURNS[\s\S]*?\$\$[\s\S]*?\$\$\s*;/iu)?.[0] ?? "";
  assert.match(restored, hardenedSearchPath);
  assert.match(restored, /FROM\s+public\.work_batches\s+b/iu);
});

test("0094 pins every owner trigger authority fence and the browser inbox boundary", async () => {
  const migration = await readFile("db/migrations/0094_work_batch_owner_approval.sql", "utf8");
  const count = pattern => migration.match(pattern)?.length ?? 0;
  assert.equal(count(/i\.actor_type='human'\s+AND\s+i\.state='active'/gu), 2);
  assert.equal(count(/g\.role_key='owner'/gu), 2);
  assert.equal(count(/\(g\.revoked_at\s+IS\s+NULL\s+OR\s+g\.revoked_at>pg_catalog\.statement_timestamp\(\)\)\s+AND\s+\(g\.expires_at\s+IS\s+NULL\s+OR\s+g\.expires_at>pg_catalog\.statement_timestamp\(\)\)/gu), 2);
  assert.equal(count(/g\.allowed_actions\s+@>\s+'\["work_batches\.decide"\]'::jsonb\s+OR\s+g\.allowed_actions\s+@>\s+'\["\*"\]'::jsonb/gu), 2);
  assert.match(migration, /pg_catalog\.pg_has_role\(session_user,[\s\S]*?pg_catalog\.pg_roles\s+WHERE\s+rolname='control_room_private_web'\),'member'\)[\s\S]*?OLD\.id\s+NOT\s+LIKE\s+'attention:work-batch:%'/u);
});
