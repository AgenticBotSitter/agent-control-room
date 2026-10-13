// R4F-06 on real PostgreSQL: a renewal (`rotate()`) must not publish a live
// successor after its predecessor credential expired.
//
// The defect: a successor stamped from a clock reading taken BEFORE a wait
// (a pool connection, the credential row lock, the tenant audit chain head
// lock, a foreign-key check on fleet_workers) passed migration 0141's
// `prior.expires_at > NEW.issued_at` guard even though the predecessor had
// expired by the time the transaction committed.
//
// The fix, in `rotate()`: the row lock is its own statement with no clock; the
// next statement stamps `ended_at = statement_timestamp()` (after the lock) and
// the successor reuses that exact database text, in microseconds; and the LAST
// statement before COMMIT, after the audit append, re-reads the predecessor's
// expiry against a fresh reading and rolls the renewal back if it has passed.
// What this does not close: the COMMIT itself, which cannot be guarded without
// a deferred commit-time trigger (a migration).
//
// Which case guards what:
//   R4F-06  an older bug only: `now` captured in application code before the
//           transaction started (it also passes on the stamp-after-lock code).
//   R4F-06b expiry between the lock request and the lock grant (the credential row lock).
//   R4F-06g expiry during a wait AFTER the stamp (audit chain head lock, worker row lock).
//   R4F-06c unexpired renewals that wait still succeed, with the database's exact stamp.
//   R4F-06d/e/f interruption, thirty contenders, and the same-millisecond boundary.
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

test("R4F-06: a renewal whose transaction start is delayed past the expiry in application code is refused (guards the old application-clock stamp)", async t => {
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

// ---------------------------------------------------------------------------
// R4F-06b: the stamp must be the database clock AFTER the credential row lock,
// at full microsecond precision.
//
// R4F-06 above delays the transaction in application code, so it can only hit
// the boundary by luck of timing. These cases place the expiry EXACTLY, from
// the rotate statement's own recorded start time, by holding the credential row
// lock from an administrator session while the real `rotate()` waits on it.
// Production would reach the same state through any concurrent writer on that
// row (an owner revocation, a second renewal) or a slow connection.
//
// Expected outcomes are independent of the code under test: the database
// clock (`clock_timestamp()`), the rows read back as the administrator, and the
// production fleet login's own `authenticate`.
// ---------------------------------------------------------------------------

type Rig = { pg: RealPostgres; db: DatabaseClient; gateway: FleetGatewayStoreV1; owner: FleetOwnerServiceV1;
  newAdmin: () => Promise<Client> };

async function withRig(body: (rig: Rig) => Promise<void>) {
  await withRealPostgres(async pg => {
    const admin = new Client(pg.admin({ database: pg.database }));
    const fleet = pool(pg, "fleet"), ownerDb = pool(pg, "fleetOwner");
    const extra: Client[] = [];
    await admin.connect();
    try {
      await seedFleetTenant((sql, params) => admin.query(sql, params));
      assert.equal((await fleet.client.query<{ current_user: string }>("SELECT current_user")).rows[0]?.current_user, "control_room_fleet");
      const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT, operationsMode: async () => "running" });
      const owner = new FleetOwnerServiceV1(ownerDb.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      await body({ pg, db: fleet.client, gateway, owner, newAdmin: async () => {
        const client = new Client(pg.admin({ database: pg.database }));
        extra.push(client); await client.connect(); return client;
      } });
    } finally {
      await Promise.allSettled([fleet.close(), ownerDb.close(), admin.end(), ...extra.map(client => client.end())]);
    }
  }, { port: PORT + 1, allowedPorts: [PORT + 1], boundMs: 150_000 });
}

let enrolled = 0;
async function enrollWorker(rig: Rig) {
  const code = await rig.owner.createEnrollmentCode(ownerIdentity(), { displayName: `Expiry fixture ${++enrolled}`, workerKind: "mcp-agent",
    projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
  const secret = c.newSecret();
  const worker = await rig.gateway.enroll({ code: code.code, workerKind: "mcp-agent", credentialDigest: c.sha256(secret),
    platform: "linux", architecture: "x64", connectorVersion: c.CONNECTOR_VERSION, clientNonce: c.newEnrollmentNonce() });
  const principal = await rig.gateway.authenticate({ bearer: secret, declaredWorkerId: worker.workerId });
  return { worker, secret, principal };
}

const sleepFor = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** Waits until exactly one statement of the fleet login is blocked on a lock and
 * its text matches `queryPattern` (an ILIKE pattern), and returns its pid. Fails
 * loudly, with what the sessions were doing, when nothing ever parks. */
async function waitUntilParked(lock: Client, rotation: Promise<unknown>, queryPattern: string) {
  let pid = 0;
  for (let attempt = 0; attempt < 500 && !pid; attempt += 1) {
    // pg_stat_activity is snapshotted once per transaction; the lock session is in one, so drop the snapshot before every look.
    await lock.query("SELECT pg_stat_clear_snapshot()");
    const rows = (await lock.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE usename='control_room_fleet'
      AND wait_event_type='Lock' AND query ILIKE $1`, [queryPattern])).rows;
    if (rows.length > 1) throw new Error("expected exactly one blocked fleet statement");
    pid = rows[0]?.pid ?? 0;
    if (!pid) await sleepFor(10);
  }
  if (!pid) {
    const settled = await Promise.race([rotation, sleepFor(50).then(() => "still pending")]);
    const seen = (await lock.query(`SELECT state,wait_event_type,left(query,50) AS q FROM pg_stat_activity WHERE usename='control_room_fleet'`)).rows;
    assert.fail(`rotate() never blocked on ${queryPattern}; rotation: ${JSON.stringify(settled, (_k, v) => v instanceof Error ? `${v.name}:${(v as { code?: string }).code}` : v)}; sessions: ${JSON.stringify(seen)}`);
  }
  return pid;
}

/** Holds the predecessor's row lock from an administrator session, starts the
 * real `rotate()`, and returns once its locked read is genuinely blocked. The
 * blocked statement's start time comes from pg_stat_activity, which was probed
 * on PG17 to equal that backend's statement_timestamp() to the microsecond. */
async function rotateBlockedOnRowLock(rig: Rig, principal: Awaited<ReturnType<typeof enrollWorker>>["principal"]) {
  const lock = await rig.newAdmin();
  await lock.query("BEGIN");
  // Administrator fixture surgery without a table lock: replica role skips the
  // production credential guard so the fixture can place expires_at exactly.
  await lock.query("SET LOCAL session_replication_role = replica");
  await lock.query(`SELECT 1 FROM fleet_worker_credentials WHERE tenant_id=$1 AND credential_id=$2 FOR UPDATE`,
    [FLEET_TENANT, principal.credentialId]);
  const successorSecret = c.newSecret();
  const startedAt = Date.now();
  const rotation = rig.gateway.rotate(principal, { newCredentialDigest: c.sha256(successorSecret) })
    .then(() => ({ accepted: true as const, afterMs: Date.now() - startedAt }), error => ({ accepted: false as const, error, afterMs: Date.now() - startedAt }));
  const pid = await waitUntilParked(lock, rotation, "%fleet_worker_credentials%FOR UPDATE%");
  return { lock, rotation, pid, successorSecret };
}

async function worldAfter(rig: Rig, admin: Client, workerId: string, predecessor: string) {
  const rows = (await admin.query<{ credential_id: string; state: string; live: boolean }>(`SELECT credential_id,state,
    (state='active' AND expires_at>clock_timestamp()) AS live FROM fleet_worker_credentials
    WHERE tenant_id=$1 AND worker_id=$2 ORDER BY issued_at`, [FLEET_TENANT, workerId])).rows;
  return { rows, predecessor: rows.find(row => row.credential_id === predecessor),
    successors: (await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM fleet_worker_credentials
      WHERE tenant_id=$1 AND rotated_from_credential_id=$2`, [FLEET_TENANT, predecessor])).rows[0]?.n };
}

// offsetMs is where the expiry sits relative to the blocked statement's own
// start time t0: negative = already expired when the statement began (including
// the sub-millisecond band a millisecond-truncated stamp falls below),
// positive = expires while the statement waits for the lock.
const EXPIRY_OFFSETS_MS = [-20, -1, -0.9, -0.1, -0.001, 0, 0.001, 0.1, 0.9, 1, 20];

test("R4F-06b: a renewal blocked on the credential lock is refused when the expiry falls anywhere before the lock is granted", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRig(async rig => {
    const admin = await rig.newAdmin();
    const outcomes: Array<Record<string, unknown>> = [];
    for (const offsetMs of EXPIRY_OFFSETS_MS) {
      const { worker, principal } = await enrollWorker(rig);
      const { lock, rotation, pid, successorSecret } = await rotateBlockedOnRowLock(rig, principal);
      try {
        await lock.query(`UPDATE fleet_worker_credentials SET expires_at=v.at, issued_at=v.at - interval '1 hour'
          FROM (SELECT query_start + ($4::float8 * interval '1 millisecond') AS at FROM pg_stat_activity WHERE pid=$3) v
          WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, principal.credentialId, pid, offsetMs]);
        // Let the real database clock pass the expiry, then free the lock.
        // Read through the lock-holding session: it alone sees its uncommitted expires_at.
        let passed = false;
        for (let attempt = 0; attempt < 2000 && !passed; attempt += 1) {
          passed = (await lock.query<{ passed: boolean }>(`SELECT clock_timestamp()>expires_at+interval '5 milliseconds' AS passed
            FROM fleet_worker_credentials WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, principal.credentialId])).rows[0]?.passed === true;
          if (!passed) await sleepFor(5);
        }
        assert.ok(passed, `${offsetMs} ms: the database clock never passed the placed expiry`);
      } finally { await lock.query("COMMIT"); }
      const result = await rotation;
      const world = await worldAfter(rig, admin, worker.workerId, principal.credentialId);
      // The production fleet login agrees: the secret the renewal would have issued must not authenticate.
      const login = await rig.gateway.authenticate({ bearer: successorSecret, declaredWorkerId: worker.workerId }).then(() => "accepted", () => "refused");
      outcomes.push({ offsetMs, accepted: result.accepted, successors: world.successors,
        liveCredentials: world.rows.filter(row => row.live).length, predecessorState: world.predecessor?.state, login });
    }
    // Reported together so a failure shows every offset, not just the first.
    assert.deepEqual(outcomes, EXPIRY_OFFSETS_MS.map(offsetMs => ({ offsetMs, accepted: false, successors: "0", liveCredentials: 0,
      predecessorState: "active", login: "refused" })), "every renewal blocked across the expiry must be refused and leave no live credential");
  });
});

// ---------------------------------------------------------------------------
// R4F-06g: waits AFTER the successor's stamp. `rotate()` still takes two locks
// once the stamp (and 0141's guard) are behind it: the tenant-wide audit chain
// head (appendAuditWith) and, through the INSERT's foreign key, a key-share lock
// on the fleet_workers row, which an owner rekey or revocation holds. A renewal
// parked there across the predecessor's expiry has already passed the guard.
// The last statement before COMMIT must refuse it. The expiry is placed 1 s
// ahead, the renewal is confirmed parked while it is still in the future, and
// the lock is released only after the database clock is 50 ms past it.
// ---------------------------------------------------------------------------
const LATER_LOCKS = [
  { name: "audit chain head", lockSql: "SELECT 1 FROM control_audit_chain_heads WHERE tenant_id=$1 FOR UPDATE",
    lockParams: (_workerId: string) => [FLEET_TENANT], parked: "%control_audit_chain_heads%FOR UPDATE%" },
  { name: "worker row", lockSql: "SELECT 1 FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2 FOR UPDATE",
    lockParams: (workerId: string) => [FLEET_TENANT, workerId], parked: "%INSERT INTO fleet_worker_credentials%" },
];

test("R4F-06g: a renewal parked on a lock taken after its stamp is refused when the predecessor expires during the wait", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRig(async rig => {
    const admin = await rig.newAdmin();
    const outcomes: Array<Record<string, unknown>> = [];
    const expected: Array<Record<string, unknown>> = [];
    for (const later of LATER_LOCKS) {
      for (const crossesExpiry of [true, true, false]) {
        const { worker, principal } = await enrollWorker(rig);
        if (crossesExpiry) {
          await admin.query("BEGIN");
          await admin.query("SET LOCAL session_replication_role = replica");
          await admin.query(`UPDATE fleet_worker_credentials SET expires_at=clock_timestamp()+interval '1000 milliseconds'
            WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, principal.credentialId]);
          await admin.query("COMMIT");
        }
        const lock = await rig.newAdmin();
        await lock.query("BEGIN");
        await lock.query(later.lockSql, later.lockParams(worker.workerId));
        const successorSecret = c.newSecret();
        const rotation = rig.gateway.rotate(principal, { newCredentialDigest: c.sha256(successorSecret) })
          .then(() => ({ accepted: true as const }), (error: { code?: string }) => ({ accepted: false as const, code: error?.code }));
        try {
          await waitUntilParked(lock, rotation, later.parked);
          if (crossesExpiry) {
            // Parked behind the later lock means the stamp and the guard are already behind it: the expiry must still be ahead.
            const ahead = (await admin.query<{ ahead: boolean }>(`SELECT expires_at>clock_timestamp() AS ahead FROM fleet_worker_credentials
              WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, principal.credentialId])).rows[0]?.ahead;
            assert.equal(ahead, true, `${later.name}: the renewal parked after the expiry had already passed; the case would not exercise the post-stamp wait`);
            let passed = false;
            for (let attempt = 0; attempt < 1000 && !passed; attempt += 1) {
              passed = (await admin.query<{ passed: boolean }>(`SELECT clock_timestamp()>expires_at+interval '50 milliseconds' AS passed
                FROM fleet_worker_credentials WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, principal.credentialId])).rows[0]?.passed === true;
              if (!passed) await sleepFor(5);
            }
            assert.ok(passed, `${later.name}: the database clock never passed the placed expiry`);
          } else { await sleepFor(100); }
        } finally { await lock.query("COMMIT"); }
        const result = await rotation;
        const world = await worldAfter(rig, admin, worker.workerId, principal.credentialId);
        const login = await rig.gateway.authenticate({ bearer: successorSecret, declaredWorkerId: worker.workerId }).then(() => "accepted", () => "refused");
        outcomes.push({ lock: later.name, crossesExpiry, accepted: result.accepted, code: "code" in result ? result.code : undefined,
          successors: world.successors, liveCredentials: world.rows.filter(row => row.live).length, predecessorState: world.predecessor?.state, login });
        expected.push(crossesExpiry
          ? { lock: later.name, crossesExpiry, accepted: false, code: "unauthenticated", successors: "0", liveCredentials: 0, predecessorState: "active", login: "refused" }
          : { lock: later.name, crossesExpiry, accepted: true, code: undefined, successors: "1", liveCredentials: 1, predecessorState: "retired", login: "accepted" });
      }
    }
    assert.deepEqual(outcomes, expected, "a renewal that waits after its stamp must be refused when the predecessor expired meanwhile, and still succeed when it did not");
  });
});

/** Wraps the real store connection and records every statement a transaction
 * runs, with the rows it returned, so a test can compare what the store sent
 * with what PostgreSQL itself said. Records only; never alters a statement. */
function recording(db: DatabaseClient) {
  const log: Array<{ sql: string; params: unknown[]; rows: unknown[] }> = [];
  const client: DatabaseClient = {
    query: db.query.bind(db),
    transaction: body => db.transaction(tx => body({
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const result = await tx.query<T>(sql, params); log.push({ sql, params, rows: result.rows }); return result;
      },
    })),
    transactionWithPreCommitCheck: db.transactionWithPreCommitCheck.bind(db),
  };
  return { client, log };
}

const THIRTY_DAYS_MS = 30 * 86_400_000;

test("R4F-06c: an unexpired renewal that waits on the credential lock still succeeds once, with the database's exact stamp", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRig(async rig => {
    const admin = await rig.newAdmin();
    for (const round of [1, 2, 3, 4, 5]) {
      const recorder = recording(rig.db);
      const gateway = new FleetGatewayStoreV1(recorder.client, { tenantId: FLEET_TENANT, operationsMode: async () => "running" });
      const { worker, principal } = await enrollWorker({ ...rig, gateway });
      const lock = await rig.newAdmin();
      await lock.query("BEGIN");
      await lock.query(`SELECT 1 FROM fleet_worker_credentials WHERE tenant_id=$1 AND credential_id=$2 FOR UPDATE`, [FLEET_TENANT, principal.credentialId]);
      const successorSecret = c.newSecret();
      recorder.log.length = 0;
      const rotation = gateway.rotate(principal, { newCredentialDigest: c.sha256(successorSecret) });
      await waitUntilParked(lock, rotation, "%fleet_worker_credentials%FOR UPDATE%"); // the renewal really is parked on the lock
      await lock.query("COMMIT"); await lock.end();
      const reply = await rotation;
      const rows = (await admin.query<{ credential_id: string; state: string; issued_at: string; ended_at: string | null;
        lifetime_ms: string; expires_iso: string; live: boolean }>(`SELECT credential_id,state,issued_at::text,ended_at::text,
        (extract(epoch FROM expires_at-issued_at)*1000)::bigint::text AS lifetime_ms,
        to_char(date_trunc('milliseconds',expires_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_iso,
        (state='active' AND expires_at>clock_timestamp()) AS live
        FROM fleet_worker_credentials WHERE tenant_id=$1 AND worker_id=$2 ORDER BY issued_at`, [FLEET_TENANT, worker.workerId])).rows;
      assert.equal(rows.length, 2, `round ${round}: predecessor and exactly one successor`);
      const [predecessor, successor] = rows;
      assert.equal(predecessor?.state, "retired");
      assert.equal(successor?.live, true, "the renewal of an unexpired credential must leave one live credential");
      assert.equal(rows.filter(row => row.live).length, 1);
      // Independent expected values: a literal 30-day lifetime, and the database's own text of the two instants.
      assert.equal(successor?.lifetime_ms, String(THIRTY_DAYS_MS), "successor lifetime is exactly thirty days");
      assert.equal(successor?.issued_at, predecessor?.ended_at, "the successor is issued at the exact instant the predecessor ended");
      assert.equal(reply.credentialExpiresAt, successor?.expires_iso, "the reply states the stored expiry");
      // What the store sent is what PostgreSQL said: the stamp is carried as the database's own text, never through a JavaScript Date.
      const retireStatement = recorder.log.find(entry => /state='retired'/u.test(entry.sql));
      const insertStatement = recorder.log.find(entry => /INSERT INTO fleet_worker_credentials/u.test(entry.sql));
      const stamp = (retireStatement?.rows[0] as { stamp?: string } | undefined)?.stamp;
      assert.equal(typeof stamp, "string");
      assert.equal((await admin.query<{ same: boolean }>(`SELECT $1::timestamptz=ended_at AS same FROM fleet_worker_credentials
        WHERE tenant_id=$2 AND credential_id=$3`, [stamp, FLEET_TENANT, principal.credentialId])).rows[0]?.same, true,
      "the retiring UPDATE returned the stored ended_at, to the microsecond");
      assert.equal(insertStatement?.params[4], stamp, "issued_at sent to the INSERT is the database's exact text");
      const audit = (await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE tenant_id=$1
        AND action='fleet.credential.rotated' AND target_id=$2 AND occurred_at=date_trunc('milliseconds',$3::timestamptz)`,
      [FLEET_TENANT, worker.workerId, predecessor?.ended_at])).rows[0]?.n;
      assert.equal(audit, "1", "the audit event is stamped with the retirement instant");
      await gateway.authenticate({ bearer: successorSecret, declaredWorkerId: worker.workerId });
    }
  });
});

test("R4F-06f: a successor stamped within the same millisecond as the expiry, but after it, is refused", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRig(async rig => {
    const admin = await rig.newAdmin();
    const outcomes: Array<Record<string, unknown>> = [];
    let aligned = 0;
    const ATTEMPTS = 20;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const { worker, principal } = await enrollWorker(rig);
      // X is a whole millisecond about 300 ms ahead; the expiry sits half a millisecond past it.
      const boundary = (await admin.query<{ x: string }>(`SELECT (date_trunc('milliseconds',clock_timestamp())+interval '300 milliseconds')::text AS x`)).rows[0]!.x;
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(`UPDATE fleet_worker_credentials SET expires_at=$3::timestamptz+interval '0.5 millisecond',
        issued_at=$3::timestamptz+interval '0.5 millisecond'-interval '1 hour' WHERE tenant_id=$1 AND credential_id=$2`,
      [FLEET_TENANT, principal.credentialId, boundary]);
      await admin.query("COMMIT");
      let stamp: string | undefined;
      // Only this wrapper waits, in the renewal's own transaction, until the database clock is 0.6 ms past X, so the
      // retiring statement starts after the expiry but inside the same millisecond. It sends no altered statement.
      const waiting: DatabaseClient = { query: rig.db.query.bind(rig.db),
        transactionWithPreCommitCheck: rig.db.transactionWithPreCommitCheck.bind(rig.db),
        transaction: body => rig.db.transaction(tx => body({
          query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            if (/state='retired'/u.test(sql)) {
              for (let spin = 0; spin < 200_000; spin += 1) {
                if ((await tx.query<{ ok: boolean }>(`SELECT clock_timestamp() >= $1::timestamptz+interval '0.6 millisecond' AS ok`, [boundary])).rows[0]?.ok) break;
              }
            }
            const result = await tx.query<T>(sql, params);
            if (/state='retired'/u.test(sql)) stamp = (result.rows[0] as { stamp?: string } | undefined)?.stamp;
            return result;
          } })) };
      const gateway = new FleetGatewayStoreV1(waiting, { tenantId: FLEET_TENANT, operationsMode: async () => "running" });
      const successorSecret = c.newSecret();
      const result = await gateway.rotate(principal, { newCredentialDigest: c.sha256(successorSecret) })
        .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }));
      const world = await worldAfter(rig, admin, worker.workerId, principal.credentialId);
      outcomes.push({ attempt, accepted: result.accepted, successors: world.successors, predecessorState: world.predecessor?.state });
      if (stamp !== undefined && (await admin.query<{ same_ms: boolean }>(`SELECT $1::timestamptz >= $2::timestamptz+interval '0.5 millisecond'
        AND $1::timestamptz < $2::timestamptz+interval '1 millisecond' AS same_ms`, [stamp, boundary])).rows[0]?.same_ms) aligned += 1;
    }
    assert.deepEqual(outcomes, Array.from({ length: ATTEMPTS }, (_, index) => ({ attempt: index + 1, accepted: false, successors: "0",
      predecessorState: "active" })), "a renewal stamped after the expiry must be refused even inside the expiry's own millisecond");
    assert.ok(aligned >= 1, `no attempt landed inside the expiry's millisecond (${aligned}/${ATTEMPTS}); the case did not exercise the boundary`);
  });
});

test("R4F-06d: a renewal interrupted while parked on the lock leaves nothing behind and can be retried", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRig(async rig => {
    const admin = await rig.newAdmin();
    const { worker, principal } = await enrollWorker(rig);
    const { lock, rotation, pid } = await rotateBlockedOnRowLock(rig, principal);
    try {
      assert.equal((await lock.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [pid])).rows[0]?.ok, true);
      const result = await rotation;
      assert.equal(result.accepted, false, "a renewal whose backend died must not report success");
    } finally { await lock.query("COMMIT"); }
    const after = await worldAfter(rig, admin, worker.workerId, principal.credentialId);
    assert.equal(after.successors, "0");
    assert.equal(after.predecessor?.state, "active");
    // A transport failure quarantines the whole bounded pool (src/web/v1/bounded-database.ts), so the retry is a fresh pool, as after a process restart.
    const restarted = pool(rig.pg, "fleet");
    try {
      const retry = await new FleetGatewayStoreV1(restarted.client, { tenantId: FLEET_TENANT, operationsMode: async () => "running" })
        .rotate(principal, { newCredentialDigest: c.sha256(c.newSecret()) });
      assert.ok(retry.credentialExpiresAt);
    } finally { await restarted.close(); }
    const final = await worldAfter(rig, admin, worker.workerId, principal.credentialId);
    assert.equal(final.successors, "1");
    assert.equal(final.rows.filter(row => row.live).length, 1);
  });
});

test("R4F-06e: thirty renewals of one credential at once yield one successor; thirty at the expiry yield none", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRig(async rig => {
    const admin = await rig.newAdmin();
    const refusal = async (promise: Promise<unknown>) => promise.then(() => "accepted", (error: { code?: string }) => error?.code ?? String(error));
    // Live credential: exactly one of thirty wins; the other twenty-nine are told unauthenticated.
    const live = await enrollWorker(rig);
    const liveOutcomes = await Promise.all(Array.from({ length: 30 }, () =>
      refusal(rig.gateway.rotate(live.principal, { newCredentialDigest: c.sha256(c.newSecret()) }))));
    // The production pool admits 8 and queues 8 more; the rest are refused at once as database_unavailable, which is overload, not an answer about the credential.
    assert.equal(liveOutcomes.filter(outcome => outcome === "accepted").length, 1, `outcomes: ${liveOutcomes.join(",")}`);
    assert.deepEqual([...new Set(liveOutcomes.filter(outcome => outcome !== "accepted"))].filter(outcome => outcome !== "database_unavailable"), ["unauthenticated"]);
    const liveWorld = await worldAfter(rig, admin, live.worker.workerId, live.principal.credentialId);
    assert.equal(liveWorld.successors, "1");
    assert.equal(liveWorld.rows.filter(row => row.live).length, 1);
    // Credential that expires while thirty renewals are parked on its lock: none may win.
    const expiring = await enrollWorker(rig);
    const lock = await rig.newAdmin();
    await lock.query("BEGIN");
    await lock.query("SET LOCAL session_replication_role = replica");
    await lock.query(`SELECT 1 FROM fleet_worker_credentials WHERE tenant_id=$1 AND credential_id=$2 FOR UPDATE`, [FLEET_TENANT, expiring.principal.credentialId]);
    const burst = Array.from({ length: 30 }, () => refusal(rig.gateway.rotate(expiring.principal, { newCredentialDigest: c.sha256(c.newSecret()) })));
    const POOL_MAX = 8; // privatePgOptions().max: the most renewals that can be parked on the lock at once
    // Wait until the number parked stops growing: connections open one by one, so the count settles somewhere up to the pool size.
    let parked = 0, steady = 0;
    for (let attempt = 0; attempt < 1000 && steady < 30; attempt += 1) {
      await lock.query("SELECT pg_stat_clear_snapshot()");
      const now = Number((await lock.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE usename='control_room_fleet'
        AND wait_event_type='Lock' AND query ILIKE '%FOR UPDATE%' AND query ILIKE '%fleet_worker_credentials%'`)).rows[0]?.n);
      steady = now > parked ? 0 : steady + 1; parked = Math.max(parked, now);
      await sleepFor(10);
    }
    assert.equal(parked, POOL_MAX, "a full pool of renewals must be parked on the credential lock");
    await lock.query(`UPDATE fleet_worker_credentials SET expires_at=clock_timestamp()+interval '300 milliseconds',
      issued_at=clock_timestamp()-interval '1 hour' WHERE tenant_id=$1 AND credential_id=$2`, [FLEET_TENANT, expiring.principal.credentialId]);
    await sleepFor(400); // under the production lock_timeout of 2 s, past the 300 ms expiry
    await lock.query("COMMIT");
    const expiredOutcomes = await Promise.all(burst);
    assert.equal(expiredOutcomes.filter(outcome => outcome === "accepted").length, 0, `outcomes: ${expiredOutcomes.join(",")}`);
    const expiredWorld = await worldAfter(rig, admin, expiring.worker.workerId, expiring.principal.credentialId);
    assert.equal(expiredWorld.successors, "0");
    assert.equal(expiredWorld.rows.filter(row => row.live).length, 0);
    const deadlocks = (await admin.query<{ deadlocks: string }>(`SELECT deadlocks::text FROM pg_stat_database WHERE datname=$1`, [rig.pg.database])).rows[0]?.deadlocks;
    assert.equal(deadlocks, "0", "the lock order must not deadlock under thirty contenders");
  });
});
