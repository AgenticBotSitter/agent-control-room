// The ceiling has to hold for callers that open their transaction in
// REPEATABLE READ, and an advisory lock alone does not give it to them.
//
// A RR transaction's snapshot is fixed at its FIRST statement, and the first
// statement of a claim is BEGIN -- before the caller ever waits on the worker
// lock. So the lock serialises the inserts, but the count still reads the world
// as it was before the peer that committed while this caller was queued: every
// RR caller sees the same stale count, and the ceiling is not a ceiling.
// Measured on real PostgreSQL 17 as the production fleet login, before 0234
// added the refusal, three RR connections at a ceiling of 2 inserted all three.
//
// 0234 therefore refuses the MODE with 0A000, after taking the lock. 0A000 is in
// neither refusal set, so it leaves the claim path as an unexpected error and
// ends the pass -- the only honest answer, since nothing about this worker or
// this offer changed, and a connector told `conflict` would move to the next
// offer and make the next claim in the same unusable transaction.
//
// This is a separate file from fleet-worker-capacity-postgres.test.ts for two
// reasons that both turned up as real failures. It needs a worker holding
// NOTHING: the store's release path frees only claims whose canonical attempt
// and lease the STORE wrote, so it cannot follow that file's unlocked race (rows
// hand-built by design, to prove the guard without the application) or its
// expiry block (lease expiry aged by hand). And under mutation this has to be
// the FIRST assertion to fail -- inside a 700-line test whose earlier phases take
// minutes once the guard is removed, the runner's 600s timeout fired first and
// the mutation entry reported a timeout rather than the refusal it exists to
// prove.
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
import { createFleetGatewayHandlerV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant, seedProposedTask }
  from "./support/fleet-fixture";
// The connector is a dependency-free .mjs shipped to worker machines.
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.FLEET_ISOLATION_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59660);
const PG = requiresRealPostgres();
const sqlState = (error: unknown) => (error as { code?: string }).code;

/** One project per offer, so 0100's whole-tree lease-scope rule is never what is
 *  measured: two claims in the same project collide by scope by design, and that
 *  would mask the ceiling. Three is the smallest race that can exceed 2. */
const RACE_PROJECTS = Object.freeze(["project:fleet-iso-0", "project:fleet-iso-1", "project:fleet-iso-2"]);
const PROJECTS_ALL = Object.freeze([...RACE_PROJECTS]);

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

/** The named production login, wrapped in the bounded database the app uses. */
function productionClient(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  // The validated shape names a loopback host; the cluster's socket directory
  // is applied afterwards, exactly as the sibling real-PostgreSQL test does.
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: login.user,
    password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/** A DatabaseClient facade over one `pg` client, transactions included. */
function facade(client: Client): DatabaseClient {
  const session: DatabaseSession = Object.freeze({
    query: async (statement: string, params: unknown[] = []) => ({ rows: (await client.query(statement, params)).rows }),
  });
  const transaction = async <T>(work: (inner: DatabaseSession) => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try { const value = await work(session); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return Object.freeze({
    query: <T>(statement: string, params: unknown[] = []) => session.query<T>(statement, params),
    transaction,
    transactionWithPreCommitCheck: async <T>(work: (inner: DatabaseSession) => Promise<T>) =>
      transaction(async inner => work(inner)),
  });
}

test("a repeatable read claimer is refused, and a serializable one is not", async t => {
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
      // The real gateway composition: the same store, handler and services the
      // Mac runs, served over the same loopback HTTP surface. The races below go
      // in on their own connections, but the worker is enrolled through here.
      const gateway = createFleetGatewayStoreFromConfigurationV1(gatewayPool.client, { tenantId: FLEET_TENANT,
        workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 5).toString("base64url") } });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
        afterDecision: () => gateway.reconcile() });
      const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(workIntake.client, new Uint8Array(32).fill(5)));
      const handler = createFleetGatewayHandlerV1({ store: gateway, proposals, onUnexpectedError: () => {} });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await seedFleetTenant((sql, params) => admin.query(sql, params));
        for (const project of PROJECTS_ALL) {
          await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
            title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
            VALUES($1,$2,$3,'adapter:fleet',$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
          [project, FLEET_TENANT, FLEET_WORKSPACE]);
          await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,
            created_at,updated_at) VALUES($1,$2,'active',1,now(),now())`, [FLEET_TENANT, project]);
        }

        // Enrolled through the real connector against the real handler, so this
        // is a real worker with a real credential and a real ceiling rather than
        // a fixture row only the guards can see.
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Isolation worker",
          workerKind: "mcp-agent", projectIds: [...PROJECTS_ALL], capabilities: ["writing"], maxConcurrent: 2 });
        const configPath = `${postgres.runDirectory}/iso-worker.json`;
        const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent", configPath });
        const subject = joined.workerId;
        const subjectNode = (await admin.query<{ node_id: string }>(
          "SELECT node_id FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2", [FLEET_TENANT, subject]))
          .rows[0]!.node_id;
        assert.equal((await admin.query<{ max_concurrent: string }>(
          "SELECT max_concurrent::text AS max_concurrent FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2",
          [FLEET_TENANT, subject])).rows[0]!.max_concurrent, "2", "the enrolled ceiling is 2");

        const liveCounts = async () => Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n
          FROM fleet_claims fc JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
          WHERE fc.tenant_id=$1 AND fc.worker_id=$2 AND l.state='active' AND l.expires_at>now()`,
        [FLEET_TENANT, subject])).rows[0]!.n);

        /**
         * Puts one job into the state a fleet claim row is admitted into: `ready`,
         * holding NO live lease, which is what 0140 requires. The canonical store
         * writes the attempt and lease and then expires them, so both the columns
         * and the payload mirror are the store's own work rather than hand-written
         * JSON -- which matters because the lease-consistency guard reads the
         * mirror.
         */
        const makeJobClaimable = async (jobId: string, attemptId: string) => {
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
            expectedJobVersion: ready.entity.version, nodeId: subjectNode, workerId: subject, attemptId, leaseId,
            transitionId: `t-${attemptId}-lease`, idempotencyKey: `k-${attemptId}-lease`,
            actor: { actorId: "identity:fleet-owner", actorType: "human" }, acquiredAt: now,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
          // Age the lease past its own expiry, then expire it canonically, so
          // the job returns to `ready` with no live lease. The store refuses an
          // expiry that is not yet due, hence occurredAt at or after it.
          const elapsed = new Date(Date.parse(claimed.lease.acquiredAt) + 1_000).toISOString();
          await admin.query(`UPDATE control_leases SET expires_at=$3::timestamptz,
            payload=jsonb_set(payload,'{expiresAt}',to_jsonb($3::timestamptz)),updated_at=$3::timestamptz
            WHERE tenant_id=$1 AND id=$2`, [FLEET_TENANT, leaseId, elapsed]);
          await store.expireLease({ tenantId: FLEET_TENANT, jobId, attemptId, leaseId, epoch: claimed.lease.epoch,
            expectedLeaseVersion: claimed.lease.version, expectedAttemptVersion: claimed.attempt.version,
            expectedJobVersion: claimed.job.version, transitionId: `t-${attemptId}-expire`,
            idempotencyKey: `k-${attemptId}-expire`, actor: { actorId: "identity:fleet-owner", actorType: "human" },
            occurredAt: new Date(Math.max(Date.now(), Date.parse(elapsed) + 1_000)).toISOString() });
          return { attemptId, leaseId };
        };

            assert.equal(await liveCounts(), 0, "the isolation races start with nothing live");

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
                await makeJobClaimable(task.jobId, `attempt:${prefix}-seed-${index}-${subject.slice(-6)}`);
                const attemptId = `attempt:${prefix}-${index}-${subject.slice(-6)}`;
                seeded.push({ workerId: subject, nodeId: subjectNode, projectId: project, jobId: task.jobId,
                  offerId: offer.offerId, attemptId, leaseId: attemptId.replace("attempt:", "lease:") });
              }
              assert.equal(new Set(seeded.map(entry => entry.projectId)).size, 3,
                "the three racers hold three distinct projects, so 0100 is not what refuses the third");
              return seeded;
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
                // Bounded, so a racer that waits on the worker lock can only wait
                // so long. Without this the suite HANGS rather than failing when
                // a peer is holding the lock: under mutation, with the repeatable
                // read refusal removed, one RR transaction wins the claim and keeps
                // that lock until it is rolled back, and every SERIALIZABLE caller
                // behind it waits indefinitely. A mutation check that can hang
                // reports a timeout instead of the refusal it exists to prove.
                await client.query("SET LOCAL lock_timeout = '3s'");
                await client.query("SET LOCAL statement_timeout = '15s'");
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
              // Release every transaction BEFORE asserting. This is what makes
              // the test fail fast rather than hang: if the guard is absent, one
              // of these transactions holds the worker advisory lock, and the
              // SERIALIZABLE race below then waits on it indefinitely -- the
              // assertion would pass and the run would still time out at 600s.
              for (const client of rrClients) await client.query("ROLLBACK").catch(() => {});

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
              assert.equal(await liveCounts(), 0, "no RR claim was committed");
            } finally { await Promise.all(rrClients.map(client => client.end().catch(() => {}))); }

            // SERIALIZABLE stays ALLOWED, deliberately: SSI is its own safety
            // property and it holds the ceiling on its own. The refusal names
            // REPEATABLE READ only, so this is the assertion that 0234 did not
            // over-refuse into refusing a mode that was already safe.
            assert.equal(await liveCounts(), 0, "the SERIALIZABLE race starts with nothing live");
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
              // Released before asserting, for the same reason as the RR block:
            // a transaction still holding the worker lock would strand teardown.
            for (const client of ssiClients) await client.query("ROLLBACK").catch(() => {});
            const ssiWon = results.filter(value => value === "won").length;
              assert.ok(ssiWon <= 2, `SERIALIZABLE admitted ${ssiWon} claims against a ceiling of 2 (${results.join(", ")})`);
              assert.ok(ssiWon >= 1, `SERIALIZABLE refused every claim, which is a blanket refusal (${results.join(", ")})`);
              assert.equal(await liveCounts(), ssiWon,
                "every claim SERIALIZABLE committed is a live one, and no more");
              // Freed the same way, and for the same reason: these rows were
              // written here, so the store's release path cannot drive them. The
              // lease is expired rather than deleted, which leaves the evidence
              // and is how a crashed machine's elapsed lease stops being capacity
              // -- the same transition 0234's guard makes on its own.
              await admin.query(`UPDATE control_leases SET state='expired',
                payload=jsonb_set(payload,'{state}','"expired"'::jsonb),updated_at=now()
                WHERE tenant_id=$1 AND job_id = ANY($2) AND state='active'`,
              [FLEET_TENANT, ssiOffers.map(offer => offer.jobId)]);
              assert.equal(await liveCounts(), 0,
                "the SERIALIZABLE winners no longer occupy the worker's capacity");
            } finally { await Promise.all(ssiClients.map(client => client.end().catch(() => {}))); }

            // A transaction that claims SEVERAL TASKS, not several callers.
            //
            // The races above are many connections, one claim each, which is
            // what the gateway does. The advisory lock already covers that shape
            // -- it serialises the inserts -- so nothing above exercises the gap
            // this does: a claim row is written BEFORE its lease, because 0140's
            // guard admits an attempt or lease only once a guarded claim already
            // names it, and 0140's lease-consistency constraint is DEFERRED, so
            // the lease is only required at COMMIT. A count that joins claims to
            // their leases therefore cannot see this transaction's own first
            // claim, and the transaction inserts its way past the ceiling.
            // Measured before the LEFT JOIN, as the fleet login on real
            // PostgreSQL 17: one READ COMMITTED transaction, ceiling 2, claims
            // A then B then C then their leases, and all three commit.
            //
            // This is on the isolation file rather than the capacity file
            // because it needs a worker holding NOTHING, which is the same
            // reason the RR block is here: the store's release path frees only
            // claims whose attempt and lease the STORE wrote, so it cannot follow
            // the other file's hand-built races or its hand-aged expiry.
            assert.equal(await liveCounts(), 0, "the multi-claim transaction starts with nothing live");
            const multiOffers = await seedIsolationOffers("iso-multi");
            const multi = await as(postgres, "fleet");
            try {
              // Bounded like every racer here, so a guard that does not refuse
              // still ends in a failure rather than a hang: the third insert is
              // what the ceiling is supposed to stop, and if it does not, this
              // transaction holds the worker lock until it is rolled back below.
              await multi.query("BEGIN");
              await multi.query("SET LOCAL lock_timeout = '3s'");
              await multi.query("SET LOCAL statement_timeout = '15s'");
              const results: string[] = [];
              for (const [index, offer] of multiOffers.entries()) {
                try {
                  await multi.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,
                    project_id,job_id,attempt_id,lease_id,idempotency_key,claimed_at)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
                  [FLEET_TENANT, `fleet-claim:${(index + 1).toString(16).padStart(32, "d")}`, offer.offerId,
                    subject, subjectNode, offer.projectId, offer.jobId, offer.attemptId, offer.leaseId,
                    `iso-multi-key-${index}`]);
                  results.push("won");
                  // The lease follows its claim, in the same transaction, so
                  // each earlier claim is a real claim whose lease merely does
                  // not exist YET -- the exact row the count has to still count.
                  await writeCanonicalAttemptAndLease(multi, offer);
                } catch (error) {
                  results.push(`refused:${sqlState(error)}`);
                }
              }
              // A ceiling of 2 admits two claims and refuses the third, however
              // the caller batches them. "Exactly two" is the whole claim: fewer
              // would mean the guard is stricter than maxConcurrent, and three
              // would mean the count cannot see its own transaction.
              assert.equal(results.filter(value => value === "won").length, 2,
                `a transaction claiming three tasks against a ceiling of 2 admitted ${results.join(", ")}`);
              assert.ok(results[2]!.includes("refused:54000"),
                `the third claim in one transaction is refused at the ceiling (${results.join(", ")})`);
              // PostgreSQL aborts a transaction at the statement that raises, so
              // the refusal above left this one ABORTED, and a COMMIT on an
              // aborted transaction is a rollback that still succeeds. So a batch
              // that runs into the ceiling commits NOTHING, not a partial batch --
              // all-or-nothing, and the evidence is that the worker is still
              // holding nothing afterwards. A caller that wanted the first two
              // claims kept has to re-run the batch, which is PostgreSQL's rule
              // and not something 0234 changes.
              await multi.query("COMMIT");
              assert.equal(await liveCounts(), 0,
                `a batch that ran into the ceiling left no claim behind (${results.join(", ")})`);

              // And the batch path still WORKS at the ceiling rather than above
              // it: two claims in one transaction commit, and each sees the
              // other's claim as a slot already taken. Without the LEFT JOIN this
              // would also pass, which is why the over-ceiling case above is the
              // one that proves the count.
              await multi.query("BEGIN");
              await multi.query("SET LOCAL lock_timeout = '3s'");
              await multi.query("SET LOCAL statement_timeout = '15s'");
              for (const [index, offer] of multiOffers.slice(0, 2).entries()) {
                await multi.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,
                  project_id,job_id,attempt_id,lease_id,idempotency_key,claimed_at)
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
                [FLEET_TENANT, `fleet-claim:${(index + 1).toString(16).padStart(32, "e")}`, offer.offerId,
                  subject, subjectNode, offer.projectId, offer.jobId, offer.attemptId, offer.leaseId,
                  `iso-multi-at-key-${index}`]);
                await writeCanonicalAttemptAndLease(multi, offer);
              }
              await multi.query("COMMIT");
              assert.equal(await liveCounts(), 2,
                "a batch of exactly maxConcurrent claims commits, and both are live");
              // Freed the same way the SERIALIZABLE winners were: the store's own
              // release path cannot drive rows written here, and expiring rather
              // than deleting leaves the evidence.
              await admin.query(`UPDATE control_leases SET state='expired',
                payload=jsonb_set(payload,'{state}','"expired"'::jsonb),updated_at=now()
                WHERE tenant_id=$1 AND job_id = ANY($2) AND state='active'`,
              [FLEET_TENANT, multiOffers.map(offer => offer.jobId)]);
              assert.equal(await liveCounts(), 0, "the multi-claim transaction's rows are released");
            } finally { await multi.end().catch(() => {}); }
      } finally { await new Promise(done => server.close(done)); }
    } finally {
      await Promise.all([admin.end(), fleetOwner.close(), gatewayPool.close(), workIntake.close()]);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 590_000 });
});
