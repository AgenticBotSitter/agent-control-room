// Real PostgreSQL proof for MIG-A (plan v4.3 §2.1): the orchestrator's
// re-split suggestion (0200), the planner selection (0201) and the durable
// failure/escalation bookkeeping (0202).
//
// Everything here runs AS the production logins. The superuser connection is
// used only to seed fixtures and to prove a refusal the login itself cannot be
// asked for; every authority assertion is made from the intake, coordinator and
// private-web logins.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { IntakeCoordinatorV1, workBatchProposalDigestV1, PostgresIntakePlannerFailureStoreV1,
  PostgresIntakeNeedsYouStoreV1, PostgresIntakeOwnerRetryStoreV1, PostgresIntakeSuggestionStoreV1,
  IntakeSuggestionStoreErrorV1,
  UnwiredPlannerAllowanceV1, intakeProjectScopeV1, intakeRequestScopeV1,
  type WorkBatchProposalV1 } from "../src/work-intake/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { IntakePlannerPortV1 } from "../src/work-intake/v1/intake-coordinator";
import type { WorkBatchServiceV1 } from "../src/work-intake/v1/service";

/** The submission half of the coordinator's port, named from the service's own
 * type so a change to `submit`'s signature fails HERE rather than being cast away
 * at the call site. */
type IntakeSubmissionPort = Pick<WorkBatchServiceV1, "authorizeBeforeBody" | "submit">;

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

/** The same port over a pool: one round trip per statement, so concurrent presses
 * interleave between statements, where the races live. */
function poolDatabase(pool: Pool): DatabaseClient {
  return {
    query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await pool.query(sql, values as never[])).rows as T[] }),
    transaction: async work => {
      const client = await pool.connect();
      try { return await database(client as unknown as Client).transaction(work); } finally { client.release(); }
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

test("the tenant-bound VIEW leaks nothing through an ERROR: a cast or a division in the caller's own filter", async t => {
  // N-B1, and the reason the `security_barrier` reloption exists.
  //
  // The tenant-bound test above proves the plain read returns zero rows. It did
  // not prove the read was SAFE, and it was not: a plain view is not a security
  // barrier, so PostgreSQL evaluates the CALLER's qual before the view's own. A
  // cheap filter the intake login adds therefore ran on every row the view
  // produced -- including tenant B's -- and a filter that FAILS turned B's row
  // into an error message carrying B's content. Measured on the round-2 tree,
  // with the intake login bound to tenant A and tenant B holding one suggestion:
  //
  //   (proposal->'tasks'->0->>'title')::int = 0    ERROR ... "SECRET-B-TENANT-ONLY"
  //   (proposal::text)::int = 0                    ERROR ... the whole proposal
  //   request_key::int = 0                         ERROR ... "orchestrator-tenant-b-1"
  //   1 / (CASE WHEN proposal::text LIKE '%SECRET%' THEN 0 ELSE 1 END) = 1
  //                                                    ERROR: division by zero
  //
  // Every one of those is built-ins only, so the attack needs no function the
  // caller may create, and TEMP is revoked from this login so it could not make
  // one either. The same cast on the BASE table is safe, because an RLS qual is a
  // security barrier by construction -- which is what makes the reloption the
  // difference rather than a stylistic choice.
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
      await seedBatch(admin, scope, "batch:orch-tenant-a");
      const ownBatch = await seedBatch(admin, scope, "batch:orch-tenant-a-2");
      await insertSuggestion(admin, { id: `split-suggestion:${"8".repeat(32)}`,
        tenantId: scope.tenantId, projectId: scope.projectId, batchId: "batch:orch-tenant-a-2",
        requestKey: "orchestrator-tenant-a-1", revision: 1, revisionDigest: ownBatch.digest,
        proposer: "identity:orch-agent", proposal: proposal(2), createdAt: NOW });

      // THE RELOPTION IS THE THING UNDER TEST, so it is asserted as a FACT before
      // the behaviour is measured. A green run on a view that is not a barrier
      // would otherwise be indistinguishable from a fix.
      const reloptions = await admin.query<{ reloptions: string[] | null }>(
        "SELECT reloptions FROM pg_class WHERE relname='work_batch_current_split_suggestions'");
      assert.deepEqual(reloptions.rows[0]!.reloptions, ["security_barrier=true"],
        "the tenant-bound view IS a security barrier, which is the whole fix");

      // WHAT THE BARRIER PROMISES, stated before the assertions because it is the
      // thing that is easy to assert wrongly. It does NOT make the caller's filter
      // silent: a filter that fails on the caller's OWN row still raises, and it
      // should -- that row is the caller's to read. What it promises is that a row
      // the view EXCLUDES is never evaluated by the caller's filter at all, so it
      // can never appear in an error message.
      //
      // So the two groups are kept separate, because they prove different things.
      //
      // GROUP ONE, THE CASTS. These raise on the caller's own row, and the only
      // thing that may appear in the message is the caller's OWN content. The
      // round-2 leak was exactly B's content appearing here.
      const casts: ReadonlyArray<readonly [string, string]> = [
        ["a cast of the first task title", "SELECT 1 FROM work_batch_current_split_suggestions WHERE (proposal->'tasks'->0->>'title')::int = 0"],
        ["a cast of the whole proposal", "SELECT 1 FROM work_batch_current_split_suggestions WHERE (proposal::text)::int = 0"],
        ["a cast of the request key", "SELECT 1 FROM work_batch_current_split_suggestions WHERE request_key::int = 0"],
        ["a cast of the integrity tag", "SELECT 1 FROM work_batch_current_split_suggestions WHERE auth_tag::int = 0"],
      ];
      // The caller's OWN material, which an error MAY name -- and whose appearing is
      // in fact the proof that the filter really was evaluated on a row.
      const ownMaterial = ["Bounded part 0", "orchestrator-tenant-a-1", "hmac-sha256", "tasks"];
      for (const [label, sql] of casts) {
        let error: string | undefined;
        try { await intake.query(sql); } catch (reason) { error = String((reason as Error).message); }
        // THE LEAK. Neither B's title nor B's request key may appear.
        assert.equal(error?.includes(secret) ?? false, false,
          `${label} revealed the other tenant's title in its error: ${error ?? ""}`);
        assert.equal(error?.includes("orchestrator-tenant-b-1") ?? false, false,
          `${label} revealed the other tenant's request key in its error: ${error ?? ""}`);
        // And the error, if any, is about the caller's OWN row.
        if (error !== undefined) assert.ok(ownMaterial.some(own => error!.includes(own)),
          `${label} raised about something that is neither the caller's own row nor a leak: ${error}`);
      }

      // GROUP TWO, THE ORACLES. These are the real test, because each is a
      // yes/no CHANNEL: it raises if and only if the caller's filter is ever
      // evaluated against a row satisfying the predicate. The form is a division
      // by a value that is ZERO only on tenant B's row, so on the caller's own row
      // the divisor is 1 and nothing raises, and if B's row ever reached the filter
      // the divisor would be 0 and the query would raise.
      //
      // A `CASE ... THEN 1/0` is deliberately NOT used, and the reason is measured
      // rather than theoretical: PostgreSQL does not promise CASE short-circuits
      // constant arms, so `1/0` was evaluated for the ELSE branch too and the
      // oracle fired on the caller's own row -- a false positive that made this
      // test pass for the wrong reason, then fail on a different plan. Putting the
      // zero in the DIVISOR makes the outcome depend only on a per-row quantity
      // the planner has no constant to fold.
      const zeroOnlyFor = (predicate: string) =>
        "SELECT 1 FROM work_batch_current_split_suggestions WHERE 1/(CASE WHEN "
        + `${predicate} THEN 0 ELSE 1 END) = 1`;
      const bId = `split-suggestion:${"7".repeat(32)}`;
      const oracles: ReadonlyArray<readonly [string, string]> = [
        ["the other tenant's request key", zeroOnlyFor("request_key='orchestrator-tenant-b-1'")],
        ["the other tenant's id", zeroOnlyFor(`id='${bId}'`)],
        ["the other tenant's revision digest", zeroOnlyFor(`base_revision_digest='${foreignBatch.digest}'`)],
        ["the other tenant's proposal text", zeroOnlyFor(`proposal::text LIKE '%${secret}%'`)],
        ["the other tenant's tenant id", zeroOnlyFor(`tenant_id='${other.tenantId}'`)],
      ];
      for (const [label, sql] of oracles) {
        await assert.doesNotReject(intake.query(sql),
          `an oracle on ${label} raised, which answers "does that row exist" -- the exact channel the barrier removes`);
      }
      // THE CONTROL, and it is the same expression keyed on the CALLER's own
      // request key. It raises, which is what proves the five above are a real
      // answer rather than a filter that never runs on this login.
      await assert.rejects(intake.query(zeroOnlyFor("request_key='orchestrator-tenant-a-1'")),
        /division by zero/u,
        "the same oracle DOES fire on the caller's own row, so the clean results above are a real answer and not a filter that never ran");

      // The same oracle on the BASE table was always safe, and must stay safe: it
      // is the control that shows the difference is the reloption and not the
      // shape of the expression.
      for (const [label, sql] of oracles) {
        const base = sql.replace("work_batch_current_split_suggestions", "work_batch_split_suggestions");
        await assert.doesNotReject(intake.query(base),
          `the base table's RLS qual is a barrier by construction, so an oracle on ${label} cannot fire there either`);
      }
      // The login's own row is still reachable, and the filters above must
      // therefore have run over a real row -- otherwise "no oracle fired" could
      // mean "no rows reached the filter at all", which would make this test pass
      // on a view that simply returns nothing.
      const own = await intake.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM work_batch_current_split_suggestions");
      assert.equal(own.rows[0]!.n, "1", "the bound tenant's own row is still there to be filtered");
      const evaluated = await intake.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM work_batch_current_split_suggestions WHERE proposal IS NOT NULL");
      assert.equal(evaluated.rows[0]!.n, "1",
        "a plain filter still sees the row, so the barrier is what stops the OTHER tenant's, not an empty view");

      // THE PLAN, asserted as a SHAPE, because the shape is the mechanism and the
      // two groups above are only its consequences. Measured on the fixed tree:
      //
      //   Subquery Scan on work_batch_current_split_suggestions
      //     Filter: (1 / (CASE WHEN ... THEN 0 ELSE 1 END) = 1)
      //     -> Nested Loop
      //          -> Index Scan ... on work_batch_split_suggestions s
      //               Filter: ((b.version = s.base_revision)
      //                        AND work_intake_split_suggestion_visible(...))
      //
      // The caller's filter is a qualifier on the view's OUTPUT, applied after the
      // view produced a row. The view's tenant predicate is a Filter on the inner
      // scan, so it decides WHICH rows exist at all. On the round-2 tree these were
      // the same Filter in the other order, which is why the caller's cheap
      // predicate ran first and could see B's row.
      //
      // EXPLAIN does not execute the qual, but it DOES constant-fold, so a literal
      // `1/0` is evaluated while the plan is BUILT and the EXPLAIN itself raises --
      // measured, and it reads as a broken barrier. The division is therefore driven
      // by a column, so the folding has nothing to work with.
      const plan = await intake.query<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF, VERBOSE)
        SELECT 1 FROM work_batch_current_split_suggestions
        WHERE 1/(CASE WHEN proposal::text LIKE '%${secret}%' THEN 0 ELSE 1 END) = 1`);
      const planText = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
      assert.match(planText, /work_intake_split_suggestion_visible/u,
        `the view's tenant predicate is in the plan at all:\n${planText}`);
      // The outer block is the Subquery Scan's header plus its own Filter lines,
      // which is exactly the caller's qual and nothing else. Its `->` children
      // belong to the view's own plan, so the block stops at the first child.
      const outerBlock = planText.slice(0, planText.search(/\s*->\s/) === -1
        ? undefined : planText.search(/\s*->\s/));
      assert.match(outerBlock, /Subquery Scan on work_batch_current_split_suggestions/u,
        `the view is a Subquery Scan, so the caller's filter is a qualifier on its OUTPUT rather than on its rows:\n${planText}`);
      assert.match(outerBlock, /Filter:[\s\S]*SECRET-B-TENANT-ONLY/u,
        `the caller's own filter is the outer one, above the tenant predicate:\n${planText}`);
      assert.match(planText, /Index Scan[\s\S]*?Filter:[\s\S]*?work_intake_split_suggestion_visible/u,
        `the tenant predicate is on the inner scan, which is what excludes B's row before the caller's filter runs:\n${planText}`);
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 9, allowedPorts: ALLOWED, boundMs: 180_000 });
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
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM work_batch_revisions WHERE batch_id=$1`,
        ["batch:orch-store"])).rows[0]!.n, 1, "a suggestion never writes a work_batch_revision");

      // THE POST-INSERT ARM, which the pre-read cannot reach. `append` does
      // pre-read, then INSERT ... ON CONFLICT DO NOTHING, then read back. The
      // window between the pre-read and the insert is where a CONCURRENT append
      // of the same key under different content lands: the insert does nothing,
      // the other caller's row is in place, and the read-back finds a row that is
      // not ours. That arm used `&&` where it needed `||`, so it only fired when
      // BOTH digests differed.
      //
      // It is driven here as a genuine race: two coordinators race the same key
      // with different proposals, and the loser must be refused rather than
      // handed the winner's record. `store` and the racing store are separate
      // adapters on separate connections, which is what makes the pre-reads
      // genuinely concurrent.
      const racer = new Client(postgres.connection("control_room_work_intake_agent"));
      await racer.connect();
      try {
        // Two adapters, two connections, and an EXPLICIT barrier between the
        // pre-read and the insert, because the post-insert arm is otherwise
        // unreachable from a test.
        //
        // Both `append` calls are the same code, so the only way to make one of
        // them lose the race -- pass its pre-read, then find the other's row where
        // its own insert would have gone -- is to hold the RIVAL between its two
        // database round trips. Its `query` blocks on a promise the test
        // releases, so the interleaving is exact rather than hoped for: without
        // the barrier, both runs of this test took the pre-read arm and the
        // post-insert `||` was never executed at all (which is why its mutation
        // escaped the first time).
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let gated = false;
        const blocking = {
          query: async (sql: string, values?: unknown[]) => {
            // The RIVAL's pre-read is the one that must see nothing, so it is
            // held and released only after the winner has inserted.
            if (!gated && sql.includes("FROM work_batch_split_suggestions")) {
              gated = true;
              await gate;
            }
            return racer.query(sql, values as never[]);
          },
        } as unknown as ReturnType<typeof database>;
        const rival = new PostgresIntakeSuggestionStoreV1(blocking, KEY);
        const base = { ...input, requestKey: "orchestrator-store-race-0003" };
        // The RIVAL carries DIFFERENT content under the SAME key, so the second
        // caller is not an exact replay -- which is the case the contract refuses.
        // Two adapters with identical content would both be correct: the second
        // is an exact replay and must be answered with the first's record.
        const winner = store.append(base);
        // Let the winner finish its pre-read and insert before the rival reads.
        await new Promise(resolve => setImmediate(resolve));
        const other = proposal(4);
        const loser = rival.append({ ...base, proposal: other, proposalDigest: workBatchProposalDigestV1(other) });
        await new Promise(resolve => setImmediate(resolve));
        release();
        const settled = await Promise.allSettled([winner, loser]);
        const rejected = settled.filter(r => r.status === "rejected");
        assert.equal(rejected.length, 1,
          `exactly one caller is refused, the other stores the row: ${JSON.stringify(settled.map(r => r.status))}`);
        for (const outcome of rejected) assert.ok(outcome.reason instanceof Error
          && /intake_suggestion_replay_conflict/u.test(outcome.reason.message),
        `and the refusal names the replay conflict, not a raw database error: ${String(outcome.reason)}`);
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM work_batch_split_suggestions
          WHERE request_key=$1`, ["orchestrator-store-race-0003"])).rows[0]!.n, 1,
          "the race left exactly one row, never two plans under one request key");
      } finally { await racer.end(); }

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
      const fromSqlRow = await admin.query<{ request: string; project: string }>(`SELECT
        planner_failure_scope_key('initial', jsonb_build_object(
          'tenantId',$1::text,'projectId',$2::text,'requestKey',$3::text)) AS request,
        planner_failure_scope_key('project', jsonb_build_object(
          'kind','initial','tenantId',$1::text,'projectId',$2::text,'ownerRequest',$4::text)) AS project`,
      [scope.tenantId, scope.projectId, requestKey, sha256Digest({ ownerRequest: description })]);
      assert.equal(fromSqlRow.rows[0]!.request, scopeKey,
        "the SQL scope key and the TypeScript scope key must be byte-identical for the request scope");
      assert.equal(fromSqlRow.rows[0]!.project, projectScope,
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
      // THE GUARD'S OWN SCOPE-MEMBERSHIP CHECK, reached directly. The adapter
      // refuses an unearned raise on its own read -- `planner_needs_you_not_escalated`
      // -- so the trigger's `NEW.scope_key NOT IN (...)` arm is only reachable by a
      // hand-written INSERT. That matters: without this assertion the trigger would
      // accept a raise naming a scope it did not recompute, as long as SOME live
      // counter in the project was at 2, and every adapter-level test would still
      // pass. E1's mutation (the membership check replaced by `OR false`) escaped
      // until this assertion existed -- measured, which is the only reason it is here.
      //
      // EVERY OTHER ARM IS SATISFIED ON PURPOSE, including the one that masked
      // this test's first version: the forged scope has a LIVE COUNTER OF ITS OWN
      // at 2. Without it the guard's final `NOT EXISTS` refuses the row and the
      // membership check is never reached -- the mutation E1 makes then passes,
      // which is how a test that looks right measures nothing.
      //
      // So the counter is built on the forged scope, the id and action_item_id are
      // the correct digests OF THAT SCOPE, the reason code is right and the raiser
      // is a real active agent. Every arm is satisfied except the membership one,
      // and that is the only thing left that can refuse it.
      // A scope the trigger CANNOT have recomputed: the row's request_key is one
      // thing, and the scope_key it names is derived from a DIFFERENT one. The
      // first version of this used the same key for both, so the trigger
      // recomputed the scope from the row and the row was correctly ACCEPTED --
      // the assertion failed, and the failure was the test being wrong, not the
      // guard. A forged row has to disagree with itself in the one way the guard
      // checks.
      const forged = intakeRequestScopeV1("initial", scope.tenantId, scope.projectId, "a-different-request-key");
      const forgedDigest = (value: string) => 'planner-needs-you:' + createHash("sha256")
        .update(`${scope.tenantId}/${scope.projectId}/${value}`, "utf8").digest("hex").slice(0, 32);
      await admin.query(`INSERT INTO control_planner_failure_counters(tenant_id,project_id,scope_key,failure_count,
        last_failure_at,cleared_at,version,updated_at,created_at) VALUES($1,$2,$3,1,$4,NULL,1,$4,$4)`,
      [scope.tenantId, scope.projectId, forged, LATER]);
      await admin.query(`UPDATE control_planner_failure_counters SET failure_count=2, version=version+1, updated_at=$4
        WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`, [scope.tenantId, scope.projectId, forged, LATER]);
      // Asserted, not assumed: if this counter is not live the test below proves
      // nothing, and the failure would read as a passing guard.
      assert.equal((await admin.query<{ failure_count: string }>(
        "SELECT failure_count::text FROM control_planner_failure_counters WHERE scope_key=$1", [forged]))
        .rows[0]!.failure_count, "2", "precondition: the forged scope's OWN counter is live at 2");
      await assert.rejects(admin.query(`INSERT INTO control_planner_needs_you_items
        (id,tenant_id,project_id,request_key,reason_code,failure_count,raised_by_identity_id,raised_at,
          owner_request_digest,scope_key,action_item_id)
        VALUES($1,$2,$3,'forged-scope-0001','orchestrator_failed_twice',2,'identity:orch-agent',$4,$5,$6,$7)`,
      [forgedDigest(forged), scope.tenantId, scope.projectId, LATER,
        sha256Digest({ ownerRequest: description }), forged,
        'attention:planner:' + forgedDigest(forged).slice("planner-needs-you:".length)]),
      /planner needs-you insert rejected/u,
      "a raise naming a scope the trigger did not recompute is refused, even though that scope has its OWN live counter at 2");
      // The CONTROL, and it is the row the refused one is only meaningful against.
      // Every arm is the same except the scope: this one names a scope the trigger
      // DID recompute, and it is accepted. Without it the refusal above could be a
      // row that was always going to fail for some unrelated reason.
      const legitimate = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description);
      assert.equal((await admin.query("SELECT failure_count::text FROM control_planner_failure_counters WHERE scope_key=$1",
        [legitimate])).rows.length, 0,
        "precondition: this description's own project counter does not exist yet");
      await admin.query(`INSERT INTO control_planner_failure_counters(tenant_id,project_id,scope_key,failure_count,
        last_failure_at,cleared_at,version,updated_at,created_at) VALUES($1,$2,$3,1,$4,NULL,1,$4,$4)`,
      [scope.tenantId, scope.projectId, legitimate, LATER]);
      await admin.query(`UPDATE control_planner_failure_counters SET failure_count=2, version=version+1, updated_at=$4
        WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`, [scope.tenantId, scope.projectId, legitimate, LATER]);
      await admin.query(`INSERT INTO control_planner_needs_you_items
        (id,tenant_id,project_id,request_key,reason_code,failure_count,raised_by_identity_id,raised_at,
          owner_request_digest,scope_key,action_item_id)
        VALUES($1,$2,$3,'legitimate-scope-0001','orchestrator_failed_twice',2,'identity:orch-agent',$4,$5,$6,$7)`,
      [forgedDigest(legitimate), scope.tenantId, scope.projectId, LATER,
        sha256Digest({ ownerRequest: description }), legitimate,
        'attention:planner:' + forgedDigest(legitimate).slice("planner-needs-you:".length)]);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items WHERE scope_key=$1",
        [legitimate])).rows[0]!.n, 1,
        "the same row, naming a scope the trigger computed, is accepted -- so the refusal above was the membership check and not something else");
      // And the forged row left nothing behind.
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items WHERE scope_key=$1",
        [forged])).rows[0]!.n, 0, "the refused row left no trace");
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

      // THE COUNT CHECK, in the database, through the real trigger. The adapter
      // refuses an unearned raise on its own read, so a hand-written INSERT is the
      // only way to reach the guard's `failure_count >= NEW.failure_count` arm --
      // and that arm is the one 0202 exists for: a raise must be a claim about a
      // COUNTER, so a caller that inserts one without a live counter at that
      // count is inventing an escalation rather than reporting one.
      //
      // The digest is taken from a real, already-cleared counter, so the scope
      // match would pass and the COUNT is the only thing that can refuse this.
      // (The row was cleared above, so its live count is 0.) Every other arm is
      // satisfied on purpose: a real active agent, the correct deterministic id,
      // and the correct reason code.
      const liveCount = (await admin.query<{ failure_count: string; cleared_at: string | null }>(
        "SELECT failure_count::text, cleared_at FROM control_planner_failure_counters WHERE scope_key=$1",
        [scopeKey])).rows[0]!;
      assert.ok(liveCount.cleared_at, "the counter this forged raise points at is cleared, so its count is 0");
      await assert.rejects(admin.query(`INSERT INTO control_planner_needs_you_items(id,tenant_id,project_id,
        request_key,reason_code,failure_count,raised_by_identity_id,raised_at,owner_request_digest)
        VALUES('planner-needs-you:' || substring(md5($1 || '/' || $2 || '/forged-count-0001') from 1 for 32),
          $1,$2,'forged-count-0001','orchestrator_failed_twice',2,'identity:orch-agent',$3,$4)`,
      [scope.tenantId, scope.projectId, LATER, sha256Digest({ ownerRequest: description })]),
      /planner needs-you insert rejected/u,
      "a raise naming a counter at 0 is refused: an escalation must be earned");
      // The counter the forged raise named is a REAL scope for a real request, so
      // the only arm that could refuse it is the count. A different id, a human
      // actor, or a wrong reason code are refused too, and each is a separate
      // property -- so they are asserted separately rather than lumped in.
      await assert.rejects(admin.query(`INSERT INTO control_planner_needs_you_items(id,tenant_id,project_id,
        request_key,reason_code,failure_count,raised_by_identity_id,raised_at,owner_request_digest)
        VALUES('planner-needs-you:' || substring(md5($1 || '/' || $2 || '/forged-owner-0002') from 1 for 32),
          $1,$2,'forged-owner-0002','orchestrator_failed_twice',9,'identity:orch-owner',$3,$4)`,
      [scope.tenantId, scope.projectId, LATER, sha256Digest({ ownerRequest: description })]),
      /planner needs-you insert rejected/u,
      "a HUMAN raiser is refused: only the coordinator's own agent escalates");
      await assert.rejects(admin.query(`INSERT INTO control_planner_needs_you_items(id,tenant_id,project_id,
        request_key,reason_code,failure_count,raised_by_identity_id,raised_at,owner_request_digest)
        VALUES('planner-needs-you:' || substring(md5($1 || '/' || $2 || '/forged-reason-0003') from 1 for 32),
          $1,$2,'forged-reason-0003','planner_no_longer_relevant',2,'identity:orch-agent',$3,$4)`,
      [scope.tenantId, scope.projectId, LATER, sha256Digest({ ownerRequest: description })]),
      /check constraint|planner needs-you insert rejected/u,
      "any other reason code is refused by the column's own CHECK");
      // The count is 2, not 1: the scope-membership assertion above ADDED a
      // legitimate row of its own, on purpose, as the control for the refused one.
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 2,
        "none of the three forged raises left a row, and the membership control's own row is the other one");
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
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 2,
        "both legitimate rows survived every refused mutation");
      // The web login may read the escalation ledger's view and nothing else.
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const seen = await web.query<{ request_key: string; reason_code: string; failure_count: string }>(
          "SELECT request_key, reason_code, failure_count FROM control_planner_open_needs_you WHERE tenant_id=$1",
        [scope.tenantId]);
        // TWO, not one: the round-2 raise, plus the scope-membership control's own
        // legitimate row. Both are real escalations of a live counter at 2.
        assert.equal(seen.rowCount, 2);
        for (const row of seen.rows) assert.equal(row.reason_code, "orchestrator_failed_twice");
        await assert.rejects(web.query("UPDATE control_planner_failure_counters SET failure_count=0"),
          /permission denied/u, "the owner must not be able to clear the coordinator's counter");
        await assert.rejects(web.query("INSERT INTO control_planner_needs_you_items(id,tenant_id,project_id,request_key,reason_code,failure_count,raised_by_identity_id,raised_at) SELECT 'planner-needs-you:0000000000000000000000000000000a',tenant_id,project_id,'forged-request-key','orchestrator_failed_twice',9,raised_by_identity_id,raised_at FROM control_planner_needs_you_items LIMIT 1"),
        /permission denied/u, "the owner must not be able to raise an escalation");
      } finally { await web.end(); }
    } finally { await coordinator.end(); await admin.end(); }
  }, { port: PORT + 6, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("one description gives one Needs-you item however many times it is pressed, and the owner can ask for one retry", async t => {
  // N-B3, both halves, against the real coordinator and the real stores.
  //
  // HALF ONE, the flood. The ledger's identity used to be the request key, and
  // the browser mints a fresh `orchestrator:<uuid>` key on every press, so six
  // presses of ONE description against a broken planner produced FIVE Needs-you
  // rows and FIVE open inbox items. The identity is now the scope that actually
  // escalated -- (project, description) -- so any number of presses converge on
  // one row and one inbox entry.
  //
  // HALF TWO, the lockout. `count(scope) >= 2` was checked BEFORE the planner, and
  // the only thing that ever cleared the counter was a success on the same
  // description -- which could never happen, because the description was refused
  // before the planner ran. Nothing else touched the counter, so a description
  // that hit one transient fault was dead in that project for good, and the copy
  // the owner saw ("try again, or choose another chief of staff") named two
  // things that did not work.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const coordinator = new Client(postgres.connection("coordinator")); await coordinator.connect();
    const web = new Client(postgres.connection("web")); await web.connect();
    try {
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope, "");
      const db = database(coordinator), scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });
      const failures = new PostgresIntakePlannerFailureStoreV1(db, scopeOf, () => LATER);
      const needsYou = new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:orch-agent" }), () => LATER);
      // The retry store runs on the OWNER'S WEB LOGIN, not the coordinator's, and
      // that is the product's authority rather than a test convenience: after
      // round 4's REVOKE the only login holding EXECUTE on
      // `control_room_planner_grant_owner_retry` is `control_room_private_web`. A
      // store built on the coordinator pool fails 42501 here, which is the property
      // worth keeping.
      const retry = new PostgresIntakeOwnerRetryStoreV1(database(web));
      const description = "Make the release notes match the shipped behaviour.";
      const projectScope = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description);

      // THE FAILURE THAT ESCALATES, twice, through the real adapter. A fresh
      // request key on the second press is the case the flood lived in, so it is
      // the case built here rather than a convenient single key.
      assert.equal(await failures.record(projectScope), 1);
      assert.equal(await failures.record(projectScope), 2);
      // SIX PRESSES, a fresh key each -- the measured flood, reproduced.
      for (let press = 0; press < 6; press += 1) {
        await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
          requestKey: `orchestrator:press-${press}`, reasonCode: "orchestrator_failed_twice",
          ownerRequest: description, now: LATER });
      }
      const rows = await admin.query<{ n: string; scope_key: string; request_key: string }>(
        `SELECT count(*)::text AS n, min(scope_key) AS scope_key, min(request_key) AS request_key
         FROM control_planner_needs_you_items WHERE tenant_id=$1`, [scope.tenantId]);
      assert.equal(rows.rows[0]!.n, "1",
        "six presses of ONE description leave ONE Needs-you item, not five");
      assert.equal(rows.rows[0]!.scope_key, projectScope,
        "and it is keyed on the description's own scope");
      assert.equal(rows.rows[0]!.request_key, "orchestrator:press-0",
        "the request key that FIRST escalated is kept as the evidence");
      const inbox = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_action_inbox WHERE kind='failure'");
      assert.equal(inbox.rows[0]!.n, "1", "and one open inbox item, not five");

      // TWO DESCRIPTIONS IN ONE PROJECT ARE STILL TWO ITEMS. The project scope
      // exists to keep one description's failures from escalating another, and
      // the de-duplication must not collapse them into one.
      const second = "Add a migration guide for the orchestrator tables.";
      const secondScope = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, second);
      assert.notEqual(secondScope, projectScope);
      assert.equal(await failures.record(secondScope), 1);
      assert.equal(await failures.record(secondScope), 2);
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:second-description", reasonCode: "orchestrator_failed_twice",
        ownerRequest: second, now: LATER });
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items"))
        .rows[0]!.n, 2, "a different description in the same project is still its own Needs-you item");

      // THE OWNER'S WAY OUT. The grant is refused while the description has NOT
      // escalated, so it cannot be used to pre-authorise a run.
      const neverFailed = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, "Never pressed.");
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:never-0001", ownerRequest: "Never pressed." }), 0,
      "a description that has not escalated has nothing to retry");

      // And the grant is the OWNER's act, on the owner's own login.
      assert.equal(await failures.ownerRetryGranted(projectScope), false,
        "no retry is granted until the owner asks for one");
      const granted = await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:owner-retry-1", ownerRequest: description });
      assert.equal(granted, 1, "the owner's retry is granted for the escalated description");
      assert.equal(await failures.ownerRetryGranted(projectScope), true,
        "and the coordinator can see it, which is what lets the next press run");
      assert.equal(await failures.count(projectScope), 2,
        "the grant does NOT lower the count: the evidence survives");
      // The latch is ONE-SHOT. A second ask before the run is refused, so the
      // gesture cannot be pressed into a run loop.
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:owner-retry-2", ownerRequest: description }), 0,
      "a retry is granted once, not once per press");

      // THE BOUND THAT MAKES IT NOT A LOOP. The run the grant authorised consumes
      // it through the ordinary clear, and a cleared counter carries no latch --
      // so a third failure after that is a NEW escalation, not a free run.
      await failures.clear(projectScope);
      assert.equal(await failures.count(projectScope), 0);
      assert.equal(await failures.ownerRetryGranted(projectScope), false,
        "the grant is spent by the run it authorised");
      assert.equal(await failures.record(projectScope), 1);
      assert.equal(await failures.ownerRetryGranted(projectScope), false,
        "and a new failure does not inherit the spent grant");
      assert.equal(await failures.record(projectScope), 2);
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:owner-retry-3", ownerRequest: description }), 1,
      "a new escalation earns a new retry");

      // THE GRANT IS NOT A WAY TO CLEAR A COUNTER. The owner's web login holds no
      // privilege on the table itself, and 0205's function refuses anything that
      // is not a live counter at >= 2, so neither the login nor the function can
      // lower a count or reach a counter outside the caller's own scopes.
      await assert.rejects(web.query("UPDATE control_planner_failure_counters SET failure_count=0"),
        /permission denied/u, "the owner web login still holds no UPDATE on the counters");
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:owner-retry-4", ownerRequest: "A description that never failed." }), 0,
      "the function grants only scopes this request computed, and a live counter at 2");
      // The coordinator's own hand-written grant is refused by the trigger, which
      // is the layer the function does not decide. The counter has to EXIST and be
      // below the escalation point, or the UPDATE matches no rows and asserts
      // nothing -- so it is given one real failure first.
      assert.equal(await failures.record(neverFailed), 1);
      await assert.rejects(coordinator.query(
        `UPDATE control_planner_failure_counters SET owner_retry_cleared_at=now(), version=version+1,
           updated_at=GREATEST(updated_at, now()) WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, neverFailed]), /planner failure counter update rejected/u,
      "a counter at 1 cannot carry a retry grant: it never escalated");
      // And a hand-written grant that also LOWERED the count is refused on the
      // same statement, so the latch cannot be used to reset a live failure.
      const live = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, "Two live failures.");
      assert.equal(await failures.record(live), 1);
      assert.equal(await failures.record(live), 2);
      await assert.rejects(coordinator.query(
        `UPDATE control_planner_failure_counters SET failure_count=0, owner_retry_cleared_at=now(),
           version=version+1, updated_at=GREATEST(updated_at, now())
         WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, live]), /planner failure counter update rejected/u,
      "a retry grant cannot lower the count it is stamped on");
      // A CLEAR on an unlatched counter is the ordinary admitted transition, and
      // it is asserted here so the two are not confused: the guard refuses a
      // GRANT that lowers the count, not a clear.
      await coordinator.query(
        `UPDATE control_planner_failure_counters SET failure_count=0, cleared_at=now(), version=version+1,
           updated_at=GREATEST(updated_at, now()) WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, live]);
      assert.equal(await failures.count(live), 0);
      // A clear that CARRIES A LATCH FORWARD is refused, which is what makes the
      // latch a one-shot rather than a standing permission: the run it authorised
      // spends it, and only the store's own clear -- which names the column -- can
      // do that.
      const spent = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, "Latched then cleared.");
      assert.equal(await failures.record(spent), 1);
      assert.equal(await failures.record(spent), 2);
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:owner-retry-5", ownerRequest: "Latched then cleared." }), 1);
      await assert.rejects(coordinator.query(
        `UPDATE control_planner_failure_counters SET failure_count=0, cleared_at=now(), version=version+1,
           updated_at=GREATEST(updated_at, now()) WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, spent]), /planner failure counter update rejected/u,
      "clearing a counter while leaving the latch set is refused, so the latch is spent only by naming it");
      // The store's own clear names the column, so it is the one that works.
      await failures.clear(spent);
      assert.equal(await failures.count(spent), 0);
      assert.equal(await failures.ownerRetryGranted(spent), false,
        "and the latch is gone: the grant cannot authorise a second run");

      // THE SPEND (R5-B1/R5-M1): it removes the latch and NOTHING ELSE, so the
      // description stays escalated while the granted run is in flight. Round 4's
      // spend zeroed the count and stamped `cleared_at`, which is the state every
      // peer read as "not escalated" -- and the state a success also leaves, which
      // is what `open()` could not tell apart.
      const inFlight = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, "Spent, still escalated.");
      assert.equal(await failures.record(inFlight), 1);
      assert.equal(await failures.record(inFlight), 2);
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:owner-retry-6", ownerRequest: "Spent, still escalated." }), 1);
      // An increment CARRIES the latch: counting a failure does not spend it.
      assert.equal(await failures.record(inFlight), 3);
      assert.equal(await failures.ownerRetryGranted(inFlight), true, "an increment keeps the owner's retry");
      // ...and an increment that tries to DROP it is refused, so a counted failure
      // cannot silently discard the owner's retry (round 4's guard let it).
      await assert.rejects(coordinator.query(
        `UPDATE control_planner_failure_counters SET failure_count=failure_count+1, last_failure_at=now(),
           owner_retry_cleared_at=NULL, version=version+1, updated_at=GREATEST(updated_at, now())
         WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, inFlight]), /planner failure counter update rejected/u,
      "an increment may not drop a latch");
      // A spend that ALSO lowers the count is refused: that is round 4's shape.
      await assert.rejects(coordinator.query(
        `UPDATE control_planner_failure_counters SET failure_count=1, owner_retry_cleared_at=NULL,
           version=version+1, updated_at=GREATEST(updated_at, now())
         WHERE tenant_id=$1 AND project_id=$2 AND scope_key=$3`,
      [scope.tenantId, scope.projectId, inFlight]), /planner failure counter update rejected/u,
      "a spend may not lower the count");
      assert.equal(await failures.spendOwnerRetry(inFlight), true, "the store's spend is admitted");
      assert.equal(await failures.spendOwnerRetry(inFlight), false, "once");
      const afterSpend = await admin.query<{ failure_count: string; latched: boolean; cleared: boolean }>(
        `SELECT failure_count::text, owner_retry_cleared_at IS NOT NULL AS latched, cleared_at IS NOT NULL AS cleared
           FROM control_planner_failure_counters WHERE scope_key=$1`, [inFlight]);
      assert.deepEqual(afterSpend.rows[0], { failure_count: "3", latched: false, cleared: false },
        "after the spend the counter is still live at 3: still escalated, latch spent");
      // The granted run's SUCCESS is the store's ordinary clear, and it matches --
      // round 4's clear matched nothing here, because the spend had already zeroed
      // the count, and that row then looked like a retry still being spent forever.
      await failures.clear(inFlight);
      assert.equal(await failures.count(inFlight), 0, "the granted run's success clears the counter");

      // R5-B1: THE RAISE RESOLVES ONLY WHEN AN ITEM STANDS, because the owner is
      // told "it has raised an item for you" on the strength of it.
      const quiet = "Failed once, never escalated.";
      assert.equal(await failures.record(intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, quiet)), 1);
      const itemsBefore = (await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n;
      await assert.rejects(needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:quiet-0001", reasonCode: "orchestrator_failed_twice", ownerRequest: quiet, now: LATER }),
      /planner_needs_you_not_escalated/u, "no escalation and no item: the raise refuses, so no Needs-you is claimed");
      // A description whose escalation a success has just cleared, but whose item
      // was raised: the raise writes nothing and resolves, because the item is real.
      await failures.clear(secondScope);
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:second-after-success", reasonCode: "orchestrator_failed_twice",
        ownerRequest: second, now: LATER });
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n,
        itemsBefore, "and it writes no second item");

      // N9: a `resplit` raise is now accepted. 0204 recomputed only the
      // `initial` project scope, so a re-split escalation passed the adapter's own
      // check and was then refused by the trigger -- measured as "planner
      // needs-you insert rejected" on a raise whose counter was at 2. The
      // application accepts both kinds (plannerNeedsYouScopeKeysV1), so the guard
      // does too.
      // A resplit raise with NO initial counter at all, so the only scope that can
      // license it is the resplit one. That isolates N9: on the round-2 tree the
      // guard recomputed only the `initial` project scope, so this raise passed the
      // adapter's own check and was then refused by the trigger -- measured as
      // "planner needs-you insert rejected" -- and the re-split path could never
      // escalate anything.
      const resplitOnly = "Re-split this batch along the storage boundary.";
      const resplitScope = intakeProjectScopeV1("resplit", scope.tenantId, scope.projectId, resplitOnly);
      const resplitRequest = intakeRequestScopeV1("resplit", scope.tenantId, scope.projectId, "orchestrator:resplit-0001");
      assert.equal(await failures.count(resplitScope), 0, "precondition: no counter for this resplit description");
      assert.equal(await failures.record(resplitScope), 1);
      assert.equal(await failures.record(resplitScope), 2);
      await needsYou.raise({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "orchestrator:resplit-0001", reasonCode: "orchestrator_failed_twice",
        ownerRequest: resplitOnly, now: LATER });
      assert.equal((await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_planner_needs_you_items WHERE scope_key=$1",
      [resplitScope])).rows[0]!.n, "1",
      "a resplit raise is accepted: the guard recomputes the resplit project scope too");
      assert.notEqual(resplitScope, resplitRequest);

      // The owner can find the item by the scope that escalated, and the view is
      // a security barrier like every other one 0205 touches.
      const seen = await web.query<{ scope_key: string }>(
        "SELECT scope_key FROM control_planner_open_needs_you WHERE tenant_id=$1 AND project_id=$2 ORDER BY scope_key",
      [scope.tenantId, scope.projectId]);
      // The exact set, not a count: a count cannot tell "one per description" from
      // "one per press, with the right total by luck", and that distinction is the
      // whole fix.
      assert.deepEqual(seen.rows.map(row => row.scope_key).sort(),
        [projectScope, secondScope, resplitScope].sort(),
        "one Needs-you row per escalating description scope, and no others");
      const barrier = await admin.query<{ reloptions: string[] | null }>(
        "SELECT reloptions FROM pg_class WHERE relname='control_planner_open_needs_you'");
      assert.deepEqual(barrier.rows[0]!.reloptions, ["security_barrier=true"]);
    } finally { await web.end(); await coordinator.end(); await admin.end(); }
  }, { port: PORT + 7, allowedPorts: ALLOWED, boundMs: 240_000 });
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

test("ONE owner grant is ONE run under 20 and 50 concurrent presses, and the description lives on afterwards (R4-M1, R5-B1, R5-M1, R5-M2)", async t => {
  // WHAT WAS MEASURED, round by round, on the real coordinator over the real stores:
  //
  //   round 3: one grant + 20 presses -> 20 runs (every press read the latch).
  //   round 4: the spend made atomic, but it ZEROED the count, so every peer that
  //            read the counter after it ran: up to 20 runs from 20 presses and
  //            about 30 from 50 (R5-M1). An `open()` read held them, and it read a
  //            field a SUCCESS sets too -- so after any failure-then-success the
  //            description was refused forever, with a Needs-you message whose
  //            item was never raised (R5-B1).
  //
  // Now the spend removes the latch and nothing else, so the counter stays at 2 or
  // more while the granted run is in flight and every peer is refused by it. This
  // test pins all of it at once, for N=20 and N=50 and for a planner that is still
  // broken and one that is fixed:
  //
  //   * exactly ONE planner run per grant;
  //   * every other press is `needs_you`, never a throw, and an item EXISTS;
  //   * afterwards the description is alive: a fixed planner's next press runs, a
  //     broken one's owner can grant again (round 4 granted 0 in both).
  //
  // THE GATE. The granted run's planner is held until every other press has
  // answered, so "concurrent" means what it says: each peer is decided while the
  // granted run is in flight. Without it, a peer that the connection pool delays
  // until after a SUCCESS is a new request on an ordinary description, and running
  // it is correct (a never-failed description runs every press, too) -- so an
  // ungated run count with a working planner measures the pool, not the grant. The
  // broken planner needs no gate: its description never stops being escalated, so
  // it is also run ungated and staggered below, and must still be exactly one run.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    // Twenty-five coordinator connections shared by up to fifty presses: the
    // cluster allows sixty, and a pool is what the product composes. Every
    // statement is its own round trip, so presses interleave between statements,
    // which is where the race lives.
    const pool = new Pool({ ...postgres.connection("coordinator"), max: 25 });
    const ownerLogin = new Client(postgres.connection("web"));
    try {
      await ownerLogin.connect();
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope, "");
      const db = poolDatabase(pool);
      const agent = { tenantId: scope.tenantId, identityId: "identity:orch-agent", actorType: "agent" as const,
        authenticatedAt: NOW, expiresAt: LATER };
      const scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });
      let batch = 0;
      const build = (planner: IntakePlannerPortV1) => new IntakeCoordinatorV1({ read: () => ({ workerId: "worker:chief",
        workerKind: "codex" as const, modelKey: "model:plan", effort: "high" as const }) }, planner,
      { async consume() { return Object.freeze({ allowed: true as const }); } },
      new PostgresIntakePlannerFailureStoreV1(db, scopeOf, () => LATER),
      new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:orch-agent" }), () => LATER),
      { async authorizeBeforeBody() { return Object.freeze({ allowed: true as const, workspaceId: scope.workspaceId,
          lifecycle: "active" as string | undefined }); },
        async submit() {
          // A receipt of the REAL schema shape, not a hand-written partial object:
          // the coordinator returns it straight to the owner.
          batch += 1;
          return Object.freeze({ schema: "control-room.work-batch-receipt/v1" as const,
            batchId: `batch:wave-${batch}`, projectId: scope.projectId, state: "proposed" as const,
            proposalDigest: workBatchProposalDigestV1(proposal(1)), revision: 1 as const, replayed: false,
            startsWork: false as const, grantsExecutionAuthority: false as const });
        } },
      { async append() { throw new Error("the suggestion store was reached, which an initial request cannot do"); },
        prefillForOwner() { throw new Error("not used"); } },
      [{ workerId: "worker:chief", workerKind: "codex" as const, nodeId: "node:chief",
        modelPolicy: { models: ["model:plan"], defaultModel: "model:plan",
          efforts: ["high" as const], defaultEffort: "high" as const } }], ["code.change"]);
      const reply = (working: boolean) => { if (!working) throw new Error("planner down");
        return { replyText: JSON.stringify(proposal(1)) }; };
      const plain = (working: boolean) => build({ async run() { return reply(working); } });
      const press = (coordinator: IntakeCoordinatorV1, description: string) => coordinator.coordinateInitial({
        principal: agent, projectId: scope.projectId, ownerRequest: description,
        idempotencyKey: `orchestrator:${randomUUID()}`, now: LATER })
        .then(result => result.status as string, error => `threw:${String((error as Error).message).slice(0, 80)}`);
      const grant = (description: string) => new PostgresIntakeOwnerRetryStoreV1(database(ownerLogin)).grant({
        tenantId: scope.tenantId, projectId: scope.projectId, requestKey: `orchestrator:grant-${randomUUID()}`,
        ownerRequest: description });
      const counter = async (description: string) => (await admin.query<{ failure_count: string;
        latched: boolean; cleared: boolean }>(`SELECT failure_count::text, owner_retry_cleared_at IS NOT NULL AS latched,
          cleared_at IS NOT NULL AS cleared FROM control_planner_failure_counters WHERE scope_key=$1`,
      [intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description)])).rows[0];
      const items = async (description: string) => Number((await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_planner_needs_you_items WHERE scope_key=$1",
      [intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description)])).rows[0]!.n);
      const tally = (outcomes: readonly string[]) => outcomes.reduce<Record<string, number>>((acc, status) => {
        acc[status] = (acc[status] ?? 0) + 1; return acc; }, {});
      // Two failures and one grant: the state every wave starts from.
      const escalateAndGrant = async (description: string) => {
        assert.equal(await press(plain(false), description), "planner_failed");
        assert.equal(await press(plain(false), description), "needs_you");
        assert.equal(await items(description), 1, "the escalation raised its item");
        assert.ok(await grant(description) >= 1, "the owner's grant is accepted");
      };

      for (const n of [20, 50]) for (const working of [false, true]) {
        const description = `One grant, ${n} gated presses, planner ${working ? "working" : "broken"}.`;
        await escalateAndGrant(description);
        let runs = 0, answered = 0, timedOut = false;
        let release!: () => void;
        const othersAnswered = new Promise<void>(resolve => { release = resolve; });
        const gated = build({ async run() {
          runs += 1;
          if (runs === 1) await Promise.race([othersAnswered,
            new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, 60_000))]);
          return reply(working);
        } });
        const outcomes = await Promise.all(Array.from({ length: n }, () => press(gated, description).then(status => {
          answered += 1; if (answered === n - 1) release(); return status; })));
        const after = await counter(description);
        const label = `N=${n} planner=${working ? "working" : "broken"} ${JSON.stringify(tally(outcomes))} `
          + `counter=${JSON.stringify(after)}`;
        assert.equal(timedOut, false, `every other press answered while the granted run was held: ${label}`);
        assert.equal(runs, 1, `one owner grant must be exactly one run: ${label}`);
        assert.equal(outcomes.filter(status => status.startsWith("threw")).length, 0, `no press may throw: ${label}`);
        assert.equal(outcomes.filter(status => status === "needs_you").length, working ? n - 1 : n,
          `every press that did not run, and a granted run that failed, is needs_you: ${label}`);
        assert.equal(outcomes.filter(status => status === "submitted").length, working ? 1 : 0, label);
        assert.equal(await items(description), 1,
          `every needs_you answer has its item, and it is still ONE item: ${label}`);
        if (working) {
          assert.deepEqual(after, { failure_count: "0", latched: false, cleared: true },
            `the granted success cleared the counter: ${label}`);
          // R5-B1, the case round 4 locked forever.
          assert.equal(await press(plain(true), description), "submitted",
            `the same description runs again after the granted success: ${label}`);
          assert.equal(await grant(description), 0, "and there is nothing to retry, which is true");
          assert.equal(await press(plain(true), description), "submitted",
            "so 'nothing to retry, press Prepare proposal' sends the owner to a press that runs");
        } else {
          assert.deepEqual(after, { failure_count: "3", latched: false, cleared: false },
            `the granted run's failure kept the description escalated, with the grant spent: ${label}`);
          assert.equal(await press(plain(true), description), "needs_you",
            "a press after the failed retry is refused without a run: the owner is asked again");
          assert.equal(await grant(description), 1, `the owner CAN ask again (round 4 granted 0): ${label}`);
          assert.equal(await press(plain(true), description), "submitted", "and that grant's run can succeed");
          assert.equal(await press(plain(true), description), "submitted", "after which the description is ordinary");
        }
      }

      // UNGATED and STAGGERED, broken planner: the description never stops being
      // escalated, so however the presses arrive the grant is still one run. The
      // staggered shape is R5-M2's: 50 presses 40 ms apart over 2 s against a planner
      // that takes 150 ms, which measured FIVE runs from one grant on round 4's tree.
      for (const shape of ["ungated", "staggered"] as const) {
        const description = `One grant, 50 ${shape} presses, planner broken.`;
        await escalateAndGrant(description);
        let runs = 0;
        const slow = build({ async run() { runs += 1; await new Promise(resolve => setTimeout(resolve, 150));
          return reply(false); } });
        const outcomes = await Promise.all(Array.from({ length: 50 }, (_, index) =>
          new Promise(resolve => setTimeout(resolve, shape === "staggered" ? index * 40 : 0))
            .then(() => press(slow, description))));
        const label = `${shape}: ${JSON.stringify(tally(outcomes))} counter=${JSON.stringify(await counter(description))}`;
        assert.equal(runs, 1, `one grant, one run, ${label}`);
        assert.deepEqual([...new Set(outcomes)], ["needs_you"], `every press is needs_you, ${label}`);
        assert.equal(await items(description), 1, label);
      }
    } finally { await ownerLogin.end().catch(() => {}); await pool.end(); await admin.end(); }
  }, { port: PORT + 9, allowedPorts: ALLOWED, boundMs: 420_000 });
});

test("R5-B1 on real logins: after a failure then a success, or any owner retry, the same description runs again", async t => {
  // The review's own liveness probe (Q2), as assertions. On round 4's tree every
  // "again" below was needs_you with 0 runs, the owner's grant returned 0, and
  // there were 0 Needs-you items and 0 open inbox entries behind those messages.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const coordinatorClient = new Client(postgres.connection("coordinator"));
    const ownerLogin = new Client(postgres.connection("web"));
    try {
      await coordinatorClient.connect(); await ownerLogin.connect();
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope, "");
      const db = database(coordinatorClient);
      const scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });
      const agent = { tenantId: scope.tenantId, identityId: "identity:orch-agent", actorType: "agent" as const,
        authenticatedAt: NOW, expiresAt: LATER };
      let broken = false, allowanceWired = true, runs = 0, batch = 0;
      // The production allowance adapter is still unwired (S7b), and L3 is exactly
      // what it does to a granted retry, so L3 uses the REAL refusing adapter.
      const unwired = new UnwiredPlannerAllowanceV1();
      const coordinator = new IntakeCoordinatorV1({ read: () => ({ workerId: "worker:chief",
        workerKind: "codex" as const, modelKey: "model:plan", effort: "high" as const }) },
      { async run() { runs += 1; if (broken) return { replyText: "not json" };
        return { replyText: JSON.stringify(proposal(1)) }; } },
      { async consume(input) { return allowanceWired ? Object.freeze({ allowed: true as const }) : unwired.consume(input); } },
      new PostgresIntakePlannerFailureStoreV1(db, scopeOf, () => LATER),
      new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:orch-agent" }), () => LATER),
      { async authorizeBeforeBody() { return Object.freeze({ allowed: true as const, workspaceId: scope.workspaceId,
          lifecycle: "active" as string | undefined }); },
        async submit() { batch += 1;
          return Object.freeze({ schema: "control-room.work-batch-receipt/v1" as const,
            batchId: `batch:live-${batch}`, projectId: scope.projectId, state: "proposed" as const,
            proposalDigest: workBatchProposalDigestV1(proposal(1)), revision: 1 as const, replayed: false,
            startsWork: false as const, grantsExecutionAuthority: false as const }); } },
      { async append() { throw new Error("not reached"); }, prefillForOwner() { throw new Error("not used"); } },
      [{ workerId: "worker:chief", workerKind: "codex" as const, nodeId: "node:chief",
        modelPolicy: { models: ["model:plan"], defaultModel: "model:plan",
          efforts: ["high" as const], defaultEffort: "high" as const } }], ["code.change"]);
      const press = async (description: string, key = `orchestrator:${randomUUID()}`) => {
        const before = runs;
        const result = await coordinator.coordinateInitial({ principal: agent, projectId: scope.projectId,
          ownerRequest: description, idempotencyKey: key, now: LATER });
        return `${result.status}${result.status === "refused" || result.status === "allowance_refused"
          ? `:${result.reasonCode}` : ""} runs+${runs - before}`;
      };
      const grant = (description: string) => new PostgresIntakeOwnerRetryStoreV1(database(ownerLogin)).grant({
        tenantId: scope.tenantId, projectId: scope.projectId, requestKey: `orchestrator:grant-${randomUUID()}`,
        ownerRequest: description });
      const itemsFor = async (description: string) => Number((await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_planner_needs_you_items WHERE scope_key=$1",
      [intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description)])).rows[0]!.n);

      // L0, control: never failed.
      assert.equal(await press("L0 never failed"), "submitted runs+1");
      assert.equal(await press("L0 never failed"), "submitted runs+1");

      // L1: one transient failure, then success, then the same request again.
      broken = true; assert.equal(await press("L1 one transient failure"), "refused:content_invalid runs+1");
      broken = false; assert.equal(await press("L1 one transient failure"), "submitted runs+1");
      for (let i = 0; i < 3; i += 1)
        assert.equal(await press("L1 one transient failure"), "submitted runs+1", `L1 again #${i + 1} must run`);
      assert.equal(await grant("L1 one transient failure"), 0, "L1: nothing to retry, and Prepare runs (above)");

      // L2: escalate, the owner grants, the granted retry succeeds, then again.
      broken = true;
      assert.equal(await press("L2 escalated then recovered"), "refused:content_invalid runs+1");
      assert.equal(await press("L2 escalated then recovered"), "needs_you runs+1");
      assert.equal(await itemsFor("L2 escalated then recovered"), 1, "the needs_you answer has its item");
      assert.equal(await press("L2 escalated then recovered"), "needs_you runs+0");
      assert.equal(await grant("L2 escalated then recovered"), 1);
      broken = false; assert.equal(await press("L2 escalated then recovered"), "submitted runs+1");
      assert.equal(await press("L2 escalated then recovered"), "submitted runs+1", "L2: the press after a granted success runs");
      assert.equal(await grant("L2 escalated then recovered"), 0);
      assert.equal(await press("L2 escalated then recovered"), "submitted runs+1");

      // L3: the granted retry is spent by the (real, unwired) allowance refusal.
      broken = true;
      assert.equal(await press("L3 allowance spent the retry"), "refused:content_invalid runs+1");
      assert.equal(await press("L3 allowance spent the retry"), "needs_you runs+1");
      assert.equal(await grant("L3 allowance spent the retry"), 1);
      broken = false; allowanceWired = false;
      assert.equal(await press("L3 allowance spent the retry"),
        "allowance_refused:planner_allowance_not_configured runs+0");
      allowanceWired = true;
      assert.equal(await press("L3 allowance spent the retry"), "needs_you runs+0",
        "the description is still escalated: the retry was spent without a run");
      assert.equal(await itemsFor("L3 allowance spent the retry"), 1, "and that needs_you has its item");
      assert.equal(await grant("L3 allowance spent the retry"), 1, "L3: the owner can ask again (round 4: 0)");
      assert.equal(await press("L3 allowance spent the retry"), "submitted runs+1");
      assert.equal(await press("L3 allowance spent the retry"), "submitted runs+1");

      // L4: a failure, the same key succeeding, then a fresh key.
      const key = `orchestrator:${randomUUID()}`;
      broken = true; assert.equal(await press("L4 same key retry", key), "refused:content_invalid runs+1");
      broken = false; assert.equal(await press("L4 same key retry", key), "submitted runs+1");
      assert.equal(await press("L4 same key retry"), "submitted runs+1", "L4: a fresh key after the success runs");

      // EVERY open inbox entry has a Needs-you item behind it, and vice versa.
      const ledger = await admin.query<{ items: string; inbox: string }>(
        `SELECT (SELECT count(*) FROM control_planner_needs_you_items WHERE tenant_id=$1)::text AS items,
                (SELECT count(*) FROM control_action_inbox WHERE tenant_id=$1 AND kind='failure')::text AS inbox`,
      [scope.tenantId]);
      assert.deepEqual(ledger.rows[0], { items: "2", inbox: "2" },
        "two descriptions escalated (L2, L3), so two items and two inbox entries, and no others");
    } finally { await coordinatorClient.end().catch(() => {}); await ownerLogin.end().catch(() => {}); await admin.end(); }
  }, { port: PORT + 8, allowedPorts: ALLOWED, boundMs: 240_000 });
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


test("the REAL coordinator spends a granted latch through the real store, and a failed retry asks the owner again", async t => {
  // The end-to-end half of the retry, and the part no double can prove: the
  // coordinator reads the latch, SPENDS it by clearing, and only then runs. The
  // unit lane proves the rule and the store lane proves the SQL; this proves the
  // two are wired to each other, which is where a "the coordinator never calls
  // clear" bug would live and neither of the other two would see it.
  //
  // The shape that must hold, end to end on real logins:
  //   2 failures -> escalation -> press is refused, no run
  //   owner grants a retry -> press runs the planner ONCE
  //   that run FAILS -> the description is STILL escalated (count 3: the spend
  //     never lowered it), the press answers needs_you, and the description's one
  //     Needs-you item is re-used rather than duplicated
  //   the latch is gone, so the next press is refused again without a run
  //   and the owner can ask again, which is the only way on (round 4 restarted
  //     the count at 1 instead, handing the next press a free run)
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const coordinatorClient = new Client(postgres.connection("coordinator")); await coordinatorClient.connect();
    // On the OWNER'S WEB LOGIN, not the coordinator's: after round 4's REVOKE that
    // is the only login holding EXECUTE on
    // `control_room_planner_grant_owner_retry`. Everything else in this test runs on
    // the coordinator, which is the point of the test -- the grant is the OWNER's
    // act and the spend is the COORDINATOR's, and they are different authorities
    // precisely because they are different logins.
    //
    // Declared BESIDE the other clients rather than inside the try, so the finally
    // below can close it unconditionally. A client still open when the harness stops
    // the cluster surfaces as an uncaught 57P01 on an idle socket, which reads as a
    // product fault and is a leaked handle.
    const ownerLogin = new Client(postgres.connection("web"));
    try {
      await ownerLogin.connect();
      await seedTenant(admin, scope, { withBinding: true });
      await seedIdentities(admin, scope, "");
      const db = database(coordinatorClient);
      const scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });
      const failures = new PostgresIntakePlannerFailureStoreV1(db, scopeOf, () => LATER);
      const needsYou = new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:orch-agent" }), () => LATER);
      const retry = new PostgresIntakeOwnerRetryStoreV1(database(ownerLogin));
      const description = "Reconcile the digest helper with the ledger writer.";
      const projectScope = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description);

      let runs = 0;
      // The planner double is broken, and stays broken: the point is that the
      // GRANTED run also fails, so the retry's outcome is a new escalation rather
      // than a recovery. A double that started working would prove nothing about
      // the latch.
      const reply = () => { throw new Error("planner down"); };
      const agent = { tenantId: scope.tenantId, identityId: "identity:orch-agent", actorType: "agent" as const,
        authenticatedAt: NOW, expiresAt: LATER };
      // The coordinator is the real one, over the real stores. The selection is
      // 0201's shape read through the port, and the submission and suggestion
      // stores throw rather than returning, because a broken planner never reaches
      // them -- if one of them is ever called, the test fails loudly instead of
      // quietly passing on a path that was never taken.
      const coordinator = new IntakeCoordinatorV1({ read: () => ({ workerId: "worker:chief",
        workerKind: "codex" as const, modelKey: "model:plan", effort: "high" as const }) },
      { async run() { runs += 1; return { replyText: reply() }; } },
      { async consume() { return Object.freeze({ allowed: true as const }); } },
      failures, needsYou, { async authorizeBeforeBody() {
        return Object.freeze({ allowed: true as const, workspaceId: scope.workspaceId,
          lifecycle: "active" as string | undefined }); },
        async submit() { throw new Error("the submission store was reached, which a broken planner cannot do"); } },
      { async append() { throw new Error("the suggestion store was reached, which a broken planner cannot do"); },
        prefillForOwner() { throw new Error("not used"); } },
      [{ workerId: "worker:chief", workerKind: "codex" as const, nodeId: "node:chief",
        modelPolicy: { models: ["model:plan"], defaultModel: "model:plan",
          efforts: ["high" as const], defaultEffort: "high" as const } }],
      ["code.change"]);

      // TWO FAILURES, through the real coordinator, each with a fresh key.
      assert.equal((await coordinator.coordinateInitial({ principal: agent, projectId: scope.projectId,
        ownerRequest: description, idempotencyKey: "e2e-fail-0001", now: LATER })).status, "planner_failed");
      assert.equal((await coordinator.coordinateInitial({ principal: agent, projectId: scope.projectId,
        ownerRequest: description, idempotencyKey: "e2e-fail-0002", now: LATER })).status, "needs_you");
      assert.equal(runs, 2);
      const itemsNow = (await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n;
      assert.equal(itemsNow, 1, "one Needs-you item for the description");

      // THE ESCALATION IS A WALL, and no run is spent against it.
      assert.equal((await coordinator.coordinateInitial({ principal: agent, projectId: scope.projectId,
        ownerRequest: description, idempotencyKey: "e2e-fail-0003", now: LATER })).status, "needs_you");
      assert.equal(runs, 2, "the refused press spent no run");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1,
        "and no second item");

      // THE OWNER ASKS, and the very next press runs the planner.
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "e2e-retry-0001", ownerRequest: description }), 1);
      const granted = await coordinator.coordinateInitial({ principal: agent, projectId: scope.projectId,
        ownerRequest: description, idempotencyKey: "e2e-retry-0002", now: LATER });
      assert.equal(runs, 3, "the granted press ran the planner exactly once");
      assert.equal(granted.status, "needs_you",
        "the granted run FAILED, and the description is still escalated, so the owner is asked again at once");
      // ...because the spend removed the latch and left the count, and the
      // failure then counted on top of it.
      const live = await admin.query<{ failure_count: string; owner_retry_cleared_at: string | null }>(
        "SELECT failure_count::text, owner_retry_cleared_at FROM control_planner_failure_counters WHERE scope_key=$1",
      [projectScope]);
      assert.equal(live.rows[0]!.owner_retry_cleared_at, null, "the latch is spent by the run it authorised");
      assert.equal(live.rows[0]!.failure_count, "3",
        "a failed retry is a THIRD failure: the evidence is kept, and the description stays escalated");
      // And the description's scope still holds exactly ONE item, which is what the
      // needs_you answer above names.
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM control_planner_needs_you_items")).rows[0]!.n, 1,
        "the failed retry re-uses the description's one item rather than adding another");
      // The next press costs no run: one grant bought one run.
      assert.equal((await coordinator.coordinateInitial({ principal: agent, projectId: scope.projectId,
        ownerRequest: description, idempotencyKey: "e2e-retry-0003", now: LATER })).status, "needs_you");
      assert.equal(runs, 3, "the press after a failed retry spends no run");
      // The owner can ask again -- and only once per escalation-and-grant.
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "e2e-retry-0004", ownerRequest: description }), 1,
      "the description is still escalated, so the owner's next ask is accepted");
      assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
        requestKey: "e2e-retry-0005", ownerRequest: description }), 0,
      "and a second ask before that run is refused");
    // EVERY client is ended here, including the owner's web login. The harness's
    // shutdown ladder stops the cluster when the body returns, and a connection
    // still open at that moment surfaces as an uncaught 57P01 on an idle socket --
    // which reads as a product fault and is a leaked handle. Closing the extra
    // client explicitly is what keeps this test's teardown honest; it was the
    // difference between this test passing and failing after round 4's REVOKE moved
    // the grant onto that login.
    } finally { await coordinatorClient.end(); await ownerLogin.end().catch(() => {}); await admin.end(); }
  }, { port: PORT + 4, allowedPorts: ALLOWED, boundMs: 240_000 });
});
