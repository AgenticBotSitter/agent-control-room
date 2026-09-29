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

test("0102 confines owner-approval items to visible batches and widens only the intake revision read scope", async () => {
  const migration = await readFile("db/migrations/0102_work_batch_owner_approval.sql", "utf8");
  const down = await readFile("db/down/0102_work_batch_owner_approval.sql", "utf8");
  const statement = (source, head) => source.match(new RegExp(`${head}\\b[\\s\\S]*?;`, "u"))?.[0] ?? "";
  const normalize = source => source.replace(/\s+/gu, " ").replace(/\( /gu, "(").trim();
  const visibleBatch = table => `EXISTS (
    SELECT 1 FROM public.work_batches w
    WHERE w.tenant_id=${table}.tenant_id AND w.id=${table}.batch_id)`;
  const itemScope = `(NOT public.is_work_intake_session() OR (${boundTenant("work_batch_items")}
    AND ${visibleBatch("work_batch_items")}))`;
  assert.match(migration, /ALTER TABLE work_batch_items ENABLE ROW LEVEL SECURITY;/u);
  assert.equal(normalize(statement(migration, "CREATE POLICY work_batch_items_existing_access")), normalize(`
    CREATE POLICY work_batch_items_existing_access ON work_batch_items
      AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);`));
  assert.equal(normalize(statement(migration, "CREATE POLICY work_batch_items_work_intake_scope")), normalize(`
    CREATE POLICY work_batch_items_work_intake_scope ON work_batch_items
      AS RESTRICTIVE FOR ALL USING ${itemScope} WITH CHECK ${itemScope};`));
  const agentEdited = `EXISTS (
    SELECT 1 FROM public.control_identities i
    WHERE i.tenant_id=work_batch_revisions.tenant_id AND i.id=work_batch_revisions.edited_by_identity_id
      AND i.actor_type='agent' AND i.auth_provider='work-intake')`;
  // Read scope only: no WITH CHECK clause, so 0093's insert check still applies.
  assert.equal(normalize(statement(migration, "ALTER POLICY work_batch_revisions_work_intake_scope")), normalize(`
    ALTER POLICY work_batch_revisions_work_intake_scope ON work_batch_revisions
      USING (NOT public.is_work_intake_session() OR (${boundTenant("work_batch_revisions")}
        AND (${agentEdited} OR ${visibleBatch("work_batch_revisions")})));`));
  assert.equal(normalize(statement(down, "ALTER POLICY work_batch_revisions_work_intake_scope")), normalize(`
    ALTER POLICY work_batch_revisions_work_intake_scope ON work_batch_revisions
      USING (NOT public.is_work_intake_session() OR (${boundTenant("work_batch_revisions")} AND ${agentEdited}));`));
  assert.match(down, /DROP POLICY work_batch_items_work_intake_scope ON work_batch_items;\s+DROP POLICY work_batch_items_existing_access ON work_batch_items;\s+ALTER TABLE work_batch_items DISABLE ROW LEVEL SECURITY;/u);
  assert.doesNotMatch(migration, /FORCE ROW LEVEL SECURITY/u);
});

test("the real-Postgres harness supplies the required work-intake bootstrap credential", async () => {
  const harness = await readFile("tests/support/attack-kit/real-postgres.ts", "utf8");
  assert.match(harness,
    /control_room_work_intake_agent:\s*randomBytes\(24\)\.toString\("base64url"\)/u);
  assert.match(harness,
    /CONTROL_ROOM_WORK_INTAKE_PASSWORD:\s*ROLE_PASSWORDS\.control_room_work_intake_agent/u);
});

test("the 0102 rollback preserves the S1 trigger search_path hardening", async () => {
  const down = await readFile("db/down/0102_work_batch_owner_approval.sql", "utf8");
  const restored = down.match(/CREATE OR REPLACE FUNCTION\s+guard_initial_work_batch_revision_insert\s*\([^)]*\)\s+RETURNS[\s\S]*?\$\$[\s\S]*?\$\$\s*;/iu)?.[0] ?? "";
  assert.match(restored, hardenedSearchPath);
  assert.match(restored, /FROM\s+public\.work_batches\s+b/iu);
});

test("0102 pins every owner trigger authority fence and the browser inbox boundary", async () => {
  const migration = await readFile("db/migrations/0102_work_batch_owner_approval.sql", "utf8");
  const count = pattern => migration.match(pattern)?.length ?? 0;
  assert.equal(count(/i\.actor_type='human'\s+AND\s+i\.state='active'/gu), 2);
  assert.equal(count(/g\.role_key='owner'/gu), 2);
  assert.equal(count(/\(g\.revoked_at\s+IS\s+NULL\s+OR\s+g\.revoked_at>pg_catalog\.statement_timestamp\(\)\)\s+AND\s+\(g\.expires_at\s+IS\s+NULL\s+OR\s+g\.expires_at>pg_catalog\.statement_timestamp\(\)\)/gu), 2);
  assert.equal(count(/g\.allowed_actions\s+@>\s+'\["work_batches\.decide"\]'::jsonb\s+OR\s+g\.allowed_actions\s+@>\s+'\["\*"\]'::jsonb/gu), 2);
  assert.match(migration, /pg_catalog\.pg_has_role\(session_user,[\s\S]*?pg_catalog\.pg_roles\s+WHERE\s+rolname='control_room_private_web'\),'member'\)[\s\S]*?OLD\.id\s+NOT\s+LIKE\s+'attention:work-batch:%'/u);
});

test("0102 bounds migration locks and uses bigint counters", async () => {
  const migration = await readFile("db/migrations/0102_work_batch_owner_approval.sql", "utf8");
  assert.match(migration, /SET LOCAL lock_timeout = '1s';\s+SET LOCAL statement_timeout = '5s';\s+ALTER TABLE work_batches/u);
  assert.match(migration, /ADD COLUMN auth_material_version bigint NOT NULL DEFAULT 1/u);
  assert.match(migration, /ordinal bigint NOT NULL CHECK \(ordinal BETWEEN 0 AND 31\)/u);
  assert.match(migration, /job_attempt_count bigint NOT NULL DEFAULT 0/u);
  assert.doesNotMatch(migration, /\b(?:auth_material_version|ordinal|job_attempt_count) integer\b/u);
});

test("0104 confines both agent-queue tables to the bound intake tenant", async () => {
  const migration = await readFile("db/migrations/0104_work_batch_agent_queue.sql", "utf8");
  const down = await readFile("db/down/0104_work_batch_agent_queue.sql", "utf8");
  const statement = (source, head) => source.match(new RegExp(`${head}\\b[\\s\\S]*?;`, "u"))?.[0] ?? "";
  const normalize = source => source.replace(/\s+/gu, " ").replace(/\( /gu, "(").trim();
  for (const table of ["work_batch_agent_queue_heads", "work_batch_queue_admissions"]) {
    const scope = `(NOT public.is_work_intake_session() OR ${boundTenant(table)})`;
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`, "u"));
    assert.equal(normalize(statement(migration, `CREATE POLICY ${table}_existing_access`)), normalize(`
      CREATE POLICY ${table}_existing_access ON ${table}
        AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);`));
    assert.equal(normalize(statement(migration, `CREATE POLICY ${table}_work_intake_scope`)), normalize(`
      CREATE POLICY ${table}_work_intake_scope ON ${table}
        AS RESTRICTIVE FOR ALL USING ${scope} WITH CHECK ${scope};`));
    assert.match(down, new RegExp(`DROP POLICY ${table}_work_intake_scope ON ${table};\\s+DROP POLICY ${table}_existing_access ON ${table};`, "u"));
  }
  assert.doesNotMatch(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /SET LOCAL lock_timeout = '1s';\s+SET LOCAL statement_timeout = '5s';(?:\s+--[^\n]*)*\s+ALTER TABLE work_batch_items/u);
  // Row locks need UPDATE privilege, which the append-only owner web role lacks.
  const guard = migration.match(/CREATE FUNCTION guard_work_batch_queue_admission_insert\(\)[\s\S]*?END \$\$;/u)?.[0] ?? "";
  assert.notEqual(guard, "");
  assert.doesNotMatch(guard, /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u);
});

test("the TypeScript batch admission gate takes no row lock on control_task_model_selections", async () => {
  const source = await readFile("src/web/v1/task-assignment-coordinator.ts", "utf8");
  const guard = source.match(/private async assertWorkBatchQueueAdmission\([\s\S]*?\n {2}webOperation\(\)/u)?.[0] ?? "";
  assert.notEqual(guard, "");
  assert.match(guard, /FROM control_task_model_selections/u);
  // Same reasoning as the migration guard above: neither control_room_private_web
  // nor control_room_task_coordinator holds UPDATE on this append-only table, so
  // a row lock here refuses every batch-admitted assignment in production.
  assert.doesNotMatch(guard, /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u);
});

test("the pipeline admission gate and pipeline service take no row lock on append-only rows", async () => {
  // Row locks need UPDATE privilege. The coordinator and web logins hold none
  // on the pipeline tables, execution plans, model selections or dependency
  // edges, so a lock there refuses every call in production
  // (tests/linear-pipeline-postgres.test.ts runs these paths as the real logins).
  const coordinator = await readFile("src/web/v1/task-assignment-coordinator.ts", "utf8");
  const gate = coordinator.match(/private async assertPipelineAdmission\([\s\S]*?\n {2}private async assertWorkBatchQueueAdmission\(/u)?.[0] ?? "";
  assert.notEqual(gate, "");
  assert.match(gate, /FROM pipeline_stage_runs/u);
  assert.doesNotMatch(gate, /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u);
  const service = await readFile("src/pipelines/v1/service.ts", "utf8");
  assert.match(service, /FROM pipeline_templates/u);
  for (const statement of service.match(/`[^`]*`/gu) ?? [])
    if (/\bFROM (?:pipeline_\w+|control_task_model_selections|control_job_dependencies|control_task_execution_plans)\b/u.test(statement))
      assert.doesNotMatch(statement, /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u, statement);
});

test("pipeline lineage on control_jobs is write-once in the 0105 migration", async () => {
  // Both shared logins hold column UPDATE on the lineage so instantiate and the
  // planner can label a job once; clearing or relabelling it would take a stage
  // out of pipeline admission (tests/linear-pipeline*.test.ts prove the refusal).
  const [migration, down] = await Promise.all([readFile("db/migrations/0105_linear_pipeline_runs.sql", "utf8"),
    readFile("db/down/0105_linear_pipeline_runs.sql", "utf8")]);
  const normalize = source => source.replace(/\s+/gu, " ").trim();
  const body = normalize(migration.match(/CREATE FUNCTION guard_control_job_pipeline_lineage\(\)[\s\S]*?END \$\$;/u)?.[0] ?? "");
  assert.match(body, /RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS/u);
  assert.match(body, /IF \(OLD\.stage_kind IS NOT NULL OR OLD\.stage_ordinal IS NOT NULL OR OLD\.pipeline_run_id IS NOT NULL\) AND \(NEW\.stage_kind IS DISTINCT FROM OLD\.stage_kind OR NEW\.stage_ordinal IS DISTINCT FROM OLD\.stage_ordinal OR NEW\.pipeline_run_id IS DISTINCT FROM OLD\.pipeline_run_id\) THEN RAISE EXCEPTION 'pipeline lineage is write-once';/u);
  assert.doesNotMatch(body, /SECURITY DEFINER/u);
  assert.match(normalize(migration), /REVOKE ALL ON FUNCTION public\.guard_control_job_pipeline_lineage\(\) FROM PUBLIC; CREATE TRIGGER control_jobs_pipeline_lineage_write_once BEFORE UPDATE OF stage_kind, stage_ordinal, pipeline_run_id ON public\.control_jobs FOR EACH ROW EXECUTE FUNCTION public\.guard_control_job_pipeline_lineage\(\);/u);
  // The all-or-none CHECK refuses a partial first write the trigger lets through.
  assert.match(migration, /ADD CONSTRAINT ck_control_jobs_pipeline_columns_all_or_none CHECK/u);
  assert.match(normalize(down), /DROP TRIGGER control_jobs_pipeline_lineage_write_once ON control_jobs; DROP FUNCTION guard_control_job_pipeline_lineage\(\);/u);
});
