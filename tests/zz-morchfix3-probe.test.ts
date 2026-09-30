// TEMPORARY reproduction probe (morchfix3 round 3). Prints measurements; asserts
// nothing. Deleted before hand-in.
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { workBatchProposalDigestV1 } from "../src/work-intake/v1";
import type { WorkBatchProposalV1 } from "../src/work-intake/v1";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59450);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
const NOW = "2026-09-29T21:00:00.000Z";
const KEY = new Uint8Array(32).fill(41);
const scope = { tenantId: "tenant:orch", workspaceId: "workspace:orch", projectId: "project:orch" };
const other = { tenantId: "tenant:orch-other", workspaceId: "workspace:orch-other", projectId: "project:orch-other" };

function proposal(taskCount: number, projectId = scope.projectId): WorkBatchProposalV1 {
  return { schema: "control-room.work-batch-proposal/v1", projectId, tasks:
    Array.from({ length: taskCount }, (_, index) => ({ localId: `part-${index}`,
      title: `Bounded part ${index}`, instructions: "Implement exactly the requested change.",
      requiredCapability: "code.change", role: "builder" as const,
      acceptanceCriteria: "The focused behavior matches the written contract.",
      acceptanceTests: "Run the focused orchestrator tests." })),
    edges: [] } as WorkBatchProposalV1;
}

async function seedTenant(admin: Client, at: { tenantId: string; workspaceId: string; projectId: string },
  options: { withBinding?: boolean } = {}) {
  const adapter = `adapter:manual:${sha256Digest({ w: at.workspaceId }).slice(7, 39)}`;
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [at.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING",
    [at.workspaceId, at.tenantId]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30) ON CONFLICT DO NOTHING`,
  [adapter, at.tenantId]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','Orchestrator project','planned','manual_project_active','healthy',
    'control_room_native',$5,'{}',$5) ON CONFLICT DO NOTHING`, [at.projectId, at.tenantId, at.workspaceId, adapter, NOW]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3) ON CONFLICT DO NOTHING`, [at.tenantId, at.projectId, NOW]);
  if (options.withBinding) {
    await admin.query("DELETE FROM work_intake_tenant_binding");
    await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [at.tenantId]);
  }
}

async function seedIdentities(admin: Client, at: { tenantId: string; projectId: string }, suffix: string) {
  const rows: Array<[string, string, string, string, string]> = [
    [`identity:orch-agent${suffix}`, "agent", "work-intake", "work_batch_proposer", '["work_batches.propose"]'],
    [`identity:orch-owner${suffix}`, "human", "test", "owner", '["*"]'],
  ];
  for (const [id, actorType, provider, roleKey, actions] of rows) {
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,'Fixture',$4,$5,'active',$6,$6)
      ON CONFLICT DO NOTHING`, [id, at.tenantId, actorType, provider, sha256Digest({ id }), NOW]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'["*"]'::jsonb,$6,$7,false,$8,$8) ON CONFLICT DO NOTHING`,
    [`grant:${id}`, at.tenantId, id, roleKey, actions, roleKey === "owner" ? "critical" : "low", roleKey === "owner", NOW]);
  }
}

async function seedBatch(admin: Client, at: { tenantId: string; projectId: string }, batchId: string,
  proposer = "identity:orch-agent") {
  const value = { ...proposal(2), projectId: at.projectId } as WorkBatchProposalV1;
  const digest = workBatchProposalDigestV1(value);
  await admin.query(`INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,proposed_by_actor_type,
    proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
    VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,10,$7,$8,1,$5,$5)`,
  [batchId, at.tenantId, at.projectId, proposer, NOW, JSON.stringify(value), digest,
    hmacSha256Tag(KEY, { purpose: "work-batch/v1", record: { id: batchId, tenantId: at.tenantId,
      projectId: at.projectId, proposedByIdentityId: proposer, proposedAt: NOW, state: "proposed", proposal: value,
      queueDepthLimit: 10, batchDigest: digest, version: 1, createdAt: NOW, updatedAt: NOW } })]);
  await admin.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,edited_at,
    reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,1,$4,$5,'submitted',$6::jsonb,$7,$8)`,
  [`${batchId}:revision:1`, at.tenantId, batchId, proposer, NOW, JSON.stringify(value), digest,
    hmacSha256Tag(KEY, { purpose: "work-batch-revision/v1", record: { id: `${batchId}:revision:1`,
      tenantId: at.tenantId, batchId, revision: 1, editedByIdentityId: proposer, editedAt: NOW,
      reasonCode: "submitted", proposal: value, revisionDigest: digest } })]);
  return { digest, value };
}

const insertSuggestion = (client: Client, input: { id: string; tenantId: string; projectId: string;
  batchId: string; requestKey: string; revision: number; revisionDigest: string; proposer: string;
  proposal: WorkBatchProposalV1; createdAt: string }) => client.query(`INSERT INTO work_batch_split_suggestions(id,tenant_id,project_id,batch_id,request_key,
  base_revision,base_revision_digest,proposed_by_identity_id,proposed_by_actor_type,proposal,proposal_digest,
  suggestion_digest,auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent',$9::jsonb,$10,$11,$12,$13)`,
  [input.id, input.tenantId, input.projectId, input.batchId, input.requestKey, input.revision,
    input.revisionDigest, input.proposer, JSON.stringify(input.proposal),
    workBatchProposalDigestV1(input.proposal),
    sha256Digest({ baseRevisionDigest: input.revisionDigest,
      proposalDigest: workBatchProposalDigestV1(input.proposal) }),
    `hmac-sha256:${"0".repeat(64)}`, input.createdAt]);

test("probe: N-B1 the view is not a security barrier", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedTenant(admin, other);
      await seedIdentities(admin, scope, "");
      await seedIdentities(admin, other, "-other");
      const foreignBatch = await seedBatch(admin, other, "batch:orch-tenant-b", "identity:orch-agent-other");
      const secret = "SECRET-B-TENANT-ONLY";
      const foreign = { ...proposal(2), projectId: other.projectId, tasks: proposal(2).tasks.map(task =>
        ({ ...task, title: secret })) } as WorkBatchProposalV1;
      await insertSuggestion(admin, { id: `split-suggestion:${"7".repeat(32)}`,
        tenantId: other.tenantId, projectId: other.projectId, batchId: "batch:orch-tenant-b",
        requestKey: "orchestrator-tenant-b-1", revision: 1, revisionDigest: foreignBatch.digest,
        proposer: "identity:orch-agent-other", proposal: foreign, createdAt: NOW });

      const reloptions = await admin.query<{ reloptions: string[] }>(
        "SELECT reloptions FROM pg_class WHERE relname='work_batch_current_split_suggestions'");
      console.log("PROBE view reloptions =", JSON.stringify(reloptions.rows[0]!.reloptions));
      const plain = await intake.query("SELECT count(*)::text AS n FROM work_batch_current_split_suggestions WHERE tenant_id=$1",
        [other.tenantId]);
      console.log("PROBE plain read rows of B =", plain.rows[0]!.n);
      for (const [label, sql] of [
        ["proposal text cast", "SELECT 1 FROM work_batch_current_split_suggestions WHERE (proposal->'tasks'->0->>'title')::int = 0"],
        ["whole proposal cast", "SELECT 1 FROM work_batch_current_split_suggestions WHERE (proposal::text)::int = 0"],
        ["request_key cast", "SELECT 1 FROM work_batch_current_split_suggestions WHERE request_key::int = 0"],
        ["LIKE oracle", "SELECT 1 FROM work_batch_current_split_suggestions WHERE CASE WHEN proposal::text LIKE '%SECRET-B-TENANT-ONLY%' THEN 1/0 ELSE 1 END = 0"],
      ] as const) {
        try { const r = await intake.query(sql); console.log(`PROBE ${label}: NO ERROR, rows=${r.rowCount}`); }
        catch (error) { console.log(`PROBE ${label}: ERROR ${String((error as Error).message).slice(0, 160)}`); }
      }
      // And the base table, which is RLS-protected.
      for (const [label, sql] of [
        ["BASE proposal cast", "SELECT 1 FROM work_batch_split_suggestions WHERE (proposal->'tasks'->0->>'title')::int = 0"],
      ] as const) {
        try { const r = await intake.query(sql); console.log(`PROBE ${label}: NO ERROR, rows=${r.rowCount}`); }
        catch (error) { console.log(`PROBE ${label}: ERROR ${String((error as Error).message).slice(0, 160)}`); }
      }
      // Every view granted to a shared login, and whether it is a barrier.
      const views = await admin.query<{ view: string; barrier: boolean; owners: string }>(`SELECT c.relname AS view,
        coalesce((SELECT true FROM unnest(coalesce(c.reloptions,'{}'::text[])) o WHERE o='security_barrier=true'),false) AS barrier,
        pg_get_userbyid(c.relowner) AS owners
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='v'
          AND EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
            JOIN pg_roles r ON r.oid=a.grantee
            WHERE a.privilege_type='SELECT' AND r.rolname IN
              ('control_room_work_intake','control_room_application','control_room_reader','control_room_backup','control_room_task_coordinator'))
        ORDER BY 1`);
      console.log("PROBE shared-login views:", JSON.stringify(views.rows, null, 1));
      // Do their base tables have RLS?
      const bases = await admin.query<{ relname: string; rls: boolean; restrictive: boolean; def: string }>(`SELECT
        c.relname, c.relrowsecurity AS rls,
        EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive::text='RESTRICTIVE') AS restrictive,
        pg_get_viewdef(c.oid,true) AS def
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
          AND c.relkind='v' AND c.relname IN ('work_batch_effective_queue_admissions','pipeline_ordered_stage_runs',
            'installation_effective_operations_mode','control_planner_open_needs_you','control_project_planner_selections')`);
      console.log("PROBE candidate views:", JSON.stringify(bases.rows, null, 1));
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 9, allowedPorts: ALLOWED, boundMs: 240_000 });
});

test("probe: N-T1 the preflight-declaration scanner", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/web/v1/private-database-preflight.ts", "utf8");
  const exempted = new Set<string>();
  for (const match of source.matchAll(/'([a-z_0-9]+\([^']*?\))'::regprocedure/g)) exempted.add(match[1]!);
  console.log("PROBE exempted:", JSON.stringify([...exempted].sort()));
  const { readdir } = await import("node:fs/promises");
  const shipped = new Map<string, string>();
  for (const file of (await readdir("db/migrations")).filter(n => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(`db/migrations/${file}`, "utf8");
    if (!/SECURITY\s+DEFINER/i.test(sql)) continue;
    for (const match of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_0-9]+)\s*\(([^)]*)\)([\s\S]*?)RETURNS\s+([a-z ]+)/gi)) {
      if (match[4]!.trim().toLowerCase() === "trigger") continue;
      const args = match[2]!.split(",").map(a => a.trim().split(/\s+/)[0]!.toLowerCase()).filter(a => a !== "");
      shipped.set(`${match[1]!.toLowerCase()}(${args.join(",")})`, file);
    }
  }
  console.log("PROBE shipped SECURITY DEFINER:", JSON.stringify([...shipped.entries()].sort(), null, 1));
});

test("probe: N-B3 the lockout and the inbox flood", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope, "");
      const description = "Make the release notes match the shipped behaviour.";
      const digest = sha256Digest({ ownerRequest: description });
      const projectKey = (await admin.query<{ k: string }>(
        "SELECT planner_failure_scope_key('project', jsonb_build_object('kind','initial','tenantId',$1::text,'projectId',$2::text,'ownerRequest',$3::text)) AS k",
        [scope.tenantId, scope.projectId, digest])).rows[0]!.k;
      console.log("PROBE project scope key =", projectKey);
      // The guard admits INSERT only at count 1, so the counter is built by the
      // real adapter's own two increments rather than hand-set to 2.
      await admin.query(`INSERT INTO control_planner_failure_counters(tenant_id,project_id,scope_key,failure_count,
        last_failure_at,cleared_at,version,updated_at,created_at) VALUES($1,$2,$3,1,$4,NULL,1,$4,$4)`,
      [scope.tenantId, scope.projectId, projectKey, NOW]);
      await admin.query(`UPDATE control_planner_failure_counters SET failure_count=2, version=version+1, updated_at=$4
        WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, projectKey, NOW]);
      const live = await admin.query<{ failure_count: string }>(
        "SELECT failure_count::text FROM control_planner_failure_counters WHERE scope_key=$1", [projectKey]);
      console.log("PROBE counter at =", live.rows[0]!.failure_count);
      // The 0204 guard: a resplit raise recomputes only the 'initial' project scope.
      const resplitItem = 'planner-needs-you:' + "a".repeat(32);
      try {
        await admin.query(`INSERT INTO control_planner_needs_you_items(id,tenant_id,project_id,request_key,reason_code,
          failure_count,raised_by_identity_id,raised_at,owner_request_digest)
          VALUES($1,$2,$3,'resplit-probe-0001','orchestrator_failed_twice',2,'identity:orch-agent',$4,$5)`,
        [resplitItem, scope.tenantId, scope.projectId, NOW, digest]);
        console.log("PROBE resplit raise: ACCEPTED");
      } catch (error) {
        console.log("PROBE resplit raise: REJECTED", String((error as Error).message).slice(0, 120));
      }
      // And the flood: N fresh request keys, one description.
      const rows = await admin.query<{ request_key: string; n: string }>(`SELECT request_key, count(*)::text AS n
        FROM control_planner_needs_you_items WHERE tenant_id=$1 GROUP BY 1`, [scope.tenantId]);
      console.log("PROBE needs-you rows after resplit attempt:", JSON.stringify(rows.rows));
      const inbox = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM control_action_inbox WHERE kind='failure'");
      console.log("PROBE failure inbox items:", inbox.rows[0]!.n);
      const uniq = await admin.query<{ n: string }>(`SELECT count(*)::text AS n
        FROM pg_constraint WHERE conrelid='control_planner_needs_you_items'::regclass AND contype='u'`);
      console.log("PROBE needs-you unique constraints:", uniq.rows[0]!.n);
      const cons = await admin.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='control_planner_needs_you_items'::regclass ORDER BY conname`);
      console.log("PROBE needs-you constraints:", JSON.stringify(cons.rows, null, 1));
    } finally { await admin.end(); }
  }, { port: PORT + 8, allowedPorts: ALLOWED, boundMs: 240_000 });
});
