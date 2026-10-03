// Tango Tier 1: "Compare N bots, then a different bot synthesises" pipeline
// template (research/tango/06-tiers-vs-control-room.md, 03-recommendations.md
// row 5). The template is a pure builder over the existing work-batch DAG
// proposal schema (S1); this file proves the shape it builds and the
// combiner/presenter distinctness enforcement, then a real store test proves
// the built proposal flows through the ordinary, already-authorized
// work-batch path unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { buildCompareAndCombineProposalV1, submitCompareAndCombineTemplateV1,
  type CompareAndCombineTemplateInputV1 } from "../src/work-intake/v1/compare-combine-template";

const NOW = "2026-09-29T12:00:00.000Z";

const step = (workerKind: string, modelKey: string, overrides: Record<string, unknown> = {}) => ({
  title: `Answer via ${workerKind}`, instructions: "Answer the question independently.",
  requiredCapability: "research.answer", requestedWorkerId: `worker:${workerKind}:${modelKey}`, requestedWorkerKind: workerKind, requestedModelKey: modelKey,
  acceptanceCriteria: "The answer addresses the question.", acceptanceTests: "Read the answer.", ...overrides,
});

const template = (overrides: Partial<CompareAndCombineTemplateInputV1> = {}): CompareAndCombineTemplateInputV1 => ({
  schema: "control-room.compare-and-combine-template/v1", projectId: "project:test",
  question: "Should we launch feature X this quarter?",
  answerers: [step("worker:codex", "model:a"), step("worker:claude", "model:b")],
  combiner: step("worker:hermes", "model:c", { title: "Combine the answers" }),
  ...overrides,
});

test("builds one builder task per answerer, one checker task depending on all of them, and no presenter by default", () => {
  const proposal = buildCompareAndCombineProposalV1(template());
  assert.equal(proposal.projectId, "project:test");
  assert.deepEqual(proposal.tasks.map(t => t.role), ["builder", "builder", "checker"]);
  assert.deepEqual(proposal.tasks.map(t => t.localId), ["answer-1", "answer-2", "combine"]);
  assert.deepEqual(proposal.edges, [{ fromLocalId: "answer-1", toLocalId: "combine" },
    { fromLocalId: "answer-2", toLocalId: "combine" }]);
  assert.match(proposal.tasks[0]!.instructions, /Should we launch feature X this quarter\?/);
  assert.match(proposal.tasks[2]!.instructions, /Combine the 2 independent answers/);
});

test("an optional presenter depends only on the combiner, never directly on the answerers", () => {
  const proposal = buildCompareAndCombineProposalV1(template({
    presenter: step("worker:codex", "model:d", { title: "Present the result", requestedWorkerId: "worker:presenter" }),
  }));
  assert.deepEqual(proposal.tasks.map(t => t.role), ["builder", "builder", "checker", "validator"]);
  assert.deepEqual(proposal.edges, [{ fromLocalId: "answer-1", toLocalId: "combine" },
    { fromLocalId: "answer-2", toLocalId: "combine" }, { fromLocalId: "combine", toLocalId: "present" }]);
});

test("supports the full 2-4 answerer range and no more", () => {
  assert.equal(buildCompareAndCombineProposalV1(template({
    answerers: [step("worker:a", "model-1"), step("worker:b", "model-2"), step("worker:c", "model-3"), step("worker:d", "model-4")],
  })).tasks.length, 5);
  assert.throws(() => buildCompareAndCombineProposalV1(template({ answerers: [step("worker:a", "model-1")] })));
  assert.throws(() => buildCompareAndCombineProposalV1(template({
    answerers: [step("worker:a", "model-1"), step("worker:b", "model-2"), step("worker:c", "model-3"),
      step("worker:d", "model-4"), step("worker:e", "model-5")],
  })));
});

test("the combiner must not be one of the answerers", () => {
  assert.throws(() => buildCompareAndCombineProposalV1(template({
    combiner: step("worker:codex", "model:a", { title: "Combine" }), // same identity as answerer 1
  })), /combiner must not be one of the answerers/);
});

test("a presenter must not be an answerer or the combiner", () => {
  assert.throws(() => buildCompareAndCombineProposalV1(template({
    presenter: step("worker:claude", "model:b"), // same identity as answerer 2
  })), /presenter must not be one of the answerers/);
  assert.throws(() => buildCompareAndCombineProposalV1(template({
    presenter: step("worker:hermes", "model:c"), // same identity as the combiner
  })), /presenter must not be the combiner/);
});

test("two answerers naming the same bot and model are refused before any batch is built", () => {
  assert.throws(() => buildCompareAndCombineProposalV1(template({
    answerers: [step("worker:codex", "model:a"), step("worker:codex", "model:a")],
  })), /distinct worker identity/);
});

test("a pinned worker id still distinguishes an otherwise identical bot/model pair", () => {
  const proposal = buildCompareAndCombineProposalV1(template({
    answerers: [step("worker:codex", "model:a", { requestedWorkerId: "worker:codex:one" }),
      step("worker:codex", "model:a", { requestedWorkerId: "worker:codex:two" })],
    combiner: step("worker:codex", "model:a", { requestedWorkerId: "worker:codex:three", title: "Combine" }),
  }));
  assert.deepEqual(proposal.tasks.map(t => t.requestedWorkerId), ["worker:codex:one", "worker:codex:two", "worker:codex:three"]);
});

async function fixture() {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await raw.exec("CREATE SCHEMA control_room_queue; CREATE TABLE control_room_queue.job(id text PRIMARY KEY)");
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Workspace')");
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:test','tenant:test','manual','1','control_room_native',
    'fixture','v1',1)`);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES('project:test','tenant:test','workspace:test',
    'adapter:test','project:test','1','Project','planned','manual_project_active','healthy','control_room_native','${NOW}','{}')`);
  // A real project always carries its lifecycle (see work-intake.test.ts); proposal
  // admission refuses a project whose lifecycle it cannot establish.
  await raw.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:test','active',1,'${NOW}','${NOW}')`);
  await raw.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:agent','tenant:test','agent','Proposing agent',
    'work-intake','${sha256Digest("agent")}','active','${NOW}','${NOW}')`);
  await raw.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:proposer','tenant:test',
    'identity:agent','work_batch_proposer','["work_batches.propose"]','["project:test"]','low',false,false,'${NOW}','${NOW}')`);
  const db = adaptPglite(raw), store = new WorkBatchStoreV1(db, new Uint8Array(32).fill(7));
  return { raw, db, store, service: new WorkBatchServiceV1(store), close: () => raw.close() };
}
const principal: AuthenticatedPrincipal = { tenantId: "tenant:test", identityId: "identity:agent", actorType: "agent",
  authenticatedAt: "2026-09-29T11:59:00.000Z", expiresAt: "2026-09-29T13:00:00.000Z" };

test("the built proposal submits through the ordinary work-batch path exactly like a hand-written one", async t => {
  const f = await fixture(); t.after(() => f.raw.close());
  const receipt = await submitCompareAndCombineTemplateV1(f.service, { principal,
    template: template({ presenter: step("worker:codex", "model:d") }),
    idempotencyKey: "compare-combine-000000001", now: NOW });
  assert.ok("batchId" in receipt, "the template submits a real work batch, not a validation refusal");
  if (!("batchId" in receipt)) return;
  assert.equal(receipt.state, "proposed");
  assert.equal(receipt.startsWork, false);
  assert.equal(receipt.grantsExecutionAuthority, false);
  const status = await f.service.status({ principal, projectId: "project:test", batchId: receipt.batchId, now: NOW });
  assert.equal(status.state, "proposed");
  assert.equal(status.taskCount, 4);
  assert.equal(status.startsWork, false);
});

test("a combiner reusing an answerer's identity never reaches the database at all", async t => {
  const f = await fixture(); t.after(() => f.raw.close());
  await assert.rejects(() => submitCompareAndCombineTemplateV1(f.service, { principal,
    template: template({ combiner: step("worker:codex", "model:a") }),
    idempotencyKey: "compare-combine-000000002", now: NOW }));
  const rows = await f.db.query("SELECT count(*)::int AS n FROM work_batches");
  assert.equal((rows.rows[0] as { n: number }).n, 0);
});
