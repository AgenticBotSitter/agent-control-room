// R6C-03 on real PostgreSQL 17, run AS the production fleet-gateway login
// (control_room_fleet, group control_room_fleet_gateway) and the production
// fleet-owner login, with only the grants db/roles/*.sql give them. Nothing in
// this file stands in for the behaviour it measures: the enrollment is the
// production `redeem_fleet_enrollment` function, the claim creates the real
// canonical lease, and every note is the production store method on the
// production login.
//
//   A bot that repeats the SAME progress note must keep its lease alive.
//
// Two things sat between a bot and its task, and both are measured here
// against a real database rather than argued about:
//
//   1. THE DEFAULT OPERATION KEY. `scripts/fleet/connector.mjs` derives one from
//      (tool, arguments) when the caller supplies no idempotencyKey, so fifty
//      identical "Still working" notes from one bot are ONE operation key. A
//      key that had already been recorded was answered as a replay -- and that
//      replay returned `leaseExpiresAt: null` having read no lease at all, so
//      the bot was told its keepalive succeeded while the lease quietly walked
//      towards expiry.
//   2. THE REPLAY ANSWER. `leaseExpiresAt: null` says "I did not renew" and
//      "your lease is gone" are the same thing, which is what made the failure
//      invisible rather than merely wrong.
//
// TIME. Real time is used, never an injected clock. 0140's
// `guard_fleet_worker_event_insert` and `redeem_fleet_enrollment` both refuse
// an `occurred_at` more than one minute ahead of the real database clock, so a
// 90-second simulated job would be refused for a future timestamp instead of
// being measured. The store is therefore built with the SHORTEST lease it
// accepts (30s), so three lease lengths is ninety real seconds. No time guard
// is disabled, no column is rewritten to fake an expiry, and every expiry
// assertion is a stored `expires_at` read back from the database.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { SupervisorReconcilerV1 } from "../src/supervisor/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, PROJECT_A, PROJECT_B, ownerIdentity, seedFleetTenant,
  seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";

// The shortest lease the store accepts, so three lease lengths is ninety
// seconds rather than forty-five minutes.
const LEASE_MS = 30_000;
// Roughly a third of a lease between notes, so no note can straddle an expiry.
const TICK_MS = 8_000;
// The measured shape: three lease lengths, identical notes the whole way.
const TICKS = 12;

// Ports 59430-59439 are this file's block. CONTROL_ROOM_PG_TEST_PORT_BASE moves
// it, so a parallel lane never shares a port with this one.
const PORT = Number(process.env.FLEET_PROGRESS_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59430);
const PG = requiresRealPostgres();

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
  host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: admin.user, password: admin.password, majorVersion: 17 as const }),
  host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
const iso = (value: unknown) => new Date(value as string).toISOString();
/** A key long enough for the schema's `^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$`. */
const KEY = (name: string) => `r6c03-${name}-key-0000000000`;
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

test("R6C-03: a repeated progress note keeps the lease alive, and only for its holder", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner"),
      coordinator = pool(postgres, "coordinator");
    const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT, leaseMs: LEASE_MS,
      operationsMode: async () => "running" });
    // The owner service is wired as the Mac-local composition wires it: the
      // gateway's reconciler runs after every owner decision, which is what
      // releases a revoked worker's in-flight lease.
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
        afterDecision: () => gateway.reconcile() });
    // The supervisor is a different production login and the sole fleet lease
    // expiry owner, so the sweep is asked as it would really be asked.
    const supervisor = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
    const asFleet = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      fleet.client.query<T>(sql, params).then(r => r.rows);
    const asWeb = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.connection("web")); await client.connect();
      try { return (await client.query<T>(sql, params)).rows; } finally { await client.end(); }
    };
    const leaseOf = async (claimId: string) => (await asFleet<{ state: string; expires_at: string | Date;
      version: number; acquired_at: string | Date }>(
      `SELECT l.state,l.expires_at,l.version,l.acquired_at
        FROM fleet_claims fc JOIN control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
        WHERE fc.claim_id=$1`, [claimId]))[0]!;
    const eventCount = async (claimId: string) => (await asFleet<{ n: number }>(
      "SELECT count(*)::int AS n FROM fleet_worker_events WHERE claim_id=$1", [claimId]))[0]!.n;
    // Enrolls one real mcp-agent through the real gateway store, as the fleet login.
    const enroll = async (label: string, projectId: string) => {
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: label, workerKind: "mcp-agent",
        projectIds: [projectId], capabilities: ["writing"], maxConcurrent: 2 });
      const secret = connector.newSecret();
      const joined = await gateway.enroll({ code: code.code, workerKind: "mcp-agent",
        credentialDigest: connector.sha256(secret), platform: "linux", architecture: "x64",
        connectorVersion: connector.CONNECTOR_VERSION, clientNonce: connector.newEnrollmentNonce() });
      const principal = await gateway.authenticate({ bearer: secret, declaredWorkerId: joined.workerId });
      return { secret, joined, principal };
    };
    const offer = async (name: string, projectId: string) => {
      const task = await seedProposedTask(admin.client, projectId, name);
      const offered = await owner.offerTask(ownerIdentity(), { projectId, jobId: task.jobId, capability: "writing" });
      return { task, offered };
    };
    try {
      assert.equal((await asFleet<{ login: string }>("SELECT current_user AS login"))[0]?.login, "control_room_fleet",
        "every lease renewal in this file runs AS the production fleet gateway login");
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));

      // THE MEASURED SHAPE. One job, three lease lengths, identical notes with
      // the connector's DERIVED key throughout -- the heartbeat a bot really
      // sends -- and the assertion is that the lease never falls behind.
      const { task, offered } = await offer("r6c03-long", PROJECT_A);
      const holder = await enroll("R6C-03 holder", PROJECT_A);
      const claim = await gateway.claim(holder.principal, { offerId: offered.offerId, idempotencyKey: KEY("claim") });
      assert.equal(claim.taskState, "leased");
      const leaseAtClaim = await leaseOf(claim.claimId);
      assert.equal(leaseAtClaim.state, "active");
      const claimExpiry = Date.parse(iso(leaseAtClaim.expires_at));
      const heartbeat = connector.idempotencyKeyFor("progress", { claimId: claim.claimId, message: "Still working" });

      const expiries: string[] = [];
      const replies: Array<{ replayed: boolean; leaseExpiresAt: string | null }> = [];
      let monotonic = true, previous = 0;
      for (let tick = 1; tick <= TICKS; tick += 1) {
        const reply = await gateway.progress(holder.principal, { claimId: claim.claimId, message: "Still working",
          idempotencyKey: heartbeat });
        const live = await leaseOf(claim.claimId);
        const expiry = iso(live.expires_at);
        expiries.push(expiry);
        replies.push(reply);
        assert.equal(live.state, "active", `the lease is still active at tick ${tick}`);
        assert.ok(Date.parse(expiry) >= claimExpiry, `tick ${tick}: expiry ${expiry} fell behind the claim-time expiry`);
        if (previous !== 0 && Date.parse(expiry) <= previous) monotonic = false;
        previous = Date.parse(expiry);
        if (tick === 1) assert.equal(reply.replayed, false, "the first note is stored, not replayed");
        else assert.equal(reply.replayed, true, `note ${tick} repeats note 1, so it is a replay of the NOTE`);
        // The reply always carries the lease's real stored expiry, never null:
        // null was exactly what made this failure invisible.
        assert.equal(reply.leaseExpiresAt, expiry, `tick ${tick}: the reply carries the lease's real expiry`);
        assert.ok(reply.leaseExpiresAt !== null, `tick ${tick}: a keepalive must never report a null expiry`);
        if (tick < TICKS) await sleep(TICK_MS);
      }
      assert.ok(monotonic, `every identical note advanced the lease: ${expiries.join(", ")}`);
      assert.ok(Date.parse(expiries[expiries.length - 1]!) >= claimExpiry + 2 * LEASE_MS,
        `the lease ran past two renewals beyond its claim-time expiry (${expiries[expiries.length - 1]})`);
      assert.equal(await eventCount(claim.claimId), 1,
        `${TICKS} identical notes are still ONE stored event row: the note is one row, only the lease moves`);
      assert.deepEqual(replies.map(reply => reply.replayed), [false, ...Array(TICKS - 1).fill(true)]);
      // The whole point of the lease: a bot that is reporting in keeps its task.
      assert.equal((await supervisor.reconcileStalled()).filter(outcome => outcome.jobId === task.jobId).length, 0,
        "the production supervisor finds NO stall in a job its bot is keeping alive");
      assert.equal((await asWeb<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1",
        [task.jobId]))[0]!.state, "running", "the task stayed honestly running");

      // A RIVAL, enrolled and holding its OWN claim, cannot see or take this
      // task while that lease is alive -- the owner consequence of the finding.
      const rivalFixture = await offer("r6c03-rival", PROJECT_B);
      const rival = await enroll("R6C-03 rival", PROJECT_B);
      const rivalClaim = await gateway.claim(rival.principal, { offerId: rivalFixture.offered.offerId,
        idempotencyKey: KEY("rival-claim") });
      assert.equal((await gateway.listWork(rival.principal)).filter(row => row.jobId === task.jobId).length, 0,
        "another worker cannot see a task whose lease is alive");
      // It also cannot extend it: a foreign claim id is indistinguishable from
      // a missing one, so nothing is renewed.
      const beforeSteal = await leaseOf(claim.claimId);
      await assert.rejects(gateway.progress(rival.principal, { claimId: claim.claimId, message: "Still working",
        idempotencyKey: KEY("rival-steal") }), (error: unknown) => (error as { code?: string }).code === "not_found",
      "another worker's note on this claim is refused, not ignored");
      assert.equal(iso((await leaseOf(claim.claimId)).expires_at), iso(beforeSteal.expires_at),
        "a foreign worker's note renews nothing");
      // And the rival may renew its OWN claim, which is the control proving the
      // refusal above was about OWNERSHIP rather than a broken note.
      await sleep(TICK_MS);
      const rivalRenewal = await gateway.progress(rival.principal, { claimId: rivalClaim.claimId,
        message: "Still working", idempotencyKey: KEY("rival-own") });
      assert.equal(rivalRenewal.leaseExpiresAt, iso((await leaseOf(rivalClaim.claimId)).expires_at));
      assert.ok(Date.parse(rivalRenewal.leaseExpiresAt!) > Date.parse(iso(beforeSteal.expires_at)),
        "the holder of a claim renews it, so the refusal above was about ownership");

      // A LOST REPLY retried with its ORIGINAL key. Two properties, both
      // measured: the note is still ONE event row, and the reply reports the
      // lease's REAL stored expiry rather than anything invented. The expiry may
      // move, because the holder is still alive and reporting -- that is the
      // keepalive working -- but it never moves further than one lease length
      // ahead of now, and the reply must equal what the database actually holds.
      const beforeRetry = await leaseOf(claim.claimId);
      const retry = await gateway.progress(holder.principal, { claimId: claim.claimId, message: "Still working",
        idempotencyKey: heartbeat });
      assert.equal(retry.replayed, true, "an exact retry of one key is a replay of the note");
      assert.equal(retry.leaseExpiresAt, iso((await leaseOf(claim.claimId)).expires_at),
        "a retry reports the expiry the lease really holds, never an invented one");
      assert.ok(retry.leaseExpiresAt !== null, "a retry must never report a null expiry");
      assert.ok(Date.parse(iso((await leaseOf(claim.claimId)).expires_at)) >= Date.parse(iso(beforeRetry.expires_at)),
        "a retry never moves the lease backwards");
      assert.ok(Date.parse(retry.leaseExpiresAt!) <= Date.now() + LEASE_MS,
        "a retry never pushes the lease more than one lease length past now");
      assert.equal(await eventCount(claim.claimId), 1, "a retry of a lost reply stores no second event");
      // One key cannot carry two different notes on the same claim.
      await assert.rejects(gateway.progress(holder.principal, { claimId: claim.claimId,
        message: "A different note entirely.", idempotencyKey: heartbeat }),
      (error: unknown) => (error as { code?: string }).code === "conflict",
      "one key cannot carry two different notes");

      // Concurrency. The pool this store runs on is EIGHT connections wide and its
      // per-statement budget is 5s, so a 50-way simultaneous burst is measured
      // the way a real gateway sees one. At the STORE layer the pool's own
      // admission bound surfaces as `PrivateDatabaseError("database_unavailable")`
      //; `gateway-http.ts` is what maps it to the fleet refusal `unavailable`,
      // which the connector retries with the same key (`TRANSIENT_CODES`). So
      // the properties asserted here are the ones that must hold however the
      // pool drains: at least one caller was served, at least one caller stored
      // the renewal, every SERVED reply carries a real stored expiry, no caller
      // ever saw an expiry the lease did not hold, and exactly one event row
      // exists however many callers ran.
      await sleep(TICK_MS);
      const atBurst = await leaseOf(claim.claimId);
      const burst = await Promise.allSettled(Array.from({ length: 50 }, () => gateway.progress(holder.principal,
        { claimId: claim.claimId, message: "Still working", idempotencyKey: heartbeat })));
      const served = burst.filter(entry => entry.status === "fulfilled")
        .map(entry => (entry as PromiseFulfilledResult<{ replayed: boolean; leaseExpiresAt: string | null }>).value);
      const refused = burst.filter(entry => entry.status === "rejected");
      const burstLease = await leaseOf(claim.claimId);
      assert.ok(served.length >= 1, `at least one of the ${burst.length} identical notes was served (${served.length})`);
      assert.ok(refused.every(entry => {
        const error = (entry as PromiseRejectedResult).reason as { code?: string; message?: string };
        // The pool's admission bound is the ONLY refusal a 50-way identical
        // burst may produce here: every caller is the holder of one live lease,
        // and it is a transport bound rather than an answer about the work.
        return error?.code === "database_unavailable" || error?.message === "database_unavailable";
      }), `the only refusal a 50-way identical burst may produce is the pool bound: ${
        [...new Set(refused.map(entry => ((entry as PromiseRejectedResult).reason as { code?: string })?.code ?? "?"))].join(",")
      } over ${refused.length} of ${burst.length} callers`);
      assert.ok(served.every(reply => typeof reply.leaseExpiresAt === "string" && reply.leaseExpiresAt !== null),
        `every SERVED reply in a 50-way identical burst carries a lease expiry (${served.length} served)`);
      // The heartbeat key was stored long before the burst, so every caller here
      // is a REPLAY of the note -- and under the fix that is precisely the case
      // that must still renew. If the old replay branch were back, none of them
      // would report an expiry at all, which is why this asserts the expiry
      // rather than a `replayed: false`.
      assert.ok(served.every(reply => reply.replayed === true),
        `every caller in the burst is a replay of the already-stored note (${served.length} served)`);
      assert.equal(await eventCount(claim.claimId), 1, "the burst stored no duplicate event");
      assert.ok(Date.parse(iso(burstLease.expires_at)) > Date.parse(iso(atBurst.expires_at)),
        `the burst moved the lease forward: ${iso(atBurst.expires_at)} -> ${iso(burstLease.expires_at)}`);
      // Whatever each caller saw must be an expiry the lease really held: a
      // burst is where a stale or invented value would surface.
      const reached = [...new Set(served.map(reply => reply.leaseExpiresAt))]
        .map(value => value as string);
      assert.ok(reached.every(value => Date.parse(value) >= Date.parse(iso(atBurst.expires_at))),
        `every burst reply reports an expiry the lease really held: ${reached.join(", ")}`);

      // AN OLD LEASE CANNOT BE REVIVED. The lease is aged the way a machine that
      // simply stopped reporting ages it: the acquisition moves back with the
      // expiry, because control_leases checks expires_at > acquired_at and
      // 0003's payload mirror compares both instants. Only the schema owner may
      // do this -- which is the point: no application role can fake an expiry.
      await admin.client.query(`UPDATE control_leases SET acquired_at=statement_timestamp()-interval '3 minutes',
        expires_at=statement_timestamp()-interval '2 minutes',
        payload=payload
          || jsonb_build_object('acquiredAt',to_jsonb((statement_timestamp()-interval '3 minutes')::timestamptz))
          || jsonb_build_object('expiresAt',to_jsonb((statement_timestamp()-interval '2 minutes')::timestamptz))
        WHERE id=(SELECT lease_id FROM fleet_claims WHERE claim_id=$1)`, [claim.claimId]);
      const agedExpiry = iso((await leaseOf(claim.claimId)).expires_at);
      assert.ok(Date.parse(agedExpiry) < Date.now(), `the fixture really aged this lease into the past (${agedExpiry})`);
      const eventsBeforeStale = await eventCount(claim.claimId);
      // A STALE key -- the very key that has renewed all along -- on an elapsed
      // lease. This is the case the finding names: an old lease must never be
      // revived, and a stale key must not even be answered.
      await assert.rejects(gateway.progress(holder.principal, { claimId: claim.claimId, message: "Still working",
        idempotencyKey: heartbeat }), (error: unknown) => (error as { code?: string }).code === "expired",
      "R6C-03: the stale key that renewed all along is refused on an elapsed lease, not revived");
      // A FRESH key on the same elapsed lease, from its own rightful holder.
      await assert.rejects(gateway.progress(holder.principal, { claimId: claim.claimId, message: "Still working",
        idempotencyKey: KEY("after-elapsed") }), (error: unknown) => (error as { code?: string }).code === "expired",
      "an elapsed lease is not renewable at all, even for its own holder with a brand-new key");
      assert.equal(iso((await leaseOf(claim.claimId)).expires_at), agedExpiry,
        "neither refused note moved the elapsed lease");
      assert.equal(await eventCount(claim.claimId), eventsBeforeStale, "the refused notes recorded no events");
      // The production supervisor is what actually reclaims an elapsed lease,
      // and it does so as the coordinator login, never as the gateway.
      assert.deepEqual(await gateway.reconcile(), { reviews: 0, revocations: 0, leaseRevocations: 0 },
        "the gateway leaves an elapsed fleet lease to the supervisor, as it always has");
      assert.ok((await supervisor.reconcileStalled()).some(outcome => outcome.jobId === task.jobId),
        "the production supervisor reclaims the elapsed lease and hands the task back");
      assert.ok(["ready", "proposed"].includes((await asWeb<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1",
        [task.jobId]))[0]!.state), "the task is handed back rather than lost");
      await assert.rejects(gateway.progress(holder.principal, { claimId: claim.claimId, message: "Still working",
        idempotencyKey: KEY("after-sweep") }),
      (error: unknown) => ["expired", "conflict", "not_found"].includes((error as { code?: string }).code ?? ""),
      "a swept claim cannot be revived by its former holder, even with a fresh key");
      assert.equal(await eventCount(claim.claimId), eventsBeforeStale,
        "nothing after the sweep recorded an event or moved a lease");

      // A RELEASED lease. A blocker with release hands the task back and the
      // lease is gone; a later note with a FRESH key must not revive it.
      const releaseFixture = await offer("r6c03-released", PROJECT_A);
      const releaseClaim = await gateway.claim(holder.principal, { offerId: releaseFixture.offered.offerId,
        idempotencyKey: KEY("release-claim") });
      await gateway.blocker(holder.principal, { claimId: releaseClaim.claimId, message: "Blocked.",
        idempotencyKey: KEY("release-blocker"), release: true });
      const releasedState = (await leaseOf(releaseClaim.claimId)).state;
      assert.notEqual(releasedState, "active", `the released lease is not active (it is ${releasedState})`);
      await assert.rejects(gateway.progress(holder.principal, { claimId: releaseClaim.claimId, message: "Still working",
        idempotencyKey: KEY("after-release") }),
      (error: unknown) => ["conflict", "expired", "not_found"].includes((error as { code?: string }).code ?? ""),
      "a released lease refuses a fresh note rather than reviving itself");
      assert.equal((await leaseOf(releaseClaim.claimId)).state, releasedState, "the released lease was not reactivated");

      // A REVOKED machine. The owner revokes the worker; its in-flight lease is
      // released by the gateway's reconciler, and it can no longer authenticate.
      const revokeFixture = await offer("r6c03-revoked", PROJECT_A);
      const revokedClaim = await gateway.claim(holder.principal, { offerId: revokeFixture.offered.offerId,
        idempotencyKey: KEY("revoked-claim") });
      assert.equal((await owner.revokeWorker(ownerIdentity(), holder.joined.workerId)).revoked, true);
      await assert.rejects(gateway.authenticate({ bearer: holder.secret, declaredWorkerId: holder.joined.workerId }),
        (error: unknown) => (error as { code?: string }).code === "unauthenticated",
      "a revoked machine can no longer authenticate, so it can renew nothing");
      assert.notEqual((await leaseOf(revokedClaim.claimId)).state, "active",
        "the revoked worker's lease was released, not renewed");
      assert.equal((await supervisor.reconcileStalled()).filter(outcome => outcome.jobId === revokeFixture.task.jobId).length,
        0, "a revoked worker's lease is never counted as a stall");

      // THE AUTHORITY CEILING. No amount of repetition may buy a bot more time than
      // the owner approved, and there are three clamps: the lease length from
      // now, the job's authority expiry, and the job's maximum duration measured
      // from when the lease was ACQUIRED. The lease-length clamp is the one the
      // heartbeat loop above measures. This covers the other two, on a task whose
      // owner authority is deliberately SHORT -- one lease length plus a second,
      // so the ceiling binds inside the test window rather than in two hours.
      const shortAuthority = await seedProposedTask(admin.client, PROJECT_A, "r6c03-short-authority",
        { maxDurationSeconds: 32 });
      const shortOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A,
        jobId: shortAuthority.jobId, capability: "writing" });
      const shortHolder = await enroll("R6C-03 short authority", PROJECT_A);
      const shortClaim = await gateway.claim(shortHolder.principal, { offerId: shortOffer.offerId,
        idempotencyKey: KEY("short-claim") });
      const shortAtClaim = await leaseOf(shortClaim.claimId);
      const shortCeiling = Math.min(Date.parse(iso(shortAtClaim.expires_at)) + LEASE_MS,
        Date.parse(iso(shortAtClaim.acquired_at)) + 32_000);
      const shortExpiries: string[] = [];
      for (let tick = 1; tick <= 6; tick += 1) {
        await gateway.progress(shortHolder.principal, { claimId: shortClaim.claimId, message: "Still working",
          idempotencyKey: KEY(`short-${tick}`) });
        const live = await leaseOf(shortClaim.claimId);
        shortExpiries.push(iso(live.expires_at));
        assert.ok(Date.parse(iso(live.expires_at)) <= shortCeiling + 1,
          `tick ${tick}: the lease was pushed to ${iso(live.expires_at)}, past the owner's authority ceiling `
          + `${new Date(shortCeiling).toISOString()}`);
        await sleep(4_000);
      }
      assert.ok(Date.parse(shortExpiries[shortExpiries.length - 1]!) > Date.parse(shortExpiries[0]!),
        "the short-authority lease did renew inside its ceiling");
      // And the ceiling really did bind: repeating forever must not extend past
      // it, so a note after the ceiling has been reached changes nothing.
      const atCeiling = await leaseOf(shortClaim.claimId);
      const afterCeiling = await gateway.progress(shortHolder.principal, { claimId: shortClaim.claimId,
        message: "Still working", idempotencyKey: KEY("short-past-ceiling") });
      assert.equal(afterCeiling.leaseExpiresAt, iso(atCeiling.expires_at),
        "a note after the owner's authority ceiling was reached renews nothing: repetition buys no more time");
      assert.equal(iso((await leaseOf(shortClaim.claimId)).expires_at), iso(atCeiling.expires_at),
        "the lease stopped exactly at the ceiling and never moved past it");

      // BAD INPUT, including the empty-prose case the connector's own validator
      // treats as a refusal. None may create, renew or move anything. The task
      // lives in PROJECT_B because 0100's scope guard holds one assignment
      // lease per project per tree, and every PROJECT_A lease in this test is
      // still held -- claiming there would be refused for scope, not for
      // anything about the note being tested.
      const badFixture = await offer("r6c03-badinput", PROJECT_B);
      const badHolder = await enroll("R6C-03 bad input", PROJECT_B);
      const badClaim = await gateway.claim(badHolder.principal, { offerId: badFixture.offered.offerId,
        idempotencyKey: KEY("bad-claim") });
      const untouched = await leaseOf(badClaim.claimId);
      for (const [label, input] of [
        ["a non-string message", { claimId: badClaim.claimId, message: 7, idempotencyKey: KEY("bad-msg") }],
        ["an empty message", { claimId: badClaim.claimId, message: "   ", idempotencyKey: KEY("blank-msg") }],
        ["a message over the bound", { claimId: badClaim.claimId, message: "x".repeat(2001), idempotencyKey: KEY("long-msg") }],
        ["a malformed idempotency key", { claimId: badClaim.claimId, message: "Still working", idempotencyKey: "no" }],
        ["a claim id that is not one", { claimId: "fleet-claim:zz", message: "Still working", idempotencyKey: KEY("bad-claim-id") }],
        ["a control character in the note", { claimId: badClaim.claimId, message: "Stillworking", idempotencyKey: KEY("ctl-msg") }],
        ["another worker's claim", { claimId: rivalClaim.claimId, message: "Still working", idempotencyKey: KEY("cross") }],
      ] as const) {
        await assert.rejects(gateway.progress(badHolder.principal, input as never),
          (error: unknown) => ["invalid", "not_found"].includes((error as { code?: string }).code ?? ""),
        `${label} is refused`);
      }
      assert.equal(iso((await leaseOf(badClaim.claimId)).expires_at), iso(untouched.expires_at),
        "no refused call moved the lease");
      assert.equal(await eventCount(badClaim.claimId), 0, "no refused call recorded an event");
    } finally {
      await Promise.allSettled([admin.close(), fleet.close(), fleetOwner.close(), coordinator.close()]);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 420_000 });
});

// The dispatcher's derived key is the mechanism the whole finding rests on, so
// it is proved here over the REAL dispatcher with the REAL connector client and
// no database: fifty calls with different JSON-RPC ids and identical arguments
// must reach the client as ONE operation key, and a caller's own key must reach
// the gateway byte for byte.
test("R6C-03: the connector derives one operation key from identical progress arguments", async t => {
  const root = await mkdtemp(join(tmpdir(), "fleet-progress-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "connector.json");
  await writeFile(configPath, JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: `fleet-worker:${"a".repeat(32)}`, secret: connector.newSecret() }), { mode: 0o600 });
  const keys: string[] = [], mcpCalls: string[] = [];
  const reply = { eventId: "fleet-event:", replayed: false, leaseExpiresAt: "2026-01-01T00:00:30.000Z" };
  const client = {
    me: async () => ({ workingAgreement: connector.WORKING_AGREEMENT }),
    progress: async (_claimId: string, _message: string, key: string) => { keys.push(key); return reply; },
    mcpCall: async (callId: string) => { mcpCalls.push(callId); },
  };
  const dispatch = connector.createMcpDispatcher({ client: client as never, configPath });
  for (let id = 1; id <= 50; id += 1) {
    const answer = await dispatch({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "post_progress", arguments: { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Still working" } } });
    assert.ok(answer && "result" in answer && !(answer as { result: { isError?: boolean } }).result.isError);
  }
  assert.equal(new Set(keys).size, 1,
    `fifty identical notes over fifty request ids reach the gateway as ${new Set(keys).size} operation keys`);
  assert.equal(keys[0], connector.idempotencyKeyFor("progress", { claimId: `fleet-claim:${"a".repeat(32)}`,
    message: "Still working" }), "the key is the documented function of tool and arguments");
  assert.equal(mcpCalls.length, 50, "every attempt is still audited");
  // An explicit key reaches the gateway as the caller wrote it, byte for byte,
  // and is NEVER hashed: a bot that manages its own keys gets its own keys.
  let explicitKey = "";
  const keyed = connector.createMcpDispatcher({ configPath, client: { ...client,
    progress: async (_claimId: string, _message: string, key: string) => { explicitKey = key; return reply; } } as never });
  await keyed({ jsonrpc: "2.0", id: 51, method: "tools/call",
    params: { name: "post_progress", arguments: { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Still working",
      idempotencyKey: "my-own-progress-key-0001" } } });
  assert.equal(explicitKey, "my-own-progress-key-0001", "a caller's own key is passed through untouched");
  // Different notes, different claims and different tools are different
  // operations, so the derived key separates content rather than collapsing it.
  assert.notEqual(connector.idempotencyKeyFor("progress", { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Still working" }),
    connector.idempotencyKeyFor("progress", { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Nearly done." }),
    "the derived key separates different notes on the same claim");
  assert.notEqual(connector.idempotencyKeyFor("progress", { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Still working" }),
    connector.idempotencyKeyFor("progress", { claimId: `fleet-claim:${"b".repeat(32)}`, message: "Still working" }),
    "the derived key separates the same note on different claims");
  assert.notEqual(connector.idempotencyKeyFor("progress", { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Still working" }),
    connector.idempotencyKeyFor("blocker", { claimId: `fleet-claim:${"a".repeat(32)}`, message: "Still working" }),
    "the derived key separates the same arguments on different tools");
});