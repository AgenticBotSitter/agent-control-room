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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabCanonicalTaskProposalServiceV1 } from "../src/idea-lab/v1/canonical-task-proposal";
import { buildIdeaLabCanonicalTaskPlanV1 } from "../src/idea-lab/v1/canonical-task-plan";
import { buildIdeaLabOwnerPromptV1 } from "../src/idea-lab/v1/discussion-prompt";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

// Reserved disposable-cluster lane for the Idea Lab link module: 59100-59109.
// The two tests use distinct ports and each allows only its own, so they can
// run in either order and can never claim a port the other is using.
const PORT = Number(process.env.IDEA_LINK_PG_PORT ?? 59107);
const FENCE_PORT = Number(process.env.IDEA_LINK_FENCE_PG_PORT ?? 59109);
const PG = requiresRealPostgres();
const NOW = "2026-09-29T15:00:00.000Z";
const LATER = "2026-09-29T16:00:00.000Z";
const KEY = new Uint8Array(32).fill(0x4c);
const hmac = (character: string) => `hmac-sha256:${character.repeat(64)}`;
/** The store's own binding digest, recomputed here so the forged row is
 * genuine in every column except the auth tag - otherwise the wrong-key tag
 * would be rejected for the wrong reason. */
const bindingDigestFor = (plan: { tenantId: string; workspaceId: string; projectId: string; sessionId: string;
  sessionDigest: string }) => sha256Digest({ contractVersion: "control-room-idea-lab-canonical-task-session-binding/v1",
  tenantId: plan.tenantId, workspaceId: plan.workspaceId, projectId: plan.projectId,
  sessionId: plan.sessionId, sessionDigest: plan.sessionDigest });
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

        // A CHANGED plan for an already linked turn is refused, and a second
        // session cannot be bound to a different project once this one owns the
        // discussion. Both guards are the reason the dropped lock is safe: they
        // are the invariants a lock was standing in for, and they must survive
        // its removal. Each is asserted through the store's own public surface.
        const originalPlan = first.plans[0]!;
        const changedPlan = buildIdeaLabCanonicalTaskPlanV1({ session, projectId: project.projectId,
          participantId: originalPlan.participantId, round: 1,
          ownerPrompt: `${buildIdeaLabOwnerPromptV1(session)}\nA different but still valid scope.`,
          contributions: [] });
        await assert.rejects(links.assertPlanAvailable(changedPlan),
          /scope_mismatch/u, "a changed plan for a linked participant turn is refused");
        // The original plan is still the one on record, so nothing was rewritten.
        await links.assertPlanAvailable(originalPlan);
        // A different project for the SAME session is refused by bindSession.
        await assert.rejects(links.bindSession(buildIdeaLabCanonicalTaskPlanV1({ session,
          projectId: other.projectId, participantId: originalPlan.participantId, round: 1,
          ownerPrompt: buildIdeaLabOwnerPromptV1(session), contributions: [] })),
        /scope_mismatch/u, "one discussion cannot be re-bound to a different project");
        // ...and a link forged under a different integrity key is refused on read.
        const wrongKeyLinks = new IdeaLabCanonicalTaskLinkStoreV1(web, new Uint8Array(32).fill(0x9c));
        await assert.rejects(wrongKeyLinks.list(session.tenantId, session.sessionId),
          /integrity_failed/u, "a link whose auth tag verifies under another key is not trusted");
        await assert.rejects(wrongKeyLinks.assertPlanAvailable(originalPlan),
          /integrity_failed/u, "a stored link forged under another key is refused before reuse");

        // A binding row forged under ANOTHER integrity key is refused on the way
        // in, not trusted. Seeded through the admin connection because that is
        // the only way to write what a least-privilege role cannot. The web
        // role holds no INSERT on control_idea_sessions either, which is a
        // separate least-privilege boundary from the provenance tables.
        const forgedSession = buildIdeaLabSessionV1({ sessionId: "idea:link-forged", tenantId: scope.tenantId,
          workspaceId: scope.workspaceId, title: session.title, ideaSummary: session.ideaSummary,
          targetCustomer: session.targetCustomer, participants: session.participants,
          maxRounds: session.maxRounds, maxDurationSeconds: session.maxDurationSeconds,
          maxCostUsd: session.maxCostUsd, createdByIdentityDigest: session.createdByIdentityDigest,
          createdAt: NOW });
        await adminClient.query(`INSERT INTO control_idea_sessions(session_id,tenant_id,workspace_id,session_digest,
          session_auth_tag,participant_count,max_rounds,payload,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [forgedSession.sessionId, scope.tenantId, scope.workspaceId,
          forgedSession.sessionDigest, hmac("a"), forgedSession.participants.length, forgedSession.maxRounds,
          JSON.stringify(forgedSession), NOW]);
        const forgedPlan = buildIdeaLabCanonicalTaskPlanV1({ session: forgedSession, projectId: project.projectId,
          participantId: forgedSession.participants[0]!.participantId, round: 1,
          ownerPrompt: buildIdeaLabOwnerPromptV1(forgedSession), contributions: [] });
        // Write the binding row itself with a tag produced under a key this
        // store does not hold, so the auth-tag check is the only thing that can
        // reject it: the columns and the binding digest are all genuine.
        const forgedBinding = bindingDigestFor(forgedPlan);
        await adminClient.query(`INSERT INTO control_idea_canonical_task_sessions(tenant_id,session_id,session_digest,
          workspace_id,project_id,binding_digest,binding_auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [scope.tenantId, forgedSession.sessionId, forgedSession.sessionDigest, scope.workspaceId,
          forgedPlan.projectId, forgedBinding, hmac("b"), NOW]);
        await assert.rejects(links.bindSession(forgedPlan), /integrity_failed/u,
          "a session binding forged under another key is refused, not trusted");
        // assertPlanAvailable() reads only the LINK table, which holds no row for
        // this turn, so it legitimately returns rather than refusing: the binding
        // is what refuses, and bindSession is where a discussion is bound. What
        // matters is that the forged binding bought no link.
        await links.assertPlanAvailable(forgedPlan);
        assert.equal((await links.list(scope.tenantId, forgedSession.sessionId)).length, 0,
          "a forged binding never yields a usable provenance link");

        // A changed record for the same task key is refused, and the stored
        // provenance is left untouched.
        const storedBefore = (await links.list(session.tenantId, session.sessionId)).length;
        await assert.rejects(links.record(changedPlan, first.receipts[0]!.receipt),
          /scope_mismatch|duplicate_record|integrity_failed/u,
          "a different link for an already linked task key is refused");
        assert.equal((await links.list(session.tenantId, session.sessionId)).length, storedBefore,
          "a refused record leaves the provenance table unchanged");

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

// A second, narrower guard for the sibling fix in the assignment coordinator.
// `control_assignment_lease_scopes` is the only remaining table the audit found
// that NO production login can row-lock, and the execution freshness fence used
// to read it FOR SHARE. It is coordinator-executed, not web-executed, so it is
// asserted as a privilege fact rather than driven through the web path.
test("the execution freshness fence's scope table stays un-lockable, so no lock is used there",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    const result = await withRealPostgres(async postgres => {
      // Every role that can read the table is refused a row lock on it, read
      // from the server rather than from the grant text.
      for (const role of ["web", "coordinator"] as const) {
        const client = new Client(postgres.connection(role));
        client.on("error", () => {});
        await client.connect();
        try {
          await assert.rejects(client.query("SELECT 1 FROM control_assignment_lease_scopes LIMIT 1 FOR UPDATE"),
            /permission denied/u, `the ${role} login must not be able to row-lock control_assignment_lease_scopes`);
        } finally { await client.end().catch(() => {}); }
      }
      // The lease table the fence does lock, and the scope table it reads, are
      // both reachable for the coordinator: this is why the fix drops the scope
      // lock rather than adding a grant.
      const adminClient = new Client(postgres.admin()); await adminClient.connect();
      const rows = (await adminClient.query("SELECT has_any_column_privilege('control_room_task_coordinator', t, 'UPDATE') AS lockable FROM unnest(ARRAY['control_leases','control_assignment_lease_scopes']) AS t")).rows as { lockable: boolean }[];
      await adminClient.end();
      assert.deepEqual(rows, [{ lockable: true }, { lockable: false }]);

      // The two statements the fence actually issues, executed for real as the
      // coordinator login. The scope read is the one that used to carry
      // FOR SHARE, so this is the statement whose privilege broke; the lease
      // read is the lock the fence still legitimately takes.
      const fence = new Client(postgres.connection("coordinator"));
      fence.on("error", () => {});
      await fence.connect();
      try {
        await assert.rejects(fence.query("SELECT scope_kind,path_fold FROM control_assignment_lease_scopes LIMIT 1 FOR SHARE"),
          /permission denied/u, "the coordinator login cannot take the lock the fence used to ask for");
        await fence.query("SELECT id FROM control_leases LIMIT 1 FOR UPDATE OF control_leases");
      } finally { await fence.end().catch(() => {}); }

      // A privilege fact alone does not stop the lock coming back: the
      // statements above would still pass with `FOR SHARE` restored in the
      // source, because it asserts the GRANT, not the SQL. Pin the source
      // itself, so re-adding a row lock on one of these reads fails here.
      //
      // Each SQL statement is a template literal, and a table name and its
      // locking clause routinely sit on different lines, so this runs per
      // statement rather than per line. Comment-only lines are dropped first,
      // so the notes explaining why each lock was removed are never read as the
      // lock itself.
      //
      // A statement is refused only when the lock is actually ON an
      // un-lockable table. `... FROM control_assignment_lease_scopes ... FOR
      // UPDATE OF l` locks the joined control_leases row instead, which the
      // coordinator does hold UPDATE on, so that statement stays legal.
      const UNLOCKABLE = ["control_idea_canonical_task_sessions", "control_idea_canonical_task_links",
        "control_assignment_lease_scopes"];
      const KEYWORDS = /^(?:ON|USING|WHERE|SET|GROUP|ORDER|LEFT|RIGHT|FULL|INNER|CROSS|JOIN|AND|OR|VALUES|SELECT|FOR|LIMIT|OFFSET|RETURNING|HAVING|UNION|EXCEPT|INTERSECT|SKIP|LOCKED|NOWAIT)$/i;
      for (const [label, file] of [
        ["canonical task link store", "src/idea-lab/v1/canonical-task-link-store.ts"],
        ["lease-scope fence", "src/web/v1/task-assignment-coordinator.ts"],
      ] as const) {
        const sql = readFileSync(join(process.cwd(), file), "utf8").split("\n")
          .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
        for (const statement of sql.split("`")) {
          // An `OF a, b` list names the locked relations and may be followed by
          // SKIP LOCKED / NOWAIT. Without it, the lock covers every table read.
          const locking = /FOR (?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)(?:\s+OF\s+([\w,\s]+?))?(?=\s+(?:SKIP|NOWAIT)\b|\s*$|\s+[),])/m.exec(statement);
          if (!locking) continue;
          const only = locking[1] ? locking[1].split(",").map(s => s.trim()).filter(Boolean) : undefined;
          // Keep the table even when the next token is a keyword: `FROM t
          // WHERE ...` yields alias "WHERE", and dropping the whole entry there
          // would hide the very statement this guard exists to catch.
          const read = [...statement.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?(\w+))?/gi)]
            .map(m => ({ table: m[1], alias: m[2] && !KEYWORDS.test(m[2]) ? m[2] : undefined }));
          const targets = only
            ? read.filter(r => only.includes(r.alias) || only.includes(r.table)).map(r => r.table)
            : read.map(r => r.table);
          for (const table of targets) {
            if (UNLOCKABLE.includes(table)) {
              assert.fail(`${label} must not row-lock ${table}: ${statement.replace(/\s+/g, " ").trim()}`);
            }
          }
        }
      }
      return postgres.appliedMigrations;
    }, { port: FENCE_PORT, allowedPorts: [FENCE_PORT], boundMs: 240_000 });
    assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []); assert.ok(result.value >= 1);
  });
