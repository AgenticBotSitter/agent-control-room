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
  agent: "identity:recurring-pg-agent", agentGrant: "grant:recurring-pg-agent",
  // An agent that is NOT registered for work intake, and a tenant outside the
  // intake binding. Both exist only for the refusal assertions below.
  unregisteredAgent: "identity:recurring-pg-unregistered", otherTenant: "tenant:recurring-pg-other",
  otherTenantAgent: "identity:recurring-pg-other-agent" };
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
  // The owner signs in through the web identity provider; the proposing agent
  // is an owner-registered work-intake agent. `auth_provider` is not cosmetic
  // here: `work_batches_work_intake_scope` (migration 0093) is a RESTRICTIVE
  // policy that admits an intake-session row only when the proposing identity
  // is an agent whose provider is literally 'work-intake'. Registering the
  // agent under any other provider makes the shared intake login's INSERT
  // raise `new row violates row-level security policy`, which the service
  // surfaces as a privilege error and the scheduler records as a failed
  // proposal — the rule then silently never proposes anything.
  for (const [identity, actor, subject, authProvider] of [
    [ids.owner, "human", "owner", provider], [ids.agent, "agent", "agent", "work-intake"],
  ] as const)
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,$1,$4,$5,'active',$6,$6)`,
    [identity, ids.tenant, actor, authProvider, sha256Digest({ provider: authProvider, subject }), at]);
  // An agent in the same tenant that is deliberately NOT registered for work
  // intake, so the RESTRICTIVE policy can be seen to refuse it.
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent',$1,'agent-key',$3,'active',$4,$4)`,
  [ids.unregisteredAgent, ids.tenant, sha256Digest({ provider: "agent-key", subject: "unregistered" }), at]);
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
  // A tenant outside that binding, seeded here because the admin client is
  // closed before the isolation refusal below runs. It carries its OWN
  // registered intake agent on purpose: `work_batches_work_intake_scope` admits
  // a row only when the tenant equals the binding AND the proposing identity is
  // a registered agent of that row's tenant. `control_identities.id` is
  // globally unique, so the other tenant gets its own identity id rather than
  // a shared one; that identity satisfies the policy's identity clause, so the
  // ONLY thing that can refuse the cross-tenant insert is the tenant binding.
  // Without that the assertion would pass for the wrong reason and tenant
  // isolation would never actually be exercised.
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Recurring PG other')", [ids.otherTenant]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent',$1,'work-intake',$3,'active',$4,$4)`,
  [ids.otherTenantAgent, ids.otherTenant, sha256Digest({ provider: "work-intake", subject: "other-agent" }), at]);
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

      // The intake boundary the run above depends on, proved rather than
      // assumed. A proposal-only batch is admitted only for the bound tenant
      // and an identity the owner registered for intake, and both halves are
      // exercised here as refusals. Without this, a fixture that merely forgot
      // to register its proposing agent would fail for the same reason (a
      // privilege error surfaced as a failed proposal) and the seed fix above
      // could silently be undone. Two independent mechanisms reject these — the
      // `work_batches_work_intake_scope` RESTRICTIVE policy and the
      // proposal-only guard trigger — and either one refusing is the invariant,
      // so both shapes are accepted.
      const directIntake = new Client(postgres.connection("control_room_work_intake_agent"));
      await directIntake.connect();
      try {
        // Same bound tenant, but an identity registered under a non-intake
        // provider: refused by the RESTRICTIVE policy, not by the grant.
        await assert.rejects(directIntake.query(`INSERT INTO work_batches(id,tenant_id,project_id,
          proposed_by_identity_id,proposed_by_actor_type,proposed_at,state,proposal,queue_depth_limit,
          batch_digest,auth_tag,version,created_at,updated_at)
          VALUES('batch:unregistered',$1,$2,$3,'agent',$4,'proposed','{}'::jsonb,5,$5,$6,1,$4,$4)`,
        [ids.tenant, ids.project, ids.unregisteredAgent, new Date(TICK).toISOString(),
          `sha256:${"c".repeat(64)}`, `hmac-sha256:${"d".repeat(64)}`]),
        /row-level security policy|permission denied|proposal-only work batch insert rejected/u);
        // A different tenant entirely: refused even for a correctly registered
        // intake agent, which is the isolation the binding exists to provide.
        await assert.rejects(directIntake.query(`INSERT INTO work_batches(id,tenant_id,project_id,
          proposed_by_identity_id,proposed_by_actor_type,proposed_at,state,proposal,queue_depth_limit,
          batch_digest,auth_tag,version,created_at,updated_at)
          VALUES('batch:other-tenant',$1,$2,$3,'agent',$4,'proposed','{}'::jsonb,5,$5,$6,1,$4,$4)`,
        [ids.otherTenant, ids.project, ids.otherTenantAgent, new Date(TICK).toISOString(),
          `sha256:${"c".repeat(64)}`, `hmac-sha256:${"d".repeat(64)}`]),
        /row-level security policy|permission denied|proposal-only work batch insert rejected/u);
        // Neither refusal may leave a row behind.
        assert.equal((await directIntake.query<{ count: number }>(`SELECT count(*)::int count
          FROM work_batches WHERE id IN ('batch:unregistered','batch:other-tenant')`)).rows[0]!.count, 0);
      } finally { await directIntake.end(); }
    } finally { await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 180_000 });
});

test("the recurring production-login proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(ran, 0); return; }
  assert.equal(ran, 1);
});
