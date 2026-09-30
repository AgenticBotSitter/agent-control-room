// Regression test (from the connonly round-5 Opus review probe).
//
// Does the fleet release path, which now takes the tenant mutex AFTER locking
// its job/attempt/lease rows, deadlock against a coordinator-shaped
// transaction that takes the mutex FIRST and then locks the same lease
// (task-assignment-coordinator.ts native assignment: mutex -> ... -> FOR UPDATE OF l)?
//
// Measured on 83fc9a1c0 (3 rounds each):
//   branch as shipped (mutex NO KEY UPDATE, taken after row locks)  -> deadlocks=3, coordinator 40P01 x3
//   old world (both sides FOR UPDATE; PROBE_COORD_MUTEX="FOR UPDATE") -> deadlocks=0
//   branch + #tenantMutex moved before readFleetEntityV1 in blocker  -> deadlocks=0 (5 rounds)
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59420) + 9;
const PG = requiresRealPostgres();
const COORD_MUTEX = process.env.PROBE_COORD_MUTEX ?? "FOR NO KEY UPDATE";

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

test("probe: fleet release vs coordinator-shaped mutex-then-lease", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    let hookArmed = false;
    let hookHit: (() => void) | undefined; let hookRelease: (() => void) | undefined;
    let currentGate: Promise<void> = Promise.resolve();
    // Pause the release transaction just before it issues its tenant-mutex query.
    const hooked: DatabaseClient = {
      query: fleet.client.query.bind(fleet.client),
      transaction: work => fleet.client.transaction(tx => work({
        query: async (sql: string, params?: unknown[]) => {
          if (hookArmed && /FROM tenants WHERE id=\$1 FOR/u.test(sql)) {
            hookArmed = false; hookHit!(); await currentGate;
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
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "probe", workerKind: "codex",
        projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
      const connector: any = await import("../scripts/fleet/connector.mjs");
      const { createServer } = await import("node:http");
      const { createFleetGatewayHandlerV1, createFleetGatewayAdmissionV1 } = await import("../src/fleet/v1");
      const handler = createFleetGatewayHandlerV1({ store: gateway, admission: createFleetGatewayAdmissionV1({}) });
      const server = createServer((q, s) => { void handler.handle(q, s); });
      await new Promise<void>(d => server.listen(0, "127.0.0.1", d));
      const origin = `http://127.0.0.1:${(server.address() as any).port}`;
      const configPath = join(dir, "bot.json");
      await connector.join({ server: origin, code: code.code, workerKind: "codex", configPath });
      const config = await connector.loadConfig(configPath);
      const principal = await gateway.authenticate({ bearer: config.secret, declaredWorkerId: config.workerId });
      await new Promise(d => server.close(d));

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
        hookArmed = true;
        const releasing = gateway.blocker(principal, { claimId: claimed.claimId, message: "probe",
          idempotencyKey: `probe-block-${round}`, release: true }).then(v => `blocker ok ${JSON.stringify(v)}`,
          (e: any) => `blocker error ${e?.message} ${e?.sqlState ?? ""}`);
        await Promise.race([reached, new Promise(r => setTimeout(r, 5000))]);
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
        await new Promise(r => setTimeout(r, 300));
        hookRelease!();
        outcomes.push(`hook=${hitOnce}`, await coordRun, await releasing);
      }
      const after = await readDeadlocks();
      const retries = stderr.filter(line => line.includes("[fleet-gateway] contention"));
      process.stdout.write(`PROBE coordMutex=${COORD_MUTEX} deadlocks=${after - before} outcomes=${JSON.stringify(outcomes)} retries=${JSON.stringify(retries)}\n`);
      assert.equal(after - before, 0, "the fleet release path must not deadlock with a mutex-first coordinator transaction");
    } finally {
      (process.stderr as any).write = write;
      await Promise.all([admin.close(), fleet.close(), fleetOwner.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
});
