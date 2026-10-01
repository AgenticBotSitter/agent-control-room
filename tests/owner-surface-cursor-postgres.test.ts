// Real-PostgreSQL proof of the owner surface cursor (MIG-G, 0218-0220).
//
// The contract under test, run as the production private-web login against a
// disposable cluster on this file's reserved port lane (59321-59329):
//   - Home and the Morning page read only what changed after the owner's cursor;
//   - a GET never acknowledges: reading does not move the cursor;
//   - a POST after a successful paint advances it with GREATEST, so a second
//     tab or a retry after a lost response cannot move it backwards;
//   - a first visit reads "from now" and reports firstVisit, with a Recent link;
//   - the cursor is per identity and per surface: one surface's paint never
//     silences the other.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

const PORT = Number(process.env.OWNER_CURSOR_PG_PORT ?? 59321);
const PG = requiresRealPostgres();
const T0 = Date.parse("2026-09-29T15:00:00.000Z");
const LATER = Date.parse("2026-09-29T16:00:00.000Z");
const scope = { tenantId: "tenant:cursor-pg", workspaceId: "workspace:cursor-pg" };
const IDENTITY_ID = "identity:cursor-pg";
const identity: VerifiedWebIdentity = { provider: "test", subject: "cursor-owner",
  tokenDigest: sha256Digest("cursor-web-session"), issuedAt: "2026-09-29T15:00:00.000Z",
  expiresAt: "2026-09-29T16:00:00.000Z", verificationExpiresAt: "2026-09-29T16:00:00.000Z" };

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

async function seed(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)`,
  [IDENTITY_ID, scope.tenantId, sha256Digest({ provider: "test", subject: identity.subject }), new Date(T0).toISOString()]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:cursor-pg',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
  [scope.tenantId, IDENTITY_ID, new Date(T0).toISOString()]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`,
  [scope.tenantId, identity.tokenDigest, IDENTITY_ID, new Date(T0).toISOString(), new Date(LATER).toISOString()]);
}

test("Home and Morning read after the owner's cursor, and only a POST acknowledges", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async (postgres: RealPostgres) => {
    const adminLogin = postgres.admin({ database: postgres.database });
    const admin = new Client(adminLogin);
    await admin.connect();
    const web = new Client(postgres.connection("web"));
    await web.connect();
    try {
      await seed(admin);
      const tasks = new WebTaskService(database(web), scope, () => T0);

      // 1. First visit: no cursor row exists, so the read is "from now" and
      //    says so. Nothing is acknowledged by reading.
      const first = await tasks.home(identity);
      assert.equal(first.cursor.firstVisit, true, "a first visit is a first visit");
      assert.equal(first.cursor.mode, "since_last_look");
      assert.equal(first.cursor.surface, "home");
      assert.equal(first.startsWork, false);
      let rows = (await admin.query(`SELECT surface,seen_through FROM owner_surface_cursors
        WHERE tenant_id=$1 AND identity_id=$2`, [scope.tenantId, IDENTITY_ID])).rows;
      assert.deepEqual(rows, [], "a GET must never create a cursor row");

      // 2. Painting acknowledges through the time the paint was read at.
      const ack = await tasks.acknowledgeHome(identity,
        { surface: "home", acknowledgeThrough: new Date(T0).toISOString() });
      assert.equal(ack.acknowledged, true);
      assert.equal(ack.seenThrough, new Date(T0).toISOString());

      // 3. Reading again is no longer a first visit.
      const second = await tasks.home(identity);
      assert.equal(second.cursor.firstVisit, false, "the cursor exists now");
      assert.equal(second.cursor.surface, "home");

      // 4. A stale acknowledgement cannot move the cursor backwards. This is
      //    the second tab / retry-after-lost-response case: GREATEST in the
      //    upsert, and the trigger refuses any decrease outright.
      const stale = await tasks.acknowledgeHome(identity,
        { surface: "home", acknowledgeThrough: new Date(T0 - 3_600_000).toISOString() });
      assert.equal(stale.seenThrough, new Date(T0).toISOString(),
        "a stale acknowledge must not rewind the cursor");
      await assert.rejects(admin.query(`UPDATE owner_surface_cursors SET seen_through=$3
        WHERE tenant_id=$1 AND identity_id=$2 AND surface='home'`,
      [scope.tenantId, IDENTITY_ID, new Date(T0 - 3_600_000).toISOString()]),
      /owner surface cursor rejected/u, "a direct rewind is refused by the guard");

      // 5. The surfaces are independent: a Morning paint does not silence Home,
      //    and Home's cursor does not satisfy a first Morning visit.
      const morningFirst = await tasks.home(identity, { surface: "morning" });
      assert.equal(morningFirst.cursor.firstVisit, true, "Morning has its own first visit");
      assert.equal(morningFirst.cursor.surface, "morning");
      await tasks.acknowledgeHome(identity, { surface: "morning", acknowledgeThrough: new Date(T0).toISOString() });
      const homeAgain = await tasks.home(identity);
      assert.equal(homeAgain.cursor.firstVisit, false, "Home's cursor is untouched by a Morning paint");

      // 6. The "Recent" link is a different read, not a different surface, and
      //    it is not an acknowledgement either.
      const recent = await tasks.home(identity, { recent: true });
      assert.equal(recent.cursor.mode, "recent", "the Recent link reports its own mode");
      assert.equal(recent.cursor.surface, "home");
      rows = (await admin.query(`SELECT surface,seen_through FROM owner_surface_cursors
        WHERE tenant_id=$1 AND identity_id=$2 ORDER BY surface`, [scope.tenantId, IDENTITY_ID])).rows;
      assert.equal(rows.length, 2, "one cursor per surface, no more");
      for (const row of rows)
        assert.equal(new Date(row.seen_through).toISOString(), new Date(T0).toISOString(),
          "reading Recent must not advance either cursor");

      // 7. An acknowledgement into the future, or for an unknown surface, is
      //    refused: a client cannot claim to have seen work that has not
      //    happened yet, and cannot write a surface that does not exist.
      await assert.rejects(tasks.acknowledgeHome(identity,
        { surface: "home", acknowledgeThrough: new Date(T0 + 3_600_000).toISOString() }),
      /invalid_request/u, "a future acknowledgement is refused");
      await assert.rejects(tasks.acknowledgeHome(identity, { surface: "nowhere",
        acknowledgeThrough: new Date(T0).toISOString() }), /invalid_request/u);
      await assert.rejects(tasks.acknowledgeHome(identity, { surface: "home", acknowledgeThrough: "not a time" }),
      /invalid_request/u);
      await assert.rejects(tasks.home(identity, { surface: "nowhere" }), /invalid_request/u);

      // 8. A second identity sees its own first visit: the cursor is per owner.
      const other: VerifiedWebIdentity = { ...identity, subject: "cursor-owner-2",
        tokenDigest: sha256Digest("cursor-web-session-2") };
      const otherId = "identity:cursor-pg-2";
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'human','Owner 2','test',$3,'active',$4,$4)`,
      [otherId, scope.tenantId, sha256Digest({ provider: "test", subject: other.subject }), new Date(T0).toISOString()]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:cursor-pg-2',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
      [scope.tenantId, otherId, new Date(T0).toISOString()]);
      await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5)`,
      [scope.tenantId, other.tokenDigest, otherId, other.issuedAt, other.expiresAt]);
      const otherHome = await tasks.home(other);
      assert.equal(otherHome.cursor.firstVisit, true, "one owner's cursor never silences another's");

      // 9. A cursor is deleted only by the down migration; there is no delete
      //    path for the web login.
      await assert.rejects(web.query(`DELETE FROM owner_surface_cursors WHERE tenant_id=$1`,
      [scope.tenantId]), /permission denied for table owner_surface_cursors/u);
    } finally {
      await web.end();
      await admin.end();
    }
  }, { port: PORT, allowedPorts: [PORT, PORT + 1, PORT + 2, PORT + 3, PORT + 4,
    PORT + 5, PORT + 6, PORT + 7, PORT + 8, PORT + 9], boundMs: 240_000 });
});
