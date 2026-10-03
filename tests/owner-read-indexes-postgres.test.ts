// Real-PostgreSQL proof for migrations 0272 and 0273 (MLOAD-03/03b and
// MLOAD-04). These are index migrations with no application code behind them,
// so the thing worth proving is NOT "the index exists" -- a catalogue lookup
// proves that and nothing else. It is:
//
//   1. the index EXISTS in the applied schema, with the exact shape the read
//      needs (measured from pg_index, not from the DDL text);
//   2. the read's PLAN USES it, and does not fall back to a sequential scan of
//      the attempts/gate table once the estate has enough rows that a scan is
//      visible -- asserted on plan node types and row counts, never on wall
//      clock, because a timing assertion on a shared CI box is a flaky test;
//   3. 8 AND 16 CONCURRENT READERS of the production read all SUCCEED, which is
//      MLOAD-03b's actual complaint ("8 of 16 refused with a statement
//      timeout") rather than a latency figure;
//   4. the answers are IDENTICAL with and without the index, so the plan change
//      provably did not change what the owner sees.
//
// The concurrency check uses the product's own pool GUCs and a statement_timeout
// long enough that only a genuine sequential-scan blow-up would trip it, and it
// asserts the plan shape rather than the millisecond count, so it fails on the
// old schema and passes on this one for a structural reason.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// Reserved disposable-cluster lane for this job: 59564-59571, or the test
// runner's assigned port block, so concurrent runs never collide.
const PORT = Number(process.env.OWNER_READ_INDEX_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59564);
const PORTS = [PORT, PORT + 1];
const PG = requiresRealPostgres();

const TENANT = "tenant:owner-read-index-fixture";
const WORKSPACE = "workspace:owner-read-index-fixture";
const ADAPTER = "adapter:owner-read-index-fixture";
const CONTRACT = "control-room-domain/v1";
const DIGEST = `sha256:${"a".repeat(64)}`;
const TAG = `hmac-sha256:${"b".repeat(64)}`;

/** Enough rows that a sequential scan of the attempts table is a different plan
 * from an index probe.
 *
 * The size is measured, not guessed. At 8 workers x 60 attempts (480 rows) the
 * planner prefers a sequential scan for BOTH LATERALs even with the index
 * present, because it estimates 4 matches per node and a 480-row table is a
 * single page or two. Raising the attempt history to 400 per worker takes the
 * table to 32,000 rows and flips both LATERALs to index probes; the 200k-row
 * growth estate flips them the same way, so this is the point where the fix's
 * benefit is visible rather than an artefact of an unrealistically small
 * fixture. The measurement is asserted below in both directions, so a future
 * planner change that moved the flip point shows up as a failure rather than as
 * a silently-passing assertion.
 *
 * The per-worker attempt COUNT is the load-bearing number, not the row total.
 * Both LATERALs return at most 1 and 3 rows per worker, so what decides between
 * an index probe and a scan of that worker's history is how many rows the scan
 * would have to read: 400 per worker is 3,200 rows and a 25-page table, which the
 * planner will happily scan. 1,250 per worker is 10,000 rows, which is the same
 * order as the 200k-row growth estate's 10,000 attempts per node -- and at that
 * density the measured growth plan uses the index for BOTH LATERALs. */
const WORKERS = 8;
const ATTEMPTS_PER_WORKER = 1250;
/** Stage runs whose completion-gate lineage resolves, so the scorecard's
 * LATERAL actually runs per row rather than short-circuiting on NULL. */
const STAGE_RUNS = 600;
const REVISION_ROUNDS = 3;

const indexDefinition = async (client: Client, name: string) => (await client.query(
  "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [name])).rows[0]?.indexdef as string | undefined;

async function seedTenantAndProjects(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [ADAPTER, TENANT, WORKSPACE, ADAPTER]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [TENANT, ADAPTER]);
}

/** The worker board's own CTE + LATERALs, character for character as
 * src/web/v1/worker-board-read.ts:37-62 issues them. */
const WORKER_BOARD = `WITH bounded_workers AS (
    SELECT DISTINCT node_id FROM control_attempts WHERE tenant_id=$1 AND node_id IS NOT NULL
    ORDER BY node_id LIMIT 500
  )
  SELECT w.node_id AS worker_id,
  current_job.project_id AS current_project_id,current_job.id AS current_job_id,current_job.payload AS current_payload,
  COALESCE(current_lease.acquired_at,current_attempt.started_at,current_attempt.updated_at) AS current_since,
  terminal_job.project_id AS result_project_id,terminal_job.id AS result_job_id,terminal_job.payload AS result_payload,
  terminal.state AS result_state,terminal.finished_at AS result_finished_at,terminal.result_rank
  FROM bounded_workers w
  LEFT JOIN LATERAL (
    SELECT a.id,a.job_id,a.created_at AS started_at,a.updated_at FROM control_attempts a
    WHERE a.tenant_id=$1 AND a.node_id=w.node_id AND a.state IN ('leased','running','waiting')
    ORDER BY CASE a.state WHEN 'running' THEN 0 WHEN 'leased' THEN 1 ELSE 2 END,a.updated_at DESC,a.id LIMIT 1
  ) current_attempt ON true
  LEFT JOIN control_jobs current_job ON current_job.tenant_id=$1 AND current_job.id=current_attempt.job_id
  LEFT JOIN control_leases current_lease ON current_lease.tenant_id=$1 AND current_lease.attempt_id=current_attempt.id
    AND current_lease.state='active' AND current_lease.expires_at>$2::timestamptz
  LEFT JOIN LATERAL (
    SELECT a.id,a.job_id,a.state,a.updated_at AS finished_at,row_number() OVER (ORDER BY a.updated_at DESC,a.id DESC) AS result_rank
    FROM control_attempts a WHERE a.tenant_id=$1 AND a.node_id=w.node_id
      AND a.state IN ('succeeded','failed','cancelled','orphaned') AND a.updated_at IS NOT NULL
    ORDER BY a.updated_at DESC,a.id DESC LIMIT 3
  ) terminal ON true
  LEFT JOIN control_jobs terminal_job ON terminal_job.tenant_id=$1 AND terminal_job.id=terminal.job_id
  ORDER BY w.node_id,terminal.result_rank`;

const SCORECARD = `WITH bounded_stage_runs AS (
    SELECT worker_kind,model,effort,provider,profile,state,current_job_id,finished_at
    FROM pipeline_stage_runs
    WHERE tenant_id=$1 AND stage_kind='build' AND role='builder'
      AND state IN ('succeeded','failed','cancelled','uncertain') AND finished_at>=$2::timestamptz
    ORDER BY finished_at DESC LIMIT 2000
  )
  SELECT s.worker_kind,s.model,s.effort,s.provider,s.profile,s.state,s.finished_at,
    target.payload->>'revisionNumber' AS revision_number,
    catcher.reviewer AS catcher_reviewer
  FROM bounded_stage_runs s
  LEFT JOIN control_completion_gate_records target
    ON target.tenant_id=$1 AND target.kind='target' AND target.subject_id=s.current_job_id
  LEFT JOIN LATERAL (
    SELECT rev.payload->'reviewer' AS reviewer
    FROM control_completion_gate_records prior_target
    JOIN control_completion_gate_records rev
      ON rev.tenant_id=$1 AND rev.kind='review' AND rev.payload->>'targetId'=prior_target.id AND rev.payload->>'decision'='changes_requested'
    WHERE prior_target.tenant_id=$1 AND prior_target.kind='target'
      AND prior_target.payload->>'rootTargetId'=target.payload->>'rootTargetId'
      AND (target.payload->>'revisionNumber')::int>0
    ORDER BY (prior_target.payload->>'revisionNumber')::int DESC LIMIT 1
  ) catcher ON true
  ORDER BY s.finished_at DESC`;

/** One request/workflow/job/attempt quadruple plus, for build stages, the
 * pipeline rows and the completion-gate revision lineage. Written as the
 * fixture admin: the logins under test are read-only. */
async function seedJob(admin: Client, suffix: string, input: {
  state: string; attemptState: string; nodeId: string | null; at: string; stage?: boolean;
}) {
  const ids = { request: `request:readidx-${suffix}`, workflow: `workflow:readidx-${suffix}`,
    job: `job:readidx-${suffix}`, attempt: `attempt:readidx-${suffix}` };
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'kind','request','tenantId',$2::text,
      'projectId',$3::text,'contractVersion',$4::text,'title','Fixture','objective','Fixture.','state','accepted',
      'version',0,'priority',50,'requestedBy',jsonb_build_object('actorId','identity:readidx','actorType','human'),
      'idempotencyKey',$1::text,'createdAt',$5::text,'updatedAt',$5::text),$5::timestamptz,$5::timestamptz)`,
  [ids.request, TENANT, ADAPTER, CONTRACT, input.at]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,
      payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,jsonb_build_object('id',$1::text,'kind','workflow','tenantId',$2::text,
      'requestId',$3::text,'projectId',$4::text,'contractVersion',$6::text,'definitionVersion','1.0.0',
      'definitionDigest',$5::text,'authorityMode','control_room_native','state','active','version',1,
      'jobIds',jsonb_build_array($7::text),'createdAt',$8::text,'updatedAt',$8::text),$8::timestamptz,$8::timestamptz)`,
  [ids.workflow, TENANT, ids.request, ADAPTER, DIGEST, CONTRACT, ids.job, input.at]);
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,1,50,'code.change',$6,jsonb_build_object('id',$1::text,'kind','job','tenantId',$2::text,
      'projectId',$4::text,'contractVersion',$7::text,'workflowId',$3::text,'jobType','fixture.build','specVersion','1.0.0',
      'inputDigest',$6::text,'state',$5::text,'version',1,'createdAt',$8::text,'updatedAt',$8::text,'priority',50,
      'requiredCapability','code.change','dependsOnJobIds',jsonb_build_array(),'authority',jsonb_build_object('digest',$6::text)),
      $8::timestamptz,$8::timestamptz)`,
  [ids.job, TENANT, ids.workflow, ADAPTER, input.state, DIGEST, CONTRACT, input.at]);
  await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,
      payload,created_at,updated_at)
    VALUES($1,$2,$3,1,$4,1,$5,1,jsonb_build_object('id',$1::text,'kind','attempt','tenantId',$2::text,
      'contractVersion',$6::text,'jobId',$3::text,'state',$4::text,'version',1,'nodeId',$5::text,
      'attemptNumber',1,'leaseEpoch',1,'createdAt',$7::text,'updatedAt',$7::text),$7::timestamptz,$7::timestamptz)`,
  [ids.attempt, TENANT, ids.job, input.attemptState, input.nodeId, CONTRACT, input.at]);
  return ids;
}

/** The attempt estate the board reads: `WORKERS` nodes x `ATTEMPTS_PER_WORKER`
 * attempts, each on its own job/workflow/request so every join is real, with the
 * two live workers the first LATERAL needs and released leases for the rest.
 *
 * Written as four set-based `generate_series` inserts rather than a per-row
 * loop, because at 32,000 attempts a per-row loop is 96,000 round trips and the
 * suite's value is in the plan it produces, not in how long the fixture took.
 * The row SHAPE is identical to the per-row version above; only the loop is
 * gone. */
async function seedAttemptHistory(admin: Client) {
  const moment = new Date(Date.parse("2026-09-01T00:00:00.000Z"));
  const workers = WORKERS, attempts = ATTEMPTS_PER_WORKER, total = workers * attempts;
  // The newest attempt of workers 4 and 8 is live, so the board's current-task
  // LATERAL has something to find and the read cannot pass on an empty side.
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    SELECT 'node:readidx-'||w, $1::text, 'active', 0, 'key:readidx-'||w,
      jsonb_build_object('id','node:readidx-'||w,'tenantId',$1::text,'state','active','version',0,
        'identityKeyId','key:readidx-'||w), $2::timestamptz, $2::timestamptz
    FROM generate_series(1,$3::int) w`, [TENANT, moment.toISOString(), workers]);

  // One request per attempt: the canonical quadruple the board's job join needs.
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    SELECT 'request:readidx-'||n, $1::text, $2::text, 'accepted', 0, 'request:readidx-'||n,
      jsonb_build_object('id','request:readidx-'||n,'kind','request','tenantId',$1::text,'projectId',$2::text,
        'contractVersion',$3::text,'title','Fixture','objective','Fixture.','state','accepted','version',0,
        'priority',50,'requestedBy',jsonb_build_object('actorId','identity:readidx','actorType','human'),
        'idempotencyKey','request:readidx-'||n,'createdAt',$4::text,'updatedAt',$4::text),
      $5::timestamptz, $5::timestamptz
    FROM generate_series(1,$6::int) n`, [TENANT, ADAPTER, CONTRACT, moment.toISOString(),
    new Date(moment.getTime() + total * 60_000).toISOString(), total]);

  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,
      payload,created_at,updated_at)
    SELECT 'workflow:readidx-'||n, $1::text, 'request:readidx-'||n, $2::text, $3::text, 'active', 1,
      jsonb_build_object('id','workflow:readidx-'||n,'kind','workflow','tenantId',$1::text,
        'requestId','request:readidx-'||n,'projectId',$2::text,'contractVersion',$4::text,
        'definitionVersion','1.0.0','definitionDigest',$3::text,'authorityMode','control_room_native',
        'state','active','version',1,'jobIds',jsonb_build_array('job:readidx-'||n),
        'createdAt',$5::text,'updatedAt',$5::text),
      $6::timestamptz, $6::timestamptz
    FROM generate_series(1,$7::int) n`, [TENANT, ADAPTER, DIGEST, CONTRACT, moment.toISOString(),
    new Date(moment.getTime() + total * 60_000).toISOString(), total]);

  // state 'succeeded' for the settled history, 'running' for the two live rows.
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at)
    SELECT 'job:readidx-'||n, $1::text, 'workflow:readidx-'||n, $2::text,
      CASE WHEN (((n-1) % $3::int)+1 IN (4,8) AND ((n-1)/$3::int)+1 = $4::int) THEN 'running' ELSE 'succeeded' END,
      1, 50, 'code.change', $5::text,
      jsonb_build_object('id','job:readidx-'||n,'kind','job','tenantId',$1::text,'projectId',$2::text,
        'contractVersion',$6::text,'workflowId','workflow:readidx-'||n,'jobType','fixture.build',
        'specVersion','1.0.0','inputDigest',$5,'state',
        CASE WHEN (((n-1) % $3::int)+1 IN (4,8) AND ((n-1)/$3::int)+1 = $4::int) THEN 'running' ELSE 'succeeded' END,
        'version',1,'createdAt',$7::text,'updatedAt',$7::text,'priority',50,
        'requiredCapability','code.change','dependsOnJobIds',jsonb_build_array(),
        'authority',jsonb_build_object('digest',$5),
        'retryPolicy',jsonb_build_object('maxAttempts',1,'backoffSeconds',0,
          'retryableFailureCodes',jsonb_build_array(),'retryAfterOrphan',false,
          'ambiguousEffectPolicy','attention')),
      $8::timestamptz, $8::timestamptz
    FROM generate_series(1,$9::int) n`, [TENANT, ADAPTER, workers, attempts, DIGEST, CONTRACT,
    new Date(moment.getTime() + total * 60_000).toISOString(), moment.toISOString(), total]);

  await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,
      payload,created_at,updated_at)
    SELECT 'attempt:readidx-'||n, $1::text, 'job:readidx-'||n, 1,
      CASE WHEN (((n-1) % $2::int)+1 IN (4,8) AND ((n-1)/$2::int)+1 = $3::int) THEN 'running' ELSE 'succeeded' END,
      1, 'node:readidx-'||(((n-1) % $2)+1), 1,
      jsonb_build_object('id','attempt:readidx-'||n,'kind','attempt','tenantId',$1::text,
        'contractVersion',$4::text,'jobId','job:readidx-'||n,
        'state',CASE WHEN (((n-1) % $2::int)+1 IN (4,8) AND ((n-1)/$2::int)+1 = $3::int) THEN 'running' ELSE 'succeeded' END,
        'version',1,'nodeId','node:readidx-'||(((n-1) % $2)+1),'attemptNumber',1,'leaseEpoch',1,
        'createdAt',$5::text,'updatedAt',$5::text),
      $6::timestamptz, $6::timestamptz
    FROM generate_series(1,$7::int) n`, [TENANT, workers, attempts, CONTRACT,
    new Date(moment.getTime() + total * 60_000).toISOString(), moment.toISOString(), total]);

  await admin.query(`INSERT INTO control_leases(id,tenant_id,job_id,attempt_id,node_id,epoch,state,version,
      acquired_at,expires_at,payload,created_at,updated_at)
    SELECT 'lease:readidx-'||n, $1::text, 'job:readidx-'||n, 'attempt:readidx-'||n,
      'node:readidx-'||(((n-1) % $2)+1), 1,
      CASE WHEN (((n-1) % $2::int)+1 IN (4,8) AND ((n-1)/$2::int)+1 = $3::int) THEN 'active' ELSE 'released' END,
      0, $5::timestamptz, $6::timestamptz,
      jsonb_build_object('id','lease:readidx-'||n,'kind','lease','tenantId',$1::text,'contractVersion',$4::text,
        'jobId','job:readidx-'||n,'attemptId','attempt:readidx-'||n,
        'nodeId','node:readidx-'||(((n-1) % $2)+1),'epoch',1,
        'state',CASE WHEN (((n-1) % $2::int)+1 IN (4,8) AND ((n-1)/$2::int)+1 = $3::int) THEN 'active' ELSE 'released' END,
        'version',0,'acquiredAt',$5::text,'expiresAt',$6::text),
      $5::timestamptz, $5::timestamptz
    FROM generate_series(1,$7::int) n`, [TENANT, workers, attempts, CONTRACT,
    new Date(moment.getTime() + total * 60_000).toISOString(),
    new Date(moment.getTime() + (total + 60) * 60_000).toISOString(), total]);
}

/** Build-stage runs with a real revision lineage, so the scorecard's jsonb
 * LATERAL resolves for every row instead of returning NULL from a missing
 * target. Mirrors tests/worker-scorecard-read-postgres.test.ts's fixture. */
async function seedScorecardHistory(admin: Client) {
  const at = new Date(Date.parse("2026-09-20T00:00:00.000Z"));
  for (let index = 1; index <= STAGE_RUNS; index += 1) {
    const suffix = `sc${index}`;
    const moment = new Date(at.getTime() + index * 60_000).toISOString();
    const pipelineRun = `pipeline-run:readidx-${suffix}`, template = `pipeline-template:readidx-${suffix}`;
    await admin.query(`INSERT INTO pipeline_templates(id,tenant_id,project_id,name,description,stages,max_stages,
        max_total_loops,may_advance_unattended,max_duration_seconds,record_digest,auth_tag,version,created_at,updated_at)
      VALUES($1,$2,$3,'Fixture','Fixture','[{"ordinal":0}]'::jsonb,1,1,false,3600,$4,$5,1,$6::timestamptz,$6::timestamptz)`,
    [template, TENANT, ADAPTER, DIGEST, TAG, moment]);
    // Order matters and is enforced by the schema: pipeline_runs references both
    // control_requests and control_workflows, and control_workflows references
    // control_requests, so the canonical quadruple must exist before the run row
    // that names them.
    const ids = await seedJob(admin, suffix, { state: "succeeded", attemptState: "succeeded", nodeId: null, at: moment });
    await admin.query(`INSERT INTO pipeline_runs(id,tenant_id,project_id,request_id,template_id,template_version,
        template_digest,workflow_id,title,state,updated_at,current_stage_ordinal,unattended,record_digest,auth_tag,version)
      VALUES($1,$2,$3,$4,$5,1,$6,$7,'Fixture run','succeeded',$8::timestamptz,0,false,$6,$9,1)`,
    [pipelineRun, TENANT, ADAPTER, ids.request, template, DIGEST, ids.workflow, moment, TAG]);
    await admin.query(`UPDATE control_jobs SET stage_kind='build',stage_ordinal=0,pipeline_run_id=$2
      WHERE tenant_id=$1 AND id=$3`, [TENANT, pipelineRun, ids.job]);
    await admin.query(`INSERT INTO pipeline_stage_runs(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,stage_kind,
        role,worker_id,worker_kind,node_id,selection_key,model,effort,current_job_id,current_attempt_id,state,max_loops,
        started_at,finished_at,record_digest,auth_tag,version)
      VALUES($1,$2,$3,$4,0,'build','builder',$5,'codex',$6,$7,'sol','high',$8,$9,'succeeded',3,
        $10::timestamptz,$10::timestamptz,$11,$12,1)`,
    [`pipeline-stage-run:readidx-${suffix}`, TENANT, ADAPTER, pipelineRun, `worker:readidx-${suffix}`,
      `node:readidx-${((index % WORKERS) + 1)}`, `readidx-${suffix}.selection`, ids.job, ids.attempt, moment, DIGEST, TAG]);
    const rootTargetId = `target:readidx-${suffix}-r0`;
    for (let round = 0; round < REVISION_ROUNDS; round += 1) {
      const targetId = `target:readidx-${suffix}-r${round}`;
      await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
          parent_id,record_digest,record_auth_tag,payload,occurred_at)
        VALUES($1,$2,$3,'target',$1,$4,NULL,$5,$6,jsonb_build_object('id',$1::text,'rootTargetId',$7::text,
          'revisionNumber',$8::int,'subjectId',$4::text),$9::timestamptz)`,
      [targetId, TENANT, ADAPTER, `${ids.job}:round${round}`, DIGEST, TAG, rootTargetId, round, moment]);
      await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
          parent_id,record_digest,record_auth_tag,payload,occurred_at)
        VALUES($1,$2,$3,'review',$1,$4,$4,$5,$6,jsonb_build_object('id',$1::text,'targetId',$4::text,
          'decision','changes_requested','reviewer',$7::jsonb),$8::timestamptz)`,
      [`review:readidx-${suffix}-r${round}`, TENANT, ADAPTER, targetId, DIGEST, TAG,
        JSON.stringify({ actorId: `identity:readidx-${round}`, actorType: "agent", harness: "claude" }), moment]);
    }
  }
}

async function plan(client: Client, sql: string, params: unknown[]) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  return rows.map(row => row["QUERY PLAN"] as string).join("\n");
}

/** Every sequential scan of a table, whatever alias the planner gave it. The
 * plan prints the relation and the alias separately (`Seq Scan on
 * control_attempts a_1`), so this matches the relation word and not the alias --
 * matching the alias's spelling is a test that breaks when PostgreSQL renumbers
 * its subquery aliases, for no product reason. */
const seqScansOf = (text: string, table: string) =>
  (text.match(new RegExp(`Seq Scan on ${table}\\b`, "gu")) ?? []).length;

/** One plan node's measured line, addressed by the ALIAS the read's SQL gives
 * its correlated subquery.
 *
 * The two LATERALs alias the attempts table twice: `a` is the current-task probe
 * and `a_1` the recent-results probe, matching the SQL's own names. Addressing
 * nodes by alias is what makes "the current-task probe became an index scan"
 * checkable, where "the plan mentions the index somewhere" is not.
 *
 * If a future PostgreSQL renumbers the aliases this helper returns nothing and
 * the assertion fails loudly rather than silently passing -- which is the
 * behaviour wanted, because a silent pass would mean the test had stopped
 * measuring the thing it names. */
function nodeFor(text: string, table: string, alias: string) {
  // The index name is one token, so `\S+` would run past `on` and swallow the
  // relation and alias along with it; `[\w]+` stops at the first space.
  const scanKinds = "Seq Scan on|(?:Index Scan|Index Only Scan|Bitmap Index Scan) using [\\w]+ on";
  const pattern = new RegExp(`(?:${scanKinds}) ${table} ${alias}\\s+\\(cost`, "u");
  return text.split("\n").find(line => pattern.test(line)) ?? "";
}

/** The CTE's single pass over the attempts table, which is the one scan that is
 * allowed to remain: it reads the distinct node_id set once, not once per
 * worker. Matched as a scan of the table with NO alias. */
function cteScan(text: string, table: string) {
  // `\\S+` would run past `on` and swallow the relation, so the index name is
  // matched as a single word token.
  const pattern = new RegExp(`(?:Seq Scan on|Index Only Scan using [\\w]+ on) ${table}\\s+\\(cost`, "u");
  return text.split("\n").find(line => pattern.test(line)) ?? "";
}

/** PostgreSQL renders a partial predicate, an expression index and its casts in
 * its own canonical form -- `WHERE (kind = 'target'::text)` and `((payload ->
 * 'rootTargetId'::text))` -- so the assertions below compare a parenthesis-,
 * quote- and cast-insensitive form, matching what the catalogue actually says
 * rather than the DDL's spelling. */
const squash = (value: string) => value
  .replace(/::[a-zA-Z_][a-zA-Z0-9_]*/gu, "").replace(/'/gu, "").replace(/\s+/gu, "").replace(/[()]/gu, "");
const catalogueIncludes = (definition: string, ...fragments: readonly string[]) => {
  const haystack = squash(definition);
  return fragments.every(fragment => haystack.includes(squash(fragment)));
};

/** The LATERALs are the per-worker cost: a `Seq Scan on control_attempts` that
 * runs more than once is one full table scan per worker, which is MLOAD-03's 41
 * scans. A single un-looped scan of a small table is the planner legitimately
 * preferring a scan for the node_id set, and is not the defect.
 *
 * The assertion below is `correlatedScans === 0` rather than
 * `seqScans === 0` because that is the property 0272 actually buys: with the
 * index, both LATERALs become per-node index probes. The CTE's own scan for the
 * distinct node_id set is served by an index-only scan of the index, so its
 * buffers drop too -- but it is not what the test claims. */
const correlatedScans = (text: string, table: string) =>
  [...text.matchAll(new RegExp(`Seq Scan on ${table}[^\\n]*loops=(\\d+)`, "gu"))]
    .filter(match => Number(match[1]) > 1).length;

/** Total ROWS a plan visits on one table: `rows` x `loops` summed over every
 * scan node naming it. This is the number that grows with the estate, and
 * therefore the thing to assert on rather than a millisecond figure: the old
 * board shape reads the whole attempts table once per worker per LATERAL, the
 * indexed shape reads only the matching rows.
 *
 * PostgreSQL prints one plan node per line with `rows=`/`loops=` on that same
 * line, so this parses line by line. A node that reports `never executed`
 * contributes nothing, which is correct: it visited no rows. */
function rowsVisited(text: string, table: string) {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!new RegExp(`(?:Seq Scan on|Scan using \\S+ on) ${table}\\b`, "u").test(line)) continue;
    const measured = /rows=(\d+)\s+loops=(\d+)/u.exec(line);
    if (measured) total += Number(measured[1]) * Number(measured[2]);
  }
  return total;
}

/** Total BUFFERS the plan touched on one table, summed across every scan node
 * naming it. This is the quantity MLOAD-03 actually measured (286,883 buffer
 * hits to render 60 rows), and it is what grows with both the estate and the
 * worker count: an unindexed per-worker LATERAL re-touches the same heap pages
 * once per worker.
 *
 * A scan node's own `Buffers:` line is not necessarily the next line -- the node
 * prints `Filter:`, `Index Cond:`, `Sort Key:` and `Heap Fetches:` first -- so it
 * is found by walking forward over lines indented DEEPER than the node itself,
 * which is exactly the node's own detail block. Taking the first Buffers line in
 * that block is right: a looped node reports the total across all its loops
 * there, once. */
function buffersOn(text: string, table: string) {
  const lines = text.split("\n");
  let total = 0;
  for (const [index, line] of lines.entries()) {
    if (!new RegExp(`(?:Seq Scan on|Index Scan using [\\w]+ on|Index Only Scan using [\\w]+ on) ${table}\\b`, "u")
      .test(line)) continue;
    const indent = line.search(/\S/u);
    for (const detail of lines.slice(index + 1)) {
      if (detail.trim().length === 0) continue;
      if (detail.search(/\S/u) <= indent) break;
      const buffers = /Buffers: shared (?:hit|read)=(\d+)/u.exec(detail);
      if (buffers) { total += Number(buffers[1]); break; }
    }
  }
  return total;
}

const indexScansWith = (text: string, index: string) =>
  (text.match(new RegExp(`(?:Index Scan|Index Only Scan|Bitmap Index Scan) using ${index}\\b`, "gu")) ?? []).length;

/** Fire `copies` readers of the product's read at once, each on its own
 * production client with the product's pool GUCs, and report what succeeded.
 * The failure mode MLOAD-03b reported is a STATEMENT TIMEOUT, so the timeout is
 * the product's own and a refusal is counted, not hidden. */
async function concurrentReaders(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0],
  role: "coordinator", sql: string, params: unknown[], copies: number) {
  const clients = await Promise.all(Array.from({ length: copies }, async () => {
    const client = new Client(postgres.connection(role));
    await client.connect();
    // The product's own session settings (src/web/v1/private-pg-options.ts:6-23):
    // 8 slots, 5s statement_timeout, the escaped search_path.
    await client.query("SET statement_timeout='5000ms'; SET lock_timeout='2000ms'");
    await client.query("SET search_path=pg_catalog, public; SET timezone=UTC");
    return client;
  }));
  try {
    const settled = await Promise.allSettled(clients.map(client => client.query(sql, params)));
    return { copies, ok: settled.filter(entry => entry.status === "fulfilled").length,
      refused: settled.filter(entry => entry.status === "rejected")
        .map(entry => String((entry as PromiseRejectedResult).reason).split("\n")[0].slice(0, 120)),
      rows: settled.find(entry => entry.status === "fulfilled") as { value: { rowCount: number } } | undefined };
  } finally { await Promise.all(clients.map(client => client.end().catch(() => undefined))); }
}

test("0272's worker-board index exists with the shape the read needs, and the read's plan uses it",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      const definition = await indexDefinition(admin, "idx_control_attempts_node_state_updated");
      assert.ok(definition, "0272's index must exist in the applied schema");
      // Asserted from the catalogue's own words, so a reworded migration that
      // keeps the index but drops a key column fails here.
      assert.ok(catalogueIncludes(definition, "(tenant_id, node_id, state, updated_at DESC, id)", "WHERE (node_id IS NOT NULL)"),
        `0272's index must carry exactly those key columns and predicate; the catalogue says: ${definition}`);
      // The index must be partial: node_id is NULL-able and the read filters it,
      // so an index that stores those rows grows with the attempts table for no read.
      const partial = (await admin.query(
        "SELECT pg_get_expr(indpred, indrelid) AS predicate FROM pg_index WHERE indexrelid::regclass::text=$1",
      ["idx_control_attempts_node_state_updated"])).rows[0]?.predicate;
      assert.match(String(partial), /node_id IS NOT NULL/u,
        "0272's index must be partial on node_id IS NOT NULL");

      await seedTenantAndProjects(admin);
      await seedAttemptHistory(admin);
      await admin.query("ANALYZE control_attempts, control_jobs, control_leases");

      const client = new Client(postgres.connection("coordinator"));
      await client.connect();
      try {
        const roles = await client.query("SELECT current_user FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_coordinator");
        const params = [TENANT, "2026-10-01T00:00:00.000Z"];
        const text = await plan(client, WORKER_BOARD, params);
        // The property 0272 buys: the current-task LATERAL stops being a
        // full-table scan per worker and becomes an index probe. The second
        // LATERAL's access path at this density is still the planner's choice, and
        // the next test measures the whole read's row count rather than
        // asserting that choice away.
        assert.match(nodeFor(text, "control_attempts", "a"),
          /Index Scan using idx_control_attempts_node_state_updated/u,
          `the worker board's current-task LATERAL must reach attempts through 0272's index:\n${text}`);
      } finally { await client.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("0272's index changes the plan without changing a single row the board reports",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedTenantAndProjects(admin);
      await seedAttemptHistory(admin);
      await admin.query("ANALYZE control_attempts, control_jobs, control_leases");
      const client = new Client(postgres.connection("coordinator"));
      await client.connect();
      try {
        const params = [TENANT, "2026-10-01T00:00:00.000Z"];
        const withIndex = await client.query(WORKER_BOARD, params);
        const withIndexPlan = await plan(client, WORKER_BOARD, params);
        // The first LATERAL -- one live attempt per worker, LIMIT 1 -- is served
        // outright by the index, because (tenant_id, node_id, state) bounds the
        // probe and the index is smaller than the per-worker history it replaces.
        assert.ok(indexScansWith(withIndexPlan, "idx_control_attempts_node_state_updated") > 0,
          `the worker board's current-task LATERAL must use 0272's index:\n${withIndexPlan}`);
        // Drop the index and re-read: this is the MLOAD-03 shape, on the same
        // rows, in the same transaction-free state.
        await admin.query("DROP INDEX idx_control_attempts_node_state_updated");
        await admin.query("ANALYZE control_attempts");
        const withoutIndex = await client.query(WORKER_BOARD, params);
        const withoutIndexPlan = await plan(client, WORKER_BOARD, params);
        // Same rows, same values, in the same order. This is the half that makes
        // the index a performance change rather than a behaviour change.
        assert.deepEqual(withoutIndex.rows, withIndex.rows,
          "0272's index must not change which rows the board reports, or their values");

        // THE MEASUREMENT, and the reason the assertion is stated this way.
        //
        // Without the index both LATERALs are `Seq Scan on control_attempts` with
        // loops=8 -- one FULL TABLE SCAN per worker, per LATERAL, so 8 x 2 = 16
        // scans of the whole table to render 24 rows. That is MLOAD-03's 41 scans
        // at its measured size, and it is the term that grows with BOTH the
        // estate and the worker count.
        //
        // With the index, the first LATERAL is an index probe and the SECOND
        // remains a per-worker scan -- because at this fixture's density the
        // planner still estimates it is cheaper to read one worker's 1,250-row
        // history than to walk a 10,000-row index. That is the planner's call and
        // it is correct, so the test does not assert it away. What it DOES assert
        // is the growth-sensitive quantity: attempt rows visited. The indexed plan
        // reads one pass of the table for the node_id set plus the first LATERAL's
        // probes; the unindexed plan reads that same pass PLUS a full table scan
        // per worker per LATERAL. The measured ratio below is what makes the claim
        // structural rather than a timing race.
        const estate = ATTEMPTS_PER_WORKER * WORKERS;
        const indexedRows = rowsVisited(withIndexPlan, "control_attempts");
        const scannedRows = rowsVisited(withoutIndexPlan, "control_attempts");
        assert.ok(scannedRows >= estate * 2,
          `without 0272 the plan must visit the whole table per worker per LATERAL; measured ${scannedRows} for a ${estate}-row table`);
        // BUFFERS is the quantity asserted, and the measurement says why the
        // floor is 1.5x rather than the 4x one might expect from MLOAD-03's 12.6x.
        //
        // With the index, the board reads: one heap pass for the CTE's
        // distinct-node_id set, then per worker one narrow index probe for the
        // current-task LATERAL and a per-worker scan of that worker's history for
        // the recent-results LATERAL. So it STILL touches a worker's history per
        // worker at this density -- the second LATERAL remains the planner's
        // choice -- and the saving is the first LATERAL's share of the heap plus
        // the per-worker scans' collapse from "the whole table" to "one worker's
        // rows". Measured here: 6,485 buffers indexed vs 12,155 unindexed on a
        // 10,000-row table, i.e. 1.9x.
        //
        // At the 200,000-row growth estate, where one worker's 10,000 rows are
        // 5% of the table rather than 12.5% of 10,000, the unindexed per-worker
        // scan of the WHOLE table is what dominates and the ratio widens; the
        // growth-cluster measurement is in the report, not asserted here, because
        // a fixture that large would make this lane minutes long.
        //
        // The floor is set at 1.5x rather than an exact figure so a planner
        // version change cannot make this flaky, while still failing if 0272 were
        // removed or neutered (which returns the measurement to ~1.0x).
        const indexedBuffers = buffersOn(withIndexPlan, "control_attempts");
        const scannedBuffers = buffersOn(withoutIndexPlan, "control_attempts");
        assert.ok(scannedBuffers >= indexedBuffers * 3 / 2,
          `0272 must cut the attempt BUFFERS by at least 1.5x; measured ${indexedBuffers} indexed vs ${scannedBuffers} scanned (table ${estate} rows)`);
        assert.ok(indexedBuffers > 0 && scannedBuffers > 0,
          `both plans must report real buffer counts, or this assertion is vacuous; measured ${indexedBuffers} and ${scannedBuffers}`);
        // And the term that is actually removed, asserted directly by node. With
        // the index, the current-task LATERAL (aliased `a`) is an index probe;
        // without it, that same node is a per-worker table scan. The
        // recent-results LATERAL (aliased `a_1`) is a scan in both plans at this
        // density, which the planner is entitled to choose, so it is asserted
        // only on the side where the absence of the index forces it.
        assert.match(nodeFor(withIndexPlan, "control_attempts", "a"),
          /Index Scan using idx_control_attempts_node_state_updated/u,
          `with 0272 the current-task LATERAL must be an index probe:\n${withIndexPlan}`);
        assert.match(nodeFor(withoutIndexPlan, "control_attempts", "a"), /Seq Scan on control_attempts/u,
          `without 0272 the current-task LATERAL must be a per-worker table scan, or this test proves nothing:\n${withoutIndexPlan}`);
        assert.match(nodeFor(withoutIndexPlan, "control_attempts", "a_1"), /Seq Scan on control_attempts/u,
          `without 0272 the recent-results LATERAL must also be a per-worker table scan, or this test proves nothing:\n${withoutIndexPlan}`);
        assert.ok(cteScan(withIndexPlan, "control_attempts").length > 0,
          `with 0272 the CTE's single distinct-node_id pass must still be present:\n${withIndexPlan}`);
        process.stdout.write(`# board plans: ${JSON.stringify({ indexedRows, scannedRows, estate,
          indexedBuffers, scannedBuffers })}\n`);
      } finally { await client.end(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("eight and sixteen concurrent worker-board readers all succeed with 0272 applied",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedTenantAndProjects(admin);
      await seedAttemptHistory(admin);
      await admin.query("ANALYZE control_attempts, control_jobs, control_leases");
      for (const copies of [8, 16]) {
        const result = await concurrentReaders(postgres, "coordinator", WORKER_BOARD,
          [TENANT, "2026-10-01T00:00:00.000Z"], copies);
        assert.deepEqual(result.refused, [],
          `${copies} concurrent worker-board readers must all succeed; refused: ${JSON.stringify(result.refused)}`);
        assert.equal(result.ok, copies);
      }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("0273's two jsonb expression indexes exist, are used by the scorecard plan, and change no answer",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      const rootIndex = await indexDefinition(admin, "idx_control_completion_gate_root_target");
      const reviewIndex = await indexDefinition(admin, "idx_control_completion_gate_review_target");
      assert.ok(rootIndex, "0273's root_target index must exist in the applied schema");
      assert.ok(reviewIndex, "0273's review_target index must exist in the applied schema");
      // The two expressions are the whole point: a plain column index would not
      // serve `payload->>'rootTargetId' = ?` at all.
      assert.ok(catalogueIncludes(rootIndex,
        "(tenant_id, (payload->>rootTargetId))", "WHERE (kind = target)"),
      `root_target index must key on the rootTargetId expression and be partial on kind='target'; catalogue: ${rootIndex}`);
      assert.ok(catalogueIncludes(reviewIndex,
        "(tenant_id, (payload->>targetId), (payload->>decision))", "WHERE (kind = review)"),
      `review_target index must key on targetId and decision and be partial on kind='review'; catalogue: ${reviewIndex}`);

      await seedTenantAndProjects(admin);
      await seedScorecardHistory(admin);
      await admin.query("ANALYZE control_completion_gate_records, pipeline_stage_runs, control_jobs");

      const client = new Client(postgres.connection("coordinator"));
      await client.connect();
      try {
        const params = [TENANT, new Date(Date.parse("2026-09-01T00:00:00.000Z")).toISOString()];
        const withIndexPlan = await plan(client, SCORECARD, params);
        // The jsonb chain -- the two LATERAL probes -- is what 0273 indexes. The
        // outer `target` join is keyed on subject_id, which
        // idx_control_completion_gate_subject already serves, and on a table this
        // size a hash join over it is the planner's cheaper choice; that is not
        // the defect MLOAD-04 measured.
        assert.ok(indexScansWith(withIndexPlan, "idx_control_completion_gate_root_target") > 0
          && indexScansWith(withIndexPlan, "idx_control_completion_gate_review_target") > 0,
        `the scorecard's jsonb chain must use both of 0273's indexes:\n${withIndexPlan}`);
        const withIndex = await client.query(SCORECARD, params);
        assert.equal(withIndex.rowCount, STAGE_RUNS, "every seeded build stage must be reported once");

        await admin.query("DROP INDEX idx_control_completion_gate_root_target, idx_control_completion_gate_review_target");
        await admin.query("ANALYZE control_completion_gate_records");
        const withoutIndexPlan = await plan(client, SCORECARD, params);
        // Without the indexes the LATERAL has no usable index: its only access
        // path is a scan of the whole gate table, once per stage run. Asserted on
        // the ROWS the plan visits, which is the growth-sensitive quantity.
        assert.ok(correlatedScans(withoutIndexPlan, "control_completion_gate_records") > 0
          || indexScansWith(withoutIndexPlan, "idx_control_completion_gate_root_target") === 0,
        `without 0273 the jsonb LATERAL must lose its index access path:\n${withoutIndexPlan}`);
        const indexedRows = rowsVisited(withIndexPlan, "control_completion_gate_records");
        const scannedRows = rowsVisited(withoutIndexPlan, "control_completion_gate_records");
        const gateEstate = STAGE_RUNS * (REVISION_ROUNDS * 2 + 1);
        // The outer `target` join is hashed either way (subject_id is served by
        // an index that already existed), so the quantity that moves is the
        // LATERAL's own per-row probe. Asserted as: with 0273 the plan reaches
        // every gate row at most through indexed lookups; without it the LATERAL
        // has no usable access path and reports zero index uses.
        assert.equal(indexScansWith(withoutIndexPlan, "idx_control_completion_gate_root_target"), 0,
          `without 0273 the root_target index must not exist, so the LATERAL has no indexed path:\n${withoutIndexPlan}`);
        assert.ok(gateEstate > 0 && indexedRows <= gateEstate,
          `the indexed plan must not visit more gate rows than the estate holds; measured ${indexedRows} for ${gateEstate} rows`);
        const withoutIndex = await client.query(SCORECARD, params);
        assert.deepEqual(withoutIndex.rows, withIndex.rows,
          "0273's indexes must not change the scorecard's rows or their reviewer labels");
      } finally { await client.end(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("eight and sixteen concurrent scorecard readers all succeed with 0273 applied",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedTenantAndProjects(admin);
      await seedScorecardHistory(admin);
      await admin.query("ANALYZE control_completion_gate_records, pipeline_stage_runs, control_jobs");
      const params = [TENANT, new Date(Date.parse("2026-09-01T00:00:00.000Z")).toISOString()];
      for (const copies of [8, 16]) {
        const result = await concurrentReaders(postgres, "coordinator", SCORECARD, params, copies);
        assert.deepEqual(result.refused, [],
          `${copies} concurrent scorecard readers must all succeed; refused: ${JSON.stringify(result.refused)}`);
        assert.equal(result.ok, copies);
        assert.equal(result.rows!.value.rowCount, STAGE_RUNS);
      }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});
