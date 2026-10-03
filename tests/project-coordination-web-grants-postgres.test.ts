// Real-PostgreSQL proof that the production private-web login can serve the
// project coordination page (GET /api/v1/projects/:projectId/coordination).
//
// Both deployments serve that route from the web login whose only group is
// control_room_private_web: the hosted private web and the Mac-local
// installation (control_room_web, scripts/mac-local/narrow-role-provision.mjs)
// both reach createProjectCoordinationCanonicalStoreAdapterV1 through
// private-task-startup.ts with the web pool, and verifyPrivateDatabase refuses
// any web login holding another role. composeProjectCoordinationPage reads
// attention_items (attentionList) and control_job_dependencies
// (readDependencies) on every read, so the role files must grant exactly those
// columns, and the startup preflight must accept exactly that grant.
//
// The attack kit provisions its own disposable cluster with the real migration
// applier and the real db/roles files, so nothing here grants the web role
// anything the role files do not.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { verifyPrivateDatabase, privateWebReadColumns } from "../src/web/v1/private-database-preflight";
import {
  ProjectCoordinationHttpService,
  createProjectCoordinationCanonicalStoreAdapterV1,
} from "../src/web/v1/project-coordination-http";
import { projectCoordinationPageSchema } from "../src/web/v1/project-coordination-wire";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";

// Reserved disposable-cluster lane: 58290-58299.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58290);
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => {
  if (PG) { required += 1; return undefined; }
  return { skip: realPostgresSkipMessage() };
};

const PROVIDER = "test";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();
const ids = (tenant: "a" | "b") => ({
  tenant: `tenant:coord-grants-${tenant}`, workspace: `workspace:coord-grants-${tenant}`,
  adapter: `adapter:coord-grants-${tenant}`, project: `project:coord-grants-${tenant}`,
  identity: `identity:coord-grants-owner-${tenant}`, grant: `grant:coord-grants-owner-${tenant}`,
  request: `request:coord-grants-${tenant}`, workflow: `workflow:coord-grants-${tenant}`,
  jobFirst: `job:coord-grants-${tenant}-first`, jobSecond: `job:coord-grants-${tenant}-second`,
});
const A = ids("a"), B = ids("b");
const tokenDigest = sha256Digest({ session: "coord-grants-owner-a" });
// Exactly the columns attentionList() and readDependencies() name, including
// their WHERE and JOIN columns.
const COMPOSER_COLUMNS = {
  attention_items: ["id", "tenant_id", "project_id", "attention_type", "title", "summary", "due_at",
    "observed_at", "work_item_id"],
  control_job_dependencies: ["tenant_id", "job_id", "depends_on_job_id"],
} as const;

async function seedTenant(admin: Client, t: ReturnType<typeof ids>) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [t.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [t.workspace, t.tenant]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [t.adapter, t.tenant]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [t.project, t.tenant, t.workspace, t.adapter]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [t.tenant, t.project]);
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [t.identity, t.tenant, PROVIDER, sha256Digest({ provider: PROVIDER, subject: t.identity }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
     require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
  [t.grant, t.tenant, t.identity, ISSUED_AT]);
  await admin.query(`INSERT INTO control_requests
    (id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'projectId',$3::text,
      'state','accepted','version',0,'idempotencyKey',$1::text),now(),now())`, [t.request, t.tenant, t.project]);
  await admin.query(`INSERT INTO control_workflows
    (id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',0,jsonb_build_object('id',$1::text,'tenantId',$2::text,'requestId',$3::text,
      'projectId',$4::text,'definitionDigest',$5::text,'state','active','version',0),now(),now())`,
  [t.workflow, t.tenant, t.request, t.project, DIGEST]);
  for (const job of [t.jobFirst, t.jobSecond]) {
    await admin.query(`INSERT INTO control_jobs
      (id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,
       created_at,updated_at)
      VALUES($1,$2,$3,$4,'ready',0,50,'fixture',$5,jsonb_build_object('id',$1::text,'tenantId',$2::text,
        'workflowId',$3::text,'projectId',$4::text,'state','ready','version',0,'priority',50,
        'requiredCapability','fixture','authority',jsonb_build_object('digest',$5::text)),now(),now())`,
    [job, t.tenant, t.workflow, t.project, DIGEST]);
  }
  await admin.query("INSERT INTO control_job_dependencies(tenant_id,job_id,depends_on_job_id) VALUES($1,$2,$3)",
    [t.tenant, t.jobSecond, t.jobFirst]);
  // One overdue approval and one open question; payload and deep_link carry
  // values the web role must never be able to read.
  for (const [suffix, type, due] of [["approval", "approval", PAST], ["question", "question", null]] as const) {
    await admin.query(`INSERT INTO attention_items
      (id,tenant_id,workspace_id,project_id,adapter_id,source_record_id,source_version,attention_type,title,summary,
       deep_link,due_at,created_at_source,observed_at,payload)
      VALUES($1,$2,$3,$4,$5,$1,'1',$6,$7,$8,'https://internal.invalid/secret',$9,now(),now(),'{"secret":true}')`,
    [`attention-${suffix}-${t.tenant}`, t.tenant, t.workspace, t.project, t.adapter, type,
      `${suffix} title ${t.tenant}`, `${suffix} summary ${t.tenant}`, due]);
  }
}

test("the production private-web login passes preflight and serves the coordination page", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedTenant(admin, A);
      await seedTenant(admin, B);
      await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5)`, [A.tenant, tokenDigest, A.identity, ISSUED_AT, EXPIRES_AT]);
    } finally { await admin.end(); }

    // The exact production pool, driver and session qualification for the
    // web login. Only the transport differs: the kit cluster is socket-only.
    const login = postgres.connection("web");
    const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
      username: login.user, password: login.password, majorVersion: 17 as const };
    const web = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
    try {
      // The startup gate every deployment runs before serving: exact role
      // membership and exact column privileges for the web login.
      await verifyPrivateDatabase(web.client, config, { tenantId: A.tenant, workspaceId: A.workspace,
        ownerIdentityId: A.identity, issuer: PROVIDER }, Date.now(), { nativeQueue: true });

      const store = createProjectCoordinationCanonicalStoreAdapterV1({
        database: web.client, tenantId: A.tenant, workspaceId: A.workspace });
      const service = new ProjectCoordinationHttpService({ database: web.client,
        scope: { tenantId: A.tenant, workspaceId: A.workspace }, clock: () => Date.now(), store });
      const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: A.identity, tokenDigest,
        issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };
      // The driver reduces a server refusal to its SQLSTATE; 42501 is
      // insufficient_privilege ("permission denied for table ...").
      const read = await service.read(identity, A.project).catch((error: unknown) => {
        const sqlState = (error as { sqlState?: unknown } | null)?.sqlState;
        assert.fail(`coordination page read failed: ${String(error)} sqlState=${String(sqlState)}`
          + (sqlState === "42501" ? " (permission denied)" : ""));
      });
      const page = projectCoordinationPageSchema.parse(read);
      assert.equal(page.project.projectId, A.project);
      assert.deepEqual(page.dependencies, [{ fromJobId: A.jobSecond, toJobId: A.jobFirst, required: true }]);
      assert.deepEqual(page.attention.map(item => [item.category, item.severity, item.ownerQuestion]).sort(), [
        ["approval", "urgent", `approval summary ${A.tenant}`],
        ["uncertainty", "normal", `question summary ${A.tenant}`],
      ]);
      assert.notEqual(page.versions.attentionVersion, 0);
      assert.doesNotMatch(JSON.stringify(page), /coord-grants-b|secret/);
    } finally { await web.close(); }

    // Least privilege: exactly the composer's columns, and no writes beyond
    // appending the dependency edge of an owner-authored dependent proposal
    // (tests/linear-pipeline-postgres.test.ts).
    const direct = new Client(login);
    await direct.connect();
    try {
      for (const [table, columns] of Object.entries(COMPOSER_COLUMNS))
        await direct.query(`SELECT ${columns.join(",")} FROM ${table} LIMIT 1`);
      for (const statement of [
        "SELECT * FROM attention_items",
        "SELECT payload FROM attention_items",
        "SELECT deep_link FROM attention_items",
        "SELECT source_record_id FROM attention_items",
        "UPDATE attention_items SET summary='x'",
        "DELETE FROM attention_items",
        `INSERT INTO attention_items(id) VALUES('attention:forged')`,
        "UPDATE control_job_dependencies SET job_id=job_id",
        "DELETE FROM control_job_dependencies",
        "TRUNCATE attention_items",
      ]) await assert.rejects(direct.query(statement), /permission denied/, statement);
    } finally { await direct.end(); }

    // The startup gate accepts exactly the composer's columns: its allowlist
    // matches them, and a table-wide SELECT (which would expose payload and
    // deep_link) makes every deployment refuse to start.
    assert.deepEqual(privateWebReadColumns, COMPOSER_COLUMNS);
    const widened = new Client(postgres.admin({ database: postgres.database }));
    await widened.connect();
    const gate = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
    try {
      await widened.query("GRANT SELECT ON attention_items TO control_room_private_web");
      await assert.rejects(verifyPrivateDatabase(gate.client, config, { tenantId: A.tenant, workspaceId: A.workspace,
        ownerIdentityId: A.identity, issuer: PROVIDER }, Date.now(), { nativeQueue: true }),
      /private_database_preflight_failed/);
    } finally { await gate.close(); await widened.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 150_000 });
});

test("the coordination-grant real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1);
  assert.equal(ran, required);
});
