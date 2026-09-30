import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { calculateScheduleOccurrencesV1 } from "../src/services/v1/recurrence";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchOwnerServiceV1, WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { WebTaskService } from "../src/web/v1/task-service";
import { parsePlainRecurringScheduleV1, RecurringRuleServiceV1 } from "../src/recurring/v1";
import { RecurringRuleSchedulerV1, recurringWorkBatchProposalPortV1,
  RECURRING_S7B_CAPS_V1, type RecurringProposalPortV1 } from "../src/scheduler/v1";
import { composeReusableSkillInstructionsV1, readBoundReusableSkillsInSessionV1,
  ReusableSkillServiceV1 } from "../src/skills/v1";
import { fixture, now, request, trust } from "./helpers/web-foundation";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const integrityKey = new Uint8Array(32).fill(19);
const task = (suffix = "") => ({ schedule: "every Monday at 9", timezone: "UTC",
  title: `Weekly dependency check${suffix}`, instructions: "Review dependency updates and summarize evidence.",
  requiredCapability: "dependency.review", acceptanceCriteria: "Evidence identifies relevant updates.",
  acceptanceTests: "The owner can review the proposal before any work starts.", skillRefs: [] });

async function recurringFixture() {
  const f = await fixture();
  const identity = createAccessVerifier(trust)(request(), now);
  const created = await f.service.create(identity, { title: "Recurring work", summary: "Safe proposal automation" },
    "recurring-project-create-0001");
  const projectId = created.project.projectId, at = new Date(now).toISOString();
  await f.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:recurring-agent',$1,'agent','Recurring proposer',
    'recurring-scheduler',$2,'active',$3,$3)`, [scope.tenantId, sha256Digest("recurring-agent"), at]);
  await f.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:recurring-proposer',$1,'identity:recurring-agent','work_batch_proposer',
    '["work_batches.propose"]',$2::jsonb,'low',false,false,$3,$3)`, [scope.tenantId, JSON.stringify([projectId]), at]);
  const principal: AuthenticatedPrincipal = { tenantId: scope.tenantId, identityId: "identity:recurring-agent",
    actorType: "agent", authenticatedAt: at, expiresAt: new Date(now + 90 * 86_400_000).toISOString() };
  const workBatches = new WorkBatchServiceV1(new WorkBatchStoreV1(f.client, integrityKey));
  return { ...f, identity, projectId, rules: new RecurringRuleServiceV1(f.client, scope, () => now),
    skills: new ReusableSkillServiceV1(f.client, scope, () => now), principal, workBatches };
}

test("plain schedules are deterministic and DST fallback emits the first local instant once", () => {
  assert.deepEqual(parsePlainRecurringScheduleV1("  every Monday at 9  "),
    { expression: "0 9 * * 1", normalized: "every monday at 09:00" });
  assert.deepEqual(parsePlainRecurringScheduleV1("every weekday at 12:05 pm"),
    { expression: "5 12 * * 1-5", normalized: "every weekday at 12:05" });
  assert.equal(parsePlainRecurringScheduleV1("whenever it seems useful"), undefined);
  const fallback = calculateScheduleOccurrencesV1({ id: "dst-fallback", kind: "cron", state: "active",
    expression: "30 1 * * 0", timezone: "America/Denver" },
  { startsAt: "2026-11-01T06:00:00.000Z", endsAt: "2026-11-01T10:00:00.000Z" });
  assert.equal(fallback.safeReason, undefined);
  assert.deepEqual(fallback.occurrences.map(value => [value.localTime, value.scheduledFor]),
    [["2026-11-01T01:30", "2026-11-01T07:30:00.000Z"]]);
});

test("skills create immutable exact versions and refuse stale, missing, executable, or secret-shaped input", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const first = await f.skills.create(f.identity, f.projectId,
    { name: "Dependency review", instructions: "Inspect declared dependencies and report supported updates." });
  const second = await f.skills.update(f.identity, f.projectId, first.skillId,
    { expectedVersion: 1, instructions: "Inspect dependencies, advisories, and release notes; cite the evidence." });
  assert.equal(second.version, 2); assert.notEqual(second.contentDigest, first.contentDigest);
  const versions = await f.client.query<{ version: number; instructions: string }>(`SELECT version,instructions
    FROM control_skill_versions WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3 ORDER BY version`,
  [scope.tenantId, f.projectId, first.skillId]);
  assert.deepEqual(versions.rows.map(row => [Number(row.version), row.instructions]), [
    [1, "Inspect declared dependencies and report supported updates."],
    [2, "Inspect dependencies, advisories, and release notes; cite the evidence."],
  ]);
  await assert.rejects(f.client.query(`UPDATE control_skill_versions SET instructions='changed' WHERE tenant_id=$1
    AND project_id=$2 AND skill_id=$3 AND version=1`, [scope.tenantId, f.projectId, first.skillId]), /append-only/u);
  await f.client.query("ALTER TABLE control_skill_versions DISABLE TRIGGER control_skill_versions_append_only");
  await f.client.query(`UPDATE control_skill_versions SET content_digest=$1 WHERE tenant_id=$2
    AND project_id=$3 AND skill_id=$4 AND version=1`, [`sha256:${"a".repeat(64)}`, scope.tenantId, f.projectId, first.skillId]);
  await assert.rejects(f.rules.create(f.identity, f.projectId,
    { ...task(), skillRefs: [{ skillId: first.skillId, version: 1 }] }),
  (error: unknown) => error instanceof WebAccessError && error.code === "conflict");
  await f.client.query(`UPDATE control_skill_versions SET content_digest=$1 WHERE tenant_id=$2
    AND project_id=$3 AND skill_id=$4 AND version=1`, [first.contentDigest, scope.tenantId, f.projectId, first.skillId]);
  await f.client.query("ALTER TABLE control_skill_versions ENABLE TRIGGER control_skill_versions_append_only");
  await assert.rejects(f.skills.update(f.identity, f.projectId, first.skillId,
    { expectedVersion: 1, instructions: "A stale write must fail." }),
  (error: unknown) => error instanceof WebAccessError && error.code === "conflict");
  await assert.rejects(f.rules.create(f.identity, f.projectId,
    { ...task(), skillRefs: [{ skillId: first.skillId, version: 99 }] }),
  (error: unknown) => error instanceof WebAccessError && error.code === "conflict");
  await assert.rejects(f.skills.create(f.identity, f.projectId,
    { name: "Executable", instructions: "Interpolate $(curl https://example.invalid)" }));
  await assert.rejects(f.skills.create(f.identity, f.projectId,
    { name: "Secret", instructions: `Bearer ${"x".repeat(40)}` }));
  const oversized = await f.skills.create(f.identity, f.projectId,
    { name: "Oversized composition", instructions: "A".repeat(3_950) });
  await assert.rejects(f.rules.create(f.identity, f.projectId,
    { ...task(), skillRefs: [{ skillId: oversized.skillId, version: 1 }] }),
  (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
});

test("a long-off Mac proposes only the newest missed run through S1 and never starts work", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const skill = await f.skills.create(f.identity, f.projectId,
    { name: "Dependency review", instructions: "Inspect dependencies and cite source evidence." });
  const rule = await f.rules.create(f.identity, f.projectId,
    { ...task(), skillRefs: [{ skillId: skill.skillId, version: skill.version }] });
  assert.equal(rule.startsWork, false); assert.equal(rule.grantsExecutionAuthority, false);
  const tickAt = Date.parse("2026-09-28T10:00:00.000Z");
  const scheduler = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    recurringWorkBatchProposalPortV1(f.workBatches, f.principal, () => tickAt), () => tickAt);
  const result = await scheduler.tick();
  assert.equal(result.startsWork, false); assert.equal(result.proposed.length, 1); assert.deepEqual(result.failed, []);
  const ledger = await f.client.query<{ occurrence_key: string; state: string; attempt_count: number }>(
    "SELECT occurrence_key,state,attempt_count FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2",
  [scope.tenantId, rule.ruleId]);
  assert.equal(ledger.rows.length, 1); assert.match(ledger.rows[0]!.occurrence_key, /2026-09-28T09:00/u);
  assert.deepEqual([ledger.rows[0]!.state, Number(ledger.rows[0]!.attempt_count)], ["proposed", 1]);
  await assert.rejects(f.client.query(`UPDATE control_recurring_proposals SET scheduled_for='2026-09-28T08:00:00.000Z'
    WHERE tenant_id=$1 AND rule_id=$2`, [scope.tenantId, rule.ruleId]), /recurring proposal update rejected/u);
  await assert.rejects(f.client.query("DELETE FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2",
    [scope.tenantId, rule.ruleId]), /append-only/u);
  await f.client.query(`INSERT INTO control_recurring_proposals
    (tenant_id,project_id,rule_id,occurrence_key,scheduled_for,definition_digest,idempotency_key,state,attempt_count,
      created_at,updated_at) VALUES($1,$2,$3,'forged-occurrence','2026-10-05T09:00:00.000Z',$4,
      'recurring-forged-batch-0001','pending',1,$5,$5)`, [scope.tenantId, f.projectId, rule.ruleId,
    `sha256:${"b".repeat(64)}`, new Date(tickAt).toISOString()]);
  await assert.rejects(f.client.query(`UPDATE control_recurring_proposals SET state='proposed',batch_id='batch:missing'
    WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key='forged-occurrence'`, [scope.tenantId, rule.ruleId]),
  /recurring proposal batch rejected/u);
  assert.equal((await f.client.query<{ count: number }>("SELECT count(*)::int count FROM work_batches")).rows[0]!.count, 1);
  assert.equal((await f.client.query<{ count: number }>("SELECT count(*)::int count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.client.query<{ count: number }>("SELECT count(*)::int count FROM control_attempts")).rows[0]!.count, 0);
  await f.client.query(`UPDATE control_recurring_rules SET last_evaluated_at='2026-09-04T12:00:00.000Z'
    WHERE tenant_id=$1 AND rule_id=$2`, [scope.tenantId, rule.ruleId]);
  assert.deepEqual((await scheduler.tick()).proposed, []);
  assert.equal((await f.client.query<{ count: number }>("SELECT count(*)::int count FROM work_batches")).rows[0]!.count, 1);
  assert.equal((await f.client.query<{ attempt_count: number }>(`SELECT attempt_count FROM control_recurring_proposals
    WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key=$3`,
  [scope.tenantId, rule.ruleId, ledger.rows[0]!.occurrence_key])).rows[0]!.attempt_count, 1,
  "an idempotent later tick must not spend the bounded retry budget");
});

test("owner approval binds the exact skill version into the canonical task", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const skill = await f.skills.create(f.identity, f.projectId,
    { name: "Evidence review", instructions: "Cite the source and distinguish facts from inference." });
  const proposed = { schema: "control-room.work-batch-proposal/v1" as const, projectId: f.projectId, tasks: [{
    localId: "review", title: "Review the evidence", instructions: "Review this week's dependency changes.",
    requiredCapability: "dependency.review", role: "builder" as const,
    acceptanceCriteria: "The review cites its evidence.", acceptanceTests: "The owner checks the cited sources.",
    skillRefs: [{ skillId: skill.skillId, version: 1 }],
  }], edges: [] };
  const submitted = await f.workBatches.submit({ principal: f.principal, projectId: f.projectId,
    rawProposal: JSON.stringify(proposed), idempotencyKey: "recurring-skill-binding-0001", now: new Date(now).toISOString() });
  assert.ok("batchId" in submitted);
  const owner = new WorkBatchOwnerServiceV1(f.client, new WebTaskService(f.client, scope, () => now),
    scope, integrityKey, () => now);
  const receipt = await owner.command(f.identity, f.projectId,
    { operation: "decide", batchId: submitted.batchId, expectedRevision: 1,
      items: [{ localId: "review", decision: "approve" }] }, "recurring-skill-owner-approve-0001");
  assert.equal(receipt.startsWork, false);
  const binding = await f.client.query<{ job_id: string; skill_version: number; content_digest: string; objective: string }>(`SELECT
      b.job_id,b.skill_version,b.content_digest,r.payload->>'objective' objective
    FROM control_task_skill_bindings b JOIN control_jobs j ON j.tenant_id=b.tenant_id AND j.id=b.job_id
    JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id
    JOIN control_requests r ON r.tenant_id=w.tenant_id AND r.id=w.request_id
    WHERE b.tenant_id=$1 AND b.skill_id=$2`, [scope.tenantId, skill.skillId]);
  assert.equal(binding.rows.length, 1); assert.equal(Number(binding.rows[0]!.skill_version), 1);
  assert.equal(binding.rows[0]!.content_digest, skill.contentDigest);
  assert.equal(binding.rows[0]!.objective, "Review this week's dependency changes.");
  await f.client.query("ALTER TABLE control_skill_versions DISABLE TRIGGER control_skill_versions_append_only");
  await f.client.query(`UPDATE control_skill_versions SET content_digest=$1 WHERE tenant_id=$2 AND project_id=$3
    AND skill_id=$4 AND version=1`, [`sha256:${"c".repeat(64)}`, scope.tenantId, f.projectId, skill.skillId]);
  await assert.rejects(f.client.transaction(tx => readBoundReusableSkillsInSessionV1(tx,
    { tenantId: scope.tenantId, projectId: f.projectId, jobId: binding.rows[0]!.job_id })), /conflict/u);
  await f.client.query(`UPDATE control_skill_versions SET content_digest=$1 WHERE tenant_id=$2 AND project_id=$3
    AND skill_id=$4 AND version=1`, [skill.contentDigest, scope.tenantId, f.projectId, skill.skillId]);
  await f.client.query("ALTER TABLE control_skill_versions ENABLE TRIGGER control_skill_versions_append_only");
  const prompt = await f.client.transaction(async tx => composeReusableSkillInstructionsV1(binding.rows[0]!.objective,
    await readBoundReusableSkillsInSessionV1(tx, { tenantId: scope.tenantId, projectId: f.projectId,
      jobId: binding.rows[0]!.job_id })));
  assert.match(prompt, /Evidence review \(.+@1\):\nCite the source/u);
});

test("Pause, Drain, and Stop block proposals, including a stop between selection and S1", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const rule = await f.rules.create(f.identity, f.projectId, task());
  const tickAt = Date.parse("2026-09-07T10:00:00.000Z");
  for (const [mode, halted] of [["paused", "paused"], ["draining", "draining"], ["stopped", "stopped"]] as const) {
    const scheduler = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => mode },
      { propose: async () => assert.fail(`${mode} reached proposal port`) }, () => tickAt);
    assert.deepEqual(await scheduler.tick(), { proposed: [], failed: [], halted, startsWork: false });
  }
  const pausedRule = await f.rules.setPaused(f.identity, f.projectId, rule.ruleId, { paused: true, expectedVersion: 1 });
  const pausedTick = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => assert.fail("a paused rule reached the proposal port") }, () => tickAt);
  assert.deepEqual((await pausedTick.tick()).proposed, []);
  await f.rules.setPaused(f.identity, f.projectId, rule.ruleId, { paused: false, expectedVersion: pausedRule.version });
  let reads = 0, calls = 0;
  const halfway = new RecurringRuleSchedulerV1(f.client, scope.tenantId,
    { read: () => ++reads === 1 ? "running" : "stopped" },
    { propose: async () => { calls += 1; return assert.fail("stop boundary reached proposal port"); } }, () => tickAt);
  assert.equal((await halfway.tick()).halted, "stopped"); assert.equal(calls, 0);
  const failed = await f.client.query<{ state: string; safe_reason_code: string }>(`SELECT state,safe_reason_code
    FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`, [scope.tenantId, rule.ruleId]);
  assert.deepEqual(failed.rows, [{ state: "failed", safe_reason_code: "operations_mode" }]);
});

test("a failed proposal retries safely and two concurrent callers still create one proposal", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const rule = await f.rules.create(f.identity, f.projectId, task());
  const tickAt = Date.parse("2026-09-07T10:00:00.000Z");
  const real = recurringWorkBatchProposalPortV1(f.workBatches, f.principal, () => tickAt);
  let failOnce = true;
  const flaky: RecurringProposalPortV1 = { propose: async input => {
    if (failOnce) { failOnce = false; throw new Error("fixture_failure"); }
    return real.propose(input);
  } };
  const scheduler = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" }, flaky, () => tickAt);
  assert.deepEqual((await scheduler.tick()).failed, [rule.ruleId]);
  assert.equal((await scheduler.tick()).proposed.length, 1);
  const retried = await f.client.query<{ state: string; attempt_count: number; safe_reason_code: string | null }>(
    `SELECT state,attempt_count,safe_reason_code FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`,
  [scope.tenantId, rule.ruleId]);
  assert.deepEqual(retried.rows.map(row => [row.state, Number(row.attempt_count), row.safe_reason_code]),
    [["proposed", 2, null]]);

  const editedRule = await f.rules.create(f.identity, f.projectId, task(" edited after failure"));
  const alwaysFails = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { throw new Error("fixture_failure"); } }, () => tickAt);
  assert.ok((await alwaysFails.tick()).failed.includes(editedRule.ruleId));
  const edited = await f.rules.update(f.identity, f.projectId, editedRule.ruleId,
    { ...task(" edited after failure"), instructions: "Use the edited instructions only for a new occurrence.", expectedVersion: 1 });
  assert.equal(edited.version, 2);
  let retargetedCalls = 0;
  const retargeted = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { retargetedCalls += 1; return assert.fail("an immutable failed occurrence was retargeted"); } },
    () => tickAt);
  assert.ok((await retargeted.tick()).failed.includes(editedRule.ruleId));
  assert.equal(retargetedCalls, 0);

  const concurrentRule = await f.rules.create(f.identity, f.projectId, task(" concurrent"));
  const first = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" }, real, () => tickAt);
  const second = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" }, real, () => tickAt);
  await Promise.all([first.tick(), second.tick()]);
  assert.equal((await f.client.query<{ count: number }>(`SELECT count(*)::int count FROM control_recurring_proposals
    WHERE tenant_id=$1 AND rule_id=$2 AND state='proposed'`, [scope.tenantId, concurrentRule.ruleId])).rows[0]!.count, 1);
  assert.equal((await f.client.query<{ count: number }>("SELECT count(*)::int count FROM work_batches")).rows[0]!.count, 2);

  const unsafeRule = await f.rules.create(f.identity, f.projectId, task(" unsafe receipt"));
  const unsafe = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async input => ({ ...await real.propose(input), startsWork: true as never }) }, () => tickAt);
  assert.deepEqual((await unsafe.tick()).failed, [unsafeRule.ruleId]);
  assert.equal((await f.client.query<{ count: number }>(`SELECT count(*)::int count FROM control_recurring_proposals
    WHERE tenant_id=$1 AND rule_id=$2 AND state='proposed'`, [scope.tenantId, unsafeRule.ruleId])).rows[0]!.count, 0);
});

test("the S1 adapter refuses any receipt that claims execution authority", async () => {
  const principal = { tenantId: scope.tenantId, identityId: "identity:agent", actorType: "agent" as const,
    authenticatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
  const unsafeService = { submit: async () => ({ schema: "control-room.work-batch-receipt/v1" as const,
    batchId: "batch:unsafe", projectId: "project:test", state: "proposed" as const,
    proposalDigest: `sha256:${"a".repeat(64)}`, revision: 1 as const, replayed: false,
    startsWork: true, grantsExecutionAuthority: false as const }) } as unknown as WorkBatchServiceV1;
  const port = recurringWorkBatchProposalPortV1(unsafeService, principal, () => now);
  await assert.rejects(port.propose({ ruleId: "recurring-rule:test", projectId: "project:test",
    occurrenceKey: "recurring-rule:test:2026-09-07T09:00", scheduledFor: "2026-09-07T09:00:00.000Z",
    definitionDigest: `sha256:${"b".repeat(64)}`, task: { ...task(), skillRefs: [] },
    idempotencyKey: "recurring-adapter-unsafe-0001" }), /recurring_proposal_refused/u);
});

test("the recurring cycle enforces the S7b proposal cap", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  for (let index = 0; index < RECURRING_S7B_CAPS_V1.maxProposalsPerCycle + 1; index += 1)
    await f.rules.create(f.identity, f.projectId, task(` ${index}`));
  const tickAt = Date.parse("2026-09-07T10:00:00.000Z"); let calls = 0;
  const port: RecurringProposalPortV1 = { propose: async input => {
    calls += 1; return recurringWorkBatchProposalPortV1(f.workBatches, f.principal, () => tickAt).propose(input);
  } };
  const result = await new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" }, port, () => tickAt).tick();
  assert.equal(result.proposed.length, RECURRING_S7B_CAPS_V1.maxProposalsPerCycle);
  assert.equal(calls, RECURRING_S7B_CAPS_V1.maxProposalsPerCycle);
  assert.equal((await f.client.query<{ count: number }>("SELECT count(*)::int count FROM work_batches")).rows[0]!.count,
    RECURRING_S7B_CAPS_V1.maxProposalsPerCycle);
  for (let index = 0; index < 4; index += 1) await f.rules.create(f.identity, f.projectId, task(` failure ${index}`));
  let failedCalls = 0;
  const failing = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { failedCalls += 1; throw new Error("fixture_failure"); } }, () => tickAt);
  await failing.tick();
  assert.equal(failedCalls, RECURRING_S7B_CAPS_V1.maxProposalsPerCycle,
    "failed calls still consume the per-cycle proposal cap");
});

test("the 0186 down migration refuses retained records and removes only empty owned objects", async t => {
  const down = await readFile("db/down/0186_recurring_rules_and_reusable_skills.sql", "utf8");
  const populated = await recurringFixture(); t.after(() => populated.db.close());
  await populated.skills.create(populated.identity, populated.projectId,
    { name: "Retained skill", instructions: "This retained version blocks destructive downgrade." });
  await assert.rejects(populated.db.exec(down), /0186 down migration refused/u);
  await populated.db.exec("ROLLBACK");
  assert.equal((await populated.client.query("SELECT 1 FROM control_skills")).rows.length, 1);

  const empty = await fixture(); t.after(() => empty.db.close());
  await empty.db.exec(down);
  const objects = await empty.client.query<{ rules: string | null; proposals: string | null;
    skills: string | null; versions: string | null; bindings: string | null }>(`SELECT
    to_regclass('control_recurring_rules')::text rules,to_regclass('control_recurring_proposals')::text proposals,
    to_regclass('control_skills')::text skills,to_regclass('control_skill_versions')::text versions,
    to_regclass('control_task_skill_bindings')::text bindings`);
  assert.deepEqual(objects.rows[0], { rules: null, proposals: null, skills: null, versions: null, bindings: null });
});
