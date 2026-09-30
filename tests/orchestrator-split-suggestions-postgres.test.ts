// Real PostgreSQL proof for MIG-A (plan v4.3 §2.1): the orchestrator's
// re-split suggestion (0200), the planner selection (0201) and the durable
// failure/escalation bookkeeping (0202).
//
// Everything here runs AS the production logins. The superuser connection is
// used only to seed fixtures and to prove a refusal the login itself cannot be
// asked for; every authority assertion is made from the intake, coordinator and
// private-web logins.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { workBatchProposalDigestV1, PostgresIntakePlannerFailureStoreV1,
  PostgresIntakeNeedsYouStoreV1, PostgresIntakeSuggestionStoreV1, IntakeSuggestionStoreErrorV1,
  UnwiredPlannerAllowanceV1, type WorkBatchProposalV1 } from "../src/work-intake/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

// Reserved disposable-cluster lane for MIG-A: 59370-59379, or the test runner's
// assigned port block, so concurrent runs never collide.
const PORT = Number(process.env.ORCHESTRATOR_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59370);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
const NOW = "2026-09-29T21:00:00.000Z";
const LATER = "2026-09-29T22:00:00.000Z";
const KEY = new Uint8Array(32).fill(41);

const scope = { tenantId: "tenant:orch", workspaceId: "workspace:orch", projectId: "project:orch" };
// A second tenant and project in the same cluster, so "cross-tenant refused" is
// proven against a real other tenant rather than a missing row.
const other = { tenantId: "tenant:orch-other", workspaceId: "workspace:orch-other",
  projectId: "project:orch-other" };

function database(client: Client): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) => {
    const result = await client.query(sql, values as never[]); return { rows: result.rows as T[] };
  } };
  return {
    query: session.query,
    transaction: async work => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
  } as DatabaseClient;
}

function proposal(taskCount: number): WorkBatchProposalV1 {
  return { schema: "control-room.work-batch-proposal/v1", projectId: scope.projectId, tasks:
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

/** An agent identity with the propose grant, an owner, and an agent WITHOUT it. */
async function seedIdentities(admin: Client, at: { tenantId: string; projectId: string }) {
  const rows: Array<[string, string, string, string, string]> = [
    ["identity:orch-agent", "agent", "work-intake", "work_batch_proposer", '["work_batches.propose"]'],
    ["identity:orch-ungranted", "agent", "work-intake", "work_batch_proposer", '["work_batches.propose","work_batches.decide"]'],
    ["identity:orch-owner", "human", "test", "owner", '["*"]'],
  ];
  for (const [id, actorType, provider, roleKey, actions] of rows) {
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,'Fixture',$4,$5,'active',$6,$6)
      ON CONFLICT DO NOTHING`, [id, at.tenantId, actorType, provider, sha256Digest({ id }), NOW]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'["*"]'::jsonb,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING`,
    [`grant:${id}`, at.tenantId, id, roleKey, actions,
      roleKey === "owner" ? "critical" : "low", roleKey === "owner", false, NOW]);
  }
}

/** A proposed batch at revision 1, inserted as the schema owner would. */
async function seedBatch(admin: Client, at: { tenantId: string; projectId: string }, batchId: string,
  proposer = "identity:orch-agent", state = "proposed") {
  const value = proposal(2);
  const digest = workBatchProposalDigestV1(value);
  const material = { id: batchId, tenantId: at.tenantId, projectId: at.projectId, proposedByIdentityId: proposer,
    proposedAt: NOW, state: "proposed", proposal: value, queueDepthLimit: 10, batchDigest: digest,
    version: 1, createdAt: NOW, updatedAt: NOW };
  await admin.query(`INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,proposed_by_actor_type,
    proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
    VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,10,$7,$8,1,$5,$5)`,
  [batchId, at.tenantId, at.projectId, proposer, NOW, JSON.stringify(value), digest,
    hmacSha256Tag(KEY, { purpose: "work-batch/v1", record: material })]);
  await admin.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,edited_at,
    reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,1,$4,$5,'submitted',$6::jsonb,$7,$8)`,
  [`${batchId}:revision:1`, at.tenantId, batchId, proposer, NOW, JSON.stringify(value), digest,
    hmacSha256Tag(KEY, { purpose: "work-batch-revision/v1", record: { id: `${batchId}:revision:1`,
      tenantId: at.tenantId, batchId, revision: 1, editedByIdentityId: proposer, editedAt: NOW,
      reasonCode: "submitted", proposal: value, revisionDigest: digest } })]);
  if (state !== "proposed") {
    // An approved batch, moved the way 0102's owner guard allows, so the guard
    // that must refuse a suggestion on it is tested against a real approved
    // state rather than a column value nobody can reach.
    await admin.query(`UPDATE work_batches SET state=$3, approval_identity_id=$4, approved_at=$5 WHERE tenant_id=$1 AND id=$2`,
    [at.tenantId, batchId, state, "identity:orch-owner", LATER]);
  }
  return { digest, value };
}

/** The suggestion INSERT. All thirteen bound values are supplied together by
 * `insertSuggestion`, so a test can never half-bind it. */
const insertSuggestion = (client: Client, input: { id: string; tenantId: string; projectId: string;
  batchId: string; requestKey: string; revision: number; revisionDigest: string; proposer: string;
  proposal: WorkBatchProposalV1; createdAt: string }) => client.query(`INSERT INTO work_batch_split_suggestions(id,tenant_id,project_id,batch_id,request_key,
  base_revision,base_revision_digest,proposed_by_identity_id,proposed_by_actor_type,proposal,proposal_digest,
  suggestion_digest,auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent',$9::jsonb,$10,$11,$12,$13)`,
  [input.id, input.tenantId, input.projectId, input.batchId, input.requestKey, input.revision,
    input.revisionDigest, input.proposer, JSON.stringify(input.proposal),
    workBatchProposalDigestV1(input.proposal),
    `sha256:${sha256Digest({ baseRevisionDigest: input.revisionDigest,
      proposalDigest: workBatchProposalDigestV1(input.proposal) })}`,
    `hmac-sha256:${"0".repeat(64)}`, input.createdAt]);

test("the intake login may append a current suggestion, and only a current one", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      const { digest, value } = await seedBatch(admin, scope, "batch:orch-one");
      const split = proposal(3);
      const accepted = await insertSuggestion(intake, { id: `split-suggestion:${"a".repeat(32)}`,
        tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-one",
        requestKey: "orchestrator-resplit-0001", revision: 1, revisionDigest: digest,
        proposer: "identity:orch-agent", proposal: split, createdAt: NOW });
      assert.equal(accepted.rowCount, 1, "an active proposer may append a suggestion for the current revision");

      // The owner reads it through the current-revision view, and the base table
      // is not the web login's to read at all.
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const view = await web.query<{ id: string; base_revision: string; starts_work: boolean;
          grants_execution_authority: boolean }>(
          `SELECT id,base_revision,starts_work,grants_execution_authority FROM work_batch_current_split_suggestions
           WHERE tenant_id=$1 AND batch_id=$2`, [scope.tenantId, "batch:orch-one"]);
        assert.equal(view.rowCount, 1, "the owner sees exactly the current suggestion");
        assert.equal(view.rows[0]!.starts_work, false);
        assert.equal(view.rows[0]!.grants_execution_authority, false);
        assert.equal(Number(view.rows[0]!.base_revision), 1);
        await assert.rejects(web.query("SELECT * FROM work_batch_split_suggestions"),
          /permission denied/u,
          "the owner login must not reach the base table, only the current-revision view");
        await assert.rejects(web.query("SELECT * FROM control_planner_failure_counters"),
          /permission denied/u, "the owner login must not read a failure counter");
        await assert.rejects(web.query("SELECT * FROM control_planner_needs_you_items"),
          /permission denied/u, "the owner login must not read the escalation ledger directly");
        assert.equal((await web.query("SELECT starts_work,grants_execution_authority FROM control_planner_open_needs_you LIMIT 1"))
          .rowCount, 0, "the escalated ledger is empty in this scenario, and the view is readable");
      } finally { await web.end(); }

      // A new revision VOIDS the older suggestion by derivation, with no mutation:
      // the row is still there, and the view no longer offers it.
      const revised = { ...value, tasks: [{ ...value.tasks[0]!, title: "Revised part" }] };
      const revisedDigest = workBatchProposalDigestV1(revised);
      await admin.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,edited_at,
        reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,2,'identity:orch-owner',$4,'owner_revision',
        $5::jsonb,$6,$7)`,
      [`batch:orch-one:revision:2`, scope.tenantId, "batch:orch-one", LATER, JSON.stringify(revised), revisedDigest,
        hmacSha256Tag(KEY, { purpose: "work-batch-revision/v1", record: { id: "batch:orch-one:revision:2",
          tenantId: scope.tenantId, batchId: "batch:orch-one", revision: 2, editedByIdentityId: "identity:orch-owner",
          editedAt: LATER, reasonCode: "owner_revision", proposal: revised, revisionDigest: revisedDigest } })]);
      await admin.query("UPDATE work_batches SET version=2, updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [scope.tenantId, "batch:orch-one", LATER]);
      const stillThere = await admin.query("SELECT id FROM work_batch_split_suggestions WHERE tenant_id=$1",
        [scope.tenantId]);
      assert.equal(stillThere.rowCount, 1, "voiding is derived: the record is retained, never rewritten");
      const webAfter = new Client(postgres.connection("web")); await webAfter.connect();
      try {
        assert.equal((await webAfter.query("SELECT id FROM work_batch_current_split_suggestions WHERE tenant_id=$1",
          [scope.tenantId])).rowCount, 0, "a stale suggestion is no longer offered to the owner");
      } finally { webAfter.end(); }
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("the write guard refuses: no propose grant, a foreign batch, a stale revision, a wrong digest, a decided batch, another tenant", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedTenant(admin, other);
      await seedIdentities(admin, scope);
      await seedIdentities(admin, other);
      const { digest } = await seedBatch(admin, scope, "batch:orch-guard");
      const split = proposal(3);
      const insert = (over: Partial<Parameters<typeof insertSuggestion>[1]>) => insertSuggestion(intake, {
        id: `split-suggestion:${"b".repeat(32)}`, tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:orch-guard", requestKey: "orchestrator-guard-0001", revision: 1, revisionDigest: digest,
        proposer: "identity:orch-agent", proposal: split, createdAt: NOW, ...over });

      // An agent whose grant is not exactly ["work_batches.propose"].
      await assert.rejects(insert({ proposer: "identity:orch-ungranted", requestKey: "orchestrator-guard-0002" }),
        /work batch split suggestion insert rejected/u);
      // A batch this identity did not propose.
      await assert.rejects(insert({ proposer: "identity:orch-owner", requestKey: "orchestrator-guard-0003" }),
        /work batch split suggestion insert rejected/u);
      // A revision the batch has not reached.
      await assert.rejects(insert({ revision: 2, requestKey: "orchestrator-guard-0004" }),
        /work batch split suggestion insert rejected/u);
      // A real revision, but the wrong digest for it.
      await assert.rejects(insert({ revisionDigest: `sha256:${"0".repeat(64)}`, requestKey: "orchestrator-guard-0005" }),
        /work batch split suggestion insert rejected/u);
      // Another tenant's project on this batch.
      await assert.rejects(insert({ projectId: other.projectId, requestKey: "orchestrator-guard-0006" }),
        /work batch split suggestion insert rejected/u);
      // Another tenant entirely, against its own agent and batch.
      const otherBatch = await seedBatch(admin, other, "batch:orch-other");
      await assert.rejects(insertSuggestion(intake, { id: `split-suggestion:${"c".repeat(32)}`,
        tenantId: other.tenantId, projectId: other.projectId, batchId: "batch:orch-other",
        requestKey: "orchestrator-guard-0007", revision: 1, revisionDigest: otherBatch.digest,
        proposer: "identity:orch-agent", proposal: split, createdAt: NOW }),
      /row-level security|insert rejected/u,
      "the shared intake login is confined to its bound tenant");
      // A decided batch accepts nothing.
      await seedBatch(admin, scope, "batch:orch-decided", "identity:orch-agent", "approved");
      await assert.rejects(insert({ batchId: "batch:orch-decided", requestKey: "orchestrator-guard-0008" }),
        /work batch split suggestion insert rejected/u);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_split_suggestions")).rows[0]!.n, 0,
        "no refused insert left a row");
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("an exact replay is idempotent, a differing replay is refused, and rows are immutable", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      const { digest } = await seedBatch(admin, scope, "batch:orch-replay");
      const split = proposal(3);
      const row = { id: `split-suggestion:${"d".repeat(32)}`, tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:orch-replay", requestKey: "orchestrator-replay-0001", revision: 1, revisionDigest: digest,
        proposer: "identity:orch-agent", proposal: split, createdAt: NOW };
      await insertSuggestion(intake, row);
      await assert.rejects(insertSuggestion(intake, row), /duplicate key/u,
        "the unique index is what makes an exact replay impossible to duplicate");
      // Same key, different content: refused by the operation's own code, not by
      // a raw constraint the caller has to recognise by text.
      const other2 = proposal(4);
      await assert.rejects(insertSuggestion(intake, { ...row, proposal: other2 }),
      /work_batch_split_suggestion_replay_conflict/u);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_split_suggestions")).rows[0]!.n, 1);
      await assert.rejects(admin.query("UPDATE work_batch_split_suggestions SET proposal_digest=$1",
        [`sha256:${"9".repeat(64)}`]), /append-only|append only|immutable/u);
      await assert.rejects(admin.query("DELETE FROM work_batch_split_suggestions"), /append-only|append only|immutable/u);
      await assert.rejects(admin.query("TRUNCATE work_batch_split_suggestions"), /append-only|append only|immutable/u);
      // A new request key on the same batch is a SECOND suggestion, not a conflict.
      await insertSuggestion(intake, { ...row, id: `split-suggestion:${"e".repeat(32)}`,
        requestKey: "orchestrator-replay-0002", proposal: other2 });
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_split_suggestions")).rows[0]!.n, 2);
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 2, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("twenty concurrent suggestions on one batch all land, with no duplicate and no lost row", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      const { digest } = await seedBatch(admin, scope, "batch:orch-stress");
      const CONCURRENCY = 20;
      // Twenty SEPARATE connections, because a single client serialises its own
      // statements and would prove nothing about contention on the unique index.
      const clients = await Promise.all(Array.from({ length: CONCURRENCY }, async (_, index) => {
        const client = new Client(postgres.connection("control_room_work_intake_agent")); await client.connect(); return { client, index };
      }));
      try {
        const results = await Promise.allSettled(clients.map(async ({ client, index }) =>
          insertSuggestion(client, { id: `split-suggestion:${String(index).padStart(32, "0")}`,
            tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-stress",
            requestKey: `orchestrator-stress-${String(index).padStart(4, "0")}`, revision: 1, revisionDigest: digest,
            proposer: "identity:orch-agent", proposal: proposal(2 + (index % 3)), createdAt: NOW })));
        const succeeded = results.filter(result => result.status === "fulfilled");
        assert.equal(succeeded.length, CONCURRENCY,
          `every distinct request key must land under contention; failures: ${
            results.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason).slice(0, 120)).join(" | ")}`);
        const stored = await admin.query<{ n: string; distinct_keys: string }>(
          "SELECT count(*)::text AS n, count(DISTINCT request_key)::text AS distinct_keys FROM work_batch_split_suggestions");
        assert.equal(stored.rows[0]!.n, String(CONCURRENCY), "no row was lost");
        assert.equal(stored.rows[0]!.distinct_keys, String(CONCURRENCY), "no request key was reused");
        // And a twenty-first attempt on ONE of those keys is refused, not doubled.
        await assert.rejects(insertSuggestion(clients[0]!.client, {
          id: `split-suggestion:${"f".repeat(32)}`, tenantId: scope.tenantId, projectId: scope.projectId,
          batchId: "batch:orch-stress", requestKey: "orchestrator-stress-0000", revision: 1, revisionDigest: digest,
          proposer: "identity:orch-agent", proposal: proposal(2), createdAt: NOW }), /duplicate key/u);
      } finally { await Promise.all(clients.map(async ({ client }) => { await client.end().catch(() => {}); })); }
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 3, allowedPorts: ALLOWED, boundMs: 240_000 });
});

test("the production suggestion store is idempotent, immutable and honest about staleness", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      const { digest, value } = await seedBatch(admin, scope, "batch:orch-store");
      const store = new PostgresIntakeSuggestionStoreV1(database(intake), KEY);
      const split = proposal(3);
      const input = { tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-store",
        requestKey: "orchestrator-store-0001", baseRevision: 1, baseRevisionDigest: digest,
        proposerIdentityId: "identity:orch-agent", proposal: split, proposalDigest: workBatchProposalDigestV1(split),
        flagsByLocalId: {} as never, createdAt: NOW };
      const first = await store.append(input);
      assert.equal(first.startsWork, false);
      assert.equal(first.grantsExecutionAuthority, false);
      assert.equal(first.savesRevision, false);
      assert.throws(() => { (first.proposal.tasks[0] as { title: string }).title = "Mutated"; },
        /read only|readonly/u, "the returned proposal is deeply immutable");
      const replay = await store.append(input);
      assert.equal(replay.suggestionId, first.suggestionId, "an exact replay returns the same record");
      const different = await store.append({ ...input, requestKey: "orchestrator-store-0002",
        proposal: proposal(4), proposalDigest: workBatchProposalDigestV1(proposal(4)) });
      assert.notEqual(different.suggestionId, first.suggestionId);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_split_suggestions")).rows[0]!.n, 2);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_revisions WHERE batch_id=$1",
        ["batch:orch-store"])).rows[0]!.n, 1, "a suggestion never writes a work_batch_revision");

      const prefill = await store.prefillForOwner({ tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:orch-store", suggestionId: first.suggestionId, ownerIdentityId: "identity:orch-owner",
        actorType: "human", currentRevision: 1, currentRevisionDigest: digest });
      assert.deepEqual(prefill.proposal, split);
      assert.equal(prefill.savesRevision, false);
      await assert.rejects(Promise.resolve().then(() => store.prefillForOwner({ tenantId: scope.tenantId,
        projectId: scope.projectId, batchId: "batch:orch-store", suggestionId: first.suggestionId,
        ownerIdentityId: "identity:orch-owner", actorType: "human", currentRevision: 2,
        currentRevisionDigest: digest })),
      (error: unknown) => error instanceof IntakeSuggestionStoreErrorV1
        && error.safeReasonCode === "intake_suggestion_stale");
      await assert.rejects(Promise.resolve().then(() => store.prefillForOwner({ tenantId: scope.tenantId,
        projectId: scope.projectId, batchId: "batch:orch-store", suggestionId: first.suggestionId,
        ownerIdentityId: "identity:orch-agent", actorType: "agent" as "human", currentRevision: 1,
        currentRevisionDigest: digest })),
      (error: unknown) => error instanceof IntakeSuggestionStoreErrorV1
        && error.safeReasonCode === "intake_suggestion_owner_required");
      // A tampered row is refused rather than handed to the owner as a plan.
      await admin.query("ALTER TABLE work_batch_split_suggestions DROP CONSTRAINT work_batch_split_suggestions_append_only");
      await admin.query("UPDATE work_batch_split_suggestions SET proposal=$1::jsonb WHERE id=$2",
        [JSON.stringify(proposal(5)), first.suggestionId]);
      await assert.rejects(Promise.resolve().then(() => store.prefillForOwner({ tenantId: scope.tenantId,
        projectId: scope.projectId, batchId: "batch:orch-store", suggestionId: first.suggestionId,
        ownerIdentityId: "identity:orch-owner", actorType: "human", currentRevision: 1,
        currentRevisionDigest: digest })),
      (error: unknown) => error instanceof IntakeSuggestionStoreErrorV1
        && error.safeReasonCode === "intake_suggestion_rejected");
      assert.ok(value.tasks.length === 2, "the fixture's own revision 1 is untouched");
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 4, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("the planner selection is tri-state, coherent, and never an execution authority", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const web = new Client(postgres.connection("web")); await web.connect();
    const coordinator = new Client(postgres.connection("coordinator")); await coordinator.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      // An absent row is "inherit", which is the manual/no-orchestrator path.
      assert.equal((await admin.query("SELECT planner_mode FROM control_project_settings WHERE tenant_id=$1",
        [scope.tenantId])).rowCount, 0);
      await web.query(`INSERT INTO control_project_settings(tenant_id,project_id,version,updated_by_identity_id,updated_at)
        VALUES($1,$2,1,'identity:orch-owner',$3)`, [scope.tenantId, scope.projectId, NOW]);
      assert.equal((await web.query("SELECT planner_mode FROM control_project_settings WHERE tenant_id=$1",
        [scope.tenantId])).rows[0]!.planner_mode, "inherit",
      "an existing settings row keeps today's behaviour: no orchestrator is enabled by a migration");
      // 'selected' needs a worker; a mode with no worker is refused.
      await assert.rejects(web.query(`UPDATE control_project_settings SET planner_mode='selected'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]),
      /planner_selection_coherent|check constraint/u);
      await assert.rejects(web.query(`UPDATE control_project_settings SET planner_mode='none', planner_worker_id='worker:one'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]),
      /planner_selection_coherent|check constraint/u,
      "a worker may only be named in 'selected' mode");
      await assert.rejects(web.query(`UPDATE control_project_settings SET planner_effort='default'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]),
      /planner_effort_check|check constraint/u, "'default' names no concrete model and is not accepted");
      // A coherent selection, written by the owner through the web login.
      await web.query(`UPDATE control_project_settings SET planner_mode='selected', planner_worker_id='worker:orch',
        planner_worker_kind='codex', planner_model='gpt-5-codex', planner_effort='high'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]);
      const selected = await web.query<{ planner_mode: string; starts_work: boolean; grants_execution_authority: boolean }>(
        `SELECT planner_mode, starts_work, grants_execution_authority FROM control_project_planner_selections
         WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]);
      assert.equal(selected.rows[0]!.planner_mode, "selected");
      assert.equal(selected.rows[0]!.starts_work, false, "a stored selection is a request, never authority");
      assert.equal(selected.rows[0]!.grants_execution_authority, false);
      // The coordinator reads the same stored request.
      assert.equal((await coordinator.query<{ planner_mode: string }>(
        "SELECT planner_mode FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2",
      [scope.tenantId, scope.projectId])).rows[0]!.planner_mode, "selected");
      // The coordinator may NOT write the owner's choice: 0201 grants the web
      // login the column-scoped UPDATE, and the coordinator holds none.
      await assert.rejects(coordinator.query(`UPDATE control_project_settings SET planner_mode='none'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]), /permission denied/u);
      // The web login's 0135 grant is column-scoped and already includes `version`
      // and the task-default columns, so those remain legitimate writes. What
      // 0201 must NOT have done is widen that grant to the row's identity.
      assert.equal((await web.query("UPDATE control_project_settings SET version=version+1 WHERE tenant_id=$1 AND project_id=$2 RETURNING version",
        [scope.tenantId, scope.projectId])).rows[0]!.version, 2, "0135's version grant still works");
      assert.equal((await web.query(`UPDATE control_project_settings SET default_model='gpt-5-codex'
        WHERE tenant_id=$1 AND project_id=$2 RETURNING default_model`, [scope.tenantId, scope.projectId]))
        .rows[0]!.default_model, "gpt-5-codex", "0135's task-default columns are unchanged by 0201");
      await assert.rejects(web.query("UPDATE control_project_settings SET tenant_id='tenant:moved' WHERE tenant_id=$1 AND project_id=$2",
        [scope.tenantId, scope.projectId]), /permission denied/u,
      "0201 must not widen the web login's settings grant to the row's identity");
      await assert.rejects(web.query("UPDATE control_project_settings SET project_id='project:moved' WHERE tenant_id=$1 AND project_id=$2",
        [scope.tenantId, scope.projectId]), /permission denied/u);
    } finally { await coordinator.end(); await web.end(); await admin.end(); }
  }, { port: PORT + 5, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("the failure counter is durable, atomic, and the escalation is idempotent", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const coordinator = new Client(postgres.connection("coordinator")); await coordinator.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      const db = database(coordinator);
      const scopeKey = "initial:tenant:orch:project:orch:planner-store-0001";
      const scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });
      const failures = new PostgresIntakePlannerFailureStoreV1(db, scopeOf, () => LATER);
      const needsYou = new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:orch-agent" }), () => LATER);
      assert.equal(await failures.count(scopeKey), 0, "an unseen request has no failures");
      assert.equal(await failures.record(scopeKey), 1);
      assert.equal(await failures.count(scopeKey), 1);
      assert.equal(await failures.record(scopeKey), 2, "the second failure is the escalation point");
      // A raise is idempotent by request key: two raises are one Needs-you item.
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "planner-store-0001", reasonCode: "orchestrator_failed_twice", now: LATER });
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "planner-store-0001", reasonCode: "orchestrator_failed_twice", now: LATER });
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_action_inbox WHERE kind='planner_failed'"))
        .rows[0]!.n, 1, "one action-inbox item, not two");
      // A raise with no live counter at 2 is refused: an escalation must be earned.
      await assert.rejects(needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "planner-store-9999", reasonCode: "orchestrator_failed_twice", now: LATER }),
      /planner_needs_you_not_escalated/u);
      // A successful run clears the count, and a stale raise is then refused too.
      await failures.clear(scopeKey);
      assert.equal(await failures.count(scopeKey), 0);
      assert.ok((await admin.query("SELECT cleared_at FROM control_planner_failure_counters WHERE scope_key=$1",
        [scopeKey])).rows[0]!.cleared_at, "a cleared counter is retained with the time it was cleared");
      // A NEW failure after a clear starts again at 1, not 3.
      assert.equal(await failures.record(scopeKey), 1);
      // The guard refuses a hand-written count: this is the whole point of it.
      await assert.rejects(coordinator.query(
        "UPDATE control_planner_failure_counters SET failure_count=9 WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3",
      [scope.tenantId, scope.projectId, scopeKey]), /planner failure counter update rejected/u);
      await assert.rejects(coordinator.query("DELETE FROM control_planner_failure_counters"), /append-only|append only|immutable/u);
      await assert.rejects(coordinator.query("UPDATE control_planner_needs_you_items SET failure_count=9"),
        /append-only|append only|immutable/u);
      await assert.rejects(coordinator.query("DELETE FROM control_planner_needs_you_items"), /append-only|append only|immutable/u);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1,
        "the ledger row survived every refused mutation");
      // The web login may read the escalation ledger's view and nothing else.
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const seen = await web.query<{ request_key: string; reason_code: string; failure_count: string }>(
          "SELECT request_key, reason_code, failure_count FROM control_planner_open_needs_you WHERE tenant_id=$1",
        [scope.tenantId]);
        assert.equal(seen.rowCount, 1);
        assert.equal(seen.rows[0]!.reason_code, "orchestrator_failed_twice");
        await assert.rejects(web.query("UPDATE control_planner_failure_counters SET failure_count=0"),
          /permission denied/u, "the owner must not be able to clear the coordinator's counter");
        await assert.rejects(web.query("INSERT INTO control_planner_needs_you_items(id,tenant_id,project_id,request_key,reason_code,failure_count,raised_by_identity_id,raised_at) SELECT 'planner-needs-you:0000000000000000000000000000000a',tenant_id,project_id,'forged-request-key','orchestrator_failed_twice',9,raised_by_identity_id,raised_at FROM control_planner_needs_you_items LIMIT 1"),
        /permission denied/u, "the owner must not be able to raise an escalation");
      } finally { await web.end(); }
    } finally { await coordinator.end(); await admin.end(); }
  }, { port: PORT + 6, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("twenty concurrent failure records produce one counter with twenty, and twenty claims of 'first'", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope);
      const CONCURRENCY = 20;
      const clients = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        const client = new Client(postgres.connection("coordinator")); await client.connect(); return client;
      }));
      try {
        const scopeKey = "initial:tenant:orch:project:orch:planner-race-0001";
        const counts = await Promise.all(clients.map(client => new PostgresIntakePlannerFailureStoreV1(
          database(client), () => ({ tenantId: scope.tenantId, projectId: scope.projectId }), () => LATER)
          .record(scopeKey)));
        assert.equal(counts.length, CONCURRENCY);
        assert.equal(Math.max(...counts), CONCURRENCY, "every caller got a distinct post-increment count");
        assert.equal(new Set(counts).size, CONCURRENCY,
          `no two callers may both believe they were first: ${counts.join(",")}`);
        const row = (await admin.query<{ n: string; failure_count: string }>(
          "SELECT count(*)::text AS n, max(failure_count)::text AS failure_count FROM control_planner_failure_counters"))
          .rows[0]!;
        assert.equal(row.n, "1", "twenty concurrent records on one key are one row");
        assert.equal(row.failure_count, String(CONCURRENCY));
        // Concurrent raises of the SAME request are one Needs-you.
        const raiseClients = clients.slice(0, 8);
        await Promise.allSettled(raiseClients.map(client => new PostgresIntakeNeedsYouStoreV1(database(client),
          () => ({ identityId: "identity:orch-agent" }), () => LATER).raise({ tenantId: scope.tenantId,
          projectId: scope.projectId, requestKey: "planner-race-0001", reasonCode: "orchestrator_failed_twice", now: LATER })));
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1,
          "idempotency holds under concurrency, not only under a sequential retry");
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_action_inbox WHERE kind='planner_failed'"))
          .rows[0]!.n, 1);
      } finally { await Promise.all(clients.map(async client => { await client.end().catch(() => {}); })); }
    } finally { await admin.end(); }
  }, { port: PORT + 7, allowedPorts: ALLOWED, boundMs: 240_000 });
});

test("the unwired S7b allowance port refuses rather than allowing an unmeasured run", async () => {
  const allowance = new UnwiredPlannerAllowanceV1();
  const outcome = await allowance.consume({ tenantId: "tenant:x", projectId: "project:x",
    requestKey: "planner-allowance-0001", scorecardKey: "orchestrator:gpt-5-codex", workerId: "worker:x",
    model: "gpt-5-codex", now: NOW });
  assert.equal(outcome.allowed, false,
    "a missing allowance adapter must never read as an allowed run");
  if (!outcome.allowed) assert.equal(outcome.reasonCode, "planner_allowance_not_configured");
});
