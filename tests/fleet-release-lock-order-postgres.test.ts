// Regression test (from the connonly round-5 Opus review probe).
//
// Does the fleet release path, which takes the tenant mutex BEFORE locking its
// job/attempt/lease rows, deadlock against a coordinator-shaped transaction
// that takes the mutex FIRST and then locks the same lease
// (task-assignment-coordinator.ts native assignment: mutex -> ... -> FOR UPDATE OF l)?
//
// Measured on 83fc9a1c0 (3 rounds each):
//   branch as shipped (mutex NO KEY UPDATE, taken after row locks)  -> deadlocks=3, coordinator 40P01 x3
//   old world (both sides FOR UPDATE; PROBE_COORD_MUTEX="FOR UPDATE") -> deadlocks=0
//   branch + #tenantMutex moved before readFleetEntityV1 in blocker  -> deadlocks=0 (5 rounds)
//
// The mutex must be the `FOR NO KEY UPDATE` form AND must be issued before the
// first `control_jobs` / `control_attempts` / `control_leases` `FOR UPDATE` in
// the SAME transaction. Both halves are asserted at runtime below, against
// the SQL the release path actually sends, so this test fails if the order
// regresses even though the static guard in fleet-connector.test.ts still
// passes. (TWO defects that each looked like "the test hangs" are fixed here:
// see SETUP and TEARDOWN below.)
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59420) + 9;
const PG = requiresRealPostgres();
const COORD_MUTEX = process.env.PROBE_COORD_MUTEX ?? "FOR NO KEY UPDATE";
// SETUP: the connector now REQUIRES a signed release to enroll. A handler built
// with `releaseTrust` alone advertises no release, so `join` refuses with
// "did not provide a valid installation release key" -- and on the merged tree
// that refusal was raised from inside the body, so every round below was
// unreachable and the deadlock assertion passed vacuously. The gateway must
// carry a release signed by the SAME trust it hands the connector; the fixture
// is built in the body's `try` below, next to the handler that serves it.
// Every bound is an environment override so a slower machine can widen it, and
// so the owner can shrink it to prove the guards fire (see the report).
// How long to wait for the hook before declaring the lock order untested.
const HOOK_WAIT_MS = Number(process.env.PROBE_HOOK_WAIT_MS ?? 10_000);
// Per-test ceiling. `test:fleet` sets no `--test-timeout`, so without this an
// unclosed handle here stalls the whole lane indefinitely (observed: 28
// minutes before anyone intervened). Kept above HOOK_WAIT_MS x rounds.
const TEST_TIMEOUT_MS = Number(process.env.PROBE_TEST_TIMEOUT_MS ?? 180_000);
// Whole-body bound, so a cluster is torn down even if the body overruns.
const BODY_BOUND_MS = Number(process.env.PROBE_BODY_BOUND_MS ?? 150_000);

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

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;
const flatten = (sql: string) => sql.replace(/\s+/gu, " ").trim();
/** Any tenant-mutex row lock the gateway can take. */
const isTenantLock = (sql: string) => /FROM tenants WHERE id=\$1 FOR/iu.test(sql);
/** The mutex exactly as it must be: NO KEY UPDATE, so it does not collide with
 * the `FOR KEY SHARE` an audit foreign-key check holds. */
const isWeakenedTenantLock = (sql: string) => /FROM tenants WHERE id=\$1 FOR UPDATE(?! NO KEY)/iu.test(sql);
/** The first job/attempt/lease row lock. A mutex issued after this one is the
 * deadlock cycle this test exists to catch. */
const isEntityRowLock = (sql: string) => /FROM control_(?:jobs|attempts|leases) WHERE .* FOR UPDATE/iu.test(sql);

test("probe: fleet release vs coordinator-shaped mutex-then-lease", { timeout: TEST_TIMEOUT_MS }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    let hookArmed = false;
    let hookHit: (() => void) | undefined; let hookRelease: (() => void) | undefined;
    let currentGate: Promise<void> = Promise.resolve();
    // Every statement the release transaction issues this round, in order.
    let issued: string[] = [];
    // Pause the release transaction just before it issues its tenant-mutex query.
    const hooked: DatabaseClient = {
      query: fleet.client.query.bind(fleet.client),
      transaction: work => fleet.client.transaction(tx => work({
        query: async (sql: string, params?: unknown[]) => {
          const statement = flatten(sql);
          issued.push(statement);
          if (hookArmed && isTenantLock(statement)) {
            hookArmed = false; hookHit?.(); await currentGate;
          }
          return tx.query(sql, params);
        } } as DatabaseSession)),
      transactionWithPreCommitCheck: fleet.client.transactionWithPreCommitCheck.bind(fleet.client),
    };
    const mode = { value: "running" as FleetOperationsModeV1 };
    const gateway = new FleetGatewayStoreV1(hooked, { tenantId: FLEET_TENANT, operationsMode: async () => mode.value });
    const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
    const stderr: string[] = []; const write = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => { stderr.push(String(chunk)); return write(chunk, ...rest); };
    const dir = await mkdtemp(join(tmpdir(), "probe5-"));
    // TEARDOWN: the gateway server is held here, not in a nested `await`, so a
    // failure anywhere in the body still closes it. Leaked earlier: the server
    // was closed by a statement AFTER `join`, so when `join` threw the handle
    // survived the body's `finally` and pinned the event loop open -- the
    // process could not exit, and the lane looked like a 28-minute hang rather
    // than a 15-second failure.
    let server: Server | undefined;
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const { connectorRelease, releaseTrust } = await buildSignedFleetConnectorReleaseForTestV1(
        { root: resolve(dir, "fleet"), builtFrom: "0".repeat(40) });
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "probe", workerKind: "codex",
        projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
      const connector: any = await import("../scripts/fleet/connector.mjs");
      const { createServer } = await import("node:http");
      const { createFleetGatewayHandlerV1, createFleetGatewayAdmissionV1 } = await import("../src/fleet/v1");
      const handler = createFleetGatewayHandlerV1({ store: gateway, admission: createFleetGatewayAdmissionV1({}),
        connectorRelease, releaseTrust });
      server = createServer((q, s) => { void handler.handle(q, s); });
      await listen(server);
      const origin = `http://127.0.0.1:${portOf(server)}`;
      const configPath = join(dir, "bot.json");
      await connector.join({ server: origin, code: code.code, workerKind: "codex", configPath });
      const config = await connector.loadConfig(configPath);
      const principal = await gateway.authenticate({ bearer: config.secret, declaredWorkerId: config.workerId });
      await close(server); server = undefined;

      const rounds = Number(process.env.PROBE_ROUNDS ?? 3);
      const readDeadlocks = async () => Number((await admin.client.query<{ d: string }>(
        "SELECT deadlocks::text AS d FROM pg_stat_database WHERE datname=current_database()")).rows[0].d);
      const before = await readDeadlocks();
      const outcomes: string[] = [];
      for (let round = 0; round < rounds; round += 1) {
        const task = await seedProposedTask(admin.client, PROJECT_A, `probe-${round}`);
        const offer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
        const claimed: any = await gateway.claim(principal, { offerId: offer.offerId, idempotencyKey: `probe-claim-${round}` });
        const lease = (await admin.client.query<{ lease_id: string }>("SELECT lease_id FROM fleet_claims WHERE claim_id=$1",
          [claimed.claimId])).rows[0].lease_id;
        let hitOnce = false;
        const reached = new Promise<void>(r => { hookHit = () => { hitOnce = true; r(); }; });
        currentGate = new Promise<void>(r => { hookRelease = r; });
        issued = [];
        hookArmed = true;
        const releasing = gateway.blocker(principal, { claimId: claimed.claimId, message: "probe",
          idempotencyKey: `probe-block-${round}`, release: true }).then(v => `blocker ok ${JSON.stringify(v)}`,
          (e: any) => `blocker error ${e?.message} ${e?.sqlState ?? ""}`);
        // A hook that is never reached used to fall through a bare race and let
        // the round -- and the deadlock assertion -- pass for the wrong reason.
        // It now fails, naming the round and the statements actually issued.
        const didReach = await Promise.race([reached.then(() => true), delay(HOOK_WAIT_MS).then(() => false)]);
        if (!didReach) {
          hookRelease!(); await releasing;
          assert.fail(`round ${round}: the release path issued no tenant-mutex row lock within ${HOOK_WAIT_MS}ms, `
            + `so the lock order is untested. Statements issued: ${JSON.stringify(issued)}`);
        }
        // Coordinator-shaped transaction, as the real coordinator login.
        const coord = new Client(postgres.connection("coordinator")); await coord.connect();
        const coordRun = (async () => {
          try {
            await coord.query("BEGIN");
            await coord.query(`SELECT id FROM tenants WHERE id=$1 ${COORD_MUTEX}`, [FLEET_TENANT]);
            await coord.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [FLEET_TENANT, lease]);
            await coord.query("COMMIT"); return "coord ok";
          } catch (e: any) { await coord.query("ROLLBACK").catch(() => {}); return `coord error ${e.code} ${e.message}`; }
          finally { await coord.end(); }
        })();
        await delay(300);
        hookRelease!();
        outcomes.push(`hook=${hitOnce}`, await coordRun, await releasing);
        // The order, asserted from the SQL the release path actually sent.
        const mutexAt = issued.findIndex(isTenantLock);
        const weakenedAt = issued.findIndex(isWeakenedTenantLock);
        const rowLockAt = issued.findIndex(isEntityRowLock);
        assert.equal(weakenedAt, -1,
          `round ${round}: the release path took the tenant mutex as FOR UPDATE; it must be FOR NO KEY UPDATE, `
          + `or the audit foreign-key checks deadlock against it again. Statement: ${issued[weakenedAt]}`);
        assert.ok(rowLockAt < 0 || mutexAt < rowLockAt,
          `round ${round}: the tenant mutex (statement ${mutexAt}) was taken AFTER the first job/attempt/lease row `
          + `lock (statement ${rowLockAt}); a coordinator holding the mutex and waiting on that row closes a deadlock `
          + `cycle. Statements: ${JSON.stringify(issued)}`);
      }
      const after = await readDeadlocks();
      const retries = stderr.filter(line => line.includes("[fleet-gateway] contention"));
      process.stdout.write(`PROBE coordMutex=${COORD_MUTEX} deadlocks=${after - before} outcomes=${JSON.stringify(outcomes)} retries=${JSON.stringify(retries)}\n`);
      assert.equal(after - before, 0, "the fleet release path must not deadlock with a mutex-first coordinator transaction");
    } finally {
      (process.stderr as any).write = write;
      // Always release a gate the body is parked on, then close the server
      // before the pools: a `close` on an open server is what keeps this lane
      // from outliving its own failure.
      hookArmed = false; hookRelease?.();
      if (server) { await close(server); server = undefined; }
      await Promise.all([admin.close(), fleet.close(), fleetOwner.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: BODY_BOUND_MS });
});
