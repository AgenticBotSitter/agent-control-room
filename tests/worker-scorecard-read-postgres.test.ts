// Real PostgreSQL proof for the worker/model scorecard read. It runs on the
// production web login (control_room_private_web) so a missing grant on
// pipeline_stage_runs or control_completion_gate_records fails here rather
// than only in a mocked unit test.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { DatabaseWorkerScorecardReadSourceV1 } from "../src/web/v1/worker-scorecard-read";

// Reserved disposable-cluster lane for this job: 59230-59231 unless the runner moves it.
const PORT = Number(process.env.WORKER_SCORECARD_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59230);
const PORTS = [PORT, PORT + 1];
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
 * count and "caught by" resolves to the most recent round's reviewer.
 *
 * R7-01: the lineage is seeded EXACTLY as the product writes it, because the
 * old fixture seeded `current_job_id` and the target's `subject_id` as the SAME
 * id and no execution plan at all -- a shape the product never produces, which
 * is why this fixture passed while every real build stage read as "review
 * outcome unknown". The stage names the SOURCE (proposal) job; an execution
 * plan maps it to the EXECUTION job; the review target's subject is the
 * execution job; each fix round adds a new source job + execution plan whose
 * plan carries `revision.rootSubjectId` (the FIRST execution job) and the
 * revised target keeps that root subject with revisionNumber>0. */
async function seedBuildStage(admin: Client, suffix: string, input: {
  workerKind: "codex" | "claude-code" | "hermes"; model: string; effort: string;
  finishedAt: string; outcome: "succeeded" | "failed" | "cancelled";
  priorRounds?: readonly { reviewer: { actorType: "agent" | "human"; actorId: string; harness?: string } }[];
  /** R7-04: seed the stage as one the OWNER cancelled. Excluded from the
   * scorecard entirely, so it must not appear in any group at all. */
  ownerCancelled?: boolean;
}) {
  const ids = { request: `request:sc-${suffix}`, workflow: `workflow:sc-${suffix}`, pipelineRun: `pipeline-run:sc-${suffix}`,
    template: `pipeline-template:sc-${suffix}`, source: `job:sc-${suffix}`, execution: `job:sc-${suffix}-exec`,
    attempt: `attempt:sc-${suffix}`, stage: `pipeline-stage-run:sc-${suffix}` };
  const at = input.finishedAt;
  // The fix round's source job: the stage's current_job_id MOVES to it, which is
  // the case the join has to survive.
  const revisionSource = `job:sc-${suffix}-fix`;
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
    [ids.source, TENANT, ids.workflow, PROJECT, input.outcome, DIGEST, at, ids.pipelineRun]);
    // The EXECUTION job the harness run is bound to, and the plan that reaches
    // it from the stage's source job. The execution job carries no stage lineage
    // of its own: 0105's guard reads it from the stage's CURRENT job.
    await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
        required_capability,authority_digest,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,1,50,'code.change',$6,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$5::text,'version',1,
        'priority',50,'workflowId',$3::text,'projectId',$4::text,'requiredCapability','code.change',
        'authority',jsonb_build_object('digest',$6::text)),
        $7::timestamptz,$7::timestamptz)`,
    [ids.execution, TENANT, ids.workflow, PROJECT, input.outcome, DIGEST, at]);
    await admin.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [TENANT, PROJECT, ids.source, ids.execution,
      JSON.stringify({ schema: "control-room.task-execution-plan/v1", tenantId: TENANT, projectId: PROJECT,
        sourceJobId: ids.source, jobId: ids.execution, job: { id: ids.execution } }), TAG]);
    const rounds = input.priorRounds ?? [];
    // A fix round is a NEW source job on the same stage, and the stage's
    // current_job_id moves to it. Only when there are rounds does the stage end
    // up naming the revision's source rather than its first one.
    let stageSourceJob = ids.source;
    let stageExecutionJob = ids.execution;
    for (const [index] of rounds.entries()) {
      const priorAt = new Date(Date.parse(at) - (rounds.length - index) * 120_000).toISOString();
      const roundSource = `job:sc-${suffix}-fix${index}`, roundExecution = `job:sc-${suffix}-fix${index}-exec`;
      await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
          required_capability,authority_digest,payload,created_at,updated_at,stage_kind,stage_ordinal,pipeline_run_id)
        VALUES($1,$2,$3,$4,$5,1,50,'code.change',$6,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$5::text,'version',1,
          'priority',50,'workflowId',$3::text,'projectId',$4::text,'requiredCapability','code.change',
          'authority',jsonb_build_object('digest',$6::text)),
          $7::timestamptz,$7::timestamptz,'build',0,$8)`,
      [roundSource, TENANT, ids.workflow, PROJECT, input.outcome, DIGEST, priorAt, ids.pipelineRun]);
      await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
          required_capability,authority_digest,payload,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,1,50,'code.change',$6,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$5::text,'version',1,
          'priority',50,'workflowId',$3::text,'projectId',$4::text,'requiredCapability','code.change',
          'authority',jsonb_build_object('digest',$6::text)),
          $7::timestamptz,$7::timestamptz)`,
      [roundExecution, TENANT, ids.workflow, PROJECT, input.outcome, DIGEST, priorAt]);
      // The revision's plan carries the ROOT subject: the FIRST execution job, not
      // this round's, which is the whole point of R7-01.
      await admin.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [TENANT, PROJECT, roundSource, roundExecution,
        JSON.stringify({ schema: "control-room.task-execution-plan/v2", tenantId: TENANT, projectId: PROJECT,
          sourceJobId: roundSource, jobId: roundExecution, job: { id: roundExecution },
          revision: { rootSubjectId: ids.execution, rootTargetId: `target:sc-${suffix}-r0`,
            fromJobId: index === 0 ? ids.source : `job:sc-${suffix}-fix${index - 1}`, revisionNumber: index + 1 } }), TAG]);
      stageSourceJob = roundSource;
      stageExecutionJob = roundExecution;
    }
    await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
      VALUES($1,$2,$3,1,$4,1,$5,1,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state',$4::text,'version',1,
        'jobId',$3::text,'attemptNumber',1,'nodeId',$5::text,'leaseEpoch',1),$6::timestamptz,$6::timestamptz)`,
    [ids.attempt, TENANT, stageExecutionJob, input.outcome, NODE, at]);
    // The stage's own attempt/lease pointers are NULL, which is what
    // PipelineServiceV1.instantiate writes (`currentAttemptId: null,
    // currentLeaseId: null`) and what every real stage row still carries:
    // nothing in the product ever UPDATEs pipeline_stage_runs (verified across
    // src, scripts and db -- the only writer is that one INSERT). The attempt
    // itself belongs to the EXECUTION job, because that is the job the
    // coordinator assigns, so the FK (current_attempt_id, current_job_id)
    // cannot be satisfied by it at all.
    await admin.query(`INSERT INTO pipeline_stage_runs(id,tenant_id,project_id,pipeline_run_id,stage_ordinal,stage_kind,role,
        worker_id,worker_kind,node_id,selection_key,model,effort,current_job_id,current_attempt_id,state,max_loops,
        started_at,finished_at,record_digest,auth_tag,version)
      VALUES($1,$2,$3,$4,0,'build','builder',$5,$6,$7,$8,$9,$10,$11,NULL,$12,3,$13::timestamptz,$13::timestamptz,$14,$15,1)`,
    [ids.stage, TENANT, PROJECT, ids.pipelineRun, `worker:${suffix}`, input.workerKind, NODE, `${suffix}.selection`,
      input.model, input.effort, stageSourceJob, input.outcome, at, DIGEST, TAG]);
    if (input.outcome !== "succeeded") return { ...ids, stageSourceJob, stageExecutionJob };
    const rootTargetId = `target:sc-${suffix}-r0`;
    // Every target in the lineage is keyed by the ROOT execution job, whatever
    // round produced it: revision N's target keeps the root subject.
    for (const [index, round] of rounds.entries()) {
      const targetId = index === 0 ? rootTargetId : `target:sc-${suffix}-r${index}`;
      const reviewId = `review:sc-${suffix}-r${index}`;
      await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
          parent_id,record_digest,record_auth_tag,payload,occurred_at)
        VALUES($1,$2,$3,'target',$1,$4,NULL,$5,$6,jsonb_build_object('id',$1::text,'rootTargetId',$7::text,
          'revisionNumber',$8::int,'subjectId',$4::text),$9::timestamptz)`,
      [targetId, TENANT, PROJECT, ids.execution, DIGEST, TAG, rootTargetId, index, at]);
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
    [finalTargetId, TENANT, PROJECT, ids.execution, DIGEST, TAG, rootTargetId, rounds.length, at]);
    await admin.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,
        parent_id,record_digest,record_auth_tag,payload,occurred_at)
      VALUES($1,$2,$3,'review',$1,$4,$4,$5,$6,jsonb_build_object('id',$1::text,'targetId',$4::text,'decision','accepted',
        'reviewer',jsonb_build_object('actorType','human','actorId','identity:owner')),$7::timestamptz)`,
    [`review:sc-${suffix}-final`, TENANT, PROJECT, finalTargetId, DIGEST, TAG, at]);
    return { ...ids, stageSourceJob, stageExecutionJob };
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
        .read({ tenantId: "tenant:worker-scorecard-empty", workspaceId: WORKSPACE, now: "2026-09-29T12:00:00.000Z" });
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
      // by a Claude checker, then by the owner, before the final accept. The
      // stage's current_job_id ends on the SECOND round's source job, so this
      // is the fixture that failed before R7-01.
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
      // R7-04: the OWNER cancelled this one. Its own model, so it would be its
      // own group if a cancellation were counted at all.
      await seedBuildStage(admin, "ownercancelled", { workerKind: "codex", model: "sol-cancelled", effort: "high",
        finishedAt: at(-600), outcome: "cancelled", ownerCancelled: true });

      const direct = new Client(postgres.connection("web")); await direct.connect();
      try {
        const roles = await direct.query<{ current_user: string }>("SELECT current_user FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_web");
        const view = await new DatabaseWorkerScorecardReadSourceV1({ query: direct.query.bind(direct) } as never)
          .read({ tenantId: TENANT, workspaceId: WORKSPACE, now: at(0) });
        assert.equal(view.groups.length, 2,
          `an owner-cancelled stage must not create a group: ${JSON.stringify(view.groups.map(g => g.model))}`);
        const codex = view.groups.find(group => group.workerKind === "codex")!;
        assert.equal(codex.model, "sol"); assert.equal(codex.effort, "high");
        // 30-day window sees all three Codex runs: 1 pass, 1 fix, 1 blocked.
        assert.equal(codex.last30Days.finished, 3);
        assert.equal(codex.last30Days.passedFirstTime, 1);
        assert.equal(codex.last30Days.neededFixes, 1);
        assert.equal(codex.last30Days.failedOrBlocked, 1);
        // R7-01: with the real lineage seeded, nothing is left "unknown": a
        // first-time pass, a two-round fix and the target each resolve.
        assert.equal(codex.last30Days.unknownReview, 0,
          "a real lineage must resolve every succeeded stage's review outcome");
        // The most recent changes_requested round (the owner's) is who "caught"
        // the fix that finally shipped, not the earlier Claude round.
        assert.deepEqual(codex.last30Days.caughtBy, [{ label: "Owner", count: 1 }]);
        // 7-day window excludes the 20-day-old blocked run.
        assert.equal(codex.last7Days.finished, 2);
        assert.equal(codex.last7Days.failedOrBlocked, 0);
        assert.equal(codex.last7Days.passedFirstTime, 1);
        assert.equal(codex.last7Days.neededFixes, 1);
        assert.equal(codex.last7Days.unknownReview, 0);
        const claude = view.groups.find(group => group.workerKind === "claude-code")!;
        assert.equal(claude.last30Days.finished, 1); assert.equal(claude.last30Days.passedFirstTime, 1);
        assert.equal(claude.last30Days.unknownReview, 0);
        // R7-04: an owner-cancelled stage is not the bot's failure. It must not
        // appear at all -- not as "failed or blocked", and not as a group of its
        // own that the owner would read as a bot that failed.
        assert.equal(view.groups.some(group => group.model === "sol-cancelled"), false,
          "a cancelled stage must not be counted against the bot");
        for (const group of view.groups) for (const bucket of [group.last7Days, group.last30Days])
          assert.equal(bucket.finished, bucket.passedFirstTime + bucket.neededFixes + bucket.failedOrBlocked + bucket.unknownReview,
            `finished must still equal the sum of the displayed categories for ${group.model}`);
      } finally { await direct.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 60_000 });
});

// PG-R6-06: `reviewer_pairs` grouped by `in_seven_days` and then aggregated with
// `jsonb_object_agg`, which KEEPS THE LAST DUPLICATE KEY without erroring. One
// worker/model group with two reviewed fixes by the SAME reviewer -- one inside
// seven days, one outside -- therefore emitted the same `reviewer_pair` twice,
// and the owner's 30-day reviewer credit became whichever of 1 or 2 the database
// happened to read last. Measured on PostgreSQL 17: with the 7-day row inserted
// first the map said "2", and with it inserted second the map said "1", for
// identical data.
//
// Order-dependence is a property of row order INSIDE one group, so both orders
// are seeded here as two separate groups in one tenant, and both must answer
// 3-then-1 splits correctly. A read that merely agreed with one insertion order
// is exactly the bug this test exists to catch.
test("PG-R6-06: reviewer credit across the 7-day boundary is identical in both insertion orders", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    // A fixed instant, so the 7-day and 30-day boundaries are the same for both
    // groups and only the INSERT ORDER differs between them.
    const readAt = "2026-10-01T12:00:00.000Z";
    const RECENT = "2026-09-28T12:00:00.000Z";   // 3 days ago: inside seven
    const OLD = "2026-09-11T12:00:00.000Z";      // 20 days ago: inside thirty, outside seven
    const reviewer = [{ reviewer: { actorType: "agent" as const, actorId: "identity:claude-checker", harness: "claude" } }];
    try {
      await seedTenant(admin);
      // Two models, one per insertion order, so the two orders land in two
      // DISTINCT groups (the grouping key is kind+model+effort+provider+profile).
      // Each group still receives the same pair of fixes from the same reviewer,
      // differing only in which of the two rows was inserted first.
      const orders = [["atlas-recent-first", ["recent", "old"]], ["atlas-old-first", ["old", "recent"]]] as const;
      for (const [model, order] of orders) {
        for (const which of order) {
          await seedBuildStage(admin, `r6-06-${model}-${which}`, { workerKind: "codex", model, effort: "high",
            finishedAt: which === "recent" ? RECENT : OLD, outcome: "succeeded", priorRounds: reviewer });
        }
      }

      const client = new Client(postgres.connection("web")); await client.connect();
      try {
        const view = await new DatabaseWorkerScorecardReadSourceV1({ query: client.query.bind(client) } as never)
          .read({ tenantId: TENANT, workspaceId: WORKSPACE, now: readAt });
        // Both seeded groups appear, each with its own two fixes.
        const groups = view.groups.filter(item => item.model.startsWith("atlas-"));
        assert.equal(groups.length, 2,
          `the two insertion orders must seed two groups, got ${JSON.stringify(view.groups.map(g => [g.model, g.last30Days.finished]))}`);
        // Both models were seeded, both with two fixes: an empty or merged pair
        // would make the order-independence assertion below vacuous.
        for (const model of ["atlas-recent-first", "atlas-old-first"])
          assert.ok(groups.some(item => item.model === model), `the ${model} group must be present`);
        for (const group of groups) {
          const where = JSON.stringify(group.last30Days.caughtBy);
          // THE ASSERTION. Two reviewed fixes in thirty days, one inside seven.
          // Under the old query the 30-day map was 1 or 2, chosen by insertion
          // order, so "correct for one order only" must fail here.
          assert.equal(group.last30Days.neededFixes, 2, `30-day fixes for this order: ${where}`);
          assert.deepEqual(group.last30Days.caughtBy, [{ label: "Claude checker", count: 2 }],
            `the 30-day reviewer credit must count BOTH fixes by the same reviewer, not one of them: ${where}`);
          assert.equal(group.last7Days.neededFixes, 1, "7-day fixes");
          assert.deepEqual(group.last7Days.caughtBy, [{ label: "Claude checker", count: 1 }],
            "the 7-day credit counts only the fix inside the window");
          assert.equal(group.last30Days.finished, 2);
          assert.equal(group.last7Days.finished, 1);
        }
        // And the two orders produced the SAME answer, which is the property the
        // fix is really about: identical data, identical numbers.
        assert.deepEqual(groups[0]!.last30Days.caughtBy, groups[1]!.last30Days.caughtBy,
          "the two insertion orders disagreed, so the credit still depends on history order");
        assert.deepEqual(groups[0]!.last7Days.caughtBy, groups[1]!.last7Days.caughtBy);
      } finally { await client.end(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 120_000 });
});

// M3-SCORE-U01: the old read capped its INPUT rows at 2000 and counted in
// JavaScript, so a busy model pushed an older model's entire history out of
// the query and the board silently reported a smaller fleet. This seeds one
// older model plus 1,999 in-window stages for another, then 1,999 / 2,000 /
// 2,001 in-window rows for the busy model, and requires the older model to stay
// visible with honest counts at every step.
test("M3-SCORE-U01: a busy model never pushes an older model off the scorecard, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    const now = new Date("2026-10-01T12:00:00.000Z");
    const at = (offsetSeconds: number) => new Date(now.getTime() + offsetSeconds * 1000).toISOString();
    try {
      await seedTenant(admin);
      // The OLDER model: one successful first-time pass, and one that needed a
      // fix caught by a Claude checker. Both are in-window. It is claude-code
      // rather than hermes because the table's own check constraint requires a
      // hermes stage to carry a provider and profile, and a non-hermes stage to
      // carry neither - the seed honours that rather than working around it.
      await seedBuildStage(admin, "oldpass", { workerKind: "claude-code", model: "atlas-old", effort: "low",
        finishedAt: at(-3_600), outcome: "succeeded" });
      await seedBuildStage(admin, "oldfix", { workerKind: "claude-code", model: "atlas-old", effort: "low",
        finishedAt: at(-2_700), outcome: "succeeded",
        priorRounds: [{ reviewer: { actorType: "agent", actorId: "identity:claude-checker", harness: "claude" } }] });

      const readAt = async (count: number) => {
        const client = new Client(postgres.connection("web")); await client.connect();
        try {
          return await new DatabaseWorkerScorecardReadSourceV1({ query: client.query.bind(client) } as never)
            .read({ tenantId: TENANT, workspaceId: WORKSPACE, now: at(0) });
        } finally { await client.end(); }
      };

      // The busy model grows one stage at a time, and the board is re-read at
      // 1,999, 2,000 and 2,001 in-window stages. Those are the exact counts the
      // old 2000-row input cap turned from a smaller number into a wrong one.
      let seeded = 0;
      for (const count of [1_999, 2_000, 2_001]) {
        for (let index = seeded; index < count; index += 1) {
          // Spread across the last six days, newest first, so every seeded
          // stage is unambiguously inside both windows. at(-600 + index) walked
          // the timestamp FORWARD from -600s as the index grew, which is only
          // 1,400 seconds over 2,001 rows and put many rows in the future -
          // outside the closed window - so 601 of 1,999 were in it.
          const minutesAgo = 1 + index * 4;
          await seedBuildStage(admin, `busy${index}`, { workerKind: "codex", model: "atlas-busy", effort: "high",
            finishedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(), outcome: "succeeded" });
        }
        seeded = count;
        const view = await readAt(count);
        const older = view.groups.find(group => group.model === "atlas-old");
        const busy = view.groups.find(group => group.model === "atlas-busy");
        assert.ok(older, `the older model must stay visible at ${count} busy stages`);
        assert.ok(busy, `the busy model must be present at ${count} stages`);
        // The older model's counts are exact, not truncated: 1 pass + 1 fix.
        assert.equal(older!.last30Days.finished, 2, `older history at ${count} busy stages`);
        assert.equal(older!.last30Days.passedFirstTime, 1);
        assert.equal(older!.last30Days.neededFixes, 1);
        assert.deepEqual(older!.last30Days.caughtBy, [{ label: "Claude checker", count: 1 }]);
        // And the busy model's own count is exact at every step.
        assert.equal(busy!.last30Days.finished, count, `busy count at ${count} seeded stages`);
        assert.equal(busy!.last30Days.passedFirstTime, count);
      }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 900_000 });
});

// M3-SCORE-U03: the old read bounded its window from below only, so a stage
// finished AFTER the observation instant was counted in "last 7/30 days"
// whenever the clock disagreed with a recorded finish.
test("M3-SCORE-U03: a finish dated after the observation instant is outside both windows, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    const now = new Date("2026-10-01T06:00:00.000Z");
    const at = (iso: string) => iso;
    try {
      await seedTenant(admin);
      // Exactly at the 7-day lower bound, exactly at the 30-day lower bound,
      // one millisecond before the 30-day bound, exactly at "now", and one day
      // in the FUTURE. The future row is the one the old read admitted.
      await seedBuildStage(admin, "sevenbound", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at("2026-09-24T06:00:00.000Z"), outcome: "succeeded" });
      await seedBuildStage(admin, "thirtybound", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at("2026-09-01T06:00:00.000Z"), outcome: "succeeded" });
      await seedBuildStage(admin, "beforebound", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at("2026-08-31T23:59:59.999Z"), outcome: "succeeded" });
      await seedBuildStage(admin, "atnow", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at("2026-10-01T06:00:00.000Z"), outcome: "succeeded" });
      await seedBuildStage(admin, "future", { workerKind: "codex", model: "sol", effort: "high",
        finishedAt: at("2026-10-02T06:00:00.000Z"), outcome: "succeeded" });

      const client = new Client(postgres.connection("web")); await client.connect();
      try {
        const read = (nowIso: string) => new DatabaseWorkerScorecardReadSourceV1({ query: client.query.bind(client) } as never)
          .read({ tenantId: TENANT, workspaceId: WORKSPACE, now: nowIso });
        const view = await read("2026-10-01T06:00:00.000Z");
        const group = view.groups.find(item => item.model === "sol")!;
        // 30-day: at the bound, 1 ms before it (excluded), exactly now. NOT the
        // future row. That is 3 of 5 seeded stages.
        assert.equal(group.last30Days.finished, 3,
          "a future-dated finish must not be counted in the 30-day window");
        // 7-day: the 7-day bound row and the exactly-now row. Not the future one.
        assert.equal(group.last7Days.finished, 2,
          "a future-dated finish must not be counted in the 7-day window");
        // Reading at a LATER instant legitimately brings the previously-future
        // row in: the bound follows the clock, and nothing is permanently lost.
        const later = await read("2026-10-03T06:00:00.000Z");
        const laterGroup = later.groups.find(item => item.model === "sol")!;
        assert.equal(laterGroup.last7Days.finished, 2, "7-day window slides with the clock");
        // At Oct 3 the 30-day window opens on Sep 3, so the Sep 1 row has
        // legitimately aged out while the formerly-future Oct 2 row is in.
        assert.equal(laterGroup.last30Days.finished, 3, "the future row is counted once it is in the past");
      } finally { await client.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 120_000 });
});

// R7-PERF: the lineage joins originally matched `payload->>'rootTargetId'` and
// `payload->>'targetId'`, which NO INDEX covers. Measured on PostgreSQL 17 as
// the production web role at 3,000 build stages, that read took 4,573 ms and
// grew as stages x gate records; joining on the indexed `subject_id` column
// instead takes 23 ms for identical output.
//
// The regression is asserted STRUCTURALLY, not only on a clock. A wall-clock
// bound alone would be flaky on a loaded machine and would still pass if the
// planner quietly fell back to the same nested loops on a different dataset,
// so the plan itself is the contract: every scan of `control_completion_gate_
// records` must be an index scan, and the reviewer's inner loop may not be
// re-entered per stage. That is the property that made the old plan quadratic;
// the timing bound is a second, coarser net over the same failure.
test("R7-PERF: the scorecard lineage joins use the index and stay bounded at 3,000 stages", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database })); await admin.connect();
    // A fixed instant, so the seeded window is identical on every run.
    const now = new Date("2026-10-01T12:00:00.000Z");
    try {
      await seedTenant(admin);
      const models = ["m-a", "m-b", "m-c", "m-d", "m-e", "m-f"];
      // One in three stages took a fix round, which is what makes the catcher
      // lateral fire at all; the rest are first-time passes.
      for (let index = 0; index < 3000; index += 1) {
        const rounds = index % 3 === 0
          ? [{ reviewer: { actorType: "agent" as const, actorId: "identity:claude-checker", harness: "claude" } }] : [];
        // Spread newest-first inside the 7-day window so every seeded stage is
        // unambiguously in both windows.
        const finishedAt = new Date(now.getTime() - (60 + index * 60) * 1000).toISOString();
        await seedBuildStage(admin, `perf${index}`, { workerKind: "claude-code", model: models[index % models.length]!,
          effort: "high", finishedAt, outcome: "succeeded", priorRounds: rounds });
      }
      await admin.query("ANALYZE");

      const client = new Client(postgres.connection("web")); await client.connect();
      try {
        const captured: { sql: string; params: unknown[] } = { sql: "", params: [] };
        const db = { query: async (sql: string, params: unknown[] = []) => {
          captured.sql = sql; captured.params = params; return client.query(sql, params);
        } };
        const started = Date.now();
        const view = await new DatabaseWorkerScorecardReadSourceV1({ query: db.query } as never)
          .read({ tenantId: TENANT, workspaceId: WORKSPACE, now: now.toISOString() });
        const readMs = Date.now() - started;
        // The dataset really is 3,000 stages and really is classified, so the
        // bound below is measured over a full read rather than an empty scan.
        const total = view.groups.reduce((sum, group) => sum + group.last30Days.finished, 0);
        assert.equal(total, 3000, "the fixture must present the full fleet to the bounded read");
        const fixes = view.groups.reduce((sum, group) => sum + group.last30Days.neededFixes, 0);
        assert.equal(fixes, 1000, "one in three stages took a fix round");

        const explain = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${captured.sql}`, captured.params as unknown[]);
        const lines = explain.rows.map(row => String(Object.values(row)[0]));
        const executionMs = Number(/Execution Time: ([\d.]+)/.exec(lines.find(line => /Execution Time/.test(line)) ?? "")?.[1] ?? NaN);

        // The structural contract, stated as a rule rather than as a plan
        // shape. A seq scan of the gate records is only acceptable when it runs
        // ONCE (loops=1): that is the single linear pass the planner makes for
        // the root-target join, and it is what the reviewer's own plan had. A
        // seq scan re-entered per stage is the quadratic read coming back,
        // whatever the clock says on the day -- so that is the failure this
        // asserts against, and a plan with many loops would fail it even if the
        // whole read happened to finish quickly.
        //
        // The node text is "Index Scan using <index> on <table>", so matching a
        // bare "Scan on <table>" silently drops every index scan and would make
        // the index assertion below vacuous. Match the scan node, whatever the
        // access method is called.
        const gateScans = lines.filter(line => /Scan[^()]*?\bon control_completion_gate_records\b/.test(line));
        const loopedSeqScans = gateScans.filter(line => /Seq Scan/.test(line)
          && Number(/loops=(\d+)/.exec(line)?.[1] ?? 1) > 1);
        assert.equal(loopedSeqScans.length, 0,
          `a seq scan of the gate records is inside a per-stage loop; plan had:\n${loopedSeqScans.join("\n")}`);
        // The lineage lookups themselves must be index-driven, not merely
        // cheap once. This is the property the fix exists to restore: the
        // subject_id columns are the leading predicate of
        // idx_control_completion_gate_subject, so an index scan is available
        // for each of them.
        const gateIndexScans = gateScans.filter(line => /Index Scan/.test(line)
          && /idx_control_completion_gate_subject/.test(line));
        assert.ok(gateIndexScans.length >= 3,
          `the lineage lookups must use idx_control_completion_gate_subject; found ${gateIndexScans.length} such scans`);
        // And the catcher's inner join must not be re-run once per stage. In
        // the slow plan `prior_target` was a pkey index scan with loops=1000000
        // for 1,000 fix rounds; index-driven it is a subject index scan with
        // loops=1000. The bound is generous because the exact loop count is the
        // planner's business, but it is O(fix rounds), not O(stages x rounds).
        const loops = gateScans.map(line => Number(/loops=(\d+)/.exec(line)?.[1] ?? 1));
        const worstLoops = Math.max(0, ...loops);
        assert.ok(worstLoops <= 3000,
          `a gate-record scan is re-entered ${worstLoops} times, which is the per-stage cost the index removed`);

        // The coarse second net: the same read the reviewer measured at 4,573 ms
        // must not climb back into seconds. 5 s on a disposable cluster is far
        // above the measured 23 ms and far below the old cost.
        assert.ok(readMs < 5000, `the scorecard read took ${readMs} ms at 3,000 stages`);
        assert.ok(executionMs < 5000, `the scorecard query took ${executionMs} ms at 3,000 stages`);
      } finally { await client.end(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 900_000 });
});

