// R4F-06 on real PostgreSQL: a renewal queued before its predecessor's expiry
// must not publish a live successor after that expiry. `rotate()` used to
// capture `now` in application code, outside its transaction; a pool-
// connection or row-lock delay crossing the boundary let a credential stamped
// from a stale, pre-expiry timestamp be born already expired-but-active,
// outliving the revocation it should have respected. The fix captures `now`
// from `statement_timestamp()` inside the SELECT ... FOR UPDATE that locks
// the predecessor, so the authority check and the stamp use one database
// clock reading rather than a second, possibly later, one.
//
// Run AS the production fleet-gateway login, with only the grants
// db/roles/fleet_gateway_roles.sql gives it, on this file's reserved
// disposable port lane (59610-59619), or the test runner's assigned port
// block so concurrent runs never collide.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, PROJECT_A, ownerIdentity, seedFleetTenant } from "./support/fleet-fixture";
import * as c from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59610);
const PG = requiresRealPostgres();
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

test("R4F-06: a renewal queued before expiry must not publish a live successor after expiry", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async pg => {
    const admin = new Client(pg.admin({ database: pg.database }));
    const fleet = pool(pg, "fleet"), ownerDb = pool(pg, "fleetOwner");
    await admin.connect();
    let release!: () => void, entered!: () => void, armed = false;
    const gate = new Promise<void>(done => { release = done; });
    const started = new Promise<void>(done => { entered = done; });
    const db = fleet.client;
    // Delays the FIRST transaction this store opens -- modelling a renewal
    // whose pool connection or transaction start is queued -- and resumes it
    // only once the test has confirmed the real database clock has passed
    // the credential's expiry. Every later transaction runs unmodified.
    const delayed: DatabaseClient = {
      query: db.query.bind(db),
      transaction: async <T>(body: (tx: DatabaseSession) => Promise<T>) => {
        if (armed) { armed = false; entered(); await gate; }
        return db.transaction(body);
      },
      transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
    };
    let pending: Promise<{ accepted: boolean; error?: unknown }> | undefined;
    try {
      await seedFleetTenant((sql, params) => admin.query(sql, params));
      assert.equal((await db.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user, "control_room_fleet");
      const gateway = new FleetGatewayStoreV1(delayed, { tenantId: FLEET_TENANT, operationsMode: async () => "running" });
      const owner = new FleetOwnerServiceV1(ownerDb.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Expiry fixture", workerKind: "mcp-agent",
        projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
      const secret = c.newSecret();
      const worker = await gateway.enroll({ code: code.code, workerKind: "mcp-agent", credentialDigest: c.sha256(secret),
        platform: "linux", architecture: "x64", connectorVersion: c.CONNECTOR_VERSION, clientNonce: c.newEnrollmentNonce() });
      // Administrator fixture surgery only, to put the credential seconds from
      // expiry. The production expiry trigger is restored before the measured
      // rotate() call below -- it is part of what this test is proving.
      await admin.query("ALTER TABLE fleet_worker_credentials DISABLE TRIGGER fleet_worker_credentials_guard");
      try {
        await admin.query(`UPDATE fleet_worker_credentials SET expires_at=statement_timestamp()+interval '2 seconds'
          WHERE tenant_id=$1 AND worker_id=$2 AND state='active'`, [FLEET_TENANT, worker.workerId]);
      } finally { await admin.query("ALTER TABLE fleet_worker_credentials ENABLE TRIGGER fleet_worker_credentials_guard"); }
      const principal = await gateway.authenticate({ bearer: secret, declaredWorkerId: worker.workerId });
      armed = true;
      pending = gateway.rotate(principal, { newCredentialDigest: c.sha256(c.newSecret()) })
        .then(() => ({ accepted: true }), error => ({ accepted: false, error }));
      await started;
      // Poll the real database clock -- not this process's -- until the
      // predecessor is genuinely expired, then let the queued renewal proceed.
      for (;;) {
        const expired = (await db.query<{ expired: boolean }>(`SELECT expires_at<=statement_timestamp() AS expired
          FROM fleet_worker_credentials WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, principal.credentialId])).rows[0]?.expired;
        if (expired) break;
        await sleep(20);
      }
      release();
      const result = await pending;
      const active = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM fleet_worker_credentials
        WHERE tenant_id=$1 AND worker_id=$2 AND state='active' AND expires_at>statement_timestamp()`, [FLEET_TENANT, worker.workerId])).rows[0]?.n;
      assert.equal(result.accepted, false, "renewal must recheck expiry after acquiring its database connection/lock");
      assert.equal(active, "0", "no unexpired active successor may exist after the predecessor expired");
    } finally {
      release(); await pending;
      await Promise.allSettled([fleet.close(), ownerDb.close(), admin.end()]);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 90_000 });
});
