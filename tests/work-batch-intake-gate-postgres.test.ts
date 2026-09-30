// Real-PostgreSQL proof of the intake gate (Tango tier 1), run AS the
// production logins that execute each step: an admin-seeded proposal (the
// work-intake login is not one of the attack-kit's named roles, so seeding
// uses the superuser exactly as work-batch-agent-queue-db.test.ts does), then
// every owner decision through the real least-privilege control_room_web
// login. The attack kit provisions a disposable socket-only cluster on this
// file's reserved port lane (59450-59459, CONTROL_ROOM_PG_TEST_PORT_BASE
// moves it) and destroys it afterwards.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchOwnerServiceV1, WorkBatchStoreV1, workBatchProposalDigestV1, type WorkBatchProposalV1 } from "../src/work-intake/v1";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59450);
const PG = requiresRealPostgres();
const integrityKey = new Uint8Array(32).fill(9);
const TENANT = "tenant:intake-gate", WORKSPACE = "workspace:intake-gate";
const OWNER = "identity:intake-gate-owner", PROPOSER = "identity:intake-gate-agent";
const PROVIDER = "test";

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: admin.user,
    password: admin.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

function proposal(projectId: string): WorkBatchProposalV1 {
  return { schema: "control-room.work-batch-proposal/v1", projectId, tasks: [
    { localId: "build", title: "Build the change", instructions: "Implement the requested change.",
      requiredCapability: "code.change", role: "builder",
      acceptanceCriteria: "tbd", acceptanceTests: "Run the focused tests and confirm they pass." },
  ], edges: [] };
}

test("the intake gate blocks approval until the owner dismisses the flag, as the real production logins", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), web = pool(postgres, "web");
    const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const tokenDigest = sha256Digest({ session: "intake-gate-owner" });
    // Raw SQL as the exact production login, bypassing the app's private-pg
    // driver, whose defense-in-depth deliberately discards raw error text.
    // Only used here to observe the guard's exact message on a direct attempt.
    const asWeb = async (sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.connection("web")); await client.connect();
      try { return await client.query(sql, params); } finally { await client.end(); }
    };
    const asAdmin = async (sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.admin({ database: postgres.database })); await client.connect();
      try { return await client.query(sql, params); } finally { await client.end(); }
    };
    try {
      await admin.client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Intake gate tenant')", [TENANT]);
      await admin.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Intake gate')",
        [WORKSPACE, TENANT]);
      await admin.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
      [OWNER, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: OWNER }), issuedAt]);
      await admin.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
        project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:intake-gate-owner',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
      [TENANT, OWNER, issuedAt]);
      await admin.client.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5)`, [TENANT, tokenDigest, OWNER, issuedAt, expiresAt]);

      const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: OWNER, tokenDigest,
        issuedAt, expiresAt, verificationExpiresAt: expiresAt };
      // A real project, created through the ordinary service, not a raw
      // insert: proposeWithDependenciesInSession (inside #decide) reads the
      // project view the service maintains, which a bare projects-table row
      // does not populate.
      const { project } = await new WebProjectService(admin.client, { tenantId: TENANT, workspaceId: WORKSPACE })
        .create(identity, { title: "Intake gate project", summary: "Real disposable SQL" }, "intake-gate-project-0001");
      const projectId = project.projectId;

      await admin.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Proposer','work-intake',$3,'active',$4,$4)`,
      [PROPOSER, TENANT, sha256Digest("intake-gate-agent"), issuedAt]);
      await admin.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
        project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:intake-gate-agent',$1,$2,'work_batch_proposer','["work_batches.propose"]',$3::jsonb,'low',
        false,false,$4,$4)`, [TENANT, PROPOSER, JSON.stringify([projectId]), issuedAt]);

      const draft = proposal(projectId);
      const principal: AuthenticatedPrincipal = { tenantId: TENANT, identityId: PROPOSER, actorType: "agent",
        authenticatedAt: issuedAt, expiresAt };
      const batch = await new WorkBatchStoreV1(admin.client, integrityKey).create({ principal, proposal: draft,
        proposalDigest: workBatchProposalDigestV1(draft), idempotencyKey: "intake-gate-proposal-0001",
        now: issuedAt, queueDepthLimit: 5 });

      const owner = new WorkBatchOwnerServiceV1(web.client, new WebTaskService(web.client, { tenantId: TENANT, workspaceId: WORKSPACE }),
        { tenantId: TENANT, workspaceId: WORKSPACE }, integrityKey);

      // The view shows the flag: the SELECT-only role can read it as unresolved.
      const firstView = await owner.view(identity, projectId, batch.batchId);
      assert.deepEqual(firstView.flagsByLocalId.build, [{ kind: "needs_more_info", reasonCode: "vague_language_used", dismissed: false }]);

      // Approving while the flag is open is refused as the real least-privilege
      // login: if the SELECT grant on work_batch_intake_flag_dismissals were
      // missing, this would fail with a Postgres permission error instead.
      await assert.rejects(owner.command(identity, projectId, { operation: "decide", batchId: batch.batchId,
        expectedRevision: 1, items: [{ localId: "build", decision: "approve" }] }, "intake-gate-decide-0001"),
      /flagged_items_unresolved/u);

      // A forged dismissal naming someone who is not an active owner-grant
      // holder is refused by the guard trigger, not by the service layer.
      await assert.rejects(asWeb(`INSERT INTO work_batch_intake_flag_dismissals(id,tenant_id,batch_id,
        project_id,revision,local_id,flag_kind,reason_code,dismissed_by_identity_id,dismissed_at,dismissal_digest,
        auth_tag,created_at) VALUES('forged',$1,$2,$3,1,'build','needs_more_info','owner_dismissed',$4,$5,$6,$7,$5)`,
      [TENANT, batch.batchId, projectId, PROPOSER, issuedAt, `sha256:${"0".repeat(64)}`, `hmac-sha256:${"0".repeat(64)}`]),
      /work batch intake flag dismissal insert rejected/u);

      // A dismissal against a revision the batch is not currently on is
      // refused, even naming the real owner and the real local id.
      await assert.rejects(asWeb(`INSERT INTO work_batch_intake_flag_dismissals(id,tenant_id,batch_id,
        project_id,revision,local_id,flag_kind,reason_code,dismissed_by_identity_id,dismissed_at,dismissal_digest,
        auth_tag,created_at) VALUES('forged-rev',$1,$2,$3,2,'build','needs_more_info','owner_dismissed',$4,$5,$6,$7,$5)`,
      [TENANT, batch.batchId, projectId, OWNER, issuedAt, `sha256:${"0".repeat(64)}`, `hmac-sha256:${"0".repeat(64)}`]),
      /work batch intake flag dismissal insert rejected/u);

      // The real owner dismisses the flag through the ordinary command path.
      const dismissed = await owner.command(identity, projectId, { operation: "dismiss_flag", batchId: batch.batchId,
        expectedRevision: 1, localId: "build", flagKind: "needs_more_info", reasonCode: "owner_dismissed" },
      "intake-gate-dismiss-0001");
      assert.equal(dismissed.state, "proposed");

      // The owning login holds no UPDATE/DELETE grant at all on this table, so
      // it never even reaches the append-only trigger.
      await assert.rejects(asWeb("UPDATE work_batch_intake_flag_dismissals SET reason_code='changed'"), /permission denied/u);
      await assert.rejects(asWeb("DELETE FROM work_batch_intake_flag_dismissals"), /permission denied/u);
      // The append-only trigger is a real second layer, not just the missing
      // grant: even the superuser cannot mutate or truncate a written row.
      await assert.rejects(asAdmin("UPDATE work_batch_intake_flag_dismissals SET reason_code='changed'"), /append-only/u);
      await assert.rejects(asAdmin("DELETE FROM work_batch_intake_flag_dismissals"), /append-only/u);
      await assert.rejects(asAdmin("TRUNCATE work_batch_intake_flag_dismissals"), /append-only/u);

      const secondView = await owner.view(identity, projectId, batch.batchId);
      assert.deepEqual(secondView.flagsByLocalId.build, [{ kind: "needs_more_info", reasonCode: "vague_language_used", dismissed: true }]);

      // Approval now succeeds, and never twice: the flag dismissal is not
      // required again for a later revision, but this exact revision commits
      // an ordinary task once.
      const receipt = await owner.command(identity, projectId, { operation: "decide", batchId: batch.batchId,
        expectedRevision: 1, items: [{ localId: "build", decision: "approve" }] }, "intake-gate-decide-0002");
      assert.equal(receipt.state, "approved");
      assert.equal(receipt.jobIds.length, 1);
    } finally {
      await Promise.all([admin.close(), web.close()]);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 120_000 });
});
