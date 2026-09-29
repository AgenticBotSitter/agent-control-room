// Temporary: confirm the forged-row block is actually reached and passes.
import { Client } from "pg";
import { withRealPostgres } from "./tests/support/attack-kit/index";
import { IdeaLabPromotionTaskLinkStoreV1, IDEA_LAB_PROMOTION_TASK_LINK_V1 } from "./src/idea-lab/v1/promotion-task-link-store";
import { sha256Digest } from "./src/security";
import type { DatabaseClient, DatabaseSession } from "./src/persistence/database";

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const hmac = (c: string) => `hmac-sha256:${c.repeat(64)}`;
const NOW = "2026-09-29T15:00:00.000Z";
const KEY = new Uint8Array(32).fill(0x4a);
const scope = { tenantId: "tenant:idea-pg", workspaceId: "workspace:idea-pg" };

function database(client: Client): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) => {
    const r = await client.query(sql, values as never[]); return { rows: r.rows as T[] }; } };
  return { query: session.query,
    transaction: async work => { await client.query("BEGIN"); try { const v = await work(session); await client.query("COMMIT"); return v; } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } },
    transactionWithPreCommitCheck: async (work, check) => { await client.query("BEGIN"); try { const v = await work(session); await check(); await client.query("COMMIT"); return v; } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } } };
}

await withRealPostgres(async postgres => {
  const admin = new Client(postgres.admin()); await admin.connect();
  try {
    await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
    await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
      project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
      VALUES('adapter.control-room-native-ideas',$1,'control_room_native_ideas','1.0.0','control_room_native','online',
      '["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'v1',30)`, [scope.tenantId]);
    await admin.query(`INSERT INTO control_idea_sessions(session_id,tenant_id,workspace_id,session_digest,session_auth_tag,
      participant_count,max_rounds,payload,created_at) VALUES('idea:forged',$1,$2,$3,$4,3,1,'{}'::jsonb,$5)`,
      [scope.tenantId, scope.workspaceId, sha("a"), hmac("a"), NOW]);
    await admin.query(`INSERT INTO control_idea_syntheses(synthesis_id,tenant_id,workspace_id,session_id,session_digest,
      synthesis_digest,synthesis_auth_tag,recommendation,overall_score,payload,synthesized_at)
      VALUES('synth:forged',$1,$2,'idea:forged',$3,$4,$5,'promote',80,'{}'::jsonb,$6)`,
      [scope.tenantId, scope.workspaceId, sha("a"), sha("b"), hmac("b"), NOW]);
    await admin.query(`INSERT INTO control_idea_decisions(decision_id,tenant_id,workspace_id,session_id,synthesis_digest,
      decision,project_id,decision_digest,decision_auth_tag,payload,decided_at)
      VALUES('decision:forged',$1,$2,'idea:forged',$3,'create_project',NULL,$4,$5,'{}'::jsonb,$6)`,
      [scope.tenantId, scope.workspaceId, sha("b"), sha("c"), hmac("c"), NOW]);
    const unsigned = { contractVersion: IDEA_LAB_PROMOTION_TASK_LINK_V1, tenantId: scope.tenantId,
      sessionId: "idea:forged", decisionDigest: sha("c"), projectId: sha("p"), jobId: sha("j"), requestId: sha("r"),
      createdAt: NOW, startsWork: false as const, grantsAssignmentAuthority: false as const, grantsApproval: false as const,
      grantsExecutionAuthority: false as const };
    const linkDigest = sha256Digest(unsigned);
    console.log("computed linkDigest:", linkDigest);
    // projectId must be a real project for the FK; use a project row.
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      description,normalized_state,domain_state,health,progress_percent,attention_count,blocker_count,priority,
      authority_mode,observed_at,payload,updated_at) VALUES('project:forge',$1,$2,'adapter.control-room-native-ideas',
      'idea:forged','v1','T','S','running','idea_project_active','healthy',0,0,0,50,'control_room_native',$3,'{}'::jsonb,$3)`,
      [scope.tenantId, scope.workspaceId, NOW]);
    const real = { ...unsigned, projectId: "project:forge", jobId: "job:forge", requestId: "request:forge" };
    const realDigest = sha256Digest(real);
    console.log("real digest:", realDigest);
    await admin.query(`UPDATE control_idea_decisions SET decision_digest=$1 WHERE tenant_id=$2 AND decision_id='decision:forged'`,
      [realDigest, scope.tenantId]);
    await admin.query(`UPDATE control_idea_decisions SET decision_auth_tag=$1 WHERE tenant_id=$2 AND decision_id='decision:forged'`,
      [hmac("c"), scope.tenantId]);
    await admin.query(`INSERT INTO control_idea_promotion_task_links(tenant_id,session_id,decision_digest,project_id,job_id,
      request_id,link_digest,link_auth_tag,created_at) VALUES($1,'idea:forged',$2,'project:forge','job:forge','request:forge',$3,$4,$5)`,
      [scope.tenantId, realDigest, realDigest, hmac("0"), NOW]);
    console.log("forged row inserted");
  } finally { await admin.end(); }

  const web = new Client(postgres.connection("web")); await web.connect();
  try {
    const store = new IdeaLabPromotionTaskLinkStoreV1(database(web), KEY);
    try { const got = await store.get(scope.tenantId, "idea:forged");
      console.log("UNEXPECTED: get() returned", JSON.stringify(got)); }
    catch (e) { console.log("get() rejected with:", (e as Error).message); }
  } finally { await web.end(); }
}, { port: 58973, allowedPorts: [58973], boundMs: 240_000 });
