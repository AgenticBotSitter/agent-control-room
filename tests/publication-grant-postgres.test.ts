// Real-PostgreSQL regression for migrations 0270 and 0271.
//
// 0270. 0210's `enforce_result_set_published` is a DEFERRABLE INITIALLY DEFERRED
// constraint trigger on control_result_file_sets and is SECURITY INVOKER, so at
// COMMIT it runs as the login that opened the transaction. It reads
// control_result_publications. `control_room_native_results` holds
// `UPDATE (state, stored_at, manifest_digest) ON control_result_file_sets` -- the
// declared -> stored move -- and, before 0270, no privilege at all on that table.
//
// Which publishes actually need the read was MEASURED, not assumed, and the
// answer is not the obvious one:
//
//   * A NATIVE set's publish does NOT need it. The `producer_kind='fleet'`
//     conjunct makes the whole IF false, so the EXISTS is never planned. Native
//     publishes reach 'stored' with the grant revoked.
//   * A FLEET set's publish DOES need it, and is refused without it: `42501
//     permission denied for table control_result_publications`, raised from
//     inside the trigger body at COMMIT.
//
// So this file asserts BOTH halves. A grant that only ever widened authority
// would pass the first and fail the second; a grant that changed nothing would
// pass the first and fail nothing -- which is exactly the state the suite was in
// before this file existed, because no test anywhere performed a fleet set's
// stored transition as `control_room_results`.
//
// 0271. `OperatorSurfaceReadServiceV1.read()` fires nine reads in one
// Promise.all and the ninth, `listOwnerFocus`, SELECTs control_owner_focus_pins
// -- on the COORDINATOR's pool (private-task-application.ts:50). No db/roles file
// granted that table to a Mac-local role, so the whole surface failed `42501
// permission denied for table control_owner_focus_pins` while the grant audit
// reported every grant correct: the table was in no role file, so it was in no
// desired set.
//
// Every case runs AS the production login over a real cluster built by the attack
// kit, with the ACL read from the catalogue immediately before the statement whose
// behaviour it is about to decide. The pattern is the one
// tests/result-upload-ingress-postgres.test.ts uses: a fresh client per statement,
// because the production driver's bounded settings and its safe-code mapping are
// the wrong tools for a fixture that has to be told exactly what refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, REPOSITORY_ROOT } from
  "./support/attack-kit/index";
import type { AttackRole, RealPostgres } from "./support/attack-kit/index";
import { FLEET_TENANT, FLEET_WORKSPACE, seedFleetTenant } from "./support/fleet-fixture";
import { databaseRoleManifestV1 } from "../scripts/mac-local/database-role-manifest.mjs";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const UP_0270 = "0270_native_result_publication_receipt_read.sql";
const UP_0271 = "0271_owner_focus_pin_read.sql";
// This file's own reserved disposable-cluster lane, 59560-59569 by default.
// A DEFAULT, not the caller's CONTROL_ROOM_PG_TEST_PORT_BASE: every postgres test
// file owns a distinct fixed lane, because the lanes run with
// --test-concurrency=1 inside one process and share that environment variable.
const PORT = Number(process.env.CONTROL_ROOM_PUBLICATION_GRANT_PG_PORT ?? 59560);
const PORTS = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const AT = new Date(Date.now() - 60_000).toISOString();
const sha = (seed: string) => `sha256:${seed.repeat(64)}`;
const hmac = (seed: string) => `hmac-sha256:${seed.repeat(64)}`;
const ZERO = sha("0");
const BYTES = 12;
const DIGEST = sha("e");
const PROJECT = "project:perf1-grants";
/** Exactly 32 lowercase hex characters, the grammar 0206 CHECKs every id here. */
const setIdOf = (n: number) => `result-set:${String(n).repeat(32)}`;
const fileIdOf = (n: number) => `result-file:${String(n).repeat(32)}`;
/** The four tables 0210's publication guards read, each mapped in 0270 to the guard
 * that reads it. Compared as a set, so a stray extra grant fails the assertion. */
const GUARD_TABLES = Object.freeze([
  "control_result_publications",   // 0210 enforce_result_set_published, at COMMIT
  "control_result_upload_sessions",// 0210 guard_result_file_upload_stored
  "control_result_upload_chunks",  // 0209's reservation guard, same publish
  "fleet_workers",                 // 0207 guard_result_file_set_producer
]);
/** Every group role a Mac-local login inherits, read from the product's own role
 * manifest rather than restated: a list written here would drift from what the
 * installer provisions, and this assertion is about the MAC SET specifically --
 * the hosted production roles are a different installation shape. */
const macEntries = Object.entries(databaseRoleManifestV1.logins as Record<string,
  { group: string; mac?: boolean }>).filter(([, entry]) => entry.mac === true);
const MAC_GROUPS = Object.freeze([...new Set(macEntries.map(([, entry]) => entry.group))]);
const MAC_LOGINS = Object.freeze(macEntries.map(([name]) => name));

/** A result of the product's own SQLSTATE, never a guard's message: the driver
 * maps every SQL error to one safe code and keeps the state, so the state is the
 * only thing a test may depend on. */
type Outcome = { ok: true; rows: number }
  | { ok: false; code: string | undefined; message: string; step?: string };

/** One statement that MUST land. A fixture write that is silently refused becomes
 * a mysterious symptom several statements later, which is what a helper that
 * returns an Outcome instead of throwing makes of it. */

/** Several statements in ONE transaction, all of which must land.
 *
 * 0206's completeness trigger is a DEFERRED constraint trigger: it counts a set's
 * own files at COMMIT. So a set declared in one statement and its file in the next,
 * even two statements apart on the same connection, is exactly the half-finished
 * publication it refuses -- `result file set committed without its declared files`.
 * Every fixture pair below therefore shares a transaction, and so does the publish
 * itself.
 */

/** One statement, returning its rows, or throwing with the server's own state. */
async function one<T = Record<string, unknown>>(postgres: RealPostgres, sql: string,
  params: unknown[] = []): Promise<T[]> {
  const client = new Client(postgres.admin({ database: postgres.database }));
  await client.connect();
  try { return ((await client.query(sql, params)).rows ?? []) as T[]; }
  finally { await client.end().catch(() => undefined); }
}

/** One statement, one connection, as the named role. Returns the Outcome rather
 * than throwing, because the assertions below need to SEE a refusal. */

async function run(postgres: RealPostgres, role: AttackRole | "admin",
  sql: string, params?: unknown[]): Promise<Outcome> {
  const options = role === "admin" ? postgres.admin({ database: postgres.database })
    : (() => { const login = postgres.connection(role); return { host: login.host, port: postgres.port,
      database: postgres.database, user: login.user, password: login.password }; })();
  const client = new Client(options);
  await client.connect();
  try { const result = await client.query(sql, params); return { ok: true, rows: result.rowCount ?? 0 }; }
  catch (error) {
    const failure = error as { code?: string; message: string; where?: string };
    return { ok: false, code: failure.code, message: String(failure.message).split("\n")[0] };
  } finally { await client.end().catch(() => undefined); }
}

/** A DatabaseClient over one connection, for CanonicalStore. It carries all three
 * methods because CanonicalStore's constructor REFUSES to run without both
 * transaction shapes, and a fixture that hand-writes canonical lineage needs the
 * real thing rather than a mock of it. */
function fixtureWriter(postgres: RealPostgres): DatabaseClient & { close(): Promise<void> } {
  const client = new Client(postgres.admin({ database: postgres.database }));
  let opened: Promise<void> | undefined;
  const ready = async () => { await (opened ??= client.connect()); };
  const query = async <T = Record<string, unknown>>(statement: string, params?: unknown[]) => {
    await ready();
    return client.query(statement, params as unknown as unknown[]) as unknown as Promise<{ rows: T[] }>;
  };
  const runTx = async (work: (tx: DatabaseSession) => Promise<unknown>, beforeCommit?: () => void | Promise<void>) => {
    await ready();
    await client.query("BEGIN");
    try {
      const value = await work({ query });
      if (beforeCommit) await beforeCommit();
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  };
  return { query, transaction: runTx, transactionWithPreCommitCheck: runTx,
    close: async () => { await ready(); await client.end(); } } as unknown as DatabaseClient & { close(): Promise<void> };
}






/** Which statement was in flight when the server refused. `pg` reports the
 * routine in `where`, so a refusal from inside a trigger names its guard and a
 * refusal from the statement itself does not -- which is the difference between
 * "0206's completeness guard fired" and "the values were wrong". */
const GUARD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  guard_result_file_set_write: "0206 guard_result_file_set_write (the SET insert)",
  guard_result_file_insert: "0206 guard_result_file_insert (the FILE insert)",
  guard_result_file_set_producer: "0207 guard_result_file_set_producer (the SET insert)",
  guard_result_file_set_acceptance: "0207 guard_result_file_set_acceptance (the SET insert)",
  guard_result_file_upload_stored: "0210 guard_result_file_upload_stored (the FILE update)",
  guard_result_file_producer_state: "0210 guard_result_file_producer_state (the FILE update)",
  guard_result_file_set_producer_state: "0210 guard_result_file_set_producer_state (the SET update)",
  enforce_result_file_set_complete: "0206 enforce_result_file_set_complete (at COMMIT)",
  enforce_result_set_published: "0210 enforce_result_set_published (at COMMIT)",
});


/** Which guard reads which table, as the shipped bodies name them. Closed on
 * purpose: an unmapped table is reported as unmapped rather than attributed to
 * whichever guard happened to be nearest. */
const TABLE_GUARDS: Readonly<Record<string, string>> = Object.freeze({
  control_result_publications: "0210 enforce_result_set_published (at COMMIT)",
  control_result_upload_sessions: "0210 guard_result_file_upload_stored (the FILE update)",
  control_result_upload_chunks: "0209 guard_result_upload_reservation (the reservation)",
  fleet_workers: "0207 guard_result_file_set_producer (the SET insert)",
});

test("0270 makes every table 0210's publication guards read readable to the publisher",
  needsPg(), async t => {
    await withRealPostgres(async postgres => {
      const rows = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        one<T>(postgres, sql, params);
      const readable = async (role: string, table: string) => (await rows<{ readable: boolean }>(
        "SELECT has_table_privilege($1,$2,'SELECT') AS readable", [role, table]))[0]!.readable;
      /** A refusal AS the login, on a table it cannot read: the grant gap itself,
       * observed rather than inferred from the catalogue. */
      const directRead = async (role: AttackRole, table: string) =>
        run(postgres, role, `SELECT count(*)::int AS n FROM ${table}`, []);
      // Apply a migration or down file exactly as deploy/postgres/apply-migrations.mjs
      // does: inside one transaction. 0270/0271 both open with SET LOCAL, which is
      // only meaningful in one -- outside it, PostgreSQL warns and the remainder of a
      // simple-protocol query is a silent no-op, so re-applying them through a bare
      // connection would report success and change nothing.
      const exec = async (sql: string) => {
        const client = new Client(postgres.admin({ database: postgres.database }));
        await client.connect();
        try {
          await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          const failure = error as { code?: string; message: string };
          throw new Error(`${failure.code ?? "no state"}: ${String(failure.message).split("\n")[0]}`);
        } finally { await client.end().catch(() => undefined); }
      };
      const up0270 = await readFile(join(REPOSITORY_ROOT, "db/migrations", UP_0270), "utf8");
      const down0270 = await readFile(join(REPOSITORY_ROOT, "db/down", UP_0270), "utf8");
      t.after(async () => { /* every cluster is destroyed by the kit */ });

      // ---- 1. on a FRESHLY PROVISIONED database the role files already grant it,
      //         because a role file is read when the module is provisioned.
      for (const table of GUARD_TABLES)
        assert.equal(await readable("control_room_native_results", table), true,
          `the role files grant the publisher ${table}, so a fresh install is not the broken one`);

      // ---- 2. and the READ is real: as the production login.
      for (const table of GUARD_TABLES) {
        const read = await directRead("results", table);
        assert.equal(read.ok, true,
          `control_room_results must be able to read ${table}, which a guard reads as the invoker: ${JSON.stringify(read)}`);
      }

      // ---- 3. the UPGRADE case, which is the one an owner in place depends on: the
      //         ACL the role files cannot reach, and the defect itself re-created.
      await exec(down0270);
      for (const table of GUARD_TABLES)
        assert.equal(await readable("control_room_native_results", table), false,
          `0270's down took the read on ${table} away, so what follows is the pre-0270 ACL`);
      const withoutGrant = await directRead("results", "control_result_publications");
      assert.equal(withoutGrant.ok, false,
        "this is the defect: the login that publishes a result set cannot read the receipt its own COMMIT checks");
      assert.equal(withoutGrant.ok ? "" : withoutGrant.code, "42501",
        `and is refused for privilege, not for a protocol error: ${JSON.stringify(withoutGrant)}`);
      assert.match(withoutGrant.ok ? "" : withoutGrant.message, /control_result_publications/u,
        "and the refusal names the table 0210's guard reads");

      // ---- 4. 0270 converges it, and the identical read succeeds.
      await exec(up0270);
      for (const table of GUARD_TABLES)
        assert.equal(await readable("control_room_native_results", table), true,
          `0270 converges ${table} onto the role file's ACL`);
      const withGrant = await directRead("results", "control_result_publications");
      assert.equal(withGrant.ok, true,
        `the identical read now succeeds: ${JSON.stringify(withGrant)}`);

      // ---- 5. the grant is a READ and nothing more. A publisher that could mint or
      //         rewrite a receipt could make 0210's guard accept a stored fleet set
      //         on its word, and one that could write an upload session could satisfy
      //         0210's own upload rule for a file it never received.
      const refused: ReadonlyArray<readonly [string, string, (readonly unknown[])?]> = [
        ["mint a receipt", `INSERT INTO control_result_publications(tenant_id,set_id,project_id,job_id,attempt_id,
          manifest_digest,file_count,total_bytes,published_at)
          VALUES('t','result-set:'||repeat('9',32),'p','j','a',$1,1,12,'2026-10-02T00:00:00.000Z'::timestamptz)`, [ZERO]],
        ["rewrite a receipt", "UPDATE control_result_publications SET file_count=2", []],
        ["delete a receipt", "DELETE FROM control_result_publications", []],
        ["reserve an upload", `INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,
          attempt_id,set_id,ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,
          expected_chunks,state,created_at,expires_at)
          VALUES('t','result-upload:'||repeat('9',32),'p','j','a','result-set:'||repeat('9',32),1,'fleet-worker:'||
            repeat('a',32),'fleet-claim:'||repeat('b',32),1,$1,1,1,'reserved','2026-10-02T00:00:00.000Z'::timestamptz,
            '2026-10-03T00:00:00.000Z'::timestamptz)`, [ZERO]],
        ["write a chunk", `INSERT INTO control_result_upload_chunks(tenant_id,upload_id,ordinal,size_bytes,
          chunk_digest,received_at) VALUES('t','result-upload:'||repeat('9',32),1,1,$1,
            '2026-10-02T00:00:00.000Z'::timestamptz)`, [ZERO]],
        ["enrol a worker", `INSERT INTO fleet_workers(tenant_id,worker_id,node_id,identity_id,worker_kind,
          display_name,project_ids,capabilities,max_concurrent,enrolled_from_code_id,state,enrolled_at)
          VALUES('t','fleet-worker:'||repeat('9',32),'n','i','codex','w','{p}','{text}',1,
            'fleet-code:'||repeat('9',32),'active','2026-10-02T00:00:00.000Z'::timestamptz)`, []],
      ];
      for (const [what, statement, params] of refused) {
        const outcome = await run(postgres, "results", statement, [...(params ?? [])]);
        assert.equal(outcome.ok, false,
          `the publisher must not be able to ${what}: ${JSON.stringify(outcome)}`);
        assert.equal(outcome.ok ? "" : outcome.code, "42501",
          `and refused for privilege: ${JSON.stringify(outcome)}`);
      }

      // ---- 6. and the GRANT SOURCE says so, not just the catalogue: 0210's own
      //         SELECT-granted tables and 0209's are the only families touched, and
      //         nothing else moved. Compared as sets, so a stray extra grant fails.
      const granted = await rows<{ table_name: string }>(`SELECT table_name FROM information_schema.role_table_grants
        WHERE grantee='control_room_native_results' AND table_schema='public' AND privilege_type='SELECT'
          AND table_name = ANY($1::text[]) ORDER BY table_name`, [[...GUARD_TABLES]]);
      assert.deepEqual(granted.map(row => row.table_name), [...GUARD_TABLES].sort(),
        "0270 adds SELECT on exactly the four tables its guards read, and no others");
    }, { port: PORT, allowedPorts: PORTS, boundMs: 300_000 });
  });

test("0271 makes the operator surface's owner-focus read reachable on the coordinator's own pool",
  needsPg(), async t => {
    await withRealPostgres(async postgres => {

      const rows = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        one<T>(postgres, sql, params);
      // Apply a migration or down file exactly as deploy/postgres/apply-migrations.mjs
      // does: inside one transaction. 0270/0271 both open with SET LOCAL, which is
      // only meaningful in one -- outside it, PostgreSQL warns and the remainder of
      // a simple-protocol query is a silent no-op, so re-applying them through a
      // bare connection would report success and change nothing.
      const exec = async (sql: string) => {
        const client = new Client(postgres.admin({ database: postgres.database }));
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          const failure = error as { code?: string; message: string; where?: string };
          throw new Error(`${failure.code ?? "no state"}: ${String(failure.message).split("\n")[0]}`);
        } finally { await client.end().catch(() => undefined); }
      };
      const pinsReadable = async (role: string) => (await one<{ readable: boolean }>(
        postgres, "SELECT has_table_privilege($1,'control_owner_focus_pins','SELECT') AS readable", [role]))
        [0]!.readable;

await seedFleetTenant(async (sql, params) => {
        const outcome = await run(postgres, "admin", sql, params);
        if (!outcome.ok) throw new Error(`${outcome.code ?? "no state"}: ${outcome.message}`);
      });
      // Two pins, one expired, so the read is proved to FILTER and not merely to
      // return a row. The project's lifecycle is not checked by this read, so the
      // projects are only there to give the pins a plausible target.
      for (const [name, level, expiresAt] of [
        ["p0", "p0", null], ["today", "today", AT],
      ] as const) {
        await rows(`INSERT INTO control_owner_focus_pins(id,tenant_id,project_id,level,created_at,expires_at,payload)
          VALUES($1::text,$2::text,$3::text,$4::text,$5::timestamptz,$6::timestamptz,
            jsonb_build_object('id',$1::text,'tenantId',$2::text,'projectId',$3::text,
              'level',$4::text,'reason','fixture','createdAt',$5::timestamptz))`,
        [`focus:${name}`, FLEET_TENANT, `project:perf1-${name}`, level, AT, expiresAt]);
      }

      // The read the bundle performs, verbatim from store.ts:85, on the login
      // that RUNS the bundle (private-task-application.ts:50 constructs the store
      // over the coordinator's client).
      const LIST_OWNER_FOCUS = `SELECT id FROM control_owner_focus_pins
        WHERE tenant_id=$1 AND (expires_at IS NULL OR expires_at > $2::timestamptz) ORDER BY level,project_id`;
      // The instant every read in this test is made at: after both pins were
      // created and after the "today" pin's expiry, so exactly one is live. Named
      // rather than written out four times because a second literal that happened
      // to be earlier would make the expiry filter vacuous and the row count
      // meaningless.
      const NOW = new Date(Date.now() + 1_000).toISOString();

      assert.equal(await pinsReadable("control_room_task_coordinator"), true,
        "0271 has granted the read on a freshly provisioned database, from the role files");

      const reachable = await run(postgres, "coordinator", LIST_OWNER_FOCUS,
        [FLEET_TENANT, NOW]);
      assert.equal(reachable.ok, true,
        `the operator surface's ninth read must succeed as the coordinator: ${JSON.stringify(reachable)}`);
      assert.equal(reachable.ok ? reachable.rows : -1, 1,
        "and it returns the one live pin -- the expired one is filtered, so the predicate ran");

      // The pre-0271 ACL: the whole nine-read bundle fails on this one branch.
await exec(await readFile(join(REPOSITORY_ROOT, "db/down", UP_0271), "utf8"));
      assert.equal(await pinsReadable("control_room_task_coordinator"), false,
        "0271's down really took the read away, so what follows is the pre-0271 ACL");
      const unreachable = await run(postgres, "coordinator", LIST_OWNER_FOCUS,
        [FLEET_TENANT, NOW]);
      assert.equal(unreachable.ok, false, "before 0271 the read is refused: this is the defect");
      assert.equal(unreachable.ok ? "" : unreachable.code, "42501",
        `and refused for privilege: ${JSON.stringify(unreachable)}`);
      assert.match(unreachable.ok ? "" : unreachable.message, /control_owner_focus_pins/u,
        "and the refusal names the pin table");

      // 0271 restores it.
await exec(await readFile(join(REPOSITORY_ROOT, "db/migrations", UP_0271), "utf8"));
      const restored = await run(postgres, "coordinator", LIST_OWNER_FOCUS, [FLEET_TENANT, NOW]);
      assert.equal(restored.ok, true,
        `0271 converges the ACL back and the read works again: ${JSON.stringify(restored)}`);
      assert.equal(restored.ok ? restored.rows : -1, 1, "and it returns the same one live pin");

      // The grant is a READ. A scheduler that could pin a project would be writing
      // the owner's priority, which 0271 deliberately does not enable.
      const refusedWrites: ReadonlyArray<readonly [string, string, (readonly unknown[])?]> = [
        ["pin a project", `INSERT INTO control_owner_focus_pins(id,tenant_id,project_id,level,created_at,payload)
          VALUES('focus:sneaky',$1::text,'project:perf1-p0','p0',$2::timestamptz,'{}'::jsonb)`, [FLEET_TENANT, AT]],
        ["move a pin", "UPDATE control_owner_focus_pins SET level='today'", []],
        ["delete a pin", "DELETE FROM control_owner_focus_pins", []],
      ];
      for (const [what, statement, params] of refusedWrites) {
        const outcome = await run(postgres, "coordinator", statement, [...(params ?? [])]);
        assert.equal(outcome.ok, false, `the coordinator must not be able to ${what}: ${JSON.stringify(outcome)}`);
        assert.equal(outcome.ok ? "" : outcome.code, "42501", `and refused for privilege: ${JSON.stringify(outcome)}`);
      }

      // The WRITE half of this feature is still unwired, so the read returns the
      // owner's pins and nothing else. Asserted so that a later change which
      // quietly grants INSERT has to say so here.
      // 0019 grants INSERT/SELECT to the hosted production roles
      // (control_room_application, control_room_reader, control_room_backup), and
      // that is correct: they are the installation's own roles. What matters is
      // that no login in the Mac-local SET -- the eight the installer provisions
      // and the pages read through -- can write a pin, because the pin is the
      // owner's. So the count is over the narrow roles, read from the role
      // manifest rather than restated here.
      const macWriters = await one<{ writers: string }>(postgres,
        `SELECT count(*)::text AS writers FROM pg_roles
          WHERE rolname = ANY($1::text[]) AND has_table_privilege(oid,'control_owner_focus_pins','INSERT')`,
        [[...MAC_GROUPS, ...MAC_LOGINS]]);
      assert.equal(macWriters[0]!.writers, "0",
        "no Mac-local login holds INSERT on the pin table, so 0271 did not quietly complete a half-wired feature");
      // And the roles that DO hold it are the ones 0019 granted it to plus the
      // installation's own owner. Named so a later widening has to change this
      // line, rather than passing because the count above only looks at the
      // Mac-local set. control_room_backup and control_room_reader hold SELECT,
      // not INSERT; the schema owner, the migrator that SET ROLEs to it, the
      // application group and its inheritors, and pg_write_all_data hold it by
      // ownership of the table.
      const hosted = await one<{ holders: string }>(postgres,
        `SELECT coalesce(string_agg(rolname, ', ' ORDER BY rolname), '') AS holders FROM pg_roles
          WHERE rolname LIKE 'control_room%' AND has_table_privilege(oid,'control_owner_focus_pins','INSERT')`);
      assert.deepEqual(hosted[0]!.holders.split(", ").sort(),
        ["control_room_app", "control_room_application", "control_room_migrator", "control_room_schema_owner"],
        "the control-room roles that can write a pin are the owner's installation roles, not a Mac-local page login");
    }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 300_000 });
  });

test("this lane ran the real-PostgreSQL tests", async t => {
  if (!PG) { assert.equal(required, 0, "a lane without PostgreSQL registers nothing to run"); return; }
  ran += 2;
  t.diagnostic(`required=${required} ran=${ran}`);
  assert.ok(required > 0, "at least one real-cluster test is registered");
  assert.equal(ran, required, "a required-but-skipped cluster test must fail the run");
});