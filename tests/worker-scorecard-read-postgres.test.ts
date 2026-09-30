// Real PostgreSQL proof for the worker/model scorecard read. It runs on the
// production web login (control_room_private_web) so a missing grant on
// pipeline_stage_runs or control_completion_gate_records fails here rather
// than only in a mocked unit test.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { DatabaseWorkerScorecardReadSourceV1 } from "../src/web/v1/worker-scorecard-read";

// Reserved disposable-cluster lane for this job: 59230-59231.
const PORT = Number(process.env.WORKER_SCORECARD_PG_PORT ?? 59230);
const PORTS = [59230, 59231];
const PG = requiresRealPostgres();

const TENANT = "tenant:worker-scorecard-fixture";
const WORKSPACE = "workspace:worker-scorecard-fixture";
const ADAPTER = "adapter:worker-scorecard-fixture";
const PROJECT = "project:worker-scorecard-fixture";
const NODE = "node:worker-scorecard-fixture";
const DIGEST = `sha256:${"a".repeat(64)}`;
const TAG = `hmac-sha256:${"b".repeat(64)}`;

async function seedTenant(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [PROJECT, TENANT, WORKSPACE, ADAPTER]);
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',0,$3,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
      'identityKeyId',$3::text),now(),now())`, [NODE, TENANT, "key:worker-scorecard-fixture"]);
}

/** One build-stage job/attempt/pipeline-stage-run, plus (unless `blocked`) a
 * completion-gate target for it. `priorRounds` seeds each earlier
 * changes_requested round as its own target+review+revision before the
 * final target, so `revisionNumber` on the final target is the true round
 * count and "caught by" resolves to the most recent round's reviewer. */
async function seedBuildStage(admin: Client, suffix: string, input: {
  workerKind: "codex" | "claude-code" | "hermes"; model: string; effort: string;
  finishedAt: string; outcome: "succeeded" | "failed" | "cancelled";
  priorRounds?: readonly { reviewer: { actorType: "agent" | "human"; actorId: string; harness?: string } }[];
}) {
  const ids = { request: `request:sc-${suffix}`, workflow: `workflow:sc-${suffix}`, pipelineRun: `pipeline-run:sc-${suffix}`,
    template: `pipeline-template:sc-${suffix}`, job: `job:sc-${suffix}`, attempt: `attempt:sc-${suffix}`,
    stage: `pipeline-stage-run:sc-${suffix}` };
  const at = input.finishedAt;
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','accepted','version',0,
      'projectId',$3::text,'idempotencyKey',$1::text),$4::timestamptz,$4::timestamptz)`,
  [ids.request, TENANT, PROJECT, at]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',1,
      'requestId',$3::text,'projectId',$4::text,'definitionDigest',$5::text),$6::timestamptz,$6::timestamptz)`,
  [ids.workflow, TENANT, ids.request, PROJECT, DIGEST, at]);
  await admin.query(`INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,stages,max_stages,
      max_total_loops,may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at)
    VALUES($1,$2,$3,'Fixture template','Fixture template.','[{"ordinal":0}]'::jsonb,1,1,false,3600,$4,$5,1,$6::timestamptz,$6::timestamptz)`,
  [ids.template, TENANT, PROJECT, DIGEST, TAG, at]);
  await admin.query(`INSERT INTO pipeline_runs(id,tenant_id,project_id,request_id,template_id,template_version,
      template_digest,workflow_id,title,state,updated_at,current_stage_ordinal,unattended,record_digest,auth_tag,version)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,'Fixture run',$8,$9::timestamptz,0,false,$6,$10,1)`,
  [ids.pipelineRun, TENANT, PROJECT, ids.request, ids.template, DIGEST, ids.workflow,
    input.outcome === "succeeded" ? "succeeded" : "failed", at, TAG]);
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id)
    VALUES($1,$2,$3,$4,$5,1,50,'code.change',$6,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$5::text,'version',1,
      'priority',50,'workflowId',$3::text,'projectId',$4::text,'requiredCapability','code.change',
      'authority',jsonb_build_object('digest',$6::text)),
      $7::timestamptz,$7::timestamptz,'build',0,$8)`,
  [ids.job, TENANT, ids.workflow, PROJECT, input.outcome, DIGEST, at, ids.pipelineRun]);
  await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,$4,1,$5,1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$4::text,'version',1,
      'jobId',$3::text,'attemptNumber',1,'nodeId',$5::text,'leaseEpoch',1),$6::timestamptz,$6::timestamptz)`,
  [ids.attempt, TENANT, ids.job, input.outcome, NODE, at]);
  await admin.query(`INSERT INTO pipeline_stage_runs(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,stage_kind,role,
      worker_id,worker_kind,node_id,selection_key,model,effort,current_job_id,current_attempt_id,state,max_loops,
      started_at,finished_at,record_digest,auth_tag,version)
    VALUES($1,$2,$3,$4,0,'build','builder',$5,$6,$7,$8,$9,$10,$11,$12,$13,3,$14::timestamptz,$14::timestamptz,$15,$16,1)`,
  [ids.stage, TENANT, PROJECT, ids.pipelineRun, `worker:${suffix}`, input.workerKind, NODE, `${suffix}.selection`,
    input.model, input.effort, ids.job, ids.attempt, input.outcome, at, DIGEST, TAG]);
  if (input.outcome !== "succeeded") return;
  const rounds = input.priorRounds ?? [];
  const rootTargetId = `target:sc-${suffix}-r0`;
  for (const [index, round] of rounds.entries()) {
    const targetId = index === 0 ? rootTargetId : `target:sc-${suffix}-r${index}`;
    const reviewId = `review:sc-${suffix}-r${index}`;
    await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
        parent_id,record_digest,record_auth_tag,payload,occurred_at)
      VALUES($1,$2,$3,'target',$1,$4,NULL,$5,$6,jsonb_build_object('id',$1::text,'rootTargetId',$7::text,
        'revisionNumber',$8::int,'subjectId',$4::text),$9::timestamptz)`,
    [targetId, TENANT, PROJECT, `${ids.job}:round${index}`, DIGEST, TAG, rootTargetId, index, at]);
    await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
        parent_id,record_digest,record_auth_tag,payload,occurred_at)
      VALUES($1,$2,$3,'review',$1,$4,$4,$5,$6,jsonb_build_object('id',$1::text,'targetId',$4::text,'decision','changes_requested',
        'reviewer',$7::jsonb),$8::timestamptz)`,
    [reviewId, TENANT, PROJECT, targetId, DIGEST, TAG, JSON.stringify(round.reviewer), at]);
  }
  const finalTargetId = rounds.length ? `target:sc-${suffix}-r${rounds.length}` : rootTargetId;
  await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
      parent_id,record_digest,record_auth_tag,payload,occurred_at)
    VALUES($1,$2,$3,'target',$1,$4,NULL,$5,$6,jsonb_build_object('id',$1::text,'rootTargetId',$7::text,
      'revisionNumber',$8::int,'subjectId',$4::text),$9::timestamptz)`,
  [finalTargetId, TENANT, PROJECT, ids.job, DIGEST, TAG, rootTargetId, rounds.length, at]);
  await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
      parent_id,record_digest,record_auth_tag,payload,occurred_at)
    VALUES($1,$2,$3,'review',$1,$4,$4,$5,$6,jsonb_build_object('id',$1::text,'targetId',$4::text,'decision','accepted',
      'reviewer',jsonb_build_object('actorType','human','actorId','identity:owner')),$7::timestamptz)`,
  [`review:sc-${suffix}-final`, TENANT, PROJECT, finalTargetId, DIGEST, TAG, at]);
  return ids;
}

test("worker scorecard runs as the production web role and stays bounded on an empty fleet", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const client = new Client(postgres.connection("web")); await client.connect();
    try {
      const roles = await client.query<{ current_user: string; rolsuper: boolean }>(
        "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
      assert.equal(roles.rows[0]!.rolsuper, false, "the read must not run as a superuser");
      const view = await new DatabaseWorkerScorecardReadSourceV1({ query: client.query.bind(client) } as never)
        .read({ tenantId: "tenant:worker-scorecard-empty", now: "2026-09-29T12:00:00.000Z" });
      assert.deepEqual(view.groups, []);
    } finally { await client.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 60_000 });
});

test("worker scorecard reports a first-time pass, a two-round revision, and a blocked run, bounded to the production web role", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    const now = new Date();
    const at = (offsetSeconds: number) => new Date(now.getTime() + offsetSeconds * 1000).toISOString();
    try {
      await seedTenant(admin);
      // First-time pass: Codex, no revision round.
      await seedBuildStage(admin, "firsttime", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at(-3_600), outcome: "succeeded" });
      // Two revise rounds: Codex again (same worker/model group), caught first
      // by a Claude checker, then by the owner, before the final accept.
      await seedBuildStage(admin, "tworounds", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at(-1_800), outcome: "succeeded", priorRounds: [
          { reviewer: { actorType: "agent", actorId: "identity:claude-checker", harness: "claude" } },
          { reviewer: { actorType: "human", actorId: "identity:owner" } },
        ] });
      // Blocked: Codex again, failed outright, well outside the 7-day window.
      await seedBuildStage(admin, "blocked", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at(-20 * 24 * 3_600), outcome: "failed" });
      // A different worker/model group, so the aggregation is proven to group by
      // worker_kind+model+effort and not collapse everything into one bucket.
      await seedBuildStage(admin, "otherworker", { workerKind: "claude-code", model: "opus", effort: "medium",
        finishedAt: at(-900), outcome: "succeeded" });

      const direct = new Client(postgres.connection("web")); await direct.connect();
      try {
        const roles = await direct.query<{ current_user: string }>("SELECT current_user FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_web");
        const view = await new DatabaseWorkerScorecardReadSourceV1({ query: direct.query.bind(direct) } as never)
          .read({ tenantId: TENANT, now: at(0) });
        assert.equal(view.groups.length, 2);
        const codex = view.groups.find(group => group.workerKind === "codex")!;
        assert.equal(codex.model, "sol"); assert.equal(codex.effort, "high");
        // 30-day window sees all three Codex runs: 1 pass, 1 fix, 1 blocked.
        assert.equal(codex.last30Days.finished, 3);
        assert.equal(codex.last30Days.passedFirstTime, 1);
        assert.equal(codex.last30Days.neededFixes, 1);
        assert.equal(codex.last30Days.failedOrBlocked, 1);
        // The most recent changes_requested round (the owner's) is who "caught"
        // the fix that finally shipped, not the earlier Claude round.
        assert.deepEqual(codex.last30Days.caughtBy, [{ label: "Owner", count: 1 }]);
        // 7-day window excludes the 20-day-old blocked run.
        assert.equal(codex.last7Days.finished, 2);
        assert.equal(codex.last7Days.failedOrBlocked, 0);
        assert.equal(codex.last7Days.passedFirstTime, 1);
        assert.equal(codex.last7Days.neededFixes, 1);
        const claude = view.groups.find(group => group.workerKind === "claude-code")!;
        assert.equal(claude.last30Days.finished, 1); assert.equal(claude.last30Days.passedFirstTime, 1);
      } finally { await direct.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 60_000 });
});
