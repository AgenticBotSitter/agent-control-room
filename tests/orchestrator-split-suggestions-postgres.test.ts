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
  UnwiredPlannerAllowanceV1, intakeProjectScopeV1, intakeRequestScopeV1,
  type WorkBatchProposalV1 } from "../src/work-intake/v1";
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

/** A proposal for `projectId`. The caller names the project, so a fixture for a
 * second tenant never carries the first tenant's project id. */
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

/** An agent identity with the propose grant, an owner, and an agent WITHOUT it.
 * `suffix` keeps the ids distinct per tenant: a second tenant's fixture must not
 * reuse the first tenant's identity ids, or its grants collide and its batch is
 * refused by 0093's guard for a reason that is a fixture bug. */
async function seedIdentities(admin: Client, at: { tenantId: string; projectId: string }, suffix: string) {
  const agent = `identity:orch-agent${suffix}`;
  const rows: Array<[string, string, string, string, string]> = [
    [agent, "agent", "work-intake", "work_batch_proposer", '["work_batches.propose"]'],
    [`identity:orch-ungranted${suffix}`, "agent", "work-intake", "work_batch_proposer", '["work_batches.propose","work_batches.decide"]'],
    [`identity:orch-owner${suffix}`, "human", "test", "owner", '["*"]'],
  ];
  for (const [id, actorType, provider, roleKey, actions] of rows) {
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,'Fixture',$4,$5,'active',$6,$6)
      ON CONFLICT DO NOTHING`, [id, at.tenantId, actorType, provider, sha256Digest({ id }), NOW]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'["*"]'::jsonb,$6,$7,false,$8,$8) ON CONFLICT DO NOTHING`,
    [`grant:${id}`, at.tenantId, id, roleKey, actions,
      roleKey === "owner" ? "critical" : "low", roleKey === "owner", NOW]);
  }
  return { agent, owner: `identity:orch-owner${suffix}` };
}

/** A proposed batch at revision 1, inserted as the schema owner would. */
async function seedBatch(admin: Client, at: { tenantId: string; projectId: string }, batchId: string,
  proposer = "identity:orch-agent", state = "proposed") {
  // The proposal's own projectId is the PROJECT's, not the shared fixture's: a
  // batch seeded for the second tenant must carry that tenant's project, or 0093's
  // row-level policy and the suggestion guard see a mismatch that is really a
  // fixture bug.
  const value = { ...proposal(2), projectId: at.projectId } as WorkBatchProposalV1;
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
    // A DECIDED batch, so the suggestion guard's `state <> 'proposed'` arm is
    // exercised against a real decided state rather than a column value nobody
    // can reach.
    //
    // 0102's owner-update guard is DISABLED for this one statement, and that is
    // the point rather than a shortcut: producing a genuinely decided batch needs
    // an item set and an HMAC decision digest computed by
    // WorkBatchOwnerServiceV1 from the installation's integrity key, which is a
    // different test's subject and not this migration's. What is under test here
    // is 0200's refusal of a decided batch, and the only thing standing between
    // the fixture and that state is a guard belonging to a different migration.
    // The batch is still fully real: it has its proposal, its revision 1, its
    // approval and its decision time, and the suggestion guard below sees exactly
    // what it would see in production.
    await admin.query("ALTER TABLE work_batches DISABLE TRIGGER work_batches_owner_update");
    try {
      await admin.query(`UPDATE work_batches SET state=$3, approval_identity_id=$4, approved_at=$5,
        decision_reason_code=$6 WHERE tenant_id=$1 AND id=$2`,
      [at.tenantId, batchId, state,
        `identity:orch-owner${at.tenantId === scope.tenantId ? "" : "-other"}`, LATER,
        state === "rejected" ? "planner_no_longer_relevant" : null]);
    } finally {
      await admin.query("ALTER TABLE work_batches ENABLE TRIGGER work_batches_owner_update");
    }
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
    // `sha256Digest` ALREADY prefixes `sha256:`. Prefixing it again is a
    // double-prefixed value, which the column's own CHECK refuses -- measured,
    // and it looked like a guard failure because the guard ran first.
    sha256Digest({ baseRevisionDigest: input.revisionDigest,
      proposalDigest: workBatchProposalDigestV1(input.proposal) }),
    `hmac-sha256:${"0".repeat(64)}`, input.createdAt]);

test("the intake login may append a current suggestion, and only a current one", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope, "");
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
        await assert.rejects(web.query("SELECT * FROM control_planner_needs_you_items"),
          /permission denied/u, "the owner login must not read the escalation ledger's base table");
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

test("the current-suggestion VIEW is tenant-bound: the intake login bound to A cannot read B's proposal", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    // The intake login is bound to `scope` (tenant A) by the fixture, and tenant B
    // is a real second tenant in the same cluster -- so "cannot read B" is proved
    // against rows that exist, not against a table that happens to be empty.
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedTenant(admin, other);
      await seedIdentities(admin, scope, "");
      await seedIdentities(admin, other, "-other");
      await seedBatch(admin, scope, "batch:orch-tenant-a");
      const foreignBatch = await seedBatch(admin, other, "batch:orch-tenant-b", "identity:orch-agent-other");
      // Tenant B's proposal text, marked so a leak is unambiguous. The suggestion's
      // OWN proposal differs from the batch's; its `base_revision_digest` is still
      // the batch's stored revision digest, which is what the guard compares.
      const secret = "SECRET-B-TENANT-ONLY";
      const foreign = { ...proposal(2), projectId: other.projectId, tasks: proposal(2).tasks.map(task =>
        ({ ...task, title: secret })) } as WorkBatchProposalV1;
      // Seeded as the SCHEMA OWNER, deliberately. The intake login is bound to
      // tenant A, and 0200's policy refuses its INSERT for tenant B -- which is the
      // write side working. To prove the READ side we need tenant B's row to exist
      // at all, so the schema owner writes it; the row is then real, current, and
      // carried by the view, and the assertions below are about whether the bound
      // login can see it.
      await insertSuggestion(admin, { id: `split-suggestion:${"7".repeat(32)}`,
        tenantId: other.tenantId, projectId: other.projectId, batchId: "batch:orch-tenant-b",
        requestKey: "orchestrator-tenant-b-1", revision: 1, revisionDigest: foreignBatch.digest,
        proposer: "identity:orch-agent-other", proposal: foreign, createdAt: NOW });
      // And the same insert through the bound intake login is refused, which is the
      // write-side half of the same rule.
      await assert.rejects(insertSuggestion(intake, { id: `split-suggestion:${"9".repeat(32)}`,
        tenantId: other.tenantId, projectId: other.projectId, batchId: "batch:orch-tenant-b",
        requestKey: "orchestrator-tenant-b-2", revision: 1, revisionDigest: foreignBatch.digest,
        proposer: "identity:orch-agent-other", proposal: foreign, createdAt: NOW }),
      /work batch split suggestion insert rejected/u,
      "the bound intake login cannot append for another tenant either");
      const ownBatch = await seedBatch(admin, scope, "batch:orch-tenant-a-2");
      await insertSuggestion(intake, { id: `split-suggestion:${"8".repeat(32)}`,
        tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-tenant-a-2",
        requestKey: "orchestrator-tenant-a-1", revision: 1, revisionDigest: ownBatch.digest,
        proposer: "identity:orch-agent", proposal: proposal(2), createdAt: NOW });

      // Precondition, asserted as the schema owner: both rows really exist, and
      // the view really carries both. Without this a "0 rows" result below would
      // be indistinguishable from a fixture that seeded nothing.
      const seeded = await admin.query<{ base: string; view: string }>(`SELECT
        (SELECT count(*)::text FROM work_batch_split_suggestions WHERE tenant_id=$1) AS base,
        (SELECT count(*)::text FROM work_batch_current_split_suggestions WHERE tenant_id=$1) AS view`,
      [other.tenantId]);
      assert.equal(seeded.rows[0]!.base, "1", "tenant B's suggestion exists");
      assert.equal(seeded.rows[0]!.view, "1", "and it is current, so the view would carry it");
      assert.equal((await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM work_batches WHERE tenant_id=$1", [other.tenantId])).rows[0]!.n, "1",
      "and tenant B's batch exists, so the view's join can succeed");

      // THE ASSERTION. As the production intake login, bound to tenant A: tenant
      // B's row is not in the view, and none of B's material is readable.
      const leaked = await intake.query<{ n: string; text: string }>(
        `SELECT count(*)::text AS n, coalesce(string_agg(proposal::text, ' '),'') AS text
         FROM work_batch_current_split_suggestions WHERE tenant_id=$1`, [other.tenantId]);
      assert.equal(leaked.rows[0]!.n, "0", "the bound intake login sees no other tenant's current suggestion");
      assert.equal(leaked.rows[0]!.text.includes(secret), false,
        "no other tenant's proposal text is readable through the view");
      // And the same query with no tenant filter at all -- the shape a careless
      // adapter would send -- still cannot see it.
      const unfiltered = await intake.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM work_batch_current_split_suggestions");
      assert.equal(unfiltered.rows[0]!.n, "1", "an unfiltered read sees only the bound tenant's single row");
      // The base table was never readable across tenants either, and 0203 must not
      // have widened it: the login's own row comes back, tenant B's does not.
      const base = await intake.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM work_batch_split_suggestions");
      assert.equal(base.rows[0]!.n, "1", "the base table is bounded too, and the view is not a way around it");
      // A request key is integrity material about another tenant's work, and it
      // must be unreachable even when the caller knows it exactly.
      const byKey = await intake.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM work_batch_current_split_suggestions WHERE request_key=$1",
      ["orchestrator-tenant-b-1"]);
      assert.equal(byKey.rows[0]!.n, "0", "a known other-tenant request key still returns nothing");
      // The login's OWN row is still readable: the fix bounds, it does not blind.
      const own = await intake.query<{ id: string; starts_work: boolean }>(
        "SELECT id,starts_work FROM work_batch_current_split_suggestions WHERE tenant_id=$1", [scope.tenantId]);
      assert.equal(own.rowCount, 1, "the bound tenant's own current suggestion is still readable");
      assert.equal(own.rows[0]!.starts_work, false, "and it still grants no authority");

      // THE OWNER PATH IS NOT REGRESSED. The web login holds no privilege on the
      // base table (0200's design) and reads the same view, and it must still see
      // its own tenant's row -- otherwise 0203 would have broken the owner path to
      // fix a leak on the intake path.
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const forWeb = await web.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM work_batch_current_split_suggestions WHERE tenant_id=$1",
        [scope.tenantId]);
        assert.equal(forWeb.rows[0]!.n, "1", "the owner web login still reads its own tenant's current suggestion");
        await assert.rejects(web.query("SELECT * FROM work_batch_split_suggestions"), /permission denied/u,
          "the web login still holds nothing on the base table");
        // EXECUTE on the predicate, by contrast, it MUST hold: a view's WHERE
        // clause is privilege-checked against session_user, not the view's owner,
        // so revoking the function from PUBLIC and granting it to the intake login
        // alone silently breaks the OWNER's read of the same view. Measured, and
        // this assertion is what keeps the next editor from re-introducing it.
        const predicate = await web.query<{ visible: boolean }>(
          "SELECT work_intake_split_suggestion_visible($1,$2,$3) AS visible",
        [scope.tenantId, "batch:orch-tenant-a-2", "identity:orch-agent"]);
        assert.equal(typeof predicate.rows[0]!.visible, "boolean",
          "the owner login holds EXECUTE and sees one boolean, never a row");
        // And the predicate is still the TENANT rule, not a bypass: a work-intake
        // session is the only thing it bounds, and this session is not one.
        assert.equal(predicate.rows[0]!.visible, true,
          "for the owner login the predicate defers to the non-intake branch, so the owner's read is unchanged");
      } finally { await web.end(); }

      // The rule is ONE definition. If the view's predicate and the table's policy
      // were spelled separately, a future edit to one would not move the other,
      // and this file's whole claim would quietly become false.
      const shape = await admin.query<{ policy: string; view: string }>(`SELECT
        (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname='work_batch_split_suggestions_work_intake_scope')
          AS policy,
        (SELECT pg_get_viewdef('work_batch_current_split_suggestions'::regclass, true)) AS view`);
      assert.match(shape.rows[0]!.policy, /work_intake_split_suggestion_visible/u,
        "the table's RESTRICTIVE policy is the shared predicate");
      assert.match(shape.rows[0]!.view, /work_intake_split_suggestion_visible/u,
        "and the view calls the same predicate, so the two cannot drift");
      // The predicate itself returns ONE boolean and no row: it is not a window.
      const oneBoolean = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM (SELECT work_intake_split_suggestion_visible('t','b','p')) s");
      assert.equal(oneBoolean.rows[0]!.n, 1, "the predicate is a single boolean projection, not a row source");
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 8, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("the write guard refuses: no propose grant, a foreign batch, a stale revision, a wrong digest, a decided batch, another tenant", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedTenant(admin, other);
      await seedIdentities(admin, scope, "");
      await seedIdentities(admin, other, "-other");
      const { digest } = await seedBatch(admin, scope, "batch:orch-guard");
      const split = proposal(3);
      const insert = (over: Partial<Parameters<typeof insertSuggestion>[1]>) => insertSuggestion(intake, {
        id: `split-suggestion:${"b".repeat(32)}`, tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:orch-guard", requestKey: "orchestrator-guard-0001", revision: 1, revisionDigest: digest,
        proposer: "identity:orch-agent", proposal: split, createdAt: NOW, ...over });

      // An agent whose grant is not exactly ["work_batches.propose"].
      await assert.rejects(insert({ proposer: "identity:orch-ungranted", requestKey: "orchestrator-guard-0002" }),
        /work batch split suggestion insert rejected/u);
      // A batch this identity did not propose. The owner holds no propose grant
      // AT ALL, so this arm is not isolated by the rejection: the grant check
      // refuses it first. The arm under test is isolated below, with a SECOND
      // agent that DOES hold exactly ["work_batches.propose"], so the only thing
      // left to refuse it is "this identity did not propose this batch".
      await assert.rejects(insert({ proposer: "identity:orch-owner", requestKey: "orchestrator-guard-0003" }),
        /work batch split suggestion insert rejected/u);
      // A second proposer identity that DOES hold exactly ["work_batches.propose"].
      // Only the batch-owns-its-proposer arm can refuse this, because every other
      // condition is satisfied: active agent, correct grant, correct project, the
      // batch is proposed, and the revision matches.
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES('identity:orch-second',$1,'agent','Second',
        'work-intake',$2,'active',$3,$3)`, [scope.tenantId, sha256Digest({ id: "identity:orch-second" }), NOW]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
        project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:orch-second',$1,'identity:orch-second','work_batch_proposer','["work_batches.propose"]'::jsonb,
        '["*"]'::jsonb,'low',false,false,$2,$2)`, [scope.tenantId, NOW]);
      await assert.rejects(insert({ proposer: "identity:orch-second", requestKey: "orchestrator-guard-0003b" }),
        /work batch split suggestion insert rejected/u,
      "an agent that holds propose but did not propose THIS batch has no standing to re-split it");
      // The same identity CAN propose a batch of its own, which proves the refusal
      // above is about ownership and not about the identity being unusable.
      const own = await seedBatch(admin, scope, "batch:orch-second", "identity:orch-second");
      assert.equal((await insertSuggestion(intake, { id: `split-suggestion:${"2".repeat(32)}`,
        tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-second",
        requestKey: "orchestrator-guard-0003c", revision: 1, revisionDigest: own.digest,
        proposer: "identity:orch-second", proposal: proposal(3), createdAt: NOW })).rowCount, 1,
      "its own batch accepts a suggestion from it");

      // Every batch here is seeded with the VALID proposer, and the suggestion
      // names the VARIANT identity. That combination is refused by the intake
      // login's ROW-LEVEL policy before the guard's grant check ever runs -- the
      // policy requires the suggestion's proposer to be the batch's own proposer,
      // and the variant is not. So to isolate a GRANT condition the row has to
      // reach the guard, which means the variant must own the batch, and that in
      // turn means 0093's work_batches guard must accept it -- which needs a valid
      // grant. Both are true at once only in this order: give the variant a valid
      // grant and let it propose its own batch, THEN break exactly the one
      // property under test.
      //
      // The ten cases below therefore do two steps each -- a valid phase (identity,
      // grant, batch) and a break phase -- and the break is applied after the batch
      // exists, so nothing else can be what refuses the suggestion.
      const variants: Array<[string, string, (identity: string) => Promise<void>]> = [
        ["revoked", "identity:orch-revoked", async identity => {
          // The guard compares against statement_timestamp(), which is REAL time,
          // not the fixture's NOW. A revocation must therefore be at a wall-clock
          // time already in the past. 0005 requires revoked_at >= created_at, and
          // created_at is the fixture clock, so the revocation is dated exactly at
          // created_at -- which is >= created_at, and long past by the time the
          // statement runs.
          await admin.query("UPDATE control_role_grants SET revoked_at=$3 WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, `grant:${identity}`, NOW]);
        }],
        ["expired", "identity:orch-expired", async identity => {
          // expires_at must be > created_at, so an already-expired grant cannot be
          // expressed against a fixture created_at. The grant is instead created
          // with a short window that has ALREADY closed by the time the statement
          // runs: created_at is set an hour before the fixture clock, and
          // expires_at an hour before NOW, so it is past while still > created_at.
          await admin.query(`UPDATE control_role_grants SET created_at=$3, updated_at=$3, expires_at=$4
            WHERE tenant_id=$1 AND id=$2`,
          [scope.tenantId, `grant:${identity}`,
            new Date(Date.parse(NOW) - 7_200_000).toISOString(),
            new Date(Date.parse(NOW) - 3_600_000).toISOString()]);
        }],
        ["otherrole", "identity:orch-otherrole", async identity => {
          await admin.query("UPDATE control_role_grants SET role_key='work_batch_reviewer' WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, `grant:${identity}`]);
        }],
        ["extraaction", "identity:orch-extra", async identity => {
          await admin.query(`UPDATE control_role_grants SET allowed_actions='["work_batches.propose","work_batches.decide"]'::jsonb
            WHERE tenant_id=$1 AND id=$2`, [scope.tenantId, `grant:${identity}`]);
        }],
        ["highrisk", "identity:orch-highrisk", async identity => {
          await admin.query("UPDATE control_role_grants SET risk_ceiling='high' WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, `grant:${identity}`]);
        }],
        ["external", "identity:orch-external", async identity => {
          await admin.query("UPDATE control_role_grants SET allow_external_effects=true WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, `grant:${identity}`]);
        }],
        ["strongfactor", "identity:orch-strong", async identity => {
          await admin.query("UPDATE control_role_grants SET require_strong_factor=true WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, `grant:${identity}`]);
        }],
        ["otherproject", "identity:orch-otherproject", async identity => {
          await admin.query(`UPDATE control_role_grants SET project_ids='["project:elsewhere"]'::jsonb
            WHERE tenant_id=$1 AND id=$2`, [scope.tenantId, `grant:${identity}`]);
        }],
        ["suspended", "identity:orch-suspended", async identity => {
          await admin.query("UPDATE control_identities SET state='suspended' WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, identity]);
        }],
        ["humanactor", "identity:orch-human", async identity => {
          await admin.query("UPDATE control_identities SET actor_type='human' WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, identity]);
        }],
      ];
      for (const [label, identity, breakIt] of variants) {
        // Phase 1: a completely valid proposer, who proposes its own batch.
        await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
          auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Variant','work-intake',$3,'active',$4,$4)
          ON CONFLICT DO NOTHING`, [identity, scope.tenantId, sha256Digest({ id: identity }), NOW]);
        await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
          project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
          VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]'::jsonb,'["*"]'::jsonb,'low',false,false,$4,$4)
          ON CONFLICT DO NOTHING`, [`grant:${identity}`, scope.tenantId, identity, NOW]);
        const variantBatch = await seedBatch(admin, scope, `batch:${label}`, identity);
        // Phase 2: break exactly one property, after the batch exists.
        await breakIt(identity);
        await assert.rejects(insertSuggestion(intake, {
          id: `split-suggestion:${label.padEnd(32, "0").slice(0, 32)}`,
          tenantId: scope.tenantId, projectId: scope.projectId, batchId: `batch:${label}`,
          requestKey: `orch-guard-${label}-0001`, revision: 1, revisionDigest: variantBatch.digest,
          proposer: identity, proposal: proposal(3), createdAt: NOW }),
        /work batch split suggestion insert rejected/u,
        `a proposer whose grant differs only in "${label}" is refused`);
      }

      // A revision the batch has not reached. The foreign key refuses this too, so
      // the version arm is isolated below against a revision that EXISTS.
      await assert.rejects(insert({ revision: 2, requestKey: "orchestrator-guard-0004" }),
        /work batch split suggestion insert rejected|foreign key/u);
      // The version arm, ISOLATED. Revision 2 is added as a real owner revision --
      // so the foreign key is satisfied and the bound digest is real -- but the
      // batch's own version is still 1, because advancing it is exactly what the
      // owner's revision-append path does in its own transaction. A suggestion
      // naming revision 2 while the batch is at 1 must be refused by the VERSION
      // check, and by nothing else: the row is bound to a revision that exists,
      // carries that revision's digest, is proposed by the batch's own proposer,
      // holds a correct propose grant, and is on a still-proposed batch.
      const revised = { ...proposal(2), tasks: [{ ...proposal(2).tasks[0]!, title: "Owner revision part" }] };
      const revisedDigest = workBatchProposalDigestV1(revised);
      await admin.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
        edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,'batch:orch-guard',2,
        'identity:orch-owner',$3,'owner_revision',$4::jsonb,$5,$6)`,
      ["batch:orch-guard:revision:2", scope.tenantId, LATER, JSON.stringify(revised), revisedDigest,
        hmacSha256Tag(KEY, { purpose: "work-batch-revision/v1", record: { id: "batch:orch-guard:revision:2",
          tenantId: scope.tenantId, batchId: "batch:orch-guard", revision: 2,
          editedByIdentityId: "identity:orch-owner", editedAt: LATER, reasonCode: "owner_revision",
          proposal: revised, revisionDigest: revisedDigest } })]);
      await assert.rejects(insert({ revision: 2, revisionDigest: revisedDigest,
        proposal: revised, requestKey: "orchestrator-guard-0004b" }),
      /work batch split suggestion insert rejected/u,
      "a suggestion may not name a revision the batch has not reached, even when that revision exists");
      // And once the batch's version advances, the same suggestion is accepted:
      // the refusal above was the version, not the revision's existence.
      await admin.query("UPDATE work_batches SET version=2, updated_at=$3 WHERE tenant_id=$1 AND id=$2",
      [scope.tenantId, "batch:orch-guard", LATER]);
      assert.equal((await insertSuggestion(intake, { id: `split-suggestion:${"3".repeat(32)}`,
        tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-guard",
        requestKey: "orchestrator-guard-0004c", revision: 2, revisionDigest: revisedDigest,
        proposer: "identity:orch-agent", proposal: revised, createdAt: NOW })).rowCount, 1,
      "at the batch's real version the same suggestion is accepted");
      // A real revision, but the wrong digest for it.
      await assert.rejects(insert({ revisionDigest: `sha256:${"0".repeat(64)}`, requestKey: "orchestrator-guard-0005" }),
        /work batch split suggestion insert rejected/u);
      // Another tenant's project on this batch.
      await assert.rejects(insert({ projectId: other.projectId, requestKey: "orchestrator-guard-0006" }),
        /work batch split suggestion insert rejected/u);
      // Another tenant entirely, against its own agent and batch. The proposal
      // names the OTHER project, so the refusal is the tenant boundary and not a
      // mismatched project id.
      const otherBatch = await seedBatch(admin, other, "batch:orch-other", "identity:orch-agent-other");
      await assert.rejects(insertSuggestion(intake, { id: `split-suggestion:${"c".repeat(32)}`,
        tenantId: other.tenantId, projectId: other.projectId, batchId: "batch:orch-other",
        requestKey: "orchestrator-guard-0007", revision: 1, revisionDigest: otherBatch.digest,
        proposer: "identity:orch-agent-other", proposal: proposal(3, other.projectId), createdAt: NOW }),
      /row-level security|insert rejected/u,
      "the shared intake login is confined to its bound tenant");
      // A rejected batch -- the state a batch lands in when the owner decides it
      // no longer stands -- accepts nothing.
      await seedBatch(admin, scope, "batch:orch-decided", "identity:orch-agent", "rejected");
      await assert.rejects(insert({ batchId: "batch:orch-decided", requestKey: "orchestrator-guard-0008" }),
        /work batch split suggestion insert rejected/u);
      // The ONLY rows that exist are the ones that were supposed to: the second
      // proposer's suggestion on its own batch, and one at the batch's real
      // current version. Every refused insert left nothing.
      const surviving = await admin.query<{ request_key: string }>(
        "SELECT request_key FROM work_batch_split_suggestions ORDER BY request_key");
      assert.deepEqual(surviving.rows.map(row => row.request_key),
        ["orchestrator-guard-0003c", "orchestrator-guard-0004c"],
        "exactly the two intended suggestions exist and no refused insert left a row");
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
      await seedIdentities(admin, scope, "");
      const { digest } = await seedBatch(admin, scope, "batch:orch-replay");
      const split = proposal(3);
      const row = { id: `split-suggestion:${"d".repeat(32)}`, tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:orch-replay", requestKey: "orchestrator-replay-0001", revision: 1, revisionDigest: digest,
        proposer: "identity:orch-agent", proposal: split, createdAt: NOW };
      await insertSuggestion(intake, row);
      // An exact replay. The row id is the SAME here, so this is refused by the
      // primary key, which is the first thing a duplicate id hits.
      await assert.rejects(insertSuggestion(intake, row), /duplicate key/u,
        "an exact replay cannot create a second row");
      // The same REQUEST KEY with different content. The row id is deliberately
      // different, so the request-key unique index is what refuses it -- and the
      // message must name the operation's own safe reason code, not a raw 23505
      // the caller has to recognise by text.
      const other2 = proposal(4);
      await assert.rejects(insertSuggestion(intake, { ...row, id: `split-suggestion:${"0".repeat(31)}1`, proposal: other2 }),
      /work_batch_split_suggestions_request_key_unique/,
      "a differing replay under a used request key is refused by the key's own index");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_split_suggestions")).rows[0]!.n, 1,
        "neither replay left a second row");
      await assert.rejects(admin.query("UPDATE work_batch_split_suggestions SET proposal_digest=$1",
        [`sha256:${"9".repeat(64)}`]), /append-only|append only|immutable/u);
      await assert.rejects(admin.query("DELETE FROM work_batch_split_suggestions"), /append-only|append only|immutable/u);
      // TRUNCATE is a separate trigger from the row-level append-only one, and it
      // is a separate refusal: a table can be emptied without touching a row. It
      // needs its own assertion or deleting the trigger is invisible.
      await assert.rejects(admin.query("TRUNCATE work_batch_split_suggestions"),
        /append-only|append only|immutable/u,
        "a table can be emptied without touching a row, so TRUNCATE needs its own guard");
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
      await seedIdentities(admin, scope, "");
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
      await seedIdentities(admin, scope, "");
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
      // B4: a DIFFERING replay under a used key is refused, not answered with the
      // row that is already there. Measured against this adapter before the fix:
      // the pre-read returned any existing row without comparing, so asking for a
      // 4-part plan under the 3-part plan's key came back as SUCCESS carrying 3
      // parts. The in-memory double refused it, so the double was the only thing
      // holding the contract.
      const conflict = (error: unknown) => error instanceof IntakeSuggestionStoreErrorV1
        && error.safeReasonCode === "intake_suggestion_replay_conflict";
      await assert.rejects(Promise.resolve().then(() => store.append({ ...input, proposal: proposal(4),
        proposalDigest: workBatchProposalDigestV1(proposal(4)) })), conflict,
      "a differing proposal under a used key is refused");
      // ... and it is refused for the base revision too, not only the proposal.
      await assert.rejects(Promise.resolve().then(() => store.append({ ...input, baseRevision: 2 })), conflict,
      "a differing base revision under a used key is refused");
      // ... and for the revision DIGEST, which is the third bound value and the
      // one a same-proposal replay would slip past a proposal-only comparison.
      await assert.rejects(Promise.resolve().then(() => store.append({ ...input,
        baseRevisionDigest: `sha256:${"0".repeat(64)}` })), conflict,
      "a differing base revision digest under a used key is refused");
      // The refusals wrote nothing, and the stored row is still the one that was
      // asked for first -- a refusal is not a partial write.
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM work_batch_split_suggestions")).rows[0]!.n, 1,
        "three refused replays left no second row");
      const survivor = await store.append(input);
      assert.equal(survivor.suggestionId, first.suggestionId,
        "and the exact replay still returns the same record after the refusals");
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
      await admin.query("ALTER TABLE work_batch_split_suggestions DISABLE TRIGGER work_batch_split_suggestions_append_only");
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
      await seedIdentities(admin, scope, "");
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
      // 0135's own rule still holds alongside 0201's: a default model is only
      // meaningful once the worker it belongs to is named, and that is the
      // constraint that must keep holding after a new column arrives.
      await assert.rejects(web.query(`UPDATE control_project_settings SET default_model='gpt-5-codex'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]), /check constraint/u);
      assert.equal((await web.query(`UPDATE control_project_settings SET default_worker_kind='codex',
        default_model='gpt-5-codex' WHERE tenant_id=$1 AND project_id=$2 RETURNING default_model`,
      [scope.tenantId, scope.projectId])).rows[0]!.default_model, "gpt-5-codex",
      "0135's task-default columns are unchanged by 0201");
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
      await seedIdentities(admin, scope, "");
      const db = database(coordinator);
      // The failure scope is a DIGEST, not a readable string: the coordinator
      // counts per request AND per project+description, and a readable scope
      // either overflowed 0202's 180-character CHECK for a long request key or
      // was unreachable from the panel because every press mints a fresh key.
      const requestKey = "planner-store-0001";
      const description = "Make the release notes match the shipped behaviour.";
      const scopeKey = intakeRequestScopeV1("initial", scope.tenantId, scope.projectId, requestKey);
      const projectScope = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description);
      const scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });
      const failures = new PostgresIntakePlannerFailureStoreV1(db, scopeOf, () => LATER);
      const needsYou = new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:orch-agent" }), () => LATER);
      assert.equal(await failures.count(scopeKey), 0, "an unseen request has no failures");
      assert.equal(await failures.record(scopeKey), 1);
      assert.equal(await failures.count(scopeKey), 1);
      assert.equal(await failures.record(scopeKey), 2, "the second failure is the escalation point");

      // THE SCOPE KEY IS THE SAME STRING ON BOTH SIDES. 0204's guard trigger
      // recomputes it in SQL from the same values the coordinator digests in
      // TypeScript, and if the two disagree then EVERY raise is refused -- the
      // whole escalation path silently dies while every unit test still passes.
      // So this asserts the SQL function against the TypeScript value directly,
      // for both shapes, rather than trusting that they "should" agree.
      // The `$N` parameters are CAST to text because jsonb_build_object cannot
      // infer a bare parameter's type, and it raises 42P18 ("could not determine
      // data type of parameter") rather than guessing. Measured, not assumed.
      //
      // `ownerRequest` is the DESCRIPTION'S DIGEST, exactly as the application
      // hashes it and exactly as the raise stores it, because the project scope
      // has to be recomputable from the stored digest alone. Passing the text
      // here would produce a different key and the comparison would fail in a way
      // that reads like a guard bug rather than a shape mismatch.
      const fromSql = await admin.query<{ request: string; project: string }>(`SELECT
        planner_failure_scope_key('initial', jsonb_build_object(
          'tenantId',$1::text,'projectId',$2::text,'requestKey',$3::text)) AS request,
        planner_failure_scope_key('project', jsonb_build_object(
          'kind','initial','tenantId',$1::text,'projectId',$2::text,'ownerRequest',$4::text)) AS project`,
      [scope.tenantId, scope.projectId, requestKey, sha256Digest({ ownerRequest: description })]);
      assert.equal(fromSql.rows[0]!.request, scopeKey,
        "the SQL scope key and the TypeScript scope key must be byte-identical for the request scope");
      assert.equal(fromSql.rows[0]!.project, projectScope,
        "... and for the project scope, or 0204's guard would refuse every escalation");
      // And both fit the CHECK that a 180-character request key used to overflow.
      assert.match(scopeKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u, "a digest scope is always a legal scope_key");
      assert.match(projectScope, /^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$/u);

      // A raise is idempotent by request key: two raises are one Needs-you item.
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey, reasonCode: "orchestrator_failed_twice", ownerRequest: description, now: LATER });
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey, reasonCode: "orchestrator_failed_twice", ownerRequest: description, now: LATER });
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_action_inbox WHERE kind='failure'"))
        .rows[0]!.n, 1, "one action-inbox item, not two");
      // The ledger stores the description DIGEST and never the text, so raising a
      // Needs-you still cannot put the owner's words in a table the web login can
      // read.
      const stored = await admin.query<{ owner_request_digest: string; text: string }>(
        "SELECT owner_request_digest, coalesce(owner_request_digest,'') AS text FROM control_planner_needs_you_items");
      assert.equal(stored.rows[0]!.owner_request_digest, sha256Digest({ ownerRequest: description }));
      assert.equal((await admin.query("SELECT count(*)::text AS n FROM information_schema.columns WHERE table_name='control_planner_needs_you_items' AND column_name='owner_request'")).rows[0]!.n, "0",
        "the ledger has no column for the description text at all");
      // A raise with no live counter at 2 is refused: an escalation must be earned.
      await assert.rejects(needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "planner-store-9999", reasonCode: "orchestrator_failed_twice",
        ownerRequest: description, now: LATER }),
      /planner_needs_you_not_escalated/u);
      // A DIFFERENT description has its own project scope, so a counter earned by
      // one description cannot license an escalation for another. This is the
      // bound the 0204 guard re-checks in SQL, and it is the reason the project
      // scope digests the text rather than just naming the project.
      const otherScope = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, "A different description.");
      assert.notEqual(otherScope, projectScope,
        "two descriptions in one project are two scopes, so neither can escalate the other");
      await assert.rejects(needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "planner-store-0002", reasonCode: "orchestrator_failed_twice",
        ownerRequest: "A different description.", now: LATER }),
      /planner_needs_you_not_escalated/u,
      "another description's project counter is not this request's counter");
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
      // Two independent refusals of a mutation, and they are not the same one.
      // DELETE is refused by the GRANT: the coordinator holds no DELETE at all, so
      // the row is unreachable that way even before a trigger sees it. The
      // append-only trigger is the second layer, and it is proved by having the
      // schema owner -- who bypasses every grant -- attempt the same DELETE.
      await assert.rejects(coordinator.query("DELETE FROM control_planner_failure_counters"),
        /permission denied/u, "the coordinator holds no DELETE on the counter");
      await assert.rejects(admin.query("DELETE FROM control_planner_failure_counters"),
        /append-only|append only|immutable/u, "and the owner is refused by the trigger, not only by the grant");
      await assert.rejects(coordinator.query("UPDATE control_planner_needs_you_items SET failure_count=9"),
        /permission denied/u, "the ledger is append-only by grant as well as by trigger");
      await assert.rejects(admin.query("UPDATE control_planner_needs_you_items SET failure_count=9"),
        /append-only|append only|immutable/u);
      await assert.rejects(coordinator.query("DELETE FROM control_planner_needs_you_items"), /permission denied/u);
      await assert.rejects(admin.query("DELETE FROM control_planner_needs_you_items"),
        /append-only|append only|immutable/u);
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
      await seedIdentities(admin, scope, "");
      const CONCURRENCY = 20;
      const clients = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        const client = new Client(postgres.connection("coordinator")); await client.connect(); return client;
      }));
      try {
        const raceKey = "planner-race-0001";
        const raceDescription = "A description under twenty concurrent failures.";
        const scopeKey = intakeRequestScopeV1("initial", scope.tenantId, scope.projectId, raceKey);
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
          projectId: scope.projectId, requestKey: raceKey, reasonCode: "orchestrator_failed_twice",
          ownerRequest: raceDescription, now: LATER })));
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1,
          "idempotency holds under concurrency, not only under a sequential retry");
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_action_inbox WHERE kind='failure'"))
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
