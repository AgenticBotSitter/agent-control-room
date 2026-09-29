// Real-PostgreSQL production-role proof for the Idea Lab canonical task link.
//
// `IdeaLabCanonicalTaskLinkStoreV1` wrote `FOR UPDATE` over two append-only
// provenance tables. In PostgreSQL a row lock requires table-level UPDATE
// privilege, and db/roles/private_web_roles.sql deliberately grants the web
// login only SELECT and INSERT on both tables. So the whole owner-facing
// "prepare this round's tasks" path died with `permission denied for table
// control_idea_canonical_task_sessions` at the privilege layer.
//
// This file reproduces that as the production `control_room_web` login, and
// then pins the least-privilege properties the fix depends on. The same class
// as S3's FOR SHARE bug and the promotion link's FOR SHARE fix, in the
// sibling store this time.
//
// Only the disposable cluster's admin connection writes fixture rows; every
// product write below is the restricted web login.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabCanonicalTaskProposalServiceV1 } from "../src/idea-lab/v1/canonical-task-proposal";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

// Reserved disposable-cluster lane for the Idea Lab link module: 59100-59109.
const PORT = Number(process.env.IDEA_LINK_PG_PORT ?? 59100);
const PG = requiresRealPostgres();
const NOW = "2026-09-29T15:00:00.000Z";
const LATER = "2026-09-29T16:00:00.000Z";
const KEY = new Uint8Array(32).fill(0x4c);
const scope = { tenantId: "tenant:idea-link", workspaceId: "workspace:idea-link" };
const IDENTITY_ID = "identity:idea-link";
const identity: VerifiedWebIdentity = { provider: "test", subject: "idea-link-owner",
  tokenDigest: sha256Digest("idea-link-web-session"), issuedAt: NOW, expiresAt: LATER, verificationExpiresAt: LATER };

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

/** Discussion state and one ordinary project, both through the real
 * production services, so every stored digest is the one the product computes.
 * Nothing canonical is hand-rolled. */
async function seedProjectAndSession(admin: Client) {
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
    VALUES('grant:idea-link',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
  [scope.tenantId, IDENTITY_ID, NOW]);
  await admin.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
    [scope.tenantId, identity.tokenDigest, IDENTITY_ID, NOW, LATER]);

  const web = database(admin);
  const { project } = await new WebProjectService(web, scope, () => Date.parse(NOW)).create(identity,
    { title: "Idea link project", summary: "Ordinary project that owns the discussion." }, "idea-link-project-001");

  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:link-pg", tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: NOW });
  await new IdeaLabProjectRegistryStoreV1(web, KEY).registerSession(session);
  return { project, session };
}

test("Idea Lab canonical task links record and replay through the production web role on append-only tables",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    const result = await withRealPostgres(async postgres => {
      const adminClient = new Client(postgres.admin()); await adminClient.connect();
      const { project, session } = await seedProjectAndSession(adminClient);

      const webClient = new Client(postgres.connection("web")); await webClient.connect();
      try {
        const web = database(webClient);

        // The privilege layer is the whole bug. These two tables are the
        // append-only provenance behind "prepare this round's tasks", and the
        // web login must hold no UPDATE on either - a row lock needs
        // table-level UPDATE, so any FOR UPDATE here would break the path.
        for (const table of ["control_idea_canonical_task_sessions", "control_idea_canonical_task_links"]) {
          assert.equal((await web.query<{ updatable: boolean }>(
            "SELECT has_table_privilege(current_user,$1,'UPDATE') AS updatable", [table])).rows[0]?.updatable,
          false, `the web role must not hold UPDATE on append-only ${table}`);
        }
        // Proof the lock would really have been refused, read from the server
        // rather than inferred: every row-lock strength fails for this login.
        for (const lock of ["FOR SHARE", "FOR KEY SHARE", "FOR NO KEY UPDATE", "FOR UPDATE"]) {
          await assert.rejects(web.query(
            `SELECT 1 FROM control_idea_canonical_task_links WHERE tenant_id=$1 ${lock}`, [scope.tenantId]),
          /permission denied/u, `${lock} must be refused for the web role on this append-only table`);
        }
        // ...and the plain read the fixed store now uses is allowed.
        assert.equal((await web.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_idea_canonical_task_links WHERE tenant_id=$1",
          [scope.tenantId])).rows[0]?.count, "0");

        // The production path, exactly as WebIdeaRoundProposalOperation calls
        // it: bind the session, check each turn, propose ordinary tasks, record
        // the links. This is the call that used to fail on the row lock.
        const links = new IdeaLabCanonicalTaskLinkStoreV1(web, KEY);
        const tasks = new WebTaskService(web, scope, () => Date.parse(NOW), { ideaIntegrityKey: KEY });
        const service = new IdeaLabCanonicalTaskProposalServiceV1(tasks, { projectId: project.projectId }, links);
        const first = await service.proposeRound(identity, { session, round: 1, contributions: [] });

        assert.equal(first.receipts.length, session.participants.length);
        assert.equal(first.receipts.every((item) => !item.replayed && item.receipt.submission === "proposed"
          && item.receipt.startsWork === false), true, "proposal assigns and runs nothing");
        assert.equal((await links.list(session.tenantId, session.sessionId)).length, session.participants.length);
        // One session binding, not one per participant turn.
        assert.equal((await web.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_idea_canonical_task_sessions WHERE tenant_id=$1",
          [scope.tenantId])).rows[0]?.count, "1");

        // An exact replay is idempotent and must not fork provenance.
        const replay = await service.proposeRound(identity, { session, round: 1, contributions: [] });
        assert.equal(replay.receipts.every((item) => item.replayed), true);
        assert.deepEqual(replay.receipts.map((item) => item.receipt.jobId).sort(),
          first.receipts.map((item) => item.receipt.jobId).sort());
        assert.equal((await links.list(session.tenantId, session.sessionId)).length, session.participants.length);

        // A second, different project must not be able to claim the discussion.
        const { project: other } = await new WebProjectService(web, scope, () => Date.parse(NOW))
          .create(identity, { title: "Other project", summary: "Must not receive this discussion's tasks." }, "idea-link-project-002");
        await assert.rejects(new IdeaLabCanonicalTaskProposalServiceV1(tasks, { projectId: other.projectId }, links)
          .proposeRound(identity, { session, round: 1, contributions: [] }));
        assert.equal((await web.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_jobs WHERE tenant_id=$1 AND project_id=$2",
          [scope.tenantId, other.projectId])).rows[0]?.count, "0", "a refused binding creates no task at all");

        // The provenance tables stay append-only even for the writing role.
        for (const statement of [
          "UPDATE control_idea_canonical_task_links SET job_id='job:other' WHERE tenant_id=$1",
          "DELETE FROM control_idea_canonical_task_links WHERE tenant_id=$1",
          "UPDATE control_idea_canonical_task_sessions SET project_id='project:other' WHERE tenant_id=$1",
          "DELETE FROM control_idea_canonical_task_sessions WHERE tenant_id=$1",
        ]) await assert.rejects(web.query(statement, [scope.tenantId]), /permission denied|append only/u);
        await assert.rejects(web.query("TRUNCATE control_idea_canonical_task_links"), /permission denied|append only/u);
        await assert.rejects(web.query("TRUNCATE control_idea_canonical_task_sessions"), /permission denied|append only/u);
      } finally { await webClient.end(); await adminClient.end(); }
      return postgres.appliedMigrations;
    }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
    assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []); assert.ok(result.value >= 1);
  });
