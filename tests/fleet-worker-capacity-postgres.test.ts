// A fleet worker's maxConcurrent is a real ceiling, proved where claims
// actually happen: in the database, under concurrent callers, as the production
// logins that execute the claim.
//
// The shape that matters is the one that was never proven. 0140 already compared
// the worker's live claims against max_concurrent, but that comparison is a
// read-then-compare with nothing serialising it, so N callers that each hold a
// stale count all see "2 live < 2" and all insert. The ceiling was in the
// application only by the accident that the claim path takes a tenant row lock
// first. A second shape is a lease past its expiry that is still in state
// 'active': the guard counted it, so a crashed worker held its own capacity
// open forever.
//
// Three workers at maxConcurrent 2, twenty offers, all racing: no worker ever
// exceeds its ceiling, and every refusal is a claim-level conflict the
// connector already moves on from, never an opaque database failure that ends
// the worker's pass.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { DOMAIN_CONTRACT_VERSION } from "../src/domain/v1/types";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant, seedProposedTask }
  from "./support/fleet-fixture";
// The connector is a dependency-free .mjs shipped to worker machines.
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.FLEET_CAPACITY_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58643);
const PG = requiresRealPostgres();
const sqlState = (error: unknown) => (error as { code?: string }).code;

/**
 * One project per offer, so 0100's whole-tree lease-scope rule is never what is
 * measured: two claims in the same project collide by scope by design, and
 * that collision would mask the capacity ceiling this file is about.
 *
 * The enrollment grid allows at most 20 projects per worker, and the three race
 * projects come out of the same budget, so the offer grid is 16.
 */
const RACE_PROJECTS = Object.freeze(["project:fleet-race-0", "project:fleet-race-1", "project:fleet-race-2"]);
const PROJECTS = Object.freeze(Array.from({ length: 16 }, (_, index) => `project:fleet-cap-${index}`));
const SPARE_PROJECT = "project:fleet-race-spare";
const PROJECTS_ALL = Object.freeze([...PROJECTS, ...RACE_PROJECTS, SPARE_PROJECT]);

type ProductionClient = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;

/** The named production login, wrapped in the bounded database the app really uses. */
function productionClient(postgres: RealPostgres, role: string): ProductionClient {
  const login = postgres.connection(role);
  // The validated shape names a loopback host; the cluster's socket directory
  // is applied afterwards, exactly as the sibling real-PostgreSQL test does.
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: login.user,
    password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/** One raw connection as the named production login, for the racing claimers. */
async function as(postgres: RealPostgres, role: string) {
  const client = new Client(postgres.connection(role));
  // Without a listener, a connection the cluster terminates during teardown
  // surfaces as an uncaughtException and buries the real failure.
  client.on("error", () => {});
  await client.connect();
  return client;
}

/** The schema-owner connection, for fixture seeding only. Never a product role. */
async function seedingConnection(postgres: RealPostgres) {
  const client = new Client(postgres.admin({ database: postgres.database }));
  client.on("error", () => {});
  await client.connect();
  return client;
}

/** A DatabaseClient facade over one `pg` client, transactions included. */
function facade(client: Client): DatabaseClient {
  const session: DatabaseSession = Object.freeze({
    query: async (statement: string, params: unknown[] = []) => {
      return { rows: (await client.query(statement, params)).rows };
    },
  });
  const transaction = async <T>(work: (session: DatabaseSession) => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try { const value = await work(session); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return Object.freeze({
    query: <T>(statement: string, params: unknown[] = []) => session.query<T>(statement, params),
    transaction,
    transactionWithPreCommitCheck: async <T>(work: (session: DatabaseSession) => Promise<T>,
      check: () => void | Promise<void>) => transaction(async inner => {
        const value = await work(inner); await check(); return value;
      }),
  });
}

test("a fleet worker never holds more live claims than its maxConcurrent, under concurrent claimers",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const admin = await seedingConnection(postgres);
      const fleetOwner = productionClient(postgres, "fleetOwner");
      const gatewayPool = productionClient(postgres, "fleet");
      const workIntake = productionClient(postgres, "control_room_work_intake_agent");
      try {
        const seeding = facade(admin);
        const { CanonicalStore } = await import("../src/persistence/canonical-store");
        const store = new CanonicalStore(seeding);
        await seedFleetTenant((sql, params) => admin.query(sql, params));
        for (const project of PROJECTS_ALL) {
          await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
            title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
            VALUES($1,$2,$3,'adapter:fleet',$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
          [project, FLEET_TENANT, FLEET_WORKSPACE]);
          await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,
            created_at,updated_at) VALUES($1,$2,'active',1,now(),now())`, [FLEET_TENANT, project]);
        }

        // The real gateway composition: the same store, handler and services
        // the Mac runs, served over the same loopback HTTP surface.
        const gateway = createFleetGatewayStoreFromConfigurationV1(gatewayPool.client, { tenantId: FLEET_TENANT,
          workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 5).toString("base64url") } });
        const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
          afterDecision: () => gateway.reconcile() });
        const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(workIntake.client, new Uint8Array(32).fill(5)));
        const unexpected: string[] = [];
        const handler = createFleetGatewayHandlerV1({ store: gateway, proposals,
          onUnexpectedError: error => {
            const failure = error as { sqlState?: string; code?: string; message?: string };
            unexpected.push(`${failure.code ?? "?"}/${failure.sqlState ?? "?"}:${failure.message ?? "?"}`);
          } });
        const server = createServer((request, response) => { void handler.handle(request, response); });
        await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
          // Three workers, each enrolled at a ceiling of 2, through the real
          // gateway handler with a real one-time code each.
          const clients: Array<{ claim(offerId: string, key: string): Promise<unknown> }> = [];
          const workerIds: string[] = [];
          // The store's own principals, so a later release goes through the same
          // service the gateway serves rather than a hand-written transition.
          const principals = new Map<string, Awaited<ReturnType<FleetGatewayStoreV1["authenticate"]>>>();
          for (let index = 0; index < 3; index += 1) {
            const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: `Cap worker ${index}`,
              workerKind: "mcp-agent", projectIds: [...PROJECTS_ALL], capabilities: ["writing"], maxConcurrent: 2 });
            const configPath = `${postgres.runDirectory}/worker-${index}.json`;
            const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent",
              configPath });
            const config = await connector.loadConfig(configPath);
            clients.push(connector.createClient(config));
            workerIds.push(joined.workerId);
            principals.set(joined.workerId, await gateway.authenticate({ bearer: config.secret,
              declaredWorkerId: joined.workerId }));
          }
          assert.equal(workerIds.length, 3, "three workers enrolled at a ceiling of 2 each");

          type RacedOffer = Readonly<{ workerId: string; nodeId: string; projectId: string; jobId: string;
            offerId: string; attemptId: string; leaseId: string }>;
          const racedOffers: RacedOffer[] = [];
          const offers: string[] = [];
          for (const [index, project] of PROJECTS.entries()) {
            const task = await seedProposedTask(seeding, project, `cap-${index}`);
            const offer = await owner.offerTask(ownerIdentity(), { projectId: project, jobId: task.jobId,
              capability: "writing" });
            offers.push(offer.offerId);
          }

          const liveCounts = async (workerId: string) => Number((await admin.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM fleet_claims fc JOIN control_leases l
               ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
             WHERE fc.tenant_id=$1 AND fc.worker_id=$2 AND l.state='active' AND l.expires_at>now()`,
          [FLEET_TENANT, workerId])).rows[0]!.n);
          const ceiling = async (workerId: string) => Number((await admin.query<{ max_concurrent: string }>(
            "SELECT max_concurrent::text AS max_concurrent FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2",
          [FLEET_TENANT, workerId])).rows[0]!.max_concurrent);
          for (const workerId of workerIds) assert.equal(await ceiling(workerId), 2, "the enrolled ceiling is 2");

          // THE CEILING, under contention. Every worker races for every offer at
          // once, through the real HTTP handler and the real claim path, three
          // times over, watching the committed live set after every attempt.
          const peaks = new Map<string, number>();
          const outcomes: Record<string, number> = {};
          for (let round = 0; round < 3; round += 1) {
            await Promise.all(workerIds.map(async (workerId, index) => {
              const client = clients[index]!;
              for (const [offerIndex, offerId] of offers.entries()) {
                try {
                  await client.claim(offerId, `cap-key-${round}-${index}-${offerIndex}`);
                  outcomes.claimed = (outcomes.claimed ?? 0) + 1;
                } catch (error) {
                  const failure = error as { code?: string };
                  const code = failure.code ?? "none";
                  outcomes[code] = (outcomes[code] ?? 0) + 1;
                  // An over-capacity claim is a conflict the connector already
                  // moves on from. An opaque refusal is a bug, not a ceiling.
                  assert.ok(code === "conflict" || code === "not_found",
                    `a refused claim reported "${code}", which the connector cannot continue past`);
                }
                const live = await liveCounts(workerId);
                peaks.set(workerId, Math.max(peaks.get(workerId) ?? 0, live));
                assert.ok(live <= 2, `worker held ${live} live claims against a ceiling of 2`);
              }
            }));
          }
          assert.ok(outcomes.claimed, "at least one claim won, so the ceiling is not a blanket refusal");
          assert.ok((outcomes.conflict ?? 0) > 0,
            `the ceiling was actually reached and refused as a conflict (${JSON.stringify(outcomes)})`);
          for (const [workerId, peak] of peaks)
            assert.ok(peak <= 2, `worker ${workerId} reached ${peak} live claims against a ceiling of 2`);
          // Every refusal was a claim-level one. None of them was an unexpected
          // database error reaching the handler's catch-all.
          assert.deepEqual([...new Set(unexpected)], [],
            "the claim path raised no unexpected database error while enforcing the ceiling");

          // THE SERIALISATION, without the application. Everything above goes
          // through the gateway claim path, which takes a tenant row lock before
          // it inserts -- so on its own it would pass with NO guard at all, and
          // a test that only proves that is proving an accident of one caller.
          //
          // These callers insert the same claim rows as the fleet login, from
          // their own connections, and take no application lock at all. The
          // ceiling then has to be the DATABASE's property, or it is not a
          // ceiling: a second gateway process, a maintenance job, or any future
          // writer that has not read this one method is exactly this shape.
          // Frees every live claim a worker holds, through the store's OWN
          // blocker-and-release path, so the job is claimable again exactly as
          // it is after a real hand-off. Nothing here reaches past the service.
          const releaseWorkerClaims = async (workerId: string) => {
            const held = (await admin.query<{ claim_id: string }>(`SELECT fc.claim_id FROM fleet_claims fc
              JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
              WHERE fc.tenant_id=$1 AND fc.worker_id=$2 AND l.state='active' AND l.expires_at>now()`,
            [FLEET_TENANT, workerId])).rows;
            const principal = principals.get(workerId);
            assert.ok(principal, "the worker has a store principal");
            for (const claim of held) {
              await gateway.blocker(principal, { claimId: claim.claim_id,
                message: "Capacity test: releasing this claim.", idempotencyKey: `cap-release-${claim.claim_id.slice(-8)}`,
                release: true });
            }
          };

          /**
           * Puts one raced job into the state a fleet claim row is admitted into:
           * the job is `ready` and holds NO live lease, which is what 0140
           * requires. The canonical store writes the attempt and lease and then
           * expires them, so both the columns and the payload mirror are the
           * store's own work rather than hand-written JSON.
           */
          const makeJobClaimable = async (jobId: string, workerId: string, nodeId: string, attemptId: string) => {
            const leaseId = attemptId.replace("attempt:", "lease:");
            const job = (await admin.query<{ payload: { version: number; state: string } }>(
              "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [FLEET_TENANT, jobId])).rows[0]!.payload;
            assert.equal(job.state, "proposed", "the raced job is still unclaimed");
            const now = new Date().toISOString();
            const ready = await store.transition({ tenantId: FLEET_TENANT, kind: "job", entityId: jobId,
              expectedVersion: job.version, toState: "ready", transitionId: `t-${attemptId}-ready`,
              idempotencyKey: `k-${attemptId}-ready`, actor: { actorId: "identity:fleet-owner", actorType: "human" },
              occurredAt: now });
            const claimed = await store.claimReadyTaskJob({ tenantId: FLEET_TENANT, jobId,
              expectedJobVersion: ready.entity.version, nodeId, workerId, attemptId, leaseId,
              transitionId: `t-${attemptId}-lease`, idempotencyKey: `k-${attemptId}-lease`,
              actor: { actorId: "identity:fleet-owner", actorType: "human" }, acquiredAt: now,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
            // Age the lease past its own expiry, then expire it canonically, so
            // the job returns to `ready` with no live lease. The store refuses
            // an expiry that is not yet due, hence occurredAt at or after it.
            const elapsed = new Date(Date.parse(claimed.lease.acquiredAt) + 1_000).toISOString();
            await admin.query(`UPDATE control_leases SET expires_at=$3::timestamptz,
              payload=jsonb_set(payload,'{expiresAt}',to_jsonb($3::timestamptz)),updated_at=$3::timestamptz
              WHERE tenant_id=$1 AND id=$2`, [FLEET_TENANT, leaseId, elapsed]);
            await store.expireLease({ tenantId: FLEET_TENANT, jobId, attemptId, leaseId,
              epoch: claimed.lease.epoch, expectedLeaseVersion: claimed.lease.version,
              expectedAttemptVersion: claimed.attempt.version, expectedJobVersion: claimed.job.version,
              transitionId: `t-${attemptId}-expire`, idempotencyKey: `k-${attemptId}-expire`,
              actor: { actorId: "identity:fleet-owner", actorType: "human" },
              occurredAt: new Date(Math.max(Date.now(), Date.parse(elapsed) + 1_000)).toISOString() });
            const after = (await admin.query<{ payload: { state: string } }>(
              "SELECT payload FROM control_jobs WHERE tenant_id=$1 AND id=$2", [FLEET_TENANT, jobId]))
              .rows[0]!.payload;
            assert.equal(after.state, "ready", "the raced job is ready");
            const live = (await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM control_leases
              WHERE tenant_id=$1 AND job_id=$2 AND state='active'`, [FLEET_TENANT, jobId])).rows[0]!.n;
            assert.equal(live, "0", "the raced job holds no live lease");
            return { attemptId, leaseId };
          };

          // One worker, three offers, three connections, one statement each, no
          // application lock anywhere. With no serialisation in the database all
          // three would read the same empty count and all three would win.
          const subject = workerIds[0]!;
          const subjectNode = (await admin.query<{ node_id: string }>(
            "SELECT node_id FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2", [FLEET_TENANT, subject]))
            .rows[0]!.node_id;
          for (const worker of workerIds) await releaseWorkerClaims(worker);
          assert.equal(await liveCounts(subject), 0, "the racing worker starts with nothing live");

// THE ISOLATION LEVEL. Every race above is READ COMMITTED, which is
          // what the gateway pool opens.
          //
          // This is the shape an advisory lock alone does not cover. An RR
          // transaction's snapshot is fixed at its FIRST statement, and the
          // first statement of a claim is BEGIN -- before the caller ever waits
          // on the worker lock. So the serialised count below still reads the
          // world as it was before the peer that committed while this caller was
          // queued: every RR caller sees the same stale count, and the ceiling
          // is not a ceiling. Measured before the guard was added, three RR
          // connections at a ceiling of 2 inserted all three.
          //
          // This block sits HERE, immediately after the unlocked race, because
          // both races need a worker holding NOTHING, so that "the ceiling
          // holds" means the ceiling rather than a worker that was already at
          // it. The release path above freed both claims. After the expiry
          // block below it could not: that lease's expiry was aged by hand.
          for (const worker of workerIds) await releaseWorkerClaims(worker);
          assert.equal(await liveCounts(subject), 0, "the isolation races start with nothing live");

          /**
           * Seeds three fresh jobs on the three race projects, each with its own
           * open offer, and returns what one racer needs to insert a claim for
           * it. `seedProposedTask` derives the job id from the NAME, so the
           * prefix is what makes these jobs distinct from the ones the race above
           * used. The enrollment grid allows 20 projects per worker and this
           * file spends all of them, so the race projects are reused rather than
           * more added.
           */
          const seedIsolationOffers = async (prefix: string) => {
            const seeded = [];
            for (const [index, project] of RACE_PROJECTS.entries()) {
              const task = await seedProposedTask(seeding, project, `${prefix}-${index}-${subject.slice(-4)}`);
              const offer = await owner.offerTask(ownerIdentity(), { projectId: project, jobId: task.jobId,
                capability: "writing" });
              await makeJobClaimable(task.jobId, subject, subjectNode,
                `attempt:${prefix}-seed-${index}-${subject.slice(-6)}`);
              const attemptId = `attempt:${prefix}-${index}-${subject.slice(-6)}`;
              seeded.push({ workerId: subject, nodeId: subjectNode, projectId: project, jobId: task.jobId,
                offerId: offer.offerId, attemptId, leaseId: attemptId.replace("attempt:", "lease:") });
            }
            assert.equal(new Set(seeded.map(entry => entry.projectId)).size, 3,
              "the three racers hold three distinct projects, so 0100 is not what refuses the third");
            return seeded;
          };

          /**
           * The canonical attempt and lease a claim row names, written in the
           * SAME transaction as that claim. 0140's gateway guard admits
           * them precisely because the guarded claim row already names them,
           * and its deferred lease-consistency constraint is checked at
           * COMMIT -- so a transaction that commits the claim without
           * these two is refused at commit with P0001, which is not a
           * capacity answer and would make a race here prove nothing.
           *
           * Attempt number and lease epoch are read per job rather than
           * invented, because both are per-job sequences and the schema
           * holds them unique.
           */
          const writeCanonicalAttemptAndLease = async (client: Client,
            offer: { workerId: string; nodeId: string; jobId: string; attemptId: string; leaseId: string }) => {
            const numbers = (await client.query<{ attempt_number: string; epoch: string }>(`SELECT
              (SELECT COALESCE(max(attempt_number)+1,1) FROM control_attempts WHERE job_id=$1) AS attempt_number,
              (SELECT COALESCE(max(epoch)+1,1) FROM control_leases WHERE job_id=$1) AS epoch`,
            [offer.jobId])).rows[0]!;
            const stamp = new Date().toISOString();
            const expires = new Date(Date.now() + 3_600_000).toISOString();
            const attemptNumber = Number(numbers.attempt_number), epoch = Number(numbers.epoch);
            await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,
              worker_id,node_id,lease_epoch,payload,created_at,updated_at)
              VALUES($1,$2,$3,$4,'leased',0,$5,$6,$7,$8::jsonb,now(),now())`, [offer.attemptId, FLEET_TENANT,
            offer.jobId, attemptNumber, offer.workerId, offer.nodeId, epoch,
            JSON.stringify({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "attempt", id: offer.attemptId,
              tenantId: FLEET_TENANT, jobId: offer.jobId, attemptNumber, state: "leased", version: 0,
              workerId: offer.workerId, nodeId: offer.nodeId, leaseEpoch: epoch, offeredAt: stamp,
              createdAt: stamp, updatedAt: stamp })]);
            await client.query(`INSERT INTO control_leases(id,tenant_id,job_id,attempt_id,node_id,epoch,state,
              version,acquired_at,expires_at,payload,created_at,updated_at)
              VALUES($1,$2,$3,$4,$5,$6,'active',0,$7::timestamptz,$8::timestamptz,$9::jsonb,now(),now())`,
            [offer.leaseId, FLEET_TENANT, offer.jobId, offer.attemptId, offer.nodeId, epoch, stamp, expires,
              JSON.stringify({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "lease", id: offer.leaseId,
                tenantId: FLEET_TENANT, jobId: offer.jobId, attemptId: offer.attemptId, nodeId: offer.nodeId,
                epoch, state: "active", version: 0, acquiredAt: stamp, expiresAt: expires,
                createdAt: stamp, updatedAt: stamp })]);
          };

          /**
           * One claim insert in an already-open transaction, at the isolation
           * level the caller chose. Order is the real claim path's order: the
           * claim row FIRST, because 0140's guard only permits an attempt or
           * lease a guarded claim already names. These blocks stop at the CLAIM
           * decision, because that is the question 0234 answers and a refused
           * claim never reaches the attempt and lease.
           *
           * `commit` is a parameter rather than always committing, because an RR
           * claim that is refused leaves its transaction aborted and the caller
           * has nothing left to commit, while the SERIALIZABLE race has to
           * COMMIT for SSI to be given the chance to abort a loser.
           */
          const insertClaim = async (client: Client, offer: { offerId: string; projectId: string; jobId: string;
            attemptId: string; leaseId: string }, claimSeed: string, keySeed: string, commit: boolean) => {
            try {
              await client.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,project_id,
                job_id,attempt_id,lease_id,idempotency_key,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
              [FLEET_TENANT, `fleet-claim:${claimSeed.padStart(32, "0")}`, offer.offerId, subject, subjectNode,
                offer.projectId, offer.jobId, offer.attemptId, offer.leaseId, keySeed]);
              if (commit) await client.query("COMMIT");
              return "won";
            } catch (error) {
              await client.query("ROLLBACK").catch(() => {});
              return `refused:${sqlState(error)}:${(error as Error).message.slice(0, 90)}`;
            }
          };

          // REPEATABLE READ: every transaction takes its snapshot BEFORE any
          // peer commits, which is the whole condition -- without that there is
          // no stale count to be stale about.
          const rrOffers = await seedIsolationOffers("iso-rr");
          const rrClients = await Promise.all(rrOffers.map(() => as(postgres, "fleet")));
          try {
            await Promise.all(rrClients.map(client => client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")));
            await Promise.all(rrClients.map(client => client.query(
              "SELECT count(*) FROM fleet_claims WHERE tenant_id=$1 AND worker_id=$2", [FLEET_TENANT, subject])));
            const results = await Promise.all(rrClients.map((client, index) =>
              insertClaim(client, rrOffers[index]!, (index + 1).toString(16).padStart(32, "b"),
                `iso-rr-key-${index}`, false)));
            // Nobody won -- not "one won". The guard refuses the MODE, so the
            // answer is the same for the first caller and the last, and no RR
            // claim is admitted however many are queued. Asserting "two of three
            // won" would be the weaker claim: it would also pass on a guard that
            // merely serialised them, which is the bug.
            assert.equal(results.filter(value => value === "won").length, 0,
              `no REPEATABLE READ claim may be admitted (${results.join(", ")})`);
            // Each is told why, in a code the claim path does NOT map to
            // conflict -- tests/fleet-claim-refusal-mapping.test.ts pins the
            // application half of that.
            for (const result of results)
              assert.ok(result.includes("refused:0A000:"),
                `an RR claim was refused on something other than 0A000 (${result})`);
            assert.equal(await liveCounts(subject), 0, "no RR claim was committed");
          } finally { await Promise.all(rrClients.map(client => client.end().catch(() => {}))); }

          // SERIALIZABLE stays ALLOWED, deliberately: SSI is its own safety
          // property and it holds the ceiling on its own. The refusal names
          // REPEATABLE READ only, so this is the assertion that 0234 did not
          // over-refuse into refusing a mode that was already safe.
          for (const worker of workerIds) await releaseWorkerClaims(worker);
          assert.equal(await liveCounts(subject), 0, "the SERIALIZABLE race starts with nothing live");
          const ssiOffers = await seedIsolationOffers("iso-ssi");
          const ssiClients = await Promise.all(ssiOffers.map(() => as(postgres, "fleet")));
          try {
            const results = await Promise.all(ssiClients.map((client, index) => (async () => {
              try {
                await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
                await client.query("SELECT count(*) FROM fleet_claims WHERE tenant_id=$1 AND worker_id=$2",
                  [FLEET_TENANT, subject]);
                // The claim row alone is not a whole claim: 0140's DEFERRED
                // lease-consistency constraint is checked at COMMIT, so a
                // transaction that commits a claim row without the attempt and
                // lease it names is refused there with P0001 -- before SSI is
                // given any chance to abort a loser, which is what would make
                // this block prove nothing. So this race commits the same
                // three rows the real claim path commits, in the real order.
                const outcome = await insertClaim(client, ssiOffers[index]!,
                  (index + 1).toString(16).padStart(32, "c"), `iso-ssi-key-${index}`, false);
                if (outcome !== "won") return outcome;
                await writeCanonicalAttemptAndLease(client, ssiOffers[index]!);
                await client.query("COMMIT");
                return "won";
              } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                return `refused:${sqlState(error)}`;
              }
            })()));
            // What this block asserts is NOT "two won". Measured here, SSI
            // aborted TWO of the three with 40001 -- every one of these callers
            // reads the same snapshot, so each one is in a read/write dependency
            // with the other two, and the cycle means none of the three can be
            // the second to commit. That is a stronger answer than the ceiling
            // needs and it is SSI's own, not 0234's.
            //
            // So the claims that matter are: the mode is NOT refused (no 0A000,
            // which is what 0234 would raise if it over-refused), and the
            // ceiling held -- whatever committed is at or below it, because
            // anything more would be a claim the guard admitted past the limit.
            for (const result of results)
              assert.ok(!result.includes("0A000"), `SERIALIZABLE is not refused by 0234 (${result})`);
            const ssiWon = results.filter(value => value === "won").length;
            assert.ok(ssiWon <= 2, `SERIALIZABLE admitted ${ssiWon} claims against a ceiling of 2 (${results.join(", ")})`);
            assert.ok(ssiWon >= 1, `SERIALIZABLE refused every claim, which is a blanket refusal (${results.join(", ")})`);
            assert.equal(await liveCounts(subject), ssiWon,
              "every claim SERIALIZABLE committed is a live one, and no more");
            // These commits are REAL, so the worker is now holding capacity the
            // unlocked race below would inherit and be refused against -- its
            // two winners would become one. They are freed through SQL rather
            // than through `releaseWorkerClaims`, which drives the store's own
            // canonical transitions and so cannot be used on rows written here:
            // the job was never moved to `running`, and the release path
            // requires that it was. Expiring the lease is the same way the
            // expiry block below frees a slot, and it leaves the evidence.
            await admin.query(`UPDATE control_leases SET state='expired',
              payload=jsonb_set(payload,'{state}','"expired"'::jsonb),updated_at=now()
              WHERE tenant_id=$1 AND job_id = ANY($2) AND state='active'`,
            [FLEET_TENANT, ssiOffers.map(offer => offer.jobId)]);
            assert.equal(await liveCounts(subject), 0,
              "the SERIALIZABLE winners no longer occupy capacity for the unlocked race below");
          } finally { await Promise.all(ssiClients.map(client => client.end().catch(() => {}))); }
          for (const [index, project] of RACE_PROJECTS.entries()) {
            const task = await seedProposedTask(seeding, project, `unlocked-${index}-${subject.slice(-4)}`);
            const offer = await owner.offerTask(ownerIdentity(), { projectId: project, jobId: task.jobId,
              capability: "writing" });
            // The store's own attempt and lease are seeded and then expired, so
            // the RACER needs ids of its own: control_attempts and
            // control_leases are primary-keyed, and reusing the seed's ids would
            // be refused on 23505 for a reason that has nothing to do with
            // capacity. Two different subjects, two different histories.
            await makeJobClaimable(task.jobId, subject, subjectNode, `attempt:seeded-${index}-${subject.slice(-6)}`);
            const attemptId = `attempt:unlocked-${index}-${subject.slice(-6)}`;
            racedOffers.push({ workerId: subject, nodeId: subjectNode, projectId: project, jobId: task.jobId,
              offerId: offer.offerId, attemptId, leaseId: attemptId.replace("attempt:", "lease:") });
          }
          assert.equal(racedOffers.length, 3, "three offers to race for");
          assert.equal(new Set(racedOffers.map(offer => offer.projectId)).size, 3,
            "the three racers hold three distinct projects, so 0100 is not what refuses the third");
          const racers = await Promise.all(racedOffers.map(() => as(postgres, "fleet")));
          try {
            const results = await Promise.all(racedOffers.map(async (offer, index) => {
              const client = racers[index]!;
              try {
                await client.query("BEGIN");
                // Order matters and is the real claim path's order: the claim
                // row FIRST, because 0140's gateway guard only permits an
                // attempt or lease a guarded fleet claim already names, and
                // 0234's capacity guard fires on the claim row itself. The
                // deferred lease-consistency constraint is satisfied by commit,
                // when the attempt and lease below are live.
                await client.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,project_id,
                  job_id,attempt_id,lease_id,idempotency_key,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
                [FLEET_TENANT, `fleet-claim:${(index + 1).toString(16).padStart(32, "a")}`, offer.offerId,
                  offer.workerId, offer.nodeId, offer.projectId, offer.jobId, offer.attemptId, offer.leaseId,
                  `unlocked-key-${index}`]);
                await writeCanonicalAttemptAndLease(client, offer);
                await client.query("COMMIT");
                return "won";
              } catch (error) {
                await client.query("ROLLBACK").catch(() => {});
                return `refused:${sqlState(error)}:${(error as Error).message.slice(0, 80)}`;
              } finally { await client.end(); }
            }));
            const won = results.filter(value => value === "won").length;
            const live = await liveCounts(subject);
            assert.equal(won, 2,
              `exactly the ceiling's worth of unlocked claims won (${results.join(",")})`);
            assert.equal(live, 2, `the unlocked race left ${live} live claims against a ceiling of 2`);
          } finally { await Promise.all(racers.map(client => client.end().catch(() => {}))); }

          // A lease past its expiry is not capacity: a machine that crashed
          // must not hold its own ceiling open forever. The lease is aged by
          // writing BOTH the column and the canonical payload mirror, because
          // the schema refuses a row whose mirror disagrees with its columns --
          // so this is the same state a clock-skewed expiry would produce.
          const held = (await admin.query<{ lease_id: string; worker_id: string; acquired_at: string }>(`SELECT
            fc.lease_id,fc.worker_id,l.acquired_at FROM fleet_claims fc
            JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
            WHERE fc.tenant_id=$1 AND fc.worker_id=$2 AND l.state='active' ORDER BY fc.claimed_at LIMIT 1`,
          [FLEET_TENANT, subject])).rows[0]!;
          assert.ok(held, "the racing worker still holds a live lease to age");
          assert.equal(await liveCounts(subject), 2, "the worker is at its ceiling before the lease ages");
          // `control_leases` forbids an expiry at or before the lease's own
          // acquisition, so an elapsed lease is written as "acquired, and
          // expiring a moment later" relative to a timestamp already in the
          // past: acquired_at is moved back with it, columns and payload
          // mirror together.
          const acquired = new Date(Date.now() - 120_000).toISOString();
          const elapsed = new Date(Date.now() - 60_000).toISOString();
          await admin.query(`UPDATE control_leases SET acquired_at=$3::timestamptz, expires_at=$4::timestamptz,
            payload=jsonb_set(jsonb_set(payload,'{acquiredAt}',to_jsonb($3::timestamptz)),
              '{expiresAt}',to_jsonb($4::timestamptz)),
            created_at=$3::timestamptz, updated_at=$4::timestamptz
            WHERE tenant_id=$1 AND id=$2`, [FLEET_TENANT, held.lease_id, acquired, elapsed]);
          assert.ok(new Date(elapsed) < new Date(), "the lease is genuinely past its expiry");
          // The proof is a NEW CLAIM, not a count. The worker is at its ceiling
          // of 2, so a fresh offer can only be claimed if the elapsed lease
          // stopped occupying a slot; 0140's own count treated state='active'
          // as capacity regardless of expiry, so a crashed machine held its own
          // ceiling open until somebody reconciled it.
          assert.equal(await liveCounts(subject), 1, "the elapsed lease is no longer live work");
          // The worker still holds ONE real live lease, so it is at half its
          // ceiling on live work and one below it on what the guard counts. A
          // fourth racing claim is therefore admitted only if the elapsed lease
          // stopped occupying a slot: 0140 counted state='active' regardless of
          // expiry, so a crashed machine held its own ceiling open until
          // somebody reconciled it.
          const spareProject = SPARE_PROJECT;
          const spare = await seedProposedTask(seeding, spareProject, `after-expiry-${subject.slice(-4)}`);
          // The offer first: 0140 admits an offer only for a job with no lease,
          // and makeJobClaimable is what gives this job its (expired) one.
          const spareOffer = await owner.offerTask(ownerIdentity(), { projectId: spareProject,
            jobId: spare.jobId, capability: "writing" });
          await makeJobClaimable(spare.jobId, subject, subjectNode, `attempt:spare-${subject.slice(-6)}`);
          const spareAttempt = `attempt:spare-claim-${subject.slice(-6)}`;
          const spareLease = spareAttempt.replace("attempt:", "lease:");
          const spareRacer = await as(postgres, "fleet");
          try {
            await spareRacer.query("BEGIN");
            await spareRacer.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,project_id,
              job_id,attempt_id,lease_id,idempotency_key,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
            [FLEET_TENANT, `fleet-claim:${"f".repeat(32)}`, spareOffer.offerId, subject, subjectNode,
              spareProject, spare.jobId, spareAttempt, spareLease, `spare-key-${subject.slice(-6)}`]);
            const spareStamp = new Date().toISOString();
            const spareExpiry = new Date(Date.now() + 3_600_000).toISOString();
            const spareNumbers = (await spareRacer.query<{ attempt_number: string; epoch: string }>(`SELECT
              (SELECT COALESCE(max(attempt_number)+1,1) FROM control_attempts WHERE job_id=$1) AS attempt_number,
              (SELECT COALESCE(max(epoch)+1,1) FROM control_leases WHERE job_id=$1) AS epoch`,
            [spare.jobId])).rows[0]!;
            const spareNumber = Number(spareNumbers.attempt_number), spareEpoch = Number(spareNumbers.epoch);
            await spareRacer.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,
              worker_id,node_id,lease_epoch,payload,created_at,updated_at)
              VALUES($1,$2,$3,$4,'leased',0,$5,$6,$7,$8::jsonb,now(),now())`, [spareAttempt, FLEET_TENANT,
              spare.jobId, spareNumber, subject, subjectNode, spareEpoch,
              JSON.stringify({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "attempt", id: spareAttempt,
                tenantId: FLEET_TENANT, jobId: spare.jobId, attemptNumber: spareNumber, state: "leased",
                version: 0, workerId: subject, nodeId: subjectNode, leaseEpoch: spareEpoch, offeredAt: spareStamp,
                createdAt: spareStamp, updatedAt: spareStamp })]);
            await spareRacer.query(`INSERT INTO control_leases(id,tenant_id,job_id,attempt_id,node_id,epoch,state,
              version,acquired_at,expires_at,payload,created_at,updated_at)
              VALUES($1,$2,$3,$4,$5,$6,'active',0,$7::timestamptz,$8::timestamptz,$9::jsonb,now(),now())`,
            [spareLease, FLEET_TENANT, spare.jobId, spareAttempt, subjectNode, spareEpoch, spareStamp, spareExpiry,
              JSON.stringify({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "lease", id: spareLease,
                tenantId: FLEET_TENANT, jobId: spare.jobId, attemptId: spareAttempt, nodeId: subjectNode,
                epoch: spareEpoch, state: "active", version: 0, acquiredAt: spareStamp, expiresAt: spareExpiry,
                createdAt: spareStamp, updatedAt: spareStamp })]);
            await spareRacer.query("COMMIT");
          } finally { await spareRacer.end().catch(() => {}); }
          assert.equal(await liveCounts(subject), 2,
            "the elapsed lease never occupied the second slot: the worker reached its ceiling again");
        } finally {
          await new Promise(done => server.close(done));
        }
      } finally {
        await Promise.all([admin.end(), fleetOwner.close(), gatewayPool.close(), workIntake.close()]);
      }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 590_000 });
  });
