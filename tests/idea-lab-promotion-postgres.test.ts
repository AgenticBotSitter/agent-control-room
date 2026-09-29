// Real-PostgreSQL production-role proof for the Idea Lab promotion link.
// The cook sandbox cannot start PostgreSQL, so this file is run by a DB-capable
// helper through the attack-kit lane and always tears down its owned cluster.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

const PORT = 58450, PG = requiresRealPostgres();
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const hmac = (character: string) => `hmac-sha256:${character.repeat(64)}`;

test("Idea promotion provenance is append-only through the production web role", needsPg(), async () => {
  const result = await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:idea-pg','Idea test')");
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:idea-pg','tenant:idea-pg','Idea workspace')");
      await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
        redaction_policy_version,cursor_retention_days) VALUES('adapter:idea-pg','tenant:idea-pg','idea_test','1.0.0',
        'control_room_native','fixture','v1',30)`);
      await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
        description,normalized_state,domain_state,health,progress_percent,attention_count,blocker_count,priority,
        authority_mode,observed_at,payload,updated_at) VALUES('project:idea-pg','tenant:idea-pg','workspace:idea-pg',
        'adapter:idea-pg','idea:promotion-pg','v1','Promoted idea','Test proposal only','running','idea_project_active',
        'healthy',0,0,0,50,'control_room_native',now(),'{}'::jsonb,now())`);
      await admin.query(`INSERT INTO control_idea_sessions(session_id,tenant_id,workspace_id,session_digest,session_auth_tag,
        participant_count,max_rounds,payload,created_at) VALUES('idea:promotion-pg','tenant:idea-pg','workspace:idea-pg',$1,$2,3,1,'{}'::jsonb,now())`, [sha("a"), hmac("a")]);
      await admin.query(`INSERT INTO control_idea_syntheses(synthesis_id,tenant_id,workspace_id,session_id,session_digest,
        synthesis_digest,synthesis_auth_tag,recommendation,overall_score,payload,synthesized_at)
        VALUES('synthesis:promotion-pg','tenant:idea-pg','workspace:idea-pg','idea:promotion-pg',$1,$2,$3,'promote',80,'{}'::jsonb,now())`, [sha("a"), sha("b"), hmac("b")]);
      await admin.query(`INSERT INTO control_idea_decisions(decision_id,tenant_id,workspace_id,session_id,synthesis_digest,
        decision,project_id,decision_digest,decision_auth_tag,payload,decided_at)
        VALUES('decision:promotion-pg','tenant:idea-pg','workspace:idea-pg','idea:promotion-pg',$1,'create_project',
        'project:idea-pg',$2,$3,'{}'::jsonb,now())`, [sha("b"), sha("c"), hmac("c")]);
      await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
        VALUES('request:idea-pg','tenant:idea-pg','project:idea-pg','submitted',0,'idea-pg','{}'::jsonb,now(),now())`);
      await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
        VALUES('workflow:idea-pg','tenant:idea-pg','request:idea-pg','project:idea-pg',$1,'proposed',0,'{}'::jsonb,now(),now())`, [sha("d")]);
      await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,
        authority_digest,payload,created_at,updated_at) VALUES('job:idea-pg','tenant:idea-pg','workflow:idea-pg','project:idea-pg',
        'proposed',0,50,'agent_task',$1,'{}'::jsonb,now(),now())`, [sha("e")]);
    } finally { await admin.end(); }

    const web = new Client(postgres.connection("web")); await web.connect();
    try {
      const inserted = await web.query(`INSERT INTO control_idea_promotion_task_links(tenant_id,session_id,decision_digest,
        project_id,job_id,request_id,link_digest,link_auth_tag,created_at)
        VALUES('tenant:idea-pg','idea:promotion-pg',$1,'project:idea-pg','job:idea-pg','request:idea-pg',$2,$3,now())
        RETURNING job_id`, [sha("c"), sha("f"), hmac("f")]);
      assert.equal(inserted.rows[0]?.job_id, "job:idea-pg");
      assert.equal((await web.query("SELECT count(*)::int AS count FROM control_idea_promotion_task_links WHERE tenant_id='tenant:idea-pg'")).rows[0]?.count, 1);
      await assert.rejects(web.query("UPDATE control_idea_promotion_task_links SET job_id='job:other' WHERE tenant_id='tenant:idea-pg'"), /permission denied|append only/u);
      await assert.rejects(web.query("DELETE FROM control_idea_promotion_task_links WHERE tenant_id='tenant:idea-pg'"), /permission denied|append only/u);
    } finally { await web.end(); }
    return postgres.appliedMigrations;
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
  assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []); assert.ok(result.value >= 1);
});
