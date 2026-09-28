import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent review guard binds the dedicated role to one server-created predecessor plan", async () => {
  const sql = await readFile("db/migrations/0097_agent_review_plans.sql", "utf8");
  assert.match(sql, /control_room_agent_reviewer/u);
  assert.match(sql, /agent reviewer raw insert rejected/u);
  assert.match(sql, /CREATE FUNCTION commit_agent_review[\s\S]*SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp/u);
  assert.match(sql, /effective_risk<>greatest\(minimum_risk,assessed_risk\)/u);
  assert.match(sql, /agent_review_hmac_sha256\(integrity_key/u);
  assert.match(sql, /review_payload->>'id'<>plan\.review_id/u);
  assert.match(sql, /review_payload->>'targetId'<>plan\.target_id/u);
  assert.match(sql, /run\.id=plan\.reviewer_run_id AND run\.job_id=plan\.reviewer_job_id/u);
  assert.match(sql, /attempt\.worker_id=plan\.reviewer->>'workerId'/u);
  assert.match(sql, /grantsApproval'[\s\S]*'false'/u);
  assert.match(sql, /grantsExecutionAuthority'[\s\S]*'false'/u);
  const service = await readFile("src/completion-gate/v1/agent-review-service.ts", "utf8");
  assert.match(service, /pipeline-stage-run\/v1/u);
  assert.match(service, /selected\.worker_kind=stage\.worker_kind/u);
  assert.match(service, /attempt\.worker_id=stage\.worker_id/u);
});

test("agent reviewer role has only completion-review commit privileges", async () => {
  const sql = await readFile("db/roles/agent_reviewer_roles.sql", "utf8");
  const grants = [...sql.matchAll(/^GRANT\s+[\s\S]*?;/gmu)].map(match => match[0]);
  assert.equal(grants.length, 4);
  assert.match(sql, /GRANT SELECT ON control_agent_review_plans, control_completion_gate_records,\s+control_completion_gate_integrity, control_harness_runs, control_attempts, control_task_execution_plans,\s+pipeline_stage_runs/u);
  assert.doesNotMatch(sql, /GRANT INSERT ON control_completion_gate_records/u);
  assert.doesNotMatch(sql, /UPDATE \(revision,record_count,state_digest,state_auth_tag\)/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION commit_agent_review\(text,jsonb,jsonb,bytea\)/u);
  assert.doesNotMatch(sql, /\b(?:control_jobs|control_leases|control_outbox|control_native_task_queue)\b/u);
  assert.doesNotMatch(sql, /GRANT\s+(?:DELETE|TRUNCATE|TRIGGER|REFERENCES)/u);
  assert.match(sql, /NOBYPASSRLS/u);
  assert.doesNotMatch(sql, /GRANT TEMPORARY/u);
  const preflight = await readFile("src/web/v1/private-database-preflight.ts", "utf8");
  assert.match(preflight, /verifyAgentReviewerDatabase/u);
  assert.match(preflight, /agentReviewerReads = \["control_agent_review_plans", "control_completion_gate_records"/u);
  assert.match(preflight, /agentReviewerInserts = new Set<string>\(\)/u);
  assert.match(preflight, /commit_agent_review\(text,jsonb,jsonb,bytea\)/u);
  assert.match(preflight, /agentReviewer: "control_room_agent_reviewer"/u);
  const databaseCheck = await readFile("scripts/mac-local/check-database.ts", "utf8");
  assert.match(databaseCheck, /verifyAgentReviewerDatabase\(db\.client, config, scope, Date\.now\(\), \{ nativeQueue: true \}\)/u);
  const provider = await readFile("src/web/v1/mac-local-default-task-provider.ts", "utf8");
  assert.match(provider, /verifyAgentReviewerDatabase\(reviewerPool\.client,[\s\S]*\{ nativeQueue: true \}\)/u);
});

test("0097 down migration refuses to erase review authority history", async () => {
  const sql = await readFile("db/down/0097_agent_review_plans.sql", "utf8");
  assert.match(sql, /LOCK TABLE control_completion_gate_records, control_agent_review_plans IN ACCESS EXCLUSIVE MODE/u);
  assert.match(sql, /agent review history exists/u);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname='control_room_agent_reviewer'\)/u);
  assert.match(sql, /REVOKE UPDATE \(web_lock\) ON control_completion_gate_records FROM control_room_agent_reviewer/u);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION commit_agent_review\(text,jsonb,jsonb,bytea\) FROM control_room_agent_reviewer/u);
  assert.match(sql, /REVOKE USAGE ON SCHEMA public FROM control_room_agent_reviewer/u);
});
