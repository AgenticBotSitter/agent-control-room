import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readMigrationGraph } from "./helpers/down-migration-order";
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

/** The scheduler's rule SCAN (int9's keyset pages with r6proj's lifecycle join, D4),
 * told apart from the cursor's tail count, which reads the same table but never orders. */
const isRuleScan = (sql: string) => sql.includes("FROM control_recurring_rules") && /ORDER BY (?:r\.)?rule_id/u.test(sql);

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
    { name: "Dependency review", instructions: "Inspect declared dependencies and report supported updates." },
    "action:recurring-first");
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
    { name: "Executable", instructions: "Interpolate $(curl https://example.invalid)" }, "action:recurring-executable"));
  await assert.rejects(f.skills.create(f.identity, f.projectId,
    { name: "Secret", instructions: `Bearer ${"x".repeat(40)}` }, "action:recurring-secret"));
  const oversized = await f.skills.create(f.identity, f.projectId,
    { name: "Oversized composition", instructions: "A".repeat(3_950) }, "action:recurring-oversized");
  await assert.rejects(f.rules.create(f.identity, f.projectId,
    { ...task(), skillRefs: [{ skillId: oversized.skillId, version: 1 }] }),
  (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
});

test("a long-off Mac proposes only the newest missed run through S1 and never starts work", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const skill = await f.skills.create(f.identity, f.projectId,
    { name: "Dependency review", instructions: "Inspect dependencies and cite source evidence." }, "action:recurring-longoff");
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
  // THE SAME GUARANTEE, OBSERVED AT THE LAYER THAT IS SUPPOSED TO REFUSE IT. Four
  // independent refusals protect a proposed occurrence's retry budget --
  // `occurrenceIneligible`'s three branches, the settled re-read inside admission,
  // and the upsert's own `state<>'proposed'` guard -- and measured, mutating any ONE
  // of them leaves this test green, because the others still refuse the tick and the
  // outcome is identical. Redundancy like that is worth keeping; an anchor a single
  // mutation can walk past is not. So the assertion is not the tick's OUTCOME but
  // whether the occurrence was ever taken to the row lock: `occurrenceIneligible` is
  // the ONLY refusal that happens before the lock, so it is the only one that can
  // keep a proposed occurrence from being locked at all, and that is what is counted.
  const budgetRule = await f.rules.create(f.identity, f.projectId, task(" retry budget"));
  const budgetAt = Date.parse("2026-09-28T10:00:00.000Z");
  const budgetPort = recurringWorkBatchProposalPortV1(f.workBatches, f.principal, () => budgetAt);
  assert.equal((await new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    budgetPort, () => budgetAt).tick()).proposed.length, 1, "the occurrence is proposed once");
  const budgetAttempts = async () => Number((await f.client.query<{ attempt_count: number }>(
    `SELECT attempt_count FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`,
  [scope.tenantId, budgetRule.ruleId])).rows[0]!.attempt_count);
  assert.equal(await budgetAttempts(), 1);
  let ruleLocks = 0;
  const countingLocks: import("../src/persistence/database").DatabaseClient = { ...f.client,
    transaction: work => f.client.transaction(tx => work({
      query: async (sql, params) => {
        if (sql.includes("FOR NO KEY UPDATE") && sql.includes("control_recurring_rules")) ruleLocks += 1;
        return tx.query(sql, params);
      } })) };
  // Five later ticks at the same instant, because the guarantee is about a repeat
  // rather than about one unlucky caller.
  let repeats = 0;
  for (let index = 0; index < 5; index += 1) {
    const again = await new RecurringRuleSchedulerV1(countingLocks, scope.tenantId, { read: () => "running" },
      { propose: async input => { repeats += 1; return await budgetPort.propose(input); } }, () => budgetAt).tick();
    assert.deepEqual(again.proposed, [], `later tick ${index + 1} reports no new proposal`);
  }
  assert.equal(ruleLocks, 0,
    "an already-proposed occurrence is refused before the row lock, which is where occurrenceIneligible refuses it");
  assert.equal(repeats, 0, "a proposed occurrence is never offered to the proposal port again");
  assert.equal(await budgetAttempts(), 1, "and it never spends a second attempt out of the owner's three");
});

test("owner approval binds the exact skill version into the canonical task", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const skill = await f.skills.create(f.identity, f.projectId,
    { name: "Evidence review", instructions: "Cite the source and distinguish facts from inference." }, "action:recurring-approval");
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

test("an operations-mode halt spends no attempt, so repeated halts cannot exhaust the retry budget", async t => {
  const f = await recurringFixture(); t.after(() => f.db.close());
  const rule = await f.rules.create(f.identity, f.projectId, task());
  const BACKOFF_MS = 15 * 60_000;
  // A mutable clock, because the backoff is what separates one halt from the next.
  // A retained row is ineligible for RETRY_BACKOFF_MS after it was written, so only
  // the FIRST halt of an occurrence reaches admission at all. The defect the review
  // found is therefore invisible on a fresh occurrence -- the upsert writes
  // attempt_count 1 either way -- and becomes visible only on a halt of an
  // occurrence that ALREADY has a row, which is what a later halt is.
  let tickAt = Date.parse("2026-09-07T10:00:00.000Z");
  const attempts = async () => Number((await f.client.query<{ attempt_count: number }>(`SELECT attempt_count
    FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`,
  [scope.tenantId, rule.ruleId])).rows[0]?.attempt_count ?? 0);
  // The mode flips between the tick's first read (which admits the scan) and the
  // admission-time read, which is the only window in which a halt can be observed
  // after a rule has already been selected as due.
  const haltedTick = async (at: number) => {
    let reads = 0;
    const scheduler = new RecurringRuleSchedulerV1(f.client, scope.tenantId,
      { read: () => ++reads === 1 ? "running" : "paused" },
      { propose: async () => assert.fail("a halted occurrence reached the proposal port") }, () => at);
    assert.equal((await scheduler.tick()).halted, "paused", `the halt at ${new Date(at).toISOString()} was observed`);
  };
  // FOUR HALTS OF THE ONE OCCURRENCE, one per backoff window. The owner is entitled to
  // stop the installation as often as they like, and none of those stops is the
  // scheduler asking S1 to do anything, so none of them is an attempt. The
  // three-attempt cap is the owner's stated bound on what the SCHEDULER spends
  // against S1; a pause must not quietly become a fourth way to spend it, because
  // the occurrence's whole retry budget would go without the work ever once having
  // been offered, and it would then leave the scan on `attempt_cap` with the owner's
  // own Pause as the reason.
  await haltedTick(tickAt);
  assert.equal(await attempts(), 1, "the first halt records the occurrence it stopped");
  for (let index = 1; index < 4; index += 1) {
    tickAt += BACKOFF_MS;
    await haltedTick(tickAt);
    assert.equal(await attempts(), 1,
      `an operations-mode halt spends no attempt however often it happens (halt ${index + 1})`);
  }
  // So the occurrence is still proposable: none of the four halts consumed its
  // budget, and one real proposal still spends the first attempt and succeeds.
  tickAt += BACKOFF_MS;
  const real = recurringWorkBatchProposalPortV1(f.workBatches, f.principal, () => tickAt);
  const result = await new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    real, () => tickAt).tick();
  assert.equal(result.proposed.length, 1, "the occurrence a halted tick recorded is still proposable");
  assert.equal(await attempts(), 2);
  // And a failed proposal still spends one, so the guard is scoped to the mode and
  // does not weaken the cap for the thing the cap is actually for.
  const failingRule = await f.rules.create(f.identity, f.projectId, task(" failing after halts"));
  assert.deepEqual(await new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { throw new Error("fixture_failure"); } }, () => tickAt).tick().then(tick => tick.failed),
  [failingRule.ruleId], "a genuine proposal failure is still a failure the owner sees");
  assert.equal(Number((await f.client.query<{ attempt_count: number }>(`SELECT attempt_count
    FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`,
  [scope.tenantId, failingRule.ruleId])).rows[0]!.attempt_count), 1,
  "a real proposal call is still exactly one attempt");
});

test("a paused rule and an edited rule are each refused before any proposal port call", async t => {
  // This case exists to make four scheduler guards SINGLY load-bearing. Each of them
  // has a second layer elsewhere that produces the same outcome on this fixture, so
  // mutating any one of them alone leaves the file green -- and an anchor that a
  // mutation survives is not a guard, it is a comment. Each mutation below is
  // therefore pinned to this case rather than to whichever test happened to pass.
  const f = await recurringFixture(); t.after(() => f.db.close());
  const tickAt = Date.parse("2026-09-07T10:00:00.000Z");
  const attemptsOn = async (ruleId: string) => Number((await f.client.query<{ attempt_count: number }>(
    `SELECT attempt_count FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`,
  [scope.tenantId, ruleId])).rows[0]?.attempt_count ?? 0);

  // THE ACTIVE-RULE SCAN IS THE FIRST PAUSE FENCE, and it is not the only one:
  // #claimOccurrence's row lock independently refuses a rule that is not `active`
  // under the lock. Both are real -- a rule can be paused between the scan and the
  // lock, which is exactly PLAN-U5's case -- so this observes the SCAN'S OWN OUTPUT
  // rather than the tick's outcome, because the outcome is the same either way.
  const scannedRows: string[][] = [];
  const counting: import("../src/persistence/database").DatabaseClient = { ...f.client,
    query: async (sql, params) => {
      const result = await f.client.query<{ rule_id: string }>(sql, params);
      if (isRuleScan(sql))
        scannedRows.push(result.rows.map(row => row.rule_id));
      return result as never;
    } };
  const pausedRule = await f.rules.create(f.identity, f.projectId, task(" paused at scan"));
  await f.rules.setPaused(f.identity, f.projectId, pausedRule.ruleId, { paused: true, expectedVersion: 1 });
  let portCalls = 0;
  const paused = await new RecurringRuleSchedulerV1(counting, scope.tenantId, { read: () => "running" },
    { propose: async () => { portCalls += 1; return assert.fail("a paused rule reached the proposal port"); } },
    () => tickAt).tick();
  assert.deepEqual(paused.proposed, []);
  assert.equal(scannedRows.length, 1, "the tick did scan the rules table");
  assert.deepEqual(scannedRows[0], [],
    "the active-rule scan itself excludes a paused rule, which is the first of its two fences");
  assert.equal(portCalls, 0, "a rule the scan excluded never reaches the proposal port");
  assert.equal(await attemptsOn(pausedRule.ruleId), 0, "and it spends no attempt either");

  // THE ROW LOCK IS THE SECOND PAUSE FENCE, and it is the one that closes the race
  // the scan cannot: a pause that COMMITS AFTER the scan selected the rule as due.
  // Asserting "no proposal" cannot separate the two fences, so the pause is committed
  // from inside the scan's own read -- the rule is handed back as `active` and is
  // already `paused` by the time the row lock is taken. The pause therefore lands in
  // the exact window the lock exists for, and mutating the locked read away lets the
  // rule through while leaving the scan untouched.
  const racedRule = await f.rules.create(f.identity, f.projectId, task(" paused after selection"));
  let pausedMidScan = false;
  const racing: import("../src/persistence/database").DatabaseClient = { ...f.client,
    query: async (sql, params) => {
      // The scan's rows are captured BEFORE the pause, which is the whole point: the
      // scheduler is handed a page in which the rule really was `active`, and the
      // pause then commits before the row lock is taken. Re-reading after the pause
      // would hand back a page that had already dropped the rule, and the tick would
      // be refused by the SCAN rather than by the lock -- which is the other fence,
      // and which this case must not be testing by accident.
      const result = await f.client.query(sql, params);
      if (!pausedMidScan && isRuleScan(sql)
        && sql.includes("state='active'") && result.rows.length) {
        pausedMidScan = true;
        await f.client.query(`UPDATE control_recurring_rules SET state='paused' WHERE tenant_id=$1 AND rule_id=$2`,
          [scope.tenantId, racedRule.ruleId]);
      }
      return result as never;
    } };
  const raced = await new RecurringRuleSchedulerV1(racing, scope.tenantId, { read: () => "running" },
    { propose: async () => { portCalls += 1; return assert.fail("a rule paused mid-scan reached the proposal port"); } },
    () => tickAt).tick();
  assert.equal(pausedMidScan, true, "the fixture really committed a pause inside the scan window");
  assert.deepEqual(raced.proposed, [], "a pause committed after selection still fences the proposal");
  assert.equal(portCalls, 0, "a rule that is not active under the lock is fenced before the port");
  assert.equal(await attemptsOn(racedRule.ruleId), 0, "a fence spends no attempt and leaves no ledger row");

  // AN EDITED RULE MUST NOT RETARGET A RECORDED OCCURRENCE. #evaluateRule compares
  // the retained row's definition digest and idempotency key against the current
  // definition, and the ledger upsert separately refuses any row whose digest does
  // not match -- so removing either one alone still protects the row. The property
  // that matters is that the occurrence the owner already failed is left exactly as
  // it was and NO port call is made, so both are asserted on the row itself.
  const editedRule = await f.rules.create(f.identity, f.projectId, task(" edited"));
  assert.deepEqual((await new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { throw new Error("fixture_failure"); } }, () => tickAt).tick()).failed,
  [editedRule.ruleId], "the occurrence fails once and is recorded");
  const before = await f.client.query<{ occurrence_key: string; definition_digest: string; attempt_count: number }>(
    `SELECT occurrence_key,definition_digest,attempt_count FROM control_recurring_proposals
      WHERE tenant_id=$1 AND rule_id=$2`, [scope.tenantId, editedRule.ruleId]);
  assert.equal(before.rows.length, 1);
  await f.rules.update(f.identity, f.projectId, editedRule.ruleId,
    { ...task(" edited"), instructions: "The edited instructions apply only to a new occurrence.",
      expectedVersion: 1 });
  // Past the backoff, so the occurrence is eligible and the definition check is the
  // only thing that can refuse it.
  const afterEdit = tickAt + 15 * 60_000;
  const retargeted = await new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { portCalls += 1; return assert.fail("an immutable failed occurrence was retargeted"); } },
    () => afterEdit).tick();
  assert.equal(retargeted.proposed.length, 0, "the edited definition cannot retarget the recorded occurrence");
  assert.equal(portCalls, 0, "and it makes no proposal call under a spent idempotency key");
  assert.deepEqual((await f.client.query<{ occurrence_key: string; definition_digest: string; attempt_count: number }>(
    `SELECT occurrence_key,definition_digest,attempt_count FROM control_recurring_proposals
      WHERE tenant_id=$1 AND rule_id=$2`, [scope.tenantId, editedRule.ruleId])).rows, before.rows,
    "the retained occurrence is byte-for-byte what the failed attempt left");
});


test("an occurrence past the retry cap is skipped by the settled re-read", async t => {
  // THE ATTEMPT CAP HAS FOUR LAYERS, and measuring it needs the state where exactly one
  // of them can refuse. This case found them by measurement, not by reading:
  //
  //   - `occurrenceIneligible` refuses a retained row whose count is past the cap,
  //     and it runs BEFORE admission;
  //   - the settled re-read inside admission refuses the same thing again, after the
  //     attempt-count upsert has settled;
  //   - the upsert's own `state<>'proposed'` guard protects rows a peer committed;
  //   - and the IMMUTABILITY CHECK refuses any row whose idempotency key is not the one
  //     this rule's current definition derives, which is the fourth and least obvious.
  //
  // The seeded row therefore has to carry the rule's REAL idempotency key, not merely
  // the right digest and occurrence key: a row with an invented key is refused by the
  // immutability check before admission is ever reached, so the case passes while
  // proving nothing about the cap. Measured, and that was the first version's fault.
  //
  // ITS OWN TENANT AND ITS OWN FIXTURE, deliberately. On the fixture above this rule
  // sorts behind three others in the scan's UUID order and the per-cycle cap of three
  // stops the tick before it is ever evaluated -- so the case would pass against a
  // scheduler that never looked at it at all. Measured, and that is exactly what
  // happened on the first attempt at writing it.
  const f = await recurringFixture(); t.after(() => f.db.close());
  const rule = await f.rules.create(f.identity, f.projectId, task(" attempt capped"));
  const { recurringRuleDefinitionDigestV1 } = await import("../src/recurring/v1/service");
  const ruleRow = (await f.client.query<Record<string, never>>(`SELECT * FROM control_recurring_rules
    WHERE tenant_id=$1 AND rule_id=$2`, [scope.tenantId, rule.ruleId])).rows[0];
  const definitionDigest = recurringRuleDefinitionDigestV1(ruleRow as never);
  // The tick instant decides WHICH occurrence the rule derives: the window runs from
  // the rule's own cursor (its creation instant) to now, and the scheduler collapses
  // every missed occurrence to the NEWEST one in it. A tick on Sept 7 therefore looks
  // for the Sept 7 occurrence, and the seeded row has to describe that one -- keying it
  // to any other instant leaves a row the scheduler never consults, and the case then
  // passes for the wrong reason.
  const local = "2026-09-07T09:00", tickAt = Date.parse("2026-09-07T10:00:00.000Z");
  const occurrenceKey = `${rule.ruleId}:${local}`;
  // The scheduler's own idempotency key, derived exactly as `#evaluateRule` derives it:
  // `recurring:<digest[7..39]>:<local time with the non-digits stripped>`. Getting this
  // wrong is invisible as a failure -- the immutability check refuses the row instead,
  // and the case still passes.
  const idempotencyKey = `recurring:${definitionDigest.slice(7, 39)}:${local.replace(/[^0-9]/g, "")}`;
  await f.client.query(`INSERT INTO control_recurring_proposals
    (tenant_id,project_id,rule_id,occurrence_key,scheduled_for,definition_digest,idempotency_key,state,attempt_count,
      created_at,updated_at) VALUES($1,$2,$3,$4,'2026-09-07T09:00:00.000Z',$5,$6,'pending',$7,$8,$8)`,
  [scope.tenantId, f.projectId, rule.ruleId, occurrenceKey, definitionDigest,
    idempotencyKey, 99, "2026-09-06T09:00:00.000Z"]);
  const seeded = await f.client.query<{ state: string; attempt_count: number; updated_at: string }>(
    `SELECT state,attempt_count,updated_at FROM control_recurring_proposals
      WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key=$3`, [scope.tenantId, rule.ruleId, occurrenceKey]);
  assert.deepEqual(seeded.rows.map(row => [row.state, Number(row.attempt_count)]), [["pending", 99]],
    "the occurrence is retained as pending, carrying every attempt already spent");
  // Well outside its own backoff, so the backoff cannot be what withholds the call and
  // the cap is the only thing left to refuse it.
  assert.ok(tickAt - Date.parse(seeded.rows[0]!.updated_at) > 15 * 60_000,
    "the retained row is outside its backoff window at this instant");
  // The scheduler really does derive THIS occurrence, so the assertions below are
  // about the cap and not about an empty window.
  const seen: string[] = [];
  const recording: import("../src/persistence/database").DatabaseClient = { ...f.client,
    query: async (sql, params) => {
      if (sql.includes("control_recurring_rules")) seen.push(sql.slice(0, 60));
      return f.client.query(sql, params) as never;
    } };
  let portCalls = 0;
  const result = await new RecurringRuleSchedulerV1(recording, scope.tenantId, { read: () => "running" },
    { propose: async () => { portCalls += 1; return assert.fail("an occurrence past the retry cap was proposed"); } },
    () => tickAt).tick();
  assert.ok(seen.length > 0, "the tick really did scan the rules table");
  assert.deepEqual(result.proposed, [], "an occurrence past the retry cap is skipped, not proposed");
  assert.equal(portCalls, 0, "and never reaches the proposal port however many attempts it already spent");
  assert.equal(Number((await f.client.query<{ attempt_count: number }>(`SELECT attempt_count
    FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key=$3`,
  [scope.tenantId, rule.ruleId, occurrenceKey])).rows[0]!.attempt_count), 99,
  "a skipped occurrence spends no further attempt");
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
  // A failure is not retried on the very next tick. The occurrence just recorded
  // its own failure, so it is inside its backoff window and a second tick one
  // minute later must make no S1 call at all -- the rule that made PLAN-U3's
  // starvation was retried immediately and forever. `failOnce` is still armed, so
  // an accidental call here would throw and fail the assertion on its own.
  assert.deepEqual((await scheduler.tick()).proposed, []);
  assert.deepEqual((await scheduler.tick()).proposed, []);
  // Past the window the retry happens, and the ledger shows the two attempts the
  // owner granted: one spent on the failure and one on the success.
  const afterBackoff = tickAt + 15 * 60_000;
  const later = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    recurringWorkBatchProposalPortV1(f.workBatches, f.principal, () => afterBackoff), () => afterBackoff);
  assert.equal((await later.tick()).proposed.length, 1);
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
  // The edited rule's failed occurrence is inside its backoff window, so this tick
  // skips it. What matters is that no port call is made: the ledger row is
  // immutable, so a retargeted retry would spend a DIFFERENT S1 idempotency key and
  // create a second batch for an occurrence that already failed once. The skip is
  // the correct outcome, and a call here would fail the assertion on its own.
  assert.deepEqual((await retargeted.tick()).proposed, []);
  assert.equal(retargetedCalls, 0);
  // And the edit really did leave the retained occurrence stale. Past the backoff
  // window the rule is no longer eligible either -- whichever way this tick gets
  // there, the immutability property is the one that matters: no port call, and no
  // second batch for an occurrence that already failed once.
  //
  // The tick is at the SAME instant as the ones above, deliberately: moving it
  // forward past the window would also make every rule created afterwards due at
  // once, and this assertion is about the edited rule alone.
  const afterEdit = new RecurringRuleSchedulerV1(f.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { retargetedCalls += 1; return assert.fail("an immutable failed occurrence was retargeted"); } },
    () => tickAt);
  const afterEditResult = await afterEdit.tick();
  assert.deepEqual(afterEditResult.proposed, []);
  assert.equal(retargetedCalls, 0);
  assert.equal((await f.client.query<{ count: number }>(`SELECT count(*)::int count FROM control_recurring_proposals
    WHERE tenant_id=$1 AND rule_id=$2 AND state<>'pending'`, [scope.tenantId, editedRule.ruleId])).rows[0]!.count,
    1, "the retargeted retry left the one retained failure and no batch");
  // The backoff really is what withheld it, rather than the rule having gone quiet
  // for some unrelated reason: the retained row is the only thing standing between
  // this occurrence and a call, and it is inside its window.
  const withheld = await f.client.query<{ attempt_count: number; updated_at: string | Date }>(
    `SELECT attempt_count,updated_at FROM control_recurring_proposals
      WHERE tenant_id=$1 AND rule_id=$2 AND state='failed'`, [scope.tenantId, editedRule.ruleId]);
  assert.equal(Number(withheld.rows[0]!.attempt_count), 1);
  assert.ok(Date.parse(String(withheld.rows[0]!.updated_at)) + 15 * 60_000 > tickAt,
    "the retained failure is inside its 15-minute backoff window at this instant");

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
  // The failing rules are a FRESH TENANT rather than four more rules on this one.
  // On the same fixture the scan still holds the three already-proposed rules, and
  // they are now `proposed` and ineligible -- which is correct, and which is why
  // this measurement used to read 2 rather than 3: the cap is spent on calls, and
  // the three ineligible rules spend none, so only two of the four failing rules were
  // ever reached before the budget ran out on something else. A dedicated tenant
  // makes the count about the CAP rather than about what else is in the scan.
  const empty = await recurringFixture();
  t.after(() => empty.db.close());
  for (let index = 0; index < 4; index += 1)
    await empty.rules.create(empty.identity, empty.projectId, task(` failure ${index}`));
  let failedCalls = 0;
  const failing = new RecurringRuleSchedulerV1(empty.client, scope.tenantId, { read: () => "running" },
    { propose: async () => { failedCalls += 1; throw new Error("fixture_failure"); } }, () => tickAt);
  const failingResult = await failing.tick();
  assert.equal(failedCalls, RECURRING_S7B_CAPS_V1.maxProposalsPerCycle,
    "failed calls still consume the per-cycle proposal cap");
  assert.equal(failingResult.failed.length, RECURRING_S7B_CAPS_V1.maxProposalsPerCycle,
    "and each one is reported as a failure, so the owner sees them");
  // A fourth failing rule was never reached: the cap stopped the tick, not the rules.
  assert.equal((await empty.client.query<{ count: number }>(`SELECT count(*)::int count
    FROM control_recurring_proposals WHERE tenant_id=$1`, [scope.tenantId])).rows[0]!.count,
    RECURRING_S7B_CAPS_V1.maxProposalsPerCycle, "the unattempted fourth rule has no ledger row at all");
});

test("the 0186 down migration refuses retained records and removes only empty owned objects", async t => {
  // 0246 added control_skill_create_actions with a foreign key onto
  // control_skills, so 0186's down can no longer drop that table until 0246's
  // own down has run. The graph is asked which down files 0186 depends on,
  // transitively, rather than being given a hand-maintained list or the whole
  // prefix: `downFiles` is ordered newest first and includes files unrelated to
  // skills, whose downs drop objects this test never created. Taking the prefix
  // failed with `trigger "control_result_file_sets_acceptance_guard" ... does
  // not exist`, which says nothing about 0186. The dependency set is what
  // actually orders this rung.
  const { before } = await readMigrationGraph();
  const prerequisites = new Set<string>();
  const stack = ["0186_recurring_rules_and_reusable_skills.sql"];
  while (stack.length > 0) {
    const file = stack.pop()!;
    for (const dependency of before.get(file) ?? []) {
      if (prerequisites.has(dependency)) continue;
      prerequisites.add(dependency); stack.push(dependency);
    }
  }
  assert.deepEqual([...prerequisites], ["0246_skill_create_idempotency.sql"],
    "0186's down depends on exactly the skill-create-action table's down");
  const down = (await Promise.all([...prerequisites].sort().reverse()
    .map((file: string) => readFile(join("db", "down", file), "utf8"))))
    .reduce((text: string, sql: string) => `${text}\n${sql}`, "")
    + await readFile(join("db", "down", "0186_recurring_rules_and_reusable_skills.sql"), "utf8");
  const populated = await recurringFixture(); t.after(() => populated.db.close());
  await populated.skills.create(populated.identity, populated.projectId,
    { name: "Retained skill", instructions: "This retained version blocks destructive downgrade." }, "action:recurring-retained");
  await assert.rejects(populated.db.exec(down), /0186 down migration refused/u);
  await populated.db.exec("ROLLBACK");
  assert.equal((await populated.client.query("SELECT 1 FROM control_skills")).rows.length, 1);

  const empty = await fixture(); t.after(() => empty.db.close());
  await empty.db.exec(down);
  // PGlite folds the column alias to lower case, so the key is matched in the
  // form it comes back rather than the form it was written in.
  const objects = await empty.client.query<Record<string, string | null>>(`SELECT
    to_regclass('control_recurring_rules')::text rules,to_regclass('control_recurring_proposals')::text proposals,
    to_regclass('control_skills')::text skills,to_regclass('control_skill_versions')::text versions,
    to_regclass('control_task_skill_bindings')::text bindings,
    to_regclass('control_skill_create_actions')::text create_actions`);
  assert.deepEqual(objects.rows[0], { rules: null, proposals: null, skills: null, versions: null,
    bindings: null, create_actions: null });
});


test("PLAN-01: every canonical schedule round-trips for all hours and minutes", () => {
  for (const day of ["day", "weekday", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"])
    for (let hour = 0; hour < 24; hour++) for (let minute = 0; minute < 60; minute++) {
      const parsed = parsePlainRecurringScheduleV1(`every ${day} at ${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`)!;
      assert.ok(parsed);
      assert.deepEqual(parsePlainRecurringScheduleV1(parsed.normalized), parsed);
    }
  for (const bad of ["every day at 24:00", "every day at 00:60", "every day at 13:00 pm", "every day at 00:00 am"])
    assert.equal(parsePlainRecurringScheduleV1(bad), undefined);
});


test("PLAN-04: default Mac host reads and saves chief-of-staff settings without a planner adapter", async t => {
  const { EventEmitter } = await import("node:events");
  const { createMacLocalWebServiceFromConfigurationV1 } = await import("../src/web/v1/mac-local-host");
  const { handlePrivateWebRequest } = await import("../src/web/v1/private-process");
  const f = await fixture(), savedClock = Date.now;
  Date.now = () => now;
  t.after(async () => { Date.now = savedClock; await f.db.close(); });
  const origin = "http://127.0.0.1:3210", ownerCode = "synthetic-test-owner-code-long-enough";
  const server = new EventEmitter() as import("node:http").Server;
  server.listen = ((_options: object, ready: () => void) => { queueMicrotask(ready); return server; }) as typeof server.listen;
  server.close = ((done: () => void) => { queueMicrotask(done); return server; }) as typeof server.close;
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const host = createMacLocalWebServiceFromConfigurationV1({
    configuration: { workspaceId: scope.workspaceId, port: 3210, enablement: { workers: [{ workerId: "worker:planner", kind: "codex",
      modelPolicy: { models: ["gpt-plan"], defaultModel: "gpt-plan", efforts: ["medium"], defaultEffort: "medium" } }], nodeId: "node:test" },
      localOwnerSession: { schema: "control-room.local-owner-session/v1", origin, tenantId: scope.tenantId,
        provider: trust.issuer, subject: "test-owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 } } as never,
    database: { client: f.client, isAvailable: () => true, close: async () => {} },
    workBatchIntegrityKey: integrityKey, assets: { count: 0, digest: "test", respond: () => undefined },
    render: () => new Response("page"), createServer: () => server });
  const send = (path: string, method = "GET", body?: unknown, cookie?: string) => handlePrivateWebRequest(
    new Request(origin + path, { method, headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
      "idempotency-key": "default-orchestration-test-0001", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), () => new Response("page"));
  try {
    await host.start();
    const login = await send("/api/v1/local-owner-session", "POST", { ownerCode });
    assert.equal(login.status, 201); const cookie = login.headers.get("set-cookie")!;
    const created = await send("/api/v1/projects", "POST", { title: "Host settings", summary: "Owner service proof" }, cookie);
    assert.equal(created.status, 201); const projectId = (await created.json()).project.projectId;
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-settings`;
    const read = await send(path, "GET", undefined, cookie);
    assert.equal(read.status, 200); const settings = await read.json();
    assert.equal(settings.describeAvailable, false);
    const choice = { mode: "selected", workerId: "worker:planner", workerKind: "codex", modelKey: "gpt-plan", effort: "medium" };
    const updated = await send(path, "POST", { expectedVersion: settings.version, choice }, cookie);
    assert.equal(updated.status, 200);
    const retained = await send(path, "GET", undefined, cookie);
    assert.equal(retained.status, 200); assert.deepEqual((await retained.json()).choice, choice);
    assert.equal((await send(path.replace("-settings", ""), "POST", { description: "Prepare a proposal." }, cookie)).status, 404);
  } finally { await host.close(); }
});

test("PLAN-04: retained suggestions work without a coordinator while description preparation stays unavailable", async t => {
  const { createProjectOrchestrationServiceV1 } = await import("../src/web/v1/project-orchestration-composition");
  const { PostgresProjectOrchestrationBatchRevisionsV1 } = await import("../src/web/v1/project-orchestration-postgres-store");
  const { PostgresIntakeSuggestionStoreV1 } = await import("../src/work-intake/v1/intake-coordinator-store");
  const { workBatchProposalDigestV1 } = await import("../src/work-intake/v1/digest");
  const f = await recurringFixture(); t.after(() => f.db.close());
  const proposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId: f.projectId, tasks: [{
    localId: "review", title: "Review dependencies", instructions: "Review the retained dependency evidence.",
    requiredCapability: "dependency.review", role: "builder" as const,
    acceptanceCriteria: "Evidence is cited.", acceptanceTests: "The owner checks the evidence.",
  }], edges: [] };
  const receipt = await f.workBatches.submit({ principal: f.principal, projectId: f.projectId,
    rawProposal: JSON.stringify(proposal), idempotencyKey: "retained-suggestion-batch-0001", now: new Date(now).toISOString() });
  assert.ok("batchId" in receipt);
  const current = await new PostgresProjectOrchestrationBatchRevisionsV1(f.client, scope.tenantId).read({
    tenantId: scope.tenantId, projectId: f.projectId, batchId: receipt.batchId });
  const suggestion = await new PostgresIntakeSuggestionStoreV1(f.client, integrityKey).append({
    tenantId: scope.tenantId, projectId: f.projectId, batchId: receipt.batchId, requestKey: "retained-suggestion-0001",
    baseRevision: current.revision, baseRevisionDigest: current.revisionDigest, proposerIdentityId: f.principal.identityId,
    proposal, proposalDigest: workBatchProposalDigestV1(proposal), flagsByLocalId: {}, createdAt: new Date(now).toISOString() });
  const service = createProjectOrchestrationServiceV1({ db: f.client, ...scope, integrityKey, queueCatalog: [], clock: () => now,
    planner: { available: true, principal: f.principal } });
  assert.equal((await service.readSettings(f.identity, f.projectId)).describeAvailable, false);
  await assert.rejects(service.describe(f.identity, f.projectId, { description: "Prepare a bounded plan." }, "retained-describe-0001"),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  const prefill = await service.useSuggestion(f.identity, f.projectId, receipt.batchId, suggestion.suggestionId, current.revision);
  assert.deepEqual(prefill.proposal, proposal);
  assert.equal(prefill.savesRevision, false); assert.equal(prefill.startsWork, false);
  assert.equal(prefill.grantsExecutionAuthority, false);
  await assert.rejects(service.useSuggestion(f.identity, f.projectId, receipt.batchId, "suggestion:missing", current.revision),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  await assert.rejects(service.useSuggestion(f.identity, f.projectId, receipt.batchId, suggestion.suggestionId, current.revision + 1),
    (error: unknown) => error instanceof WebAccessError && error.code === "conflict");
});

test("PLAN-05: installed intake drives recurring proposals, catches up at restart, and owns single-flight shutdown", async () => {
  const { EventEmitter } = await import("node:events");
  const { prepareWorkIntakePrivateServiceV1 } = await import("../src/work-intake/v1/private-service");
  const f = await recurringFixture();
  let clock = Date.parse("2026-09-07T10:00:00.000Z"), callback: (() => void) | undefined;
  // PLAN-U3's 15-minute retry backoff is KEPT (lead decision on rv-mplanpg §3b): the
  // starvation fix depends on it and the scheduler cannot tell a transient failure
  // from a permanent one. So a failed occurrence is retried once its window has passed,
  // NOT on the very next tick. `clock` is this installation's whole notion of now --
  // it feeds both the scheduler's clock and the intake's `now` -- so a retry tick has
  // to advance it, which is exactly what an installation waiting out a window does.
  const BACKOFF_MS = 15 * 60_000;
  let hold = false, reads = 0, released!: () => void, databaseClosed = false, coordinatorAvailable = true, reports = 0, fail = false, refuse = false;
  const blocked = new Promise<void>(resolve => { released = resolve; });
  const opened: string[] = [], closed: string[] = [];
  let reportReceived: (() => void) | undefined;
  let claimReleased: (() => void) | undefined;
  const nextReport = () => Promise.race([
    new Promise<boolean>(resolve => { reportReceived = () => resolve(true); }),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
  ]);
  // A tick that runs to completion releases the proposal claim last, so waiting on
  // that release is waiting on the tick. Bounded by the same two seconds a reported
  // failure gets, because a cycle that throws before its release reports instead.
  const tick = async () => {
    const released = new Promise<boolean>(resolve => {
      claimReleased = () => resolve(true);
      setTimeout(() => { if (claimReleased === undefined) resolve(false); }, 2_000);
    });
    callback!();
    return await released;
  };
  // The retained occurrence ledger, so each retry below can be read rather than
  // inferred from a total. Occurrence keys are rule-id-prefixed; only the schedule
  // instant distinguishes one from another, and it is that instant these cases are
  // about, so the key is trimmed to it.
  const ledger = async () => (await f.client.query<{ occurrence_key: string; state: string;
    attempt_count: number; safe_reason_code: string | null }>(`SELECT occurrence_key,state,attempt_count,
      safe_reason_code FROM control_recurring_proposals WHERE rule_id=$1 ORDER BY occurrence_key`,
  [rule.ruleId])).rows.map(row => ({ ...row,
    occurrence_key: row.occurrence_key.replace(/^recurring-rule:[0-9a-f-]{36}:/u, "") }));
  const db: import("../src/persistence/database").DatabaseClient = { ...f.client,
    transaction: callback => f.client.transaction(tx => callback({
      query: async (sql, params) => refuse && sql.includes("control_identities") ? { rows: [] } : tx.query(sql, params),
    })),
    async query<T>(sql: string, params?: unknown[]) {
      assert.equal(databaseClosed, false);
      if (refuse && sql.includes("control_identities")) return { rows: [] };
      // Matches the scheduler's rule SCAN by table, not by the exact query text: the scan
      // legitimately changed shape when the lifecycle filter was added (a join on
      // projects and the manual head), and a matcher keyed to the old text would keep
      // "passing" while silently no longer instrumenting the scan at all.
      if (isRuleScan(sql)) {
        reads++;
        if (fail) throw new Error("injected_dropped_connection");
        if (hold) await blocked;
      }
      const result = await f.client.query<T>(sql, params);
      // Releasing the proposal claim is the LAST statement of a tick, so it is the
      // one point every tick that actually ran passes through. `callback()` returns
      // void and a successful cycle reports nothing, so this is how the ticks below
      // are awaited rather than slept on -- polling the ledger for the expected
      // outcome instead would pass just as happily against a tick that never ran.
      if (sql.includes("control_recurring_proposal_claims SET expires_at")) {
        const signal = claimReleased; claimReleased = undefined; signal?.();
      }
      return result;
    } };
  const rule = await f.rules.create(f.identity, f.projectId, task());
  const server = new EventEmitter() as import("node:http").Server;
  server.listen = ((_options: object, ready: () => void) => { queueMicrotask(ready); return server; }) as typeof server.listen;
  server.close = ((done: () => void) => { queueMicrotask(done); return server; }) as typeof server.close;
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const database = { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_work_intake_agent",
    password: "disposable", majorVersion: 17 as const };
  const prepared = await prepareWorkIntakePrivateServiceV1({ port: 3212, database, integrityKey,
    credentials: [
      { workerId: "worker:missing", workerKind: "codex", credentialDigest: sha256Digest("missing"),
        principal: { ...f.principal, identityId: "identity:missing-proposer" } },
      { workerId: "worker:test", workerKind: "codex", credentialDigest: sha256Digest("synthetic"), principal: f.principal }],
    recurring: { tenantId: scope.tenantId, database: { ...database, username: "control_room_coordinator" } } },
  { openDatabase(config) { opened.push(config.username); return { client: db, isAvailable: () => config.username !== "control_room_coordinator" || coordinatorAvailable,
    async close() { closed.push(config.username); databaseClosed = true; } }; },
    createServer: () => server, now: () => new Date(clock).toISOString(),
    loopRuntime: { setInterval(run: () => void) { callback = run; return { unref() {} } as never; },
      clearInterval() { callback = undefined; }, report() { reports++; reportReceived?.(); } } });
  try {
    assert.equal(reads, 0, "preparation must not run a cycle");
    await prepared.start();
    const batches = await f.workBatches.list({ principal: f.principal, projectId: f.projectId, now: new Date(clock).toISOString() });
    assert.equal(batches.length, 1, "the default composition must run the missed due occurrence at startup");
    await Promise.all(Array.from({ length: 50 }, () => prepared.start()));
    assert.deepEqual(opened, ["control_room_work_intake_agent", "control_room_coordinator"]);
    assert.equal(prepared.isReady(), true);
    coordinatorAvailable = false; assert.equal(prepared.isReady(), false); coordinatorAvailable = true;
    assert.equal((await f.client.query<{ n: number }>("SELECT count(*)::int n FROM control_jobs")).rows[0]!.n, 0);
    // A dropped connection is reported, and the next cycle can retry.
    fail = true; const droppedReport = nextReport(); callback!();
    assert.equal(await droppedReport, true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports, 1); fail = false;
    clock = Date.parse("2026-09-14T10:00:00.000Z");
    refuse = true; const refusedReport = nextReport(); callback!();
    assert.equal(await refusedReport, true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reports, 2, "a refused proposal must report a failed cycle");
    refuse = false;
    // The September 14 occurrence recorded its own failure a moment ago, so it is
    // INSIDE its backoff window right now.
    const inside = await ledger();
    assert.deepEqual(inside.map(row => [row.occurrence_key, row.state, Number(row.attempt_count),
      row.safe_reason_code]),
      [["2026-09-07T09:00", "proposed", 1, null],
        ["2026-09-14T09:00", "failed", 1, "proposal_failed"]],
      "the startup occurrence stays proposed and the refused one is retained as a single failed attempt");
    // A RETRY INSIDE THE BACKOFF IS SKIPPED, and both halves matter: the occurrence is
    // not proposed, and it spends no attempt. `reads` is this fixture's count of rule
    // scans, so an extra scan proves the tick really looked and really declined; the
    // unchanged attempt count proves it declined for the backoff's reason rather than
    // spending the budget. Asserting only "not proposed" would pass just as well
    // against a tick that never ran.
    const beforeInside = reads;
    assert.equal(await tick(), true, "a tick inside the backoff window still runs");
    assert.equal(reads, beforeInside + 1, "that tick really scanned the rules");
    assert.deepEqual(await ledger(), inside, "a retry inside the backoff spends no attempt and changes nothing");
    // Past the window the retry happens, which is what makes the Sept-7 catch-up and
    // the Sept-14 retry different events rather than one.
    clock += BACKOFF_MS;
    assert.equal(await tick(), true, "the retry tick runs");
    const retried = await ledger();
    assert.deepEqual(retried.map(row => [row.occurrence_key, row.state, Number(row.attempt_count),
      row.safe_reason_code]),
      [["2026-09-07T09:00", "proposed", 1, null],
        ["2026-09-14T09:00", "proposed", 2, null]],
      "the retry succeeds once the window has passed and its second attempt is spent");
    hold = true; const before = reads;
    for (let i = 0; i < 50; i++) callback!();
    while (reads === before) await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, before + 1, "fifty timer callbacks may own only one tick");
    let settled = false;
    const closing = prepared.close().then(() => { settled = true; });
    assert.equal(prepared.isReady(), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(databaseClosed, false);
    released(); await closing;
    assert.equal(callback, undefined); assert.equal(closed.length, 2);
    await Promise.all(Array.from({ length: 50 }, () => prepared.close()));
    assert.equal(closed.length, 2); assert.equal(prepared.isReady(), false);
    await assert.rejects(prepared.start(), /work_intake_private_service_closed/);
    const count = (await f.client.query<{ n: number }>("SELECT count(*)::int n FROM control_recurring_proposals WHERE state='proposed'")).rows[0]!.n;
    assert.equal(count, 2);
    assert.equal((await f.client.query<{ n: number }>("SELECT count(*)::int n FROM control_attempts")).rows[0]!.n, 0);
  } finally { released(); await prepared.close(); await f.db.close(); }
});