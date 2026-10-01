// Real-PostgreSQL proof of navigation Stage 0 + 0b (MIG-N, 0240-0242), run as
// the PRODUCTION private-web login against a disposable cluster on this file's
// reserved port lane (59960-59969).
//
// Every claim below is a claim the product makes, checked against the database
// rather than against a fake:
//
//   - DUE IS COMPUTED. A chore whose last done instant was a week ago is due;
//     one done an hour ago is not, and the only difference is the row's own
//     last_done_at. Nothing stores a due date.
//   - DONE IS FORWARD-ONLY. Marking a chore done pushes its next due date out by
//     the cadence, so "I check it once and don't need to see it again" is what
//     the row actually says. A second Done, a stale Done from a retry, and a
//     hand-written UPDATE that would rewind it are each refused.
//   - SNOOZE HIDES, DONE DOES NOT DELETE. A snoozed chore leaves the panel; a
//     chore is removed only by its down migration and the web login holds no
//     DELETE on it at all.
//   - ONE OWNER CANNOT READ, ACT ON, OR FORGE ANOTHER'S ROWS. Two independent
//     identities in the same tenant, and the second sees an empty panel, gets
//     `not_found` for the first's chore, and cannot mark the first's chore done.
//   - THE GUARD RE-READS THE LIVE OWNER GRANT. A row whose named identity is not
//     an active human owner with a tenant-wide grant is refused by the DATABASE,
//     even when the SQL that inserted it was well-formed and ran as a login that
//     legitimately holds INSERT.
//   - THE WEB LOGIN HOLDS EXACTLY THE GRANTED COLUMNS. A hand-written UPDATE
//     that tries to rewrite a chore's title, cadence or owner is refused by the
//     GRANT, before any trigger runs.
//
// Plus the down-rung proof: each down file removes everything its up file added,
// on a live cluster.
//
// ON THE CLOCK, because it changes what each assertion means. The service is
// handed a FIXED clock so every due computation is deterministic, and the guards
// in 0242 compare their stamps against the DATABASE's own statement_timestamp()
// — which is real time, not this clock. So the fixed instant here is real
// `Date.now()`, and due-ness is moved by moving `last_done_at` through the
// service (whose value IS the service clock) rather than by pretending the
// database clock jumped forward. Every stamp the service writes is therefore
// inside the guard's own bounds by construction.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { OwnerNavigationServiceV1 } from "../src/web/v1/owner-navigation-service";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

// The assigned lane for this stream: 59960-59969, and nothing outside it.
const PORT = Number(process.env.NAVIGATION_PG_PORT ?? 59960);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const scope = { tenantId: "tenant:nav-pg", workspaceId: "workspace:nav-pg" };
const OWNER_A = "identity:nav-pg-a";
const OWNER_B = "identity:nav-pg-b";
const ZONE = "UTC";

function identityFor(subject: string, token: string): VerifiedWebIdentity {
  const issuedAt = new Date(NOW).toISOString();
  const expiresAt = new Date(NOW + 6 * HOUR).toISOString();
  return { provider: "test", subject, tokenDigest: sha256Digest(token),
    issuedAt, expiresAt, verificationExpiresAt: expiresAt };
}
const ownerA = identityFor("nav-owner-a", "nav-web-session-a");
const ownerB = identityFor("nav-owner-b", "nav-web-session-b");

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

async function seedOwner(admin: Client, identity: VerifiedWebIdentity, identityId: string, grantId: string) {
  const at = new Date(NOW).toISOString();
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)
    ON CONFLICT (id) DO NOTHING`,
  [identityId, scope.tenantId, sha256Digest({ provider: identity.provider, subject: identity.subject }), at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)
    ON CONFLICT (id) DO NOTHING`, [grantId, scope.tenantId, identityId, at]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  [scope.tenantId, identity.tokenDigest, identityId, at, new Date(NOW + 6 * HOUR).toISOString()]);
}

/**
 * The default-path service: real functions, no injected port, tool or runner.
 *
 * The SESSION clock is real `Date.now()` (as it is in production), and only the
 * DUE clock is simulated — so a test can ask "would this be due in a week?"
 * without making the session look expired to `WebSessionAuthority` or the
 * database guards. Everything else — the queries, the guards, the grants, the
 * stamps actually written — is the production path.
 */
function service(web: Client, dueMs: number) {
  return new OwnerNavigationServiceV1(database(web), scope, () => Date.now(), () => dueMs);
}

test("real PostgreSQL: Stage 0 + 0b chores, visits and pins, as the production web login",
  PG ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async (postgres: RealPostgres) => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const web = new Client(postgres.connection("web"));
    await web.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)",
        [scope.workspaceId, scope.tenantId]);
      await seedOwner(admin, ownerA, OWNER_A, "grant:nav-pg-a");
      await seedOwner(admin, ownerB, OWNER_B, "grant:nav-pg-b");
      const now = service(web, NOW);

      // ---- 1. An empty panel is an honest "nothing is due", not an error and not a 0.
      const empty = await now.dueChores(ownerA);
      assert.deepEqual(empty.chores, [], "a new owner has nothing due");
      assert.equal(empty.source, "recorded", "an empty panel is a real read, not an unavailable one");
      assert.equal(empty.startsWork, false);
      assert.equal(empty.grantsExecutionAuthority, false);

      // ---- 2. Due is COMPUTED from the cadence and the row's own last_done_at.
      // A daily chore declared just now is not due, whatever the hour is: the
      // first firing of "every day at 12:00" strictly after this instant is still
      // in the future. Nothing stored that fact.
      const fresh = await now.declareChore(ownerA,
        { title: "Review bot memory", targetPageKey: "bot-memory", schedule: "every day at 12:00", timezone: ZONE });
      assert.equal(fresh.chore.schedule, "every day at 12:00", "the owner's own words come back");
      assert.equal(fresh.chore.cronExpression, "0 12 * * *", "the normalized cron is derived here, not supplied");
      assert.equal(fresh.stillDue, false, "declared at this instant, the next firing has not happened yet");
      // A KNOWN LIMIT OF THE SHARED GRAMMAR, asserted rather than discovered later:
      // parsePlainRecurringScheduleV1's hour field is (1[0-2]|[1-9]), so midnight
      // is NOT expressible — "every day at 00:00" and "at 0:00" are both refused.
      // That grammar is shared with control_recurring_rules (0186) and is not this
      // stream's to change, so a chore that genuinely wants a midnight fire has no
      // spelling today. Recorded here because it will look like a bug to whoever
      // tries it, and because the alternative — widening the shared regex from a
      // database stream — would change an owner-facing rule surface for no gain.
      await assert.rejects(now.declareChore(ownerA,
        { title: "Midnight", targetPageKey: "bot-memory", schedule: "every day at 00:00", timezone: ZONE }),
      /invalid_request/u, "the shared cadence grammar does not express midnight");
      assert.deepEqual((await now.dueChores(ownerA)).chores, [], "still nothing due, and still a recorded read");

      // Tomorrow, the SAME row is due, with no write in between. That is the whole
      // claim: due is a function of now, and now is the only thing that moved.
      const tomorrow = service(web, NOW + DAY);
      const due = await tomorrow.dueChores(ownerA);
      assert.equal(due.chores.length, 1, "tomorrow the same row is due");
      assert.equal(due.chores[0]!.title, "Review bot memory");
      assert.equal(due.chores[0]!.lastDoneAt, null, "never done");
      assert.equal(due.chores[0]!.dueAt, fresh.chore.dueAt,
        "the due instant is the cadence's own firing, computed twice and identical");
      assert.equal(due.chores[0]!.nextDueAt, fresh.chore.nextDueAt,
        `and the read says when it comes back (declare said ${fresh.chore.nextDueAt}, read says ${due.chores[0]!.nextDueAt})`);

      // ---- 3. DONE pushes the next due date out by the cadence, and is forward-only.
      // The Done is stamped with the REAL clock (actor.now), which is the whole
      // point of splitting the two clocks: a chore marked done now has its next
      // due date pushed out by a full cadence from NOW, not from some simulated
      // instant.
      const done = await now.actOnChore(ownerA, { action: "done", choreId: fresh.chore.choreId });
      assert.equal(done.stillDue, false, "a Done that landed is never reported as still due");
      assert.ok(Date.parse(done.chore.lastDoneAt!) >= Date.parse(new Date(NOW).toISOString()),
        "last_done_at is a real instant, not a simulated one");
      // The panel is empty right after a Done, because the next firing is a full
      // cadence away from the stamp just written.
      assert.deepEqual((await now.dueChores(ownerA)).chores, [],
        "the panel disappears the moment it is Done");
      // And it comes back one cadence later — the owner's own promise in §3b. The
      // due clock reads a day on, which is now past the firing a daily cadence
      // reached after the Done.
      assert.equal((await service(web, NOW + DAY).dueChores(ownerA)).chores.length, 1,
        "and reappears one full cadence later, which is the owner's own promise in §3b");

      // A stale retry must not rewind it. The service refuses an elapsed snooze
      // before it reaches the database...
      await assert.rejects(tomorrow.actOnChore(ownerA,
        { action: "snooze", choreId: fresh.chore.choreId, until: new Date(NOW).toISOString() }),
      /invalid_request/u, "a snooze already elapsed is refused before it reaches the database");
      // ... and the DATABASE refuses a rewind even when the SQL is hand-written
      // and well-formed, which is the part the service cannot enforce. The UPDATE
      // names only granted columns, so it reaches the guard rather than being
      // stopped by the column grant first.
      await assert.rejects(web.query(`UPDATE recurring_chores SET last_done_at=$3
        WHERE tenant_id=$1 AND owner_identity_id=$2`,
      [scope.tenantId, OWNER_A, new Date(NOW).toISOString()]),
      /recurring chore rejected/u, "the guard refuses a rewind a well-formed UPDATE attempts");

      // ---- 4. SNOOZE hides without deleting, and there is no DELETE path at all.
      const second = await tomorrow.declareChore(ownerA,
        { title: "Check the VPS front door", targetPageKey: "vps-front-door",
          schedule: "every day at 12:00", timezone: ZONE });
      const snoozedUntil = new Date(NOW + 3 * DAY).toISOString();
      const snoozed = await tomorrow.actOnChore(ownerA,
        { action: "snooze", choreId: second.chore.choreId, until: snoozedUntil });
      assert.equal(snoozed.stillDue, false);
      assert.equal(snoozed.chore.snoozedUntil, snoozedUntil);
      // A snooze three days out hides it for the whole of those three days, even
      // though the cadence fires daily — the snooze is the stronger claim. The
      // panel is NOT empty at this point: the FIRST chore is due again here, which
      // is exactly what it should be. So the assertion is scoped to the second
      // chore by id, not to the whole panel.
      const atSnooze = (await service(web, NOW + 2 * DAY).dueChores(ownerA)).chores;
      assert.equal(atSnooze.some(chore => chore.choreId === second.chore.choreId), false,
        "a snoozed chore stays out of the panel until its snooze ends");
      assert.equal(atSnooze.some(chore => chore.choreId === fresh.chore.choreId), true,
        "while a chore that was merely marked Done comes back when it is due again");
      assert.equal((await service(web, NOW + 4 * DAY).dueChores(ownerA)).chores
        .some(chore => chore.choreId === second.chore.choreId), true,
      "and comes back once the snooze has elapsed");
      const stillThere = (await admin.query(`SELECT count(*)::int AS n FROM recurring_chores
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND chore_id=$3`,
      [scope.tenantId, OWNER_A, second.chore.choreId])).rows[0]!.n;
      assert.equal(stillThere, 1, "a snooze hides the row from the panel; it does not remove it");
      // The web login has no DELETE on chores at all.
      await assert.rejects(web.query(`DELETE FROM recurring_chores WHERE tenant_id=$1`, [scope.tenantId]),
      /permission denied for table recurring_chores/u,
      "a chore is removed only by its down migration");
      // A BACKDATED SNOOZE IS REFUSED BY THE DATABASE. The service refuses one too,
      // but this is the hand-written path: a well-formed UPDATE naming only granted
      // columns, setting a snooze that has already elapsed. Without the guard's
      // future-bound this would silently re-arm the chore from the moment it was
      // written, which is exactly the "stale row that looks like a snooze" state the
      // column comment says the bound exists to prevent. `updated_at` is a real
      // "now" so the guard's snooze clause is the only thing that can refuse.
      const realInstant = new Date().toISOString();
      await assert.rejects(web.query(`UPDATE recurring_chores SET snoozed_until=$3,updated_at=$4
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND chore_id=$5`,
      [scope.tenantId, OWNER_A, new Date(Date.parse(realInstant) - DAY).toISOString(), realInstant,
        second.chore.choreId]),
      /recurring chore snooze rejected/u, "a snooze already elapsed is refused by the database, not just the service");
      // A FUTURE-DATED SNOOZE IS ACCEPTED, so the refusal above is the bound and
      // not the guard refusing everything.
      //
      // `snoozed_until` is the future hold the owner asked for and is legitimately
      // days away; the guard bounds updated_at against the clock and snoozed_until
      // only for being in the past. That split is the design, and it is why
      // `updated_at` does not travel with the snooze.
      await web.query(`UPDATE recurring_chores SET snoozed_until=$3,updated_at=$4
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND chore_id=$5`,
      [scope.tenantId, OWNER_A, new Date(Date.parse(realInstant) + 5 * DAY).toISOString(), realInstant,
        second.chore.choreId]);
      assert.equal((await admin.query(`SELECT snoozed_until FROM recurring_chores
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND chore_id=$3`,
      [scope.tenantId, OWNER_A, second.chore.choreId])).rows[0]!.snoozed_until instanceof Date, true,
      "and the future snooze really landed, so the refusal above is the bound");
      // A FUTURE SNOOZE CANNOT BE PULLED EARLIER BY HAND. This is the second,
      // independent monotonic clause — a future value is acceptable, a decrease is
      // not — and it is asserted separately because a guard that only checked
      // "must be in the future" would let a pull-back through.
      await assert.rejects(web.query(`UPDATE recurring_chores SET snoozed_until=$3
        WHERE tenant_id=$1 AND owner_identity_id=$2`,
      [scope.tenantId, OWNER_A, new Date(NOW + DAY).toISOString()]),
      /recurring chore rejected/u, "a future snooze cannot be pulled earlier by hand");

      // ---- 5. Bad input is refused, and refused with the same error.
      for (const bad of [
        { title: "", targetPageKey: "bot-memory", schedule: "every monday at 9:00", timezone: ZONE },
        { title: "x", targetPageKey: "Not A Key", schedule: "every monday at 9:00", timezone: ZONE },
        // A cron expression is not accepted from a caller: the cadence is parsed
        // from the owner's own words, so a client cannot invent one.
        { title: "x", targetPageKey: "bot-memory", schedule: "*/5 * * * *", timezone: ZONE },
        { title: "x", targetPageKey: "bot-memory", schedule: "every monday at 9:00", timezone: "Mars/Olympus" },
        { title: "x", targetPageKey: "bot-memory", schedule: "every monday at 9:00", timezone: ZONE, cron: "0 9 * * 1" },
      ]) await assert.rejects(now.declareChore(ownerA, bad), /invalid_request/u);
      await assert.rejects(tomorrow.actOnChore(ownerA, { action: "done", choreId: "chore:not-a-uuid" }),
      /invalid_request/u);
      await assert.rejects(tomorrow.actOnChore(ownerA,
        { action: "snooze", choreId: fresh.chore.choreId, until: "not a time" }), /invalid_request/u);
      // A snooze past the stated horizon is refused rather than accepted.
      await assert.rejects(tomorrow.actOnChore(ownerA, { action: "snooze", choreId: fresh.chore.choreId,
        until: new Date(NOW + 400 * DAY).toISOString() }), /invalid_request/u);

      // ---- 6. ONE OWNER CANNOT REACH ANOTHER'S ROWS. Owner B's own panel is
      // empty, B gets not_found for A's chore, and B cannot mark it done.
      const other = service(web, NOW + DAY);
      assert.deepEqual((await other.dueChores(ownerB)).chores, [], "B's panel does not contain A's chores");
      await assert.rejects(other.actOnChore(ownerB, { action: "done", choreId: fresh.chore.choreId }),
      /not_found/u, "another owner's chore is not found, which does not confirm it exists");
      // And B's own declare lands on B, leaving A's rows untouched.
      await other.declareChore(ownerB,
        { title: "B's own weekly", targetPageKey: "workers", schedule: "every tuesday at 7:00", timezone: ZONE });
      const owners = (await admin.query(`SELECT owner_identity_id,count(*)::int AS n FROM recurring_chores
        WHERE tenant_id=$1 GROUP BY owner_identity_id ORDER BY owner_identity_id`, [scope.tenantId])).rows;
      assert.deepEqual(owners, [{ owner_identity_id: OWNER_A, n: 2 }, { owner_identity_id: OWNER_B, n: 1 }],
        "each row belongs to exactly one owner");

      // ---- 7. THE GUARD RE-READS THE LIVE OWNER GRANT. The web login legitimately
      // holds INSERT, and the SQL below is well-formed with in-window stamps, but
      // it names an identity that is not an owner — so the DATABASE refuses it.
      //
      // THE FIXTURE IS A HUMAN WITH NO OWNER GRANT, NOT A SERVICE IDENTITY. A
      // first attempt used an `actor_type='service'` identity, and mutating the
      // guard's owner check did NOT fail the test — because the guard also
      // requires `actor_type='human'`, so the service identity was refused by that
      // clause and the owner-grant clause was never the thing under test. A human
      // identity that holds no owner grant passes every other clause, so the
      // refusal below can only be the owner-grant re-read.
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'human','A person with no grant','test',$3,'active',$4,$4) ON CONFLICT (id) DO NOTHING`,
      ["identity:nav-pg-nogrant", scope.tenantId, sha256Digest("nav-nogrant"), new Date(NOW).toISOString()]);
      await assert.rejects(web.query(`INSERT INTO recurring_chores
        (tenant_id,chore_id,title,target_page_key,plain_schedule,cron_expression,timezone,owner_identity_id,created_at,updated_at)
        VALUES($1,'chore:00000000-0000-4000-8000-000000000002','Forged','bot-memory','every day at 12:00',
          '0 12 * * *',$2,$3,$4,$4)`,
      [scope.tenantId, ZONE, "identity:nav-pg-nogrant", new Date(NOW).toISOString()]),
      /recurring chore needs the owner/u, "only the owner may write their own chore");
      // The same fixture through the other two guards. A human with no grant, so
      // each of these is refused by that guard's own owner re-read and nothing else.
      await assert.rejects(web.query(`INSERT INTO page_visits
        (tenant_id,owner_identity_id,page_key,last_opened_at,open_count,updated_at)
        VALUES($1,$2,'workers',$3,1,$3)`, [scope.tenantId, "identity:nav-pg-nogrant", new Date(NOW).toISOString()]),
      /page visit needs the owner/u);
      await assert.rejects(web.query(`INSERT INTO page_pins
        (tenant_id,owner_identity_id,page_key,pinned_at,updated_at) VALUES($1,$2,'workers',$3,$3)`,
      [scope.tenantId, "identity:nav-pg-nogrant", new Date(NOW).toISOString()]),
      /page pin needs the owner/u);
      // And a grant that exists but is NOT an owner grant — an operator — is
      // refused too, which is the case a `role_key='owner'` check alone catches but
      // an `allowed_actions` check alone would not, and the reverse.
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'human','An operator','test',$3,'active',$4,$4) ON CONFLICT (id) DO NOTHING`,
      ["identity:nav-pg-operator", scope.tenantId, sha256Digest("nav-operator"), new Date(NOW).toISOString()]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:nav-pg-operator',$1,$2,'operator','["projects.read"]','["*"]','low',false,false,$3,$3)`,
      [scope.tenantId, "identity:nav-pg-operator", new Date(NOW).toISOString()]);
      await assert.rejects(web.query(`INSERT INTO recurring_chores
        (tenant_id,chore_id,title,target_page_key,plain_schedule,cron_expression,timezone,owner_identity_id,created_at,updated_at)
        VALUES($1,'chore:00000000-0000-4000-8000-000000000003','Forged','bot-memory','every day at 12:00',
          '0 12 * * *',$2,$3,$4,$4)`,
      [scope.tenantId, ZONE, "identity:nav-pg-operator", new Date(NOW).toISOString()]),
      /recurring chore needs the owner/u, "an operator grant is not an owner grant");
      // And a revoked owner grant stops new writes even though the session itself is
      // still live. The refusal here comes from the POLICY layer (`actor.require`),
      // which is the first of two independent checks — the guard inside the
      // database never gets the chance to say no. That ordering is the stronger
      // arrangement, so the assertion accepts either refusal rather than pinning
      // one that a future refactor could legitimately move.
      await admin.query("UPDATE control_role_grants SET revoked_at=$3 WHERE tenant_id=$1 AND id=$2",
        [scope.tenantId, "grant:nav-pg-b", new Date(NOW).toISOString()]);
      await assert.rejects(now.declareChore(ownerB,
        { title: "After revocation", targetPageKey: "workers", schedule: "every tuesday at 7:00", timezone: ZONE }),
      /access_denied|recurring chore needs the owner/u,
      "a revoked grant stops new chores even though the session is live");
      await admin.query("UPDATE control_role_grants SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2",
        [scope.tenantId, "grant:nav-pg-b"]);

      // ---- 8. THE GRANT IS EXACT. A hand-written UPDATE that tries to rewrite a
      // chore's title, cadence or owner is refused by the COLUMN grant, before any
      // guard runs — so the frozen columns are protected by two independent
      // mechanisms, and the grant is the one that fires first.
      await assert.rejects(web.query(`UPDATE recurring_chores SET title='Renamed' WHERE tenant_id=$1`,
        [scope.tenantId]), /permission denied for table recurring_chores/u,
        "the web login cannot rewrite a chore's title");
      await assert.rejects(web.query(`UPDATE recurring_chores SET cron_expression='0 10 * * 2' WHERE tenant_id=$1`,
        [scope.tenantId]), /permission denied for table recurring_chores/u,
        "the web login cannot change a chore's cadence");
      await assert.rejects(web.query(`UPDATE recurring_chores SET owner_identity_id=$2 WHERE tenant_id=$1`,
        [scope.tenantId, OWNER_B]), /permission denied for table recurring_chores/u,
        "nor move a chore to another owner");

      // ---- 8b. THE FROZEN COLUMNS ARE FROZEN IN THE DATABASE TOO, NOT ONLY IN
      // THE GRANT. The assertions above are all refused by the COLUMN grant, which
      // means they prove nothing about the trigger: the schema owner holds every
      // column and bypasses every grant, so if the trigger's frozen-column clause
      // were removed these would still pass. So they are re-run AS THE SCHEMA OWNER,
      // where only the trigger can refuse. This is the only way to prove the second
      // mechanism is load-bearing rather than decorative.
      //
      // The role switch is ASSERTED rather than assumed: a silent no-op here would
      // make every assertion below pass for the wrong reason — as the migrator
      // login, whose UPDATE of `title` is refused by the GRANT, not by the trigger.
      const owner = new Client(postgres.connection("migrator"));
      await owner.connect();
      try {
        await owner.query("SET ROLE control_room_schema_owner");
        const role = (await owner.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role;
        assert.equal(role, "control_room_schema_owner",
          "the frozen-column assertions below must run as the schema owner, or they prove nothing");
        const target = (await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM recurring_chores WHERE tenant_id=$1", [scope.tenantId])).rows[0]!.n;
        assert.ok(target > 0, "and there is a row to update, so a refusal cannot be a vacuous one");
        // One parameter for the tenant in every case. The `owner_identity_id` case needs
        // a second, so it names $2 and gets one; the other five get exactly the one
        // they use. Passing two to a statement that only reads $1 is a bind error,
        // which is not a refusal and would have read as one.
        for (const [column, value, label] of [
          ["title", "'Renamed by the schema owner'", "a chore's title"],
          ["target_page_key", "'renamed'", "a chore's target page"],
          ["cron_expression", "'0 10 * * 2'", "a chore's cadence"],
          ["plain_schedule", "'every friday at 5'", "a chore's plain schedule"],
          ["timezone", "'America/Denver'", "a chore's timezone"],
          ["owner_identity_id", "$2", "a chore's owner"],
        ] as const) {
          const parameters = column === "owner_identity_id" ? [scope.tenantId, OWNER_B] : [scope.tenantId];
          let thrown: unknown;
          try {
            await owner.query(`UPDATE recurring_chores SET ${column}=${value} WHERE tenant_id=$1`, parameters);
          } catch (error) { thrown = error; }
          assert.ok(thrown !== undefined,
            `${label} must be refused; an UPDATE that changed nothing and raised nothing proves nothing`);
          assert.match(String((thrown as Error).message), /recurring chore rejected/u,
            `${label} is frozen even for the schema owner, who holds every column (got: ${(thrown as Error).message})`);
        }
        // And the permitted UPDATE still works as the schema owner, so the guard above is
        // refusing the frozen COLUMNS and not every write. Scoped to `fresh`, which
        // has a null snooze: `second` carries the future snooze section 4 gave it,
        // and a Done on a snoozed chore would trip the table's own
        // last_done_at <= snoozed_until CHECK — which is that constraint working,
        // not a reason to widen this UPDATE to every row.
        await owner.query(`UPDATE recurring_chores SET last_done_at=$2,updated_at=$2
        WHERE tenant_id=$1 AND owner_identity_id=$3 AND chore_id=$4`,
        [scope.tenantId, new Date().toISOString(), OWNER_A, fresh.chore.choreId]);
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM recurring_chores
        WHERE tenant_id=$1 AND chore_id=$2 AND last_done_at IS NOT NULL`,
        [scope.tenantId, fresh.chore.choreId])).rows[0]!.n, 1,
        "so a Done by the schema owner really landed, and the refusals above were about the frozen columns");
      } finally {
        await owner.query("RESET ROLE").catch(() => {});
        await owner.query("ROLLBACK").catch(() => {});
        await owner.end();
      }

      // ---- 9. PAGE VISITS move forward only, and a stale retry cannot rewind them.
      // Visits are stamped with the REAL clock (recordVisit compares and writes
      // against real instants), so the assertions here are about MONOTONICITY,
      // not about a simulated sequence: each new visit must not carry an earlier
      // stamp than the one before it.
      const firstVisit = await now.recordVisit(ownerA, { pageKey: "workers" });
      assert.equal(firstVisit.openCount, 1);
      const visitAgain = await now.recordVisit(ownerA, { pageKey: "workers" });
      assert.equal(visitAgain.openCount, 2, "the count is a counter");
      assert.ok(Date.parse(visitAgain.lastOpenedAt) >= Date.parse(firstVisit.lastOpenedAt),
        `recency moved forward, not back (${firstVisit.lastOpenedAt} -> ${visitAgain.lastOpenedAt})`);
      // A retry carrying the ORIGINAL timestamp must not pull the recency back.
      const stale = await now.recordVisit(ownerA,
        { pageKey: "workers", openedAt: firstVisit.lastOpenedAt });
      assert.ok(Date.parse(stale.lastOpenedAt) >= Date.parse(visitAgain.lastOpenedAt),
        `a stale retry cannot rewind the owner's recency order (${visitAgain.lastOpenedAt} -> ${stale.lastOpenedAt})`);
      assert.equal(stale.openCount, 3, "but it still counts: the visit did happen");
      // A clock far in the future is refused rather than clamped.
      await assert.rejects(now.recordVisit(ownerA,
        { pageKey: "workers", openedAt: new Date(NOW + 400 * DAY).toISOString() }),
      /invalid_request/u, "a phone with a wrong clock cannot pin a page to the top forever");
      // And the database refuses a hand-written rewind.
      await assert.rejects(web.query(`UPDATE page_visits SET last_opened_at=$3
        WHERE tenant_id=$1 AND owner_identity_id=$2`, [scope.tenantId, OWNER_A, new Date(NOW).toISOString()]),
      /page visit rejected/u, "the visit guard refuses a rewind");
      await assert.rejects(web.query(`DELETE FROM page_visits WHERE tenant_id=$1`, [scope.tenantId]),
      /permission denied for table page_visits/u, "visits have no DELETE path either");
      // The open counter cannot be lowered either: that would erase the fact that
      // the owner opened the page, which is the only thing the row records.
      await assert.rejects(web.query(`UPDATE page_visits SET open_count=1
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND page_key='workers'`, [scope.tenantId, OWNER_A]),
      /page visit rejected/u, "the visit guard refuses a lowered counter");

      // ---- 10. PINS: the one table with a DELETE, ordered by pin order. Pins are
      // stamped with the real clock too, so "the order they were pinned" is
      // asserted by the ORDER itself, which is what the tile rule actually reads
      // — not by comparing timestamps the test cannot control.
      await now.setPin(ownerA, { pageKey: "projects", pinned: true });
      const secondPin = await now.setPin(ownerA, { pageKey: "workers", pinned: true });
      assert.equal(secondPin.pinned, true);
      const shortcuts = await now.shortcuts(ownerA);
      assert.deepEqual(shortcuts.pinned.map(pin => pin.pageKey), ["projects", "workers"],
        "pins come back in the order they were pinned");
      assert.ok(Date.parse(shortcuts.pinned[1]!.pinnedAt) >= Date.parse(shortcuts.pinned[0]!.pinnedAt),
        "and that order matches their stamps");
      assert.deepEqual(shortcuts.recent.map(visit => visit.pageKey), ["workers"],
        "and the most recent page, most recent first");
      assert.equal(shortcuts.source, "recorded");
      // Re-pinning an already-pinned page moves it to the back: that is how the
      // owner reorders by hand, and it is the only spelling they have. The read
      // order is (pinned_at, page_key), so a same-millisecond re-pin is still
      // deterministic — but to assert the MOVE rather than the tie-break, this
      // one waits for the clock to tick.
      await new Promise(resolve => setTimeout(resolve, 5));
      await now.setPin(ownerA, { pageKey: "projects", pinned: true });
      assert.deepEqual((await now.shortcuts(ownerA)).pinned.map(pin => pin.pageKey),
        ["workers", "projects"], "a re-pin moves to the back of the owner's own order");
      // Unpin is the one DELETE, and it removes only this owner's row.
      const unpinned = await now.setPin(ownerA, { pageKey: "workers", pinned: false });
      assert.equal(unpinned.pinned, false);
      assert.equal(unpinned.pinnedAt, null);
      assert.deepEqual((await now.shortcuts(ownerA)).pinned.map(pin => pin.pageKey),
        ["projects"], "unpinning removes exactly one pin");
      // B's shortcuts never contain A's, and a bad key is refused.
      await assert.rejects(now.setPin(ownerB, { pageKey: "Not_A_KEY", pinned: true }),
      /invalid_request/u, "a page key that is not a registry key is refused");
      await assert.rejects(now.recordVisit(ownerA, { pageKey: "Not_A_KEY" }), /invalid_request/u);
      const bShortcuts = await service(web, NOW + DAY).shortcuts(ownerB);
      assert.deepEqual(bShortcuts.pinned, [], "one owner's pins are not another's");
      assert.deepEqual(bShortcuts.recent, [], "nor are their visits");

      // ---- 11. THE BOUNDS ARE REPORTED, NOT HIDDEN. Fifty is the panel's limit,
      // and an owner with more than that is told so — this app's standing rule is
      // that a missing signal has to be a real signal. The query asks for one row
      // more than the panel shows, which is how the extra one is known to exist.
      // Seeded directly as the admin rather than through the service: 51 declares
      // would take 51 authenticated transactions and prove nothing the INSERT does
      // not, while the READ is the thing under test here.
      for (let index = 0; index < 51; index += 1) {
        await admin.query(`INSERT INTO recurring_chores
          (tenant_id,chore_id,title,target_page_key,plain_schedule,cron_expression,timezone,owner_identity_id,created_at,updated_at)
          VALUES($1,$2,$3,'bot-memory','every day at 12:00','0 12 * * *',$4,$5,$6,$6)`,
        [scope.tenantId, `chore:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          `Bulk ${index}`, ZONE, OWNER_A, new Date(NOW).toISOString()]);
      }
      const many = await service(web, NOW + DAY).dueChores(ownerA);
      assert.equal(many.chores.length, 50, "the read is bounded at the panel's own limit");
      assert.equal(many.additionalChoresOmitted, true, "and it says there are more rather than implying that was all");
      // A second call with no extra rows says false, so the flag means "there are
      // more" and not "there are many". Owner B declared one chore earlier with a
      // TUESDAY cadence, so it is not due at this clock — the point being made here
      // is the isolation, and the count is asserted against whatever B's own panel
      // genuinely contains rather than against a number this test chose.
      const few = await service(web, NOW + DAY).dueChores(ownerB);
      assert.equal(few.chores.length, 0, "the other owner's panel is unaffected by 51 chores added to A's");
      assert.equal(few.additionalChoresOmitted, false, "and is told there is nothing else, not that A has many");
      // The same for the tile inputs, which is where silent truncation would be
      // worst: the tile rule falls back to three fixed defaults on empty history.
      for (let index = 0; index < 51; index += 1) {
        await admin.query(`INSERT INTO page_pins
          (tenant_id,owner_identity_id,page_key,pinned_at,updated_at) VALUES($1,$2,$3,$4,$4)`,
        [scope.tenantId, OWNER_A, `page-${index}`, new Date(NOW + index).toISOString()]);
      }
      const manyPins = await now.shortcuts(ownerA);
      assert.equal(manyPins.pinned.length, 50, "pins are bounded too");
      assert.equal(manyPins.additionalPinsOmitted, true, "and the extra pins are reported");

      // ---- 12. THE DOWN FILES, as real rollbacks on the live cluster. Applied in
      // REVERSE migration order, which is the only order that can work: 0242's
      // guards and triggers hang off tables 0241 and 0240 created, so its down has
      // to run before theirs or the DROP TABLE would cascade the triggers away and
      // the DROP TRIGGER statements would fail on a table that no longer exists.
      const migrator = new Client(postgres.connection("migrator"));
      await migrator.connect();
      const adminCount = async (sql: string, values: unknown[] = []) =>
        (await admin.query<{ n: number }>(sql, values as never[])).rows[0]!.n;
      try {
        await migrator.query(await readFile(join(process.cwd(), "db/down/0242_navigation_owner_guards_and_grants.sql"), "utf8"));
        assert.equal(await adminCount("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('guard_recurring_chore_write','guard_page_visit_write','guard_page_pin_write')"), 0,
          "0242's down removed all three guards");
        assert.equal(await adminCount("SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname IN ('recurring_chores','page_visits','page_pins') AND NOT t.tgisinternal"), 0,
          "and every trigger they hung, on all three tables");
        assert.equal(await adminCount("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee='control_room_private_web' AND table_name IN ('recurring_chores','page_visits','page_pins')"),
          0, "and revoked every grant 0242 made, leaving none behind");
        await migrator.query(await readFile(join(process.cwd(), "db/down/0241_page_visits_and_pins.sql"), "utf8"));
        assert.equal(await adminCount("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('page_visits','page_pins')"), 0,
          "0241's down removed both tile tables");
        await migrator.query(await readFile(join(process.cwd(), "db/down/0240_recurring_chores.sql"), "utf8"));
        assert.equal(await adminCount("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='recurring_chores'"), 0,
          "0240's down removed the chore table");
        assert.equal(await adminCount("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_module_install_approval_insert'"), 1,
          "and left every EARLIER migration's guard exactly where it was");
      } finally { await migrator.end(); }
    } finally {
      await web.end();
      await admin.end();
    }
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 300_000 });
});