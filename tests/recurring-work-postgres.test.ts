// Real-PostgreSQL proof for M6. The rule/skill owner path runs as the
// production web login, due-rule bookkeeping runs as the production task
// coordinator login, and S1 proposal intake runs as the production work-intake
// login. The attack kit owns and always tears down its disposable cluster.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { RecurringRuleServiceV1 } from "../src/recurring/v1";
import { RecurringRuleSchedulerV1, recurringWorkBatchProposalPortV1 } from "../src/scheduler/v1";
import { ReusableSkillServiceV1 } from "../src/skills/v1";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase } from "../src/web/v1/private-database-preflight";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58710), PG = requiresRealPostgres();
const NOW = Date.parse("2026-09-29T08:00:00.000Z"), TICK = Date.parse("2026-10-05T10:00:00.000Z");
const ids = { tenant: "tenant:recurring-pg", workspace: "workspace:recurring-pg", adapter: "adapter:recurring-pg",
  project: "project:recurring-pg", owner: "identity:recurring-pg-owner", ownerGrant: "grant:recurring-pg-owner",
  agent: "identity:recurring-pg-agent", agentGrant: "grant:recurring-pg-agent" };
const provider = "test", tokenDigest = sha256Digest({ session: "recurring-pg-owner" });
let ran = 0;

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

async function seed(admin: Client) {
  const at = new Date(NOW).toISOString(), expires = new Date(TICK + 86_400_000).toISOString();
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Recurring PG')", [ids.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Recurring PG')",
    [ids.workspace, ids.tenant]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0','control_room_native',
    'disabled','v1',30)`, [ids.adapter, ids.tenant]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','Recurring PG','running','manual_project_active','healthy','control_room_native',$5,'{}',$5)`,
  [ids.project, ids.tenant, ids.workspace, ids.adapter, at]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [ids.tenant, ids.project, at]);
  for (const [identity, actor, subject] of [[ids.owner, "human", "owner"], [ids.agent, "agent", "agent"]] as const)
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,$1,$4,$5,'active',$6,$6)`,
    [identity, ids.tenant, actor, provider, sha256Digest({ provider, subject }), at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
  [ids.ownerGrant, ids.tenant, ids.owner, at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
  [ids.agentGrant, ids.tenant, ids.agent, JSON.stringify([ids.project]), at]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [ids.tenant, tokenDigest, ids.owner, at, expires]);
  await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [ids.tenant]);
}

test("recurring work and skill versions run through their exact production logins", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    try { await seed(admin); } finally { await admin.end(); }
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    const scope = { tenantId: ids.tenant, workspaceId: ids.workspace };
    const preflight = { ...scope, ownerIdentityId: ids.owner, issuer: provider };
    const identity: VerifiedWebIdentity = { provider, subject: "owner", tokenDigest,
      issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(TICK + 86_400_000).toISOString(),
      verificationExpiresAt: new Date(TICK + 86_400_000).toISOString() };
    const principal: AuthenticatedPrincipal = { tenantId: ids.tenant, identityId: ids.agent, actorType: "agent",
      authenticatedAt: new Date(NOW).toISOString(), expiresAt: new Date(TICK + 86_400_000).toISOString() };
    try {
      await verifyPrivateDatabase(web.client, web.config, preflight, NOW, { nativeQueue: true });
      await verifyTaskCoordinatorDatabase(coordinator.client, coordinator.config, preflight, NOW, { nativeQueue: true });
      const skills = new ReusableSkillServiceV1(web.client, scope, () => NOW);
      const rules = new RecurringRuleServiceV1(web.client, scope, () => NOW);
      const skill = await skills.create(identity, ids.project,
        { name: "Evidence review", instructions: "Cite the retained evidence and state uncertainty." });
      const updated = await skills.update(identity, ids.project, skill.skillId,
        { expectedVersion: 1, instructions: "Cite retained evidence, dates, and uncertainty." });
      assert.equal(updated.version, 2);
      const rule = await rules.create(identity, ids.project, { schedule: "every Monday at 9", timezone: "UTC",
        title: "Weekly dependency review", instructions: "Review dependency changes.",
        requiredCapability: "dependency.review", acceptanceCriteria: "Evidence is cited.",
        acceptanceTests: "The owner checks every cited source.", skillRefs: [{ skillId: skill.skillId, version: 1 }] });
      const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(intake.client, new Uint8Array(32).fill(29)));
      const result = await new RecurringRuleSchedulerV1(coordinator.client, ids.tenant, { read: () => "running" },
        recurringWorkBatchProposalPortV1(proposals, principal, () => TICK), () => TICK).tick();
      assert.equal(result.proposed.length, 1); assert.equal(result.startsWork, false);
      assert.equal((await coordinator.client.query<{ count: number }>(`SELECT count(*)::int count
        FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2 AND state='proposed'`,
      [ids.tenant, rule.ruleId])).rows[0]!.count, 1);
      assert.equal((await coordinator.client.query<{ count: number }>("SELECT count(*)::int count FROM control_jobs WHERE tenant_id=$1",
        [ids.tenant])).rows[0]!.count, 0);

      const directWeb = new Client(postgres.connection("web")), directCoordinator = new Client(postgres.connection("coordinator"));
      await directWeb.connect(); await directCoordinator.connect();
      try {
        await assert.rejects(directWeb.query("UPDATE control_skill_versions SET instructions='forged'"), /permission denied|append-only/u);
        await assert.rejects(directCoordinator.query(`UPDATE control_recurring_rules SET task_template='{}'`), /permission denied/u);
        await assert.rejects(directCoordinator.query(`INSERT INTO control_skills(tenant_id) VALUES('forged')`), /permission denied/u);
      } finally { await directWeb.end(); await directCoordinator.end(); }
    } finally { await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 180_000 });
});

test("the recurring production-login proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(ran, 0); return; }
  assert.equal(ran, 1);
});
