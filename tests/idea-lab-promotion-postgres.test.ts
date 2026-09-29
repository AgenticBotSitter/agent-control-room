// Real-PostgreSQL production-role proof for the Idea Lab promotion link.
//
// The first version of this file hand-rolled `INSERT INTO control_requests ...
// '{}'::jsonb` as fixture setup. That is not a legal `control_requests` row:
// the canonical payload mirror trigger (0004_cr4b_review_hardening) requires
// payload.version/id/tenantId/state/projectId/idempotencyKey to mirror the
// indexed columns, so the setup itself was refused with
// "canonical payload mirror mismatch on control_requests". The trigger is
// correct and stays. The fix is to stop inventing canonical rows: this file
// now seeds only the Idea Lab discussion state as the disposable cluster's
// admin, then drives the REAL production path through the restricted web
// login - WebTaskService.propose, which builds request/workflow/job via
// CanonicalStore.createProposedWorkBundle - exactly as the product does.
//
// Only the disposable cluster's admin connection writes fixture rows; every
// product write below is the production web login.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { buildIdeaLabContributionV1, buildIdeaLabDecisionV1, buildIdeaLabSessionV1,
  buildIdeaLabSynthesisV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IDEA_LAB_PROMOTION_TASK_LINK_V1, IdeaLabPromotionTaskLinkStoreV1 } from "../src/idea-lab/v1/promotion-task-link-store";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

// Reserved disposable-cluster lane for the Idea Lab module: 58970-58979.
const PORT = Number(process.env.IDEA_PROMOTION_PG_PORT ?? 58970);
const PG = requiresRealPostgres();
const NOW = "2026-09-29T15:00:00.000Z";
const LATER = "2026-09-29T16:00:00.000Z";
const KEY = new Uint8Array(32).fill(0x4a);
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const hmac = (character: string) => `hmac-sha256:${character.repeat(64)}`;
const scope = { tenantId: "tenant:idea-pg", workspaceId: "workspace:idea-pg" };
const IDENTITY_ID = "identity:idea-pg";
const identity: VerifiedWebIdentity = { provider: "test", subject: "idea-owner",
  tokenDigest: sha256Digest("idea-web-session"), issuedAt: NOW, expiresAt: LATER, verificationExpiresAt: LATER };

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
    transactionWithPreCommitCheck: async (work, check) => {
      await client.query("BEGIN");
      try { const value = await work(session); await check(); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
  };
}

/** Discussion state only. No canonical request/workflow/job row is invented here:
 * those must come from the production service so the payload mirror holds. */
async function seedDiscussion(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter.control-room-native-ideas',$1,'control_room_native_ideas','1.0.0','control_room_native','online',
    '["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'v1',30)`, [scope.tenantId]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)`,
  [IDENTITY_ID, scope.tenantId, sha256Digest({ provider: "test", subject: identity.subject }), NOW]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:idea-pg',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
  [scope.tenantId, IDENTITY_ID, NOW]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [scope.tenantId, identity.tokenDigest, IDENTITY_ID, NOW, LATER]);

  // Built with the real contract builders so every stored digest is the one
  // the product would have computed, not a repeated-character placeholder.
  // The participant roster is the reviewed shape: distinct identity digests and
  // perspectives, and at least one skeptic, or the session is refused.
  const persona = (label: string) => sha256Digest({ syntheticIdeaLabIdentity: label });
  const session = buildIdeaLabSessionV1({ sessionId: "idea:promotion-pg", tenantId: scope.tenantId,
    workspaceId: scope.workspaceId, title: "Promotion",
    ideaSummary: "Validate a promoted idea cheaply before committing to it.",
    targetCustomer: "One narrow customer segment with a measurable pain.",
    participants: [
      { participantId: "bot:customer", identityDigest: persona("customer"), displayName: "Customer Lens",
        perspective: "customer", harness: "hermes", modelClass: "research", platform: "linux",
        sourceMode: "injected_only", liveConnected: false, canDispatch: false },
      { participantId: "bot:market", identityDigest: persona("market"), displayName: "Market Scout",
        perspective: "market", harness: "hermes", modelClass: "research", platform: "linux",
        sourceMode: "injected_only", liveConnected: false, canDispatch: false },
      { participantId: "bot:skeptic", identityDigest: persona("skeptic"), displayName: "Red Team",
        perspective: "skeptic", harness: "codex", modelClass: "reasoning", platform: "macos",
        sourceMode: "injected_only", liveConnected: false, canDispatch: false },
    ],
    maxRounds: 1, maxDurationSeconds: 600, maxCostUsd: 4,
    createdByIdentityDigest: persona("owner"), createdAt: NOW });
  const contributions = [0, 1, 2].map(index => buildIdeaLabContributionV1(session, {
    participantId: session.participants[index]!.participantId, round: 1,
    safeOpinion: `Participant ${index} sees a narrow, testable opportunity worth a small experiment.`,
    opportunityCode: "narrow_beachhead", primaryRiskCode: "adoption_risk",
    suggestedExperiment: "Run one ten-interview concierge pass.", confidencePercent: 60, contributedAt: NOW }));
  const registry = new IdeaLabProjectRegistryStoreV1(database(admin), KEY);
  const synthesis = buildIdeaLabSynthesisV1(session, contributions, { marketDemand: 70, feasibility: 70, differentiation: 60, durability: 55, ownerFit: 70,
 riskPercent: 40, executiveSummary: "Validate cheaply before committing.",
    nextExperiment: "Run one ten-interview concierge pass.", dissentingPerspectiveCodes: [],
    synthesizedAt: NOW });
  const decision = buildIdeaLabDecisionV1(session, synthesis, contributions, {
    decision: "create_project", safeReasonCode: "owner_promoted_for_validation",
    ownerIdentityDigest: sha256Digest({ tenantId: scope.tenantId, identityId: IDENTITY_ID, purpose: "idea_lab_owner_v1" }),
    project: { projectId: "project:idea-promotion-pg", workspaceName: "Promoted idea", title: "Promoted idea",
      summary: "Validate the smallest useful experiment before any execution.",
      projectKind: "business_validation", priority: 50 }, decidedAt: NOW });

  // The promoted project is written the way the product writes it, including
  // its lifecycle event, so the web project read can rebuild the projection.
  await registry.registerSession(session);
  for (const contribution of contributions) await registry.recordContribution(contribution);
  await registry.recordSynthesis(synthesis);
  await registry.recordDecision(decision);
  return decision;
}

test("Idea promotion creates one canonical proposed task and an append-only link through the production web role",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    const result = await withRealPostgres(async postgres => {
      // The disposable cluster's admin connection stays open for the whole
      // proof: it seeds the discussion and, at the end, forges one row that a
      // least-privilege role could never write. Every product write below is
      // still the restricted web login.
      const adminClient = new Client(postgres.admin()); await adminClient.connect();
      const decision = await seedDiscussion(adminClient);

      const projectId = decision.project!.projectId;
      const webClient = new Client(postgres.connection("web")); await webClient.connect();
      try {
        const web = database(webClient);
        // The production proposal path, exactly as the promotion route calls it.
        const tasks = new WebTaskService(web, scope, () => Date.parse(NOW), { ideaIntegrityKey: KEY });
        const proposed = await tasks.propose(identity, projectId,
          { title: "Run the first validation", instructions: "Run one ten-interview concierge pass." },
          `idea-promotion:${decision.decisionDigest.slice(7)}`);
        assert.equal(proposed.receipt.submission, "proposed");
        assert.equal(proposed.receipt.startsWork, false);

        // The canonical rows really were mirrored: the trigger is what admitted
        // them, and a forged mirror is still refused afterwards.
        const request = (await web.query<{ project_id: string; state: string; idempotency_key: string;
          payload: { version: number; id: string; tenantId: string; state: string; projectId: string; idempotencyKey: string } }>(
          "SELECT project_id,state,idempotency_key,payload FROM control_requests WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, proposed.receipt.requestId])).rows[0];
        assert.equal(request?.state, "draft", "an ordinary proposal request stays in draft");
        assert.equal(request?.payload.version, 0);
        assert.equal(request?.payload.id, proposed.receipt.requestId);
        assert.equal(request?.payload.tenantId, scope.tenantId);
        assert.equal(request?.payload.projectId, projectId);
        assert.equal(request?.payload.idempotencyKey, request?.idempotency_key);
        assert.equal(request?.payload.state, "draft");

        const job = (await web.query<{ state: string; payload: { workflowId: string; projectId: string; authority: { digest: string } } }>(
          "SELECT state,payload FROM control_jobs WHERE tenant_id=$1 AND id=$2",
          [scope.tenantId, proposed.receipt.jobId])).rows[0];
        assert.equal(job?.state, "proposed", "promotion never makes a runnable job");
        assert.equal(job?.payload.projectId, projectId);

        // Promotion assigns, approves, leases and executes nothing.
        assert.equal((await web.query<{ count: string }>("SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1",
          [scope.tenantId])).rows[0]?.count, "0");
        assert.equal((await web.query<{ count: string }>("SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1",
          [scope.tenantId])).rows[0]?.count, "0");

        // The provenance link, written by the same production store the route uses.
        const links = new IdeaLabPromotionTaskLinkStoreV1(web, KEY);
        const input = { contractVersion: IDEA_LAB_PROMOTION_TASK_LINK_V1, tenantId: scope.tenantId,
          sessionId: "idea:promotion-pg", decisionDigest: decision.decisionDigest, projectId,
          jobId: proposed.receipt.jobId, requestId: proposed.receipt.requestId, createdAt: proposed.receipt.createdAt,
          startsWork: false as const, grantsAssignmentAuthority: false as const, grantsApproval: false as const,
          grantsExecutionAuthority: false as const };
        const saved = await links.record(input);
        assert.equal(saved.replayed, false);
        assert.equal(saved.link.jobId, proposed.receipt.jobId);
        assert.deepEqual(await links.get(scope.tenantId, "idea:promotion-pg"), saved.link);
        assert.equal((await links.record(input)).replayed, true, "an exact replay is idempotent");
        await assert.rejects(links.record({ ...input, jobId: `${projectId}-other-job` }));

        // The read-back inside record() must stay lockable by a role that holds
        // only SELECT and INSERT. `FOR SHARE` needs table-level UPDATE, which
        // this append-only provenance table deliberately withholds, so adding a
        // row lock there would break every real promotion at the privilege layer.
        assert.equal((await web.query<{ updatable: boolean }>(
          "SELECT has_table_privilege(current_user,'control_idea_promotion_task_links','UPDATE') AS updatable")).rows[0]?.updatable,
        false, "the web role must not hold UPDATE on append-only promotion provenance");
        assert.equal((await web.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_idea_promotion_task_links WHERE tenant_id=$1 AND session_id=$2",
          [scope.tenantId, "idea:promotion-pg"])).rows[0]?.count, "1");

        // One link, and it is append-only even for the writing role.
        assert.equal((await web.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_idea_promotion_task_links WHERE tenant_id=$1",
          [scope.tenantId])).rows[0]?.count, "1");
        await assert.rejects(web.query("UPDATE control_idea_promotion_task_links SET job_id='job:other' WHERE tenant_id=$1",
          [scope.tenantId]), /permission denied|append only/u);
        await assert.rejects(web.query("DELETE FROM control_idea_promotion_task_links WHERE tenant_id=$1",
          [scope.tenantId]), /permission denied|append only/u);
        await assert.rejects(web.query("TRUNCATE control_idea_promotion_task_links"), /permission denied|append only/u);

        // A whole second promotion for the same project is refused: the decision
        // digest and job id are unique, so provenance cannot fork.
        const second = await tasks.propose(identity, projectId,
          { title: "Run a second validation", instructions: "Try a different angle." }, "idea-promotion-second-0001");
        await assert.rejects(new IdeaLabPromotionTaskLinkStoreV1(web, KEY).record({ ...input,
          jobId: second.receipt.jobId, requestId: second.receipt.requestId, createdAt: second.receipt.createdAt }));

        // Two different integrity guards must each refuse a tampered row.
        // (1) A link that hashes correctly but whose HMAC auth tag was produced
        // with a key the store does not hold: only the tag check can catch it.
        // (2) A link whose columns do not hash to its stored linkDigest: the
        // self-check in parse() must reject it before anything is trusted.
        // Each forged row points at a real ordinary proposed job, because the
        // provenance table's foreign keys are part of what keeps it honest, and
        // all of them are written through the disposable cluster's admin
        // connection - the only way to forge what a least-privilege role cannot.
        const forge = async (label: string, sessionId: string, digest: string, tag: string, jobId: string, requestId: string, decisionDigest: string = digest) => {
          // Digests are unique per tenant, so every forged row needs its own.
          const sessionDigest = sha256Digest({ forgedSession: sessionId });
          const synthesisDigest = sha256Digest({ forgedSynthesis: sessionId });
          await adminClient.query(`INSERT INTO control_idea_sessions(session_id,tenant_id,workspace_id,session_digest,
            session_auth_tag,participant_count,max_rounds,payload,created_at)
            VALUES($1,$2,$3,$4,$5,3,1,'{}'::jsonb,$6)`, [sessionId, scope.tenantId, scope.workspaceId,
            sessionDigest, hmac("a"), NOW]);
          await adminClient.query(`INSERT INTO control_idea_syntheses(synthesis_id,tenant_id,workspace_id,session_id,
            session_digest,synthesis_digest,synthesis_auth_tag,recommendation,overall_score,payload,synthesized_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'promote',80,'{}'::jsonb,$8)`, [`synth:${label}`, scope.tenantId,
            scope.workspaceId, sessionId, sessionDigest, synthesisDigest, hmac("b"), NOW]);
          await adminClient.query(`INSERT INTO control_idea_decisions(decision_id,tenant_id,workspace_id,session_id,
            synthesis_digest,decision,project_id,decision_digest,decision_auth_tag,payload,decided_at)
            VALUES($1,$2,$3,$4,$5,'create_project',$6,$7,$8,'{}'::jsonb,$9)`, [`decision:${label}`, scope.tenantId,
            scope.workspaceId, sessionId, synthesisDigest, projectId, decisionDigest, hmac("f"), NOW]);
          await adminClient.query(`INSERT INTO control_idea_promotion_task_links(tenant_id,session_id,decision_digest,
            project_id,job_id,request_id,link_digest,link_auth_tag,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [scope.tenantId, sessionId, decisionDigest, projectId, jobId,
            requestId, digest, tag, NOW]);
          return sessionId;
        };
        const { hmacSha256Tag } = await import("../src/security");
        // (1) Correctly hashed link, tag computed under a key the store lacks.
        // get() rebuilds the link from the stored columns - notably
        // decisionDigest, projectId, jobId, requestId and createdAt - so the
        // digest here is computed over exactly that material. Computing it over
        // anything else would let the digest self-check reject the row first,
        // and this assertion would pass while never exercising the tag check.
        const tagJob = await tasks.propose(identity, projectId,
          { title: "Third validation", instructions: "Only to give the forged row a real job." }, "idea-promotion-forge-tag");
        const tagSession = "idea:promotion-tag";
        const tagRequestId = "request:tag";
        // The forged decision's digest is what get() will read back as decisionDigest.
        const tagDecisionDigest = sha256Digest({ forgedDecision: tagSession });
        const tagMaterial = { ...input, sessionId: tagSession, decisionDigest: tagDecisionDigest,
          projectId, jobId: tagJob.receipt.jobId, requestId: tagRequestId, createdAt: NOW };
        const tagDigest = sha256Digest(tagMaterial);
        const wrongKeyTag = hmacSha256Tag(new Uint8Array(32).fill(0x99),
          { kind: "idea_promotion_task_link", tenantId: scope.tenantId, sessionId: tagSession, digest: tagDigest });
        await forge("tag", tagSession, tagDigest, wrongKeyTag, tagJob.receipt.jobId, tagRequestId, tagDecisionDigest);
        // This row is well formed by construction, so reaching the tag check at
        // all is what the next assertion proves.
        assert.equal((await web.query<{ stored: string }>(
          "SELECT link_digest AS stored FROM control_idea_promotion_task_links WHERE tenant_id=$1 AND session_id=$2",
          [scope.tenantId, tagSession])).rows[0]?.stored, tagDigest);
        await assert.rejects(new IdeaLabPromotionTaskLinkStoreV1(web, KEY).get(scope.tenantId, tagSession),
          /integrity_failed/u, "a link whose HMAC tag verifies under another key must not be trusted on read");

        // (2) A digest that does not hash the stored columns: refused by the self-check.
        const digestJob = await tasks.propose(identity, projectId,
          { title: "Fourth validation", instructions: "Only to give the forged row a real job." }, "idea-promotion-forge-digest");
        await forge("digest", "idea:promotion-digest", sha("d"), hmac("d"), digestJob.receipt.jobId, "request:digest");
        await assert.rejects(new IdeaLabPromotionTaskLinkStoreV1(web, KEY).get(scope.tenantId, "idea:promotion-digest"),
          /integrity_failed/u, "a link whose columns do not hash to its stored digest must be refused");
      } finally { await webClient.end(); await adminClient.end(); }
      return postgres.appliedMigrations;
    }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
    assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []); assert.ok(result.value >= 1);
  });
