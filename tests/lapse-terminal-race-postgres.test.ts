// Real-PostgreSQL proofs for the two lapse (0237) guards whose mutations were
// SURVIVING: a removed `l.state='active'` in the fleet revocation candidate
// query, and a widened state filter in `reconcileAttempt`'s FOR UPDATE re-check.
//
// # 1. The revocation pass's candidate filter is a BOUNDED-WINDOW guard.
//
// The obvious reading of `AND l.state='active'` -- "an already-terminal lease
// is never re-moved on a repeated reconcile" -- is already enforced one line
// later, by the re-read under `FOR UPDATE` at gateway-store.ts:1014, which
// skips any lease no longer active. A test aimed only there PASSES with the
// filter removed: the pass re-selects the row, the re-read skips it, and
// nothing observable changes. That was measured on real PostgreSQL, not
// assumed -- it is the first thing this lane tried, and the mutation survived
// it.
//
// What the filter really protects is the query's `ORDER BY fc.claimed_at
// LIMIT 50` window. `fleet_claims` is append-only -- nothing in this
// repository ever deletes a claim row -- so a machine that has churned through
// many tasks accumulates terminal claim rows forever. Fill that window with 50
// terminal rows and the one still-ACTIVE lease sits behind it: with the filter
// the window holds exactly the live lease; without it the window is full of
// dead rows, the live lease is never selected, and the owner's revocation
// leaves real work running on a machine that no longer exists. That is a
// data-integrity failure, not a wasted-work one -- which is why it survived.
//
// # 2. The supervisor's FOR UPDATE re-check is a WINNER-LOSER guard.
//
// `reconcileStalled` reads a candidate list with no locks, then each candidate
// is re-read under FOR UPDATE before anything is written. With that re-check
// widened to admit a `cancelled` attempt and an `orphaned` job, a sweep that
// loses the lock race proceeds against work a revocation already withdrew: it
// counts a lapse, writes three transition events, and raises a Needs-you item
// for something the owner took back on purpose.
//
// Every statement runs AS the production login that executes it in production:
// the fleet gateway login for the revocation pass and the coordinator login
// for the supervisor sweep, over TCP, with only the grants db/roles gives
// them. Superuser appears only in the tenant fixture seed, exactly as the
// shipped fleet lanes use it.
//
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved lane 59470-59471 (CONTROL_ROOM_PG_TEST_PORT_BASE moves it) and
// destroys it afterwards.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1,
  type FleetOperationsModeV1 } from "../src/fleet/v1";
import { SupervisorReconcilerV1 } from "../src/supervisor/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, PROJECT_B, seedFleetTenant,
  seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";

const PORTS = Object.freeze(Array.from({ length: 2 }, (_, index) =>
  Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59470) + index));
const PORT = PORTS[0];
const PG = requiresRealPostgres();

/** The revocation pass's own candidate window, verbatim from gateway-store.ts:995. */
const CANDIDATE_QUERY =
  `SELECT l.job_id,l.attempt_id,l.id AS lease_id FROM fleet_claims fc
      JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
     WHERE fc.tenant_id=$1 AND fc.worker_id=$2 AND l.state='active' ORDER BY fc.claimed_at LIMIT 50`;
/** The same window with the guard removed, exactly as the manifest mutation spells it. */
const MUTATED_CANDIDATE_QUERY = CANDIDATE_QUERY.replace(" AND l.state='active'", "");

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: admin.user,
    password: admin.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/**
 * Pulls a lease's expiry back so the supervisor's own `l.expires_at<=$3`
 * predicate admits it, AS the production login that owns that column.
 *
 * Two schema facts force this exact shape, and both were found the hard way:
 *
 *   - `control_leases` grants the fleet gateway login UPDATE on (expires_at,
 *     renewed_at) and NOTHING else, so `acquired_at` cannot be written here at
 *     all. The shipped lapse-stress lane's `acquired_at` write is superuser
 *     fixture surgery; this test does not need it.
 *   - 0003 checks `expires_at > acquired_at`, so an expiry pulled back to
 *     "30 seconds ago" is refused with 23514 whenever the lease was acquired
 *     less than 30 seconds ago -- which is always, in a test.
 *
 * `acquired_at + 1 second` satisfies both: it is inside the writable columns,
 * it stays after the acquisition, and it is genuinely in the past as soon as a
 * second of real time passes. The payload mirror moves with the column because
 * 0004's trigger compares both instants against the payload.
 */
async function ageLease(db: DatabaseClient, leaseId: string): Promise<void> {
  try {
    await db.query(`UPDATE control_leases SET expires_at=acquired_at+interval '1 second',
      payload=payload || jsonb_build_object('expiresAt', to_jsonb((acquired_at+interval '1 second')::timestamptz))
      WHERE id=$1`, [leaseId]);
  } catch (error) {
    // The bounded driver sanitizes the SQLSTATE onto the error, and a bare
    // `database_unavailable` would hide which statement was refused. The
    // fixture is the thing under diagnosis here, so the real state goes in the
    // message rather than being swallowed.
    throw new Error(`lease_ageing_refused:sqlstate=${(error as { sqlState?: string }).sqlState ?? "none"}`);
  }
  // A real, bounded wait for the lease's own one-second expiry. This is the
  // clock the database itself sets, not a sleep standing in for a race: the
  // assertions downstream depend on `expires_at` being in the past, and there
  // is no advisory-lock trick that can make a timestamp be in the past.
  await new Promise(done => setTimeout(done, 1_100));
}

/**
 * Reads one claim's canonical triple and the whole audit footprint the
 * revocation pass could have written.
 *
 * TWO production logins, because no single role holds both sets of grants and
 * the split is itself the evidence: `control_room_fleet_gateway` is granted
 * SELECT on fleet_claims, and `control_room_task_coordinator` is granted SELECT
 * on control_transition_events, control_outbox, control_assignment_lease_scopes
 * and control_supervisor_*. The private web role is granted neither the
 * transition-event table nor fleet_claims, so an assertion that leaned on a
 * superuser view would be testing a privilege production does not have.
 */
async function readClaimState(postgres: RealPostgres, claimId: string) {
  const fleet = new Client(postgres.connection("fleet"));
  await fleet.connect();
  let ids: { lease_id: string; attempt_id: string; job_id: string };
  try {
    const row = (await fleet.query("SELECT lease_id,attempt_id,job_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2",
      [FLEET_TENANT, claimId])).rows[0];
    assert.ok(row, "the claim row names exactly one lease, attempt and job");
    ids = row;
  } finally { await fleet.end(); }
  const coordinator = new Client(postgres.connection("coordinator"));
  await coordinator.connect();
  try {
    const triple = (await coordinator.query(`SELECT l.state AS lease_state,a.state AS attempt_state,j.state AS job_state,
      l.version AS lease_version,a.version AS attempt_version,j.version AS job_version
      FROM control_leases l JOIN control_attempts a ON a.tenant_id=l.tenant_id AND a.id=l.attempt_id
      JOIN control_jobs j ON j.tenant_id=l.tenant_id AND j.id=l.job_id
      WHERE l.tenant_id=$1 AND l.id=$2`, [FLEET_TENANT, ids.lease_id])).rows[0];
    assert.ok(triple, "the lease, attempt and job named by the claim all exist");
    const entities = [ids.lease_id, ids.attempt_id, ids.job_id];
    const events = (await coordinator.query<{ id: string }>(
      "SELECT id FROM control_transition_events WHERE tenant_id=$1 AND entity_id=ANY($2::text[]) ORDER BY id",
    [FLEET_TENANT, entities])).rows.map((row: { id: string }) => row.id);
    const outbox = (await coordinator.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_outbox WHERE tenant_id=$1 AND aggregate_id=ANY($2::text[])",
    [FLEET_TENANT, entities])).rows[0];
    const scopes = (await coordinator.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
    [FLEET_TENANT, ids.lease_id])).rows[0];
    return { ...triple, scopes: Number(scopes?.count), outbox: Number(outbox?.count), events };
  } finally { await coordinator.end(); }
}

test("the revocation pass's bounded candidate window still finds a live lease behind 50 terminal claims",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner"),
        coordinator = pool(postgres, "coordinator");
      const dir = await mkdtemp(join(tmpdir(), "lapse-window-"));
      const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
        builtFrom: "0".repeat(40) });
      const mode = { value: "running" as FleetOperationsModeV1 };
      const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT,
        operationsMode: async () => mode.value });
      // Wired with `afterDecision` exactly as the Mac-local composition wires
      // it: the owner's own revocation settles canonical state immediately, and
      // the gateway's timer repeats the pass.
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
        afterDecision: () => gateway.reconcile() });
      const handler = createFleetGatewayHandlerV1({ store: gateway, releaseTrust: release.releaseTrust,
        connectorRelease: release.connectorRelease, onUnexpectedError: error => { throw error; } });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await seedFleetTenant((sql, params) => admin.client.query(sql, params));

        // ONE project, not fifty. 0100's ownership-scope guard refuses two
        // LIVE leases whose scopes overlap, and a fleet task with no declared
        // scope holds the whole project tree -- but the blocker-release path
        // deletes the derived scope rows, so a finished task frees its project
        // immediately and the next task can be claimed there. Fifty SEQUENTIAL
        // tasks in one project is exactly how a real machine accumulates
        // terminal claim rows, and it keeps the worker inside the enrollment
        // cap of twenty project ids (`list(..., 20)` in owner-service.ts:61).
        const BURNT = 50;
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Lapse window worker",
          workerKind: "mcp-agent", projectIds: [PROJECT_A, PROJECT_B], capabilities: ["writing"],
          maxConcurrent: 8 });
        const configPath = join(dir, "worker.json");
        const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent", configPath });
        const worker = connector.createClient(await connector.loadConfig(configPath));

        // --- Fifty tasks the machine FINISHES, through the real product path:
        // claim, then release with a blocker, which moves the lease to
        // `released`, the attempt to `failed` and the job back to `ready`, and
        // drops the derived scope rows. These become the terminal claim rows
        // that fill the window. The capacity ceiling of eight is never reached,
        // because a released lease stops counting the moment it is released
        // (0234 counts only an `active`, unexpired lease).
        for (let index = 0; index < BURNT; index += 1) {
          const task = await seedProposedTask(admin.client, PROJECT_A, `lapse-burn-${index}`);
          const offer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId,
            capability: "writing" });
          const claim = await worker.claim(offer.offerId, `lapse-burn-claim-${String(index).padStart(4, "0")}`);
          await worker.blocker(claim.claimId, "done with this one, taking the next",
            `lapse-burn-block-${String(index).padStart(4, "0")}`, true);
        }

        // --- And one task still IN FLIGHT, in a project outside that run, so
        // its claim row is the NEWEST and sits BEHIND the fifty terminal ones
        // in an oldest-first window.
        const liveTask = await seedProposedTask(admin.client, PROJECT_B, "lapse-window-live");
        const liveOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_B, jobId: liveTask.jobId,
          capability: "writing" });
        const liveClaim = await worker.claim(liveOffer.offerId, "lapse-window-live-01");
        const liveLease = (await admin.client.query<{ lease_id: string }>(
          "SELECT lease_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2",
        [FLEET_TENANT, liveClaim.claimId])).rows[0]!.lease_id;

        // Both halves of the shape are asserted before anything is tested, so
        // a later failure can only be about the guard.
        const counts = await fleet.client.query<{ terminal: number; live: number }>(
          `SELECT count(*) FILTER (WHERE l.state<>'active')::int AS terminal,
             count(*) FILTER (WHERE l.state='active')::int AS live
           FROM fleet_claims fc JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
           WHERE fc.tenant_id=$1 AND fc.worker_id=$2`, [FLEET_TENANT, joined.workerId]);
        assert.equal(counts.rows[0]?.terminal, BURNT,
          `the worker holds exactly ${BURNT} terminal claims, which is what fills the window`);
        assert.equal(counts.rows[0]?.live, 1, "and exactly one live lease");

        // --- THE GUARD, measured on the production login against the query
        // verbatim from the product. Both windows are run so the assertion
        // cannot pass merely because the window is small.
        const guarded = (await fleet.client.query<{ lease_id: string }>(
          CANDIDATE_QUERY, [FLEET_TENANT, joined.workerId])).rows.map(row => row.lease_id);
        assert.deepEqual(guarded, [liveLease],
          `the guarded window selects ONLY the still-active lease, never the ${BURNT} terminal claims `
          + "that precede it in an oldest-first window");

        const mutated = (await fleet.client.query<{ lease_id: string; state: string }>(
          MUTATED_CANDIDATE_QUERY, [FLEET_TENANT, joined.workerId])).rows;
        assert.equal(mutated.length, 50, "the unguarded window is exactly full");
        assert.ok(!mutated.some(row => row.lease_id === liveLease),
          "and it never sees the live lease: the owner's revocation would silently miss in-flight work");
        assert.equal(mutated.filter(row => row.state === "active").length, 0,
          "every row in the unguarded window is a terminal one");

        // --- And the product path agrees. The owner's revocation must reach the
        // in-flight lease behind the terminal claims: with the guard removed
        // the pass finds nothing, the lease stays `active`, and abandoned work
        // keeps a lease owned by a machine the owner has already revoked.
        await owner.revokeWorker(ownerIdentity(), joined.workerId);
        const afterRevocation = await readClaimState(postgres, liveClaim.claimId);
        assert.deepEqual({ lease: afterRevocation.lease_state, attempt: afterRevocation.attempt_state,
          job: afterRevocation.job_state },
          { lease: "revoked", attempt: "cancelled", job: "orphaned" },
          "the revocation pass reaches the live lease hidden behind the terminal claims");
        assert.equal(afterRevocation.scopes, 0,
          "and releases its derived ownership scope, so later work in that project is not blocked");

        // A repeated pass changes nothing at all: no counter movement, no row
        // movement, no new audit row. This is the "repeated reconcile" half of
        // the guard's stated purpose, and it is checked on the whole snapshot.
        assert.deepEqual(await gateway.reconcile(), { reviews: 0, revocations: 0, leaseRevocations: 0 },
          "a repeated reconcile revokes no further lease");
        assert.deepEqual(await readClaimState(postgres, liveClaim.claimId), afterRevocation,
          "and leaves the terminal state and its audit rows exactly as they were");

        // The supervisor, the sole expiry owner, finds nothing to sweep: a
        // deliberate withdrawal is not a lapse.
        assert.deepEqual(await new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT).reconcileStalled(), [],
          "a revoked worker's lease is never swept as a stall");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_supervisor_task_heads WHERE tenant_id=$1", [FLEET_TENANT],
        )).rows[0]?.count, 0, "no lapse is counted for work the owner took back on purpose");
      } finally {
        await new Promise(done => server.close(done));
        await Promise.all([admin.close(), fleet.close(), fleetOwner.close(), coordinator.close()]);
        await rm(dir, { recursive: true, force: true });
      }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 540_000 });
  });

test("a racing sweep cannot reconcile an attempt a revocation already cancelled: the FOR UPDATE re-check is the guard",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner"),
        coordinator = pool(postgres, "coordinator");
      const dir = await mkdtemp(join(tmpdir(), "lapse-race-sweep-"));
      const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
        builtFrom: "0".repeat(40) });
      const mode = { value: "running" as FleetOperationsModeV1 };
      const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT,
        operationsMode: async () => mode.value });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const handler = createFleetGatewayHandlerV1({ store: gateway, releaseTrust: release.releaseTrust,
        connectorRelease: release.connectorRelease, onUnexpectedError: error => { throw error; } });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await seedFleetTenant((sql, params) => admin.client.query(sql, params));
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Lapse sweep worker",
          workerKind: "mcp-agent", projectIds: [PROJECT_A, PROJECT_B], capabilities: ["writing"],
          maxConcurrent: 1 });
        const configPath = join(dir, "worker.json");
        const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent", configPath });
        const worker = connector.createClient(await connector.loadConfig(configPath));

        const task = await seedProposedTask(admin.client, PROJECT_A, "lapse-sweep-1");
        const offer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId,
          capability: "writing" });
        const claim = await worker.claim(offer.offerId, "lapse-sweep-claim-01");
        const row = (await admin.client.query<{ lease_id: string; attempt_id: string }>(
          "SELECT lease_id,attempt_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2",
        [FLEET_TENANT, claim.claimId])).rows[0];
        assert.ok(row, "the claim row names its lease and attempt");

// The lease is genuinely elapsed, so the supervisor's own
        // `l.expires_at<=$3` predicate admits it: a real STALL candidate, not
        // live work. See `ageLease` for why the expiry moves to
        // `acquired_at + 1 second` rather than to a fixed past instant.
        await ageLease(fleet.client, row.lease_id);

        const lapsedBefore = (await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_supervisor_task_heads WHERE tenant_id=$1", [FLEET_TENANT],
        )).rows[0]?.count ?? 0;
        assert.equal(lapsedBefore, 0, "nothing has lapsed yet");

        // --- THE GUARD'S ACTUAL WINDOW, established by measurement rather than
        // by reading the manifest's `why`.
        //
        // The obvious framing -- "a sweep must not reconcile what a revocation
        // already cancelled" -- is ALREADY prevented upstream, and this lane
        // measured that first. The revocation pass moves the lease out of
        // `active` in the SAME transaction that cancels the attempt
        // (gateway-store.ts:1024-1027), so `reconcileStalled`'s own candidate
        // query, which requires `l.state='active'` (reconciler.ts:113), never
        // names the attempt at all. A test written only that way PASSES with
        // this guard widened -- which is precisely why the mutation survived.
        //
        // What the FOR UPDATE re-check protects is the WINDOW between the
        // candidate read and the row write: the candidate read takes NO locks
        // (reconciler.ts:109-114). Inside that window a revocation can cancel
        // the attempt and orphan the job. The sweep's re-check then has to see
        // that committed work and stop. This is the shape built below, and it
        // is the shape the guard exists for.
        // The interleaving is the production one, in production order: the
        // owner's revocation and the gateway's revocation pass COMMIT first,
        // and the sweep then reaches its FOR UPDATE re-check and re-reads that
        // committed work. That ordering is forced, not scheduled -- the sweep
        // cannot have named this attempt as a candidate while the lease was
        // already out of the active set, so any sweep that gets as far as its
        // re-check necessarily does so after the revocation. The candidate
        // query takes no locks at all (reconciler.ts:109-114), which is exactly
        // why this window exists and why the re-check is what closes it.
        //
        // An advisory-lock interposer was tried here and does NOT work, and the
        // reason is worth recording rather than repeating: no product code
        // takes that key, so the sweep never blocks on it and the "barrier"
        // orders nothing. A row-lock interposer is no better -- the gateway's
        // revocation pass writes those same three rows, so holding them from
        // the test deadlocks against the very transaction it needs to precede.
        // Both were measured on real PostgreSQL. What the FOR UPDATE re-check
        // actually needs in order to bite is a committed revocation, and that is
        // reachable without interposing at all.
        await owner.revokeWorker(ownerIdentity(), joined.workerId);
        assert.equal((await gateway.reconcile()).leaseRevocations, 1,
          "the revocation pass took the elapsed lease out of the active set");
        const racedOutcomes = await new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT).reconcileStalled();

        const revoked = await readClaimState(postgres, claim.claimId);
        assert.deepEqual({ lease: revoked.lease_state, attempt: revoked.attempt_state, job: revoked.job_state },
          { lease: "revoked", attempt: "cancelled", job: "orphaned" },
          "the revocation really did cancel the attempt and orphan the job the sweep was chasing");

        assert.deepEqual(racedOutcomes, [],
          "a sweep whose re-check lands after a revocation reconciles nothing: the cancelled attempt beside the "
          + "orphaned job is refused, so no lapse is counted for work the owner withdrew");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_supervisor_task_heads WHERE tenant_id=$1", [FLEET_TENANT],
        )).rows[0]?.count ?? 0, lapsedBefore, "the losing sweep counts no lapse at all");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_supervisor_reconciliation_events WHERE tenant_id=$1",
        [FLEET_TENANT])).rows[0]?.count ?? 0, 0, "and writes no reconciliation event");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_action_inbox WHERE tenant_id=$1", [FLEET_TENANT],
        )).rows[0]?.count ?? 0, 0, "no Needs-you item is raised for a deliberate withdrawal");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_outbox WHERE tenant_id=$1 AND topic='service.incident.opened'",
        [FLEET_TENANT])).rows[0]?.count ?? 0, 0, "and no incident is proposed");

        // The three canonical rows keep the revocation's versions: a sweep that
        // had proceeded would have written `expired`/`orphaned` over them.
        assert.deepEqual(await readClaimState(postgres, claim.claimId), revoked,
          "the revocation's terminal state and versions survive the blocked sweep exactly");

        // --- WHAT ACTUALLY REFUSES THE ROW, MEASURED.
        //
        // This is the honest finding for this guard, and it is asserted rather
        // than asserted-about. Both spellings of the re-check are run against
        // the row the revocation really left behind, on the production login:
        //
        //   the shipped predicate          leased/running/waiting attempt,
        //                                 leased/running job, active lease
        //   the manifest's widening        + `cancelled` as an attempt state and
        //                                 `orphaned` as a job state
        //
        // The widening is EQUIVALENT against today's state machine, and the
        // reason is structural rather than coincidental: every committed writer
        // that makes an attempt terminal ALSO moves that attempt's lease out of
        // `active` in the same transaction -- the fleet revocation (`revoked`),
        // the fleet blocker release (`released`), the supervisor sweep
        // (`expired`) and CanonicalStore.revokeLease (`revoked`). There is
        // therefore no committed state in which an attempt is `cancelled` while
        // its own lease is still `active`, so the binding predicate is
        // `l.state='active'` and widening the attempt and job lists changes
        // nothing about which rows match.
        //
        // The guard is KEPT. It states the intent, it is the predicate a future
        // writer that cancels an attempt without releasing its lease would hit,
        // and deleting a correct guard on the strength of an equivalent mutant
        // is exactly the trade this repository's mutation manifest exists to
        // refuse. This assertion is here so the next reader learns it from a
        // test rather than by re-deriving it.
        const at = new Date().toISOString();
        const recheck = await coordinator.client.query(
          `SELECT a.id FROM control_attempts a JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
             JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id AND l.job_id=j.id
           WHERE a.tenant_id=$1 AND a.id=$2 AND a.state IN ('leased','running','waiting')
             AND j.state IN ('leased','running') AND l.state='active' AND l.expires_at<=$3`,
          [FLEET_TENANT, row.attempt_id, at]);
        const mutatedRecheck = await coordinator.client.query(
          `SELECT a.id FROM control_attempts a JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
             JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id AND l.job_id=j.id
           WHERE a.tenant_id=$1 AND a.id=$2 AND a.state IN ('leased','running','waiting','cancelled')
             AND j.state IN ('leased','running','orphaned') AND l.state='active' AND l.expires_at<=$3`,
          [FLEET_TENANT, row.attempt_id, at]);
        assert.deepEqual(recheck.rows, [], "the shipped re-check refuses the revoked row");
        assert.deepEqual(mutatedRecheck.rows, [],
          "and so does the widened one: the lease predicate is what binds, because no committed writer leaves a "
          + "cancelled attempt beside an active lease, which is why this mutation is equivalent rather than caught");

        // --- Two sweeps racing each other, so the loser of the row lock is
        // proven to REFUSE rather than to throw. This is the liveness half:
        // exactly one wins, the loser re-reads under FOR UPDATE and returns
        // nothing, and neither raises a Needs-you item.
        //
        // It uses a SECOND worker, because the first one was revoked above and
        // a revoked worker cannot claim. PROJECT_B is already in its enrollment
        // scope, so no fixture surgery is needed.
        const secondCode = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Lapse second worker",
          workerKind: "mcp-agent", projectIds: [PROJECT_B], capabilities: ["writing"], maxConcurrent: 1 });
        const secondPath = join(dir, "second-worker.json");
        await connector.join({ server: origin, code: secondCode.code, workerKind: "mcp-agent", configPath: secondPath });
        const secondWorker = connector.createClient(await connector.loadConfig(secondPath));
        const secondTask = await seedProposedTask(admin.client, PROJECT_B, "lapse-sweep-race");
        const secondOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_B, jobId: secondTask.jobId,
          capability: "writing" });
        const secondClaim = await secondWorker.claim(secondOffer.offerId, "lapse-sweep-race-01");
        const secondRow = (await admin.client.query<{ lease_id: string }>(
          "SELECT lease_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2",
        [FLEET_TENANT, secondClaim.claimId])).rows[0];
        await ageLease(fleet.client, secondRow!.lease_id);

        const left = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
        const right = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
        const racing = await Promise.all([left.reconcileStalled(), right.reconcileStalled()]);
        const reconciled = racing.flat();
        assert.equal(reconciled.length, 1,
          `exactly one of two racing sweeps reconciles the genuine stall: ${JSON.stringify(reconciled)}`);
        assert.equal(new Set(reconciled.map(outcome => outcome.attemptId)).size, reconciled.length,
          "and no attempt is reconciled twice: the loser re-reads under FOR UPDATE and returns nothing");
        const swept = await readClaimState(postgres, secondClaim.claimId);
        assert.deepEqual({ lease: swept.lease_state, attempt: swept.attempt_state, job: swept.job_state },
          { lease: "expired", attempt: "orphaned", job: "ready" },
          "a reconciled stall ends expired/orphaned/ready");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_supervisor_task_heads WHERE tenant_id=$1", [FLEET_TENANT],
        )).rows[0]?.count ?? 0, 1, "exactly one lapse is counted on the whole run, and it is the genuine stall");
        assert.equal((await coordinator.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM control_supervisor_reconciliation_events WHERE tenant_id=$1",
        [FLEET_TENANT])).rows[0]?.count ?? 0, 1, "and exactly one reconciliation event");

        // The revoked attempt is STILL untouched by that sweep: it reconciled
        // the stall, not the withdrawal.
        assert.deepEqual(await readClaimState(postgres, claim.claimId), revoked,
          "two racing sweeps still leave the revoked attempt, job and lease exactly as the revocation wrote them");
      } finally {
        await new Promise(done => server.close(done));
        await Promise.all([admin.close(), fleet.close(), fleetOwner.close(), coordinator.close()]);
        await rm(dir, { recursive: true, force: true });
      }
    }, { port: PORTS[1], allowedPorts: [PORT, PORTS[1]], boundMs: 480_000 });
  });