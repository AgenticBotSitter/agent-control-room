// A downgrade round-trip for 0209-0211 on a real cluster.
//
// The up files apply cleanly - the ingress proof covers that, and the migration
// applier runs them on every real-PostgreSQL test in the repo. What this covers
// is the other direction, which is where a schema change quietly leaks: does 0211
// down, then 0210 down, then 0209 down return a database to EXACTLY the state
// 0208 left, without CASCADE, and without revoking a privilege an EARLIER
// migration's role file conferred?
//
// "Exactly" is measured as a value, not as a list of assertions, so a grant
// nobody thought to check is still in the comparison:
//
//   * every relation, trigger and function 0209-0211 added is gone;
//   * the downgrade GRANTED nothing;
//   * every privilege it revoked is on a table 0209-0211 added - so it cannot
//     have taken away part 1's result-file catalog grants;
//   * the catalog's grants are byte-identical to what they were before;
//   * and the whole thing re-applies, because a downgrade that cannot be
//     re-upgraded is not a downgrade, and that is the half nobody tests until a
//     Mac that failed an upgrade is retried.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { REPOSITORY_ROOT, realPostgresSkipMessage, requiresRealPostgres, withRealPostgres }
  from "./support/attack-kit/index";
// The real applier, loaded from the repository root rather than by a relative
// path: tsx resolves the relative form against the WORKTREE, not the test file,
// which lands outside the checkout entirely. It is a .mjs with no type
// declarations, and this test needs the genuine one rather than a hand-written
// CREATE TABLE, or it would be proving that SQL is valid instead of that an
// UPGRADE WORKS.
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";

/** Every migration the ledger orders after 0211, read from the ledger file
 * itself. The downgrade takes the whole tail down before the three it is
 * reversing, and the alternative — a hard-coded list in this test — is a list that
 * silently falls behind: it had missed 0212-0213, 0234, 0238 and then 0255-0256,
 * each of which would have made the tail take-down leave its objects behind.
 *
 * Derived from `deploy/postgres/migration-ledger.json` rather than from the
 * directory listing, because the LEDGER ORDER is what the applier applied and
 * therefore what the downgrade has to reverse; a directory listing would be a
 * second, subtly different order. */
function expectedTail(): string[] {
  const ledger = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "deploy/postgres/migration-ledger.json"),
    "utf8")) as { entries: { file: string; order: number; kind?: string }[] };
  // Strictly AFTER 0211, so 0211 itself (one of the three being reversed) is not
  // in the tail; the boundary is the file name, which sorts the way the ledger
  // orders the migration.
  const after = ledger.entries.filter(entry => (entry.kind ?? "migrate") === "migrate")
    .filter(entry => entry.file > "db/migrations/0211_job_artifact_inputs.sql")
    .map(entry => entry.file.replace("db/migrations/", ""))
    .sort();
  return after;
}
// The real grant reconciler, for the same reason: the narrow role files are NOT
// in the migration ledger. `db/roles/private_web_roles.sql` and
// `db/roles/fleet_gateway_roles.sql` are applied by the Mac-local provisioner
// and by this reconciler, and by nothing in `applyMigrations`. A re-upgrade that
// stops at the applier therefore restores the TABLES and leaves the database with
// no privileges at all, which is the real shape of "a Mac that failed an
// upgrade and was retried" - and it is why the re-apply here has to use
// production's own two steps rather than one convenient call.
import { applyMacGrantDiffV1, desiredMacGrantsV1, diffMacGrantsV1, readMacGrantCatalogV1 }
  from "../scripts/mac-local/database-upgrade-grants.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59310);
// The assigned lane is the port block CONTROL_ROOM_PG_TEST_PORT_BASE names, or
// 59310-59319 when it is unset. Any other port is refused by the kit.
// Derived from PORT, for the same reason as the ingress lane: one source, so a moved
// port base cannot silently fall outside the block this job is entitled to.
const PORTS = Array.from({ length: 10 }, (_, index) => PORT + index);

const DOWN_FILES = ["0211_job_artifact_inputs.sql", "0210_result_upload_publication.sql",
  "0209_result_upload_sessions.sql"];

const TABLE_IN_UP = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/giu;

/**
 * The triggers and functions 0209-0211 add, DERIVED from their own up files.
 *
 * A hand-written list here is exactly what goes stale: this file's first draft
 * named five triggers and the migrations install seventeen, so the downgrade
 * assertion compared a truncated set and failed for the right reason by the
 * wrong one. The names a migration creates are in its own SQL, so they are read
 * from there. If a migration adds a trigger without updating anything else, this
 * still knows about it; if a down file fails to drop one, that is exactly the
 * leak this test exists to catch.
 */
const addedFromUpFiles = async (pattern: RegExp) => {
  const found = new Set<string>();
  for (const name of UP_FILES) {
    const sql = await readFile(join(REPOSITORY_ROOT, "db", "migrations", name), "utf8");
    for (const match of sql.matchAll(pattern)) found.add(match[1]);
  }
  assert.ok(found.size > 0, "no object names found in the 0209-0211 up files");
  return [...found].sort();
};

/**
 * The trigger names 0209-0211 install, paired with the table each fires on.
 *
 * The TABLE matters, and pairing is why: these migrations install triggers on
 * tables OTHER migrations created - 0209 guards `control_jobs` and 0210 guards
 * 0206's catalog - and a name-only scan cannot tell those from a pre-existing
 * trigger whose name happens to contain `publication` or `declared`. The first
 * draft of this test did exactly that and reported 0072's
 * `control_codex_result_publications_immutable` as a leaked trigger from 0210,
 * which is how a test that was supposed to catch leaks started inventing them.
 *
 * So a trigger is derived from the statement that installs it, with its own
 * `ON <table>`, and the comparison is by (name, table). A trigger these
 * migrations install on a table they did NOT create still has to be gone after
 * a downgrade, so both kinds are captured - the pairing is what distinguishes
 * them from somebody else's.
 */
const triggersInstalledByUpFiles = async () => {
  const found = new Map<string, string>();
  for (const name of UP_FILES) {
    const sql = await readFile(join(REPOSITORY_ROOT, "db", "migrations", name), "utf8");
    for (const match of sql.matchAll(TRIGGER_IN_UP)) found.set(match[1], match[2]);
  }
  assert.ok(found.size > 0, "no trigger names found in the 0209-0211 up files");
  return found;
};

/**
 * `CREATE [CONSTRAINT] TRIGGER <name> ... ON <table>`, capturing both, matched to
 * the END of that one statement.
 *
 * Two details are load-bearing, and both were found by this test failing on a
 * false positive first.
 *
 * The `[^;]` bound: a looser `[\s\S]*?` spans from one `CREATE TRIGGER` to the
 * next `ON` in the FILE whenever the statement does not itself contain one,
 * which silently paired a trigger name with a table from another migration. The
 * first draft did, and reported a guard on `control_role_grants` - installed by
 * 0140, a different subsystem - as something 0209-0211 should have removed.
 *
 * The optional `CONSTRAINT`: 0210 installs
 * `control_result_file_sets_published` as a CONSTRAINT TRIGGER, and a pattern
 * without that word matched nothing, so the one trigger a down file drops from
 * a table this migration did not create was the one trigger the test never
 * checked. It leaked through two runs of a test written to catch exactly that.
 */
const TRIGGER_IN_UP = /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z0-9_]+)[^;]*?\bON\s+([a-z0-9_]+)/giu;
const FUNCTION_IN_UP = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)/giu;

const UP_FILES = ["0209_result_upload_sessions.sql", "0210_result_upload_publication.sql",
  "0211_job_artifact_inputs.sql"];

/** The role files the reconciler reads. The same list the provisioner uses, so
 * a grant added to any of them is reconciled here without editing this test. */
const ROLE_FILES = ["private_web_roles.sql", "task_coordinator_roles.sql",
  "native_queue_producer_roles.sql", "native_results_roles.sql",
  "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
  "agent_reviewer_roles.sql", "fleet_gateway_roles.sql"];

const ROLES = ["control_room_private_web", "control_room_fleet_gateway", "control_room_reader",
  "control_room_backup", "control_room_application", "control_room_schedule_admissions",
  "control_room_github_broker", "control_room_work_intake"];

type Row = Record<string, unknown>;
type Querier = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;

/** Every role's table privileges in the public schema, as a comparable value.
 * Read from information_schema rather than from a hand-written list, because a
 * grant nobody thought to check is exactly the one a down file gets wrong. */
const grants = async (db: Querier) => (await db(`SELECT table_name,grantee,privilege_type,is_grantable
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND grantee = ANY($1::text[])
  ORDER BY table_name,grantee,privilege_type`, [ROLES])).rows
  .map((row) => `${String(row.table_name)}|${String(row.grantee)}|${String(row.privilege_type)}|`
    + `${String(row.is_grantable)}`);

/** Every role's COLUMN privileges, the same way. `role_table_grants` does not
 * list a column grant at all, so a down file that forgot `REVOKE UPDATE (col)`
 * passed the table comparison above while the gateway kept write access to
 * part 1's catalog after a rollback (review files2up B3). This view expands a
 * table-level grant into one row per column as well, so it is a superset of the
 * table comparison for the column-capable privileges, and it is compared whole. */
const columnGrants = async (db: Querier) => (await db(`SELECT table_name,column_name,grantee,privilege_type,
  is_grantable FROM information_schema.role_column_grants
  WHERE table_schema='public' AND grantee = ANY($1::text[])
  ORDER BY table_name,column_name,grantee,privilege_type`, [ROLES])).rows
  .map((row) => `${String(row.table_name)}|${String(row.column_name)}|${String(row.grantee)}|`
    + `${String(row.privilege_type)}|${String(row.is_grantable)}`);

const relations = async (db: Querier) => (await db(`SELECT c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p') ORDER BY c.relname`)).rows
  .map((row) => String(row.relname));

const triggers = async (db: Querier) => (await db(`SELECT t.tgname, c.relname AS table_name FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY t.tgname`)).rows
  .map((row) => `${String(row.tgname)}|${String(row.table_name)}`);

const functions = async (db: Querier) => (await db(`SELECT p.proname FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' ORDER BY p.proname`)).rows.map((row) => String(row.proname));

test("0209-0211 downgrade to exactly the 0208 state, and re-apply", async (t) => {
  const skip = requiresRealPostgres() ? undefined : realPostgresSkipMessage();
  if (skip) { t.skip(skip); return; }
  await withRealPostgres(async (postgres) => {
    // The applier has already run every migration on this fresh cluster, so the
    // three are present. Superuser, because applying a down file IS a schema
    // operation - the point of this test is the files, not a login's rights,
    // and the ingress proof already covers what each production login may do.
    const db: Querier = async (sql, params) => {
      const client = new Client(postgres.admin());
      await client.connect();
      try {
        return { rows: (await client.query(sql, params as unknown[])).rows };
      } finally { await client.end(); }
    };

    // --- the state with 0209-0211 applied ---------------------------------
    const addedRelations = await addedFromUpFiles(TABLE_IN_UP);
    // The tables 0209-0211 install GUARDS on without creating. A down file may
    // revoke a privilege on one of these, because its own migration's guard
    // reads that table through the caller's rights - 0209's reservation guard
    // is SECURITY INVOKER and reads the result-file catalog, which is exactly
    // why the gateway holds SELECT on a table 0209 did not create. The set is
    // derived from the migrations' own SQL, so a guard appearing on a fourth
    // table still has to be argued for rather than swept up.
    const guardedForeignTables = new Set<string>();
    for (const name of UP_FILES) {
      const sql = await readFile(join(REPOSITORY_ROOT, "db", "migrations", name), "utf8");
      for (const match of sql.matchAll(TRIGGER_IN_UP)) {
        if (!addedRelations.includes(match[2])) guardedForeignTables.add(match[2]);
      }
    }
    // The catalog is on that list, and the 0209 down file is the one that
    // revokes its SELECT. Naming it here is a cross-check on that decision
    // rather than a way to make any revoke acceptable: if 0209's guard stopped
    // reading the catalog, this set would lose it and the revoke would fail.
    const justifiedOnForeignTables = guardedForeignTables;
    const installedTriggers = await triggersInstalledByUpFiles();
    const addedFunctions = await addedFromUpFiles(FUNCTION_IN_UP);
    const grantsBefore = await grants(db);
    const columnGrantsBefore = await columnGrants(db);
    const relationsBefore = await relations(db);
    const triggersBefore = await triggers(db);
    const functionsBefore = await functions(db);
    for (const relation of addedRelations)
      assert.ok(relationsBefore.includes(relation), `${relation} exists after 0209-0211`);
    for (const [name, table] of installedTriggers)
      assert.ok(triggersBefore.includes(`${name}|${table}`),
        `${name} on ${table} is installed after 0209-0211`);
    for (const fn of addedFunctions)
      assert.ok(functionsBefore.includes(fn), `${fn} exists after 0209-0211`);

    // --- take the three back out, newest first, through the real files ---
    // The down files each BEGIN and COMMIT, and a later one references what an
    // earlier one drops, so the order is not a preference.
    //
    // The applier's own rows go first, and EVERY row from the three onwards.
    //
    // Applying a down file is exactly what `control_room_schema_migrations`
    // records, so leaving a row behind would make the re-apply below a no-op:
    // the applier would see it already applied, skip it, and then correctly
    // complain that the live schema no longer matches the digest it recorded.
    //
    // The rows AFTER the three have to go too, and that is the merge, not a
    // detail. `ledger_order` is a dense sequence and the applier refuses any
    // applied order that is not a prefix of the executable list
    // (`migration_gap`), so deleting 0209-0211 while leaving 0224-0237 in
    // place produces applied orders 1..134 then 138..143 -- a hole, and a
    // correct refusal. That is precisely the state a Mac is in when an upgrade
    // failed part way through, so the honest simulation of "a failed upgrade
    // that is retried" is to drop the tail as well and let the re-apply below
    // put the WHOLE tail back. Selecting by `ledger_order >=` keeps this correct
    // as later migrations are added, which a hard-coded filename list does not.
    const appliedThree = (await db(`SELECT filename,ledger_order FROM control_room_schema_migrations
      WHERE filename = ANY($1::text[]) ORDER BY ledger_order`,
    [DOWN_FILES.map((name) => `db/migrations/${name}`)])).rows as { filename: string; ledger_order: number }[];
    assert.deepEqual(appliedThree.map((row) => row.filename),
      ["db/migrations/0209_result_upload_sessions.sql", "db/migrations/0210_result_upload_publication.sql",
        "db/migrations/0211_job_artifact_inputs.sql"],
      "the three are in the applied ledger, in ledger order");
    // The LAST of the three, not the first: the tail that has to come off with
    // them is everything ordered after the three of them, and taking the minimum
    // swept 0210 and 0211 into the tail loop -- so their down files ran twice and
    // the second run raised 42P01 on a table the first run had already dropped.
    const lastDownOrder = appliedThree[appliedThree.length - 1]!.ledger_order;
    // The rows after the three have to be dropped from the SCHEMA too, not only
    // from the ledger. A real failed upgrade has not applied them at all, and
    // this test is that case: leaving 0224-0237's tables in place while deleting
    // their ledger rows makes the re-apply below collide on
    // `relation "control_owner_push_attempt_heads" already exists` -- the
    // applier correctly refusing to create a table the database already has.
    //
    // Derived from the ledger rather than named, so a later migration joins the
    // tail without anyone editing this test, and each is taken down newest first
    // because a down file references what an earlier one drops.
    const later = ((await db(`SELECT filename FROM control_room_schema_migrations
      WHERE ledger_order > $1 ORDER BY ledger_order DESC`, [lastDownOrder])).rows)
      .map((row) => String((row as { filename: string }).filename).replace("db/migrations/", ""));
    // The tail is DERIVED from the ledger rather than restated, so a migration
    // added after this test was written joins it without anyone editing this list:
    // every migration ordered after 0211 is taken down first, newest first,
    // because a down file references what an earlier one drops. Restating it made
    // this test a list to keep in step with the ledger, and it silently fell
    // behind 0212-0213, 0234, 0238 and then 0255-0256.
    assert.deepEqual(later.slice().sort(), expectedTail(),
      `the tail after 0209-0211 is exactly what is taken down first: ${later.join(", ")}`);
    assert.ok(later.length > 0, "there IS a tail to take down, or this simulates nothing");
    for (const name of later) {
      const path = join(REPOSITORY_ROOT, "db", "down", name);
      assert.ok(existsSync(path), `db/down/${name} exists: the tail has to be reversible to be simulated`);
      try { await db(await readFile(path, "utf8")); }
      catch (error) { throw new Error(`down file ${name} failed: ${String((error as Error).message)}`); }
    }
    // The state this downgrade is actually aiming at: 0208's, which is the state
    // AFTER the tail comes off and BEFORE the three. Taken HERE, so every later
    // comparison is against the real target rather than against a list of names
    // this file happens to know -- and so a tail down file that removed something
    // it should not have is caught here rather than read as the target.
    const targetRelations = await relations(db);
    const targetTriggers = await triggers(db);
    const targetFunctions = await functions(db);
    const targetGrants = await grants(db);
    const targetColumnGrants = await columnGrants(db);
    await db(`DELETE FROM control_room_schema_migrations WHERE ledger_order >= $1`, [appliedThree[0]!.ledger_order]);
    for (const name of DOWN_FILES) {
      const sql = await readFile(join(REPOSITORY_ROOT, "db", "down", name), "utf8");
      // Named in the failure, because a down file that raises for a reason the
      // reader of a bare 42P01 cannot see is the whole cost of this shape.
      try { await db(sql); }
      catch (error) { throw new Error(`down file ${name} failed: ${String((error as Error).message)}`); }
    }

    // --- everything they added is gone -----------------------------------
    const relationsAfter = await relations(db);
    for (const relation of addedRelations)
      assert.ok(!relationsAfter.includes(relation), `${relation} is gone after the downgrade`);
    const triggersAfter = await triggers(db);
    for (const [name, table] of installedTriggers)
      assert.ok(!triggersAfter.includes(`${name}|${table}`),
        `${name} on ${table} is gone after the downgrade`);
    const functionsAfter = await functions(db);
    for (const fn of addedFunctions)
      assert.ok(!functionsAfter.includes(fn), `${fn} is gone after the downgrade`);
    // And nothing ELSE went with them: every relation that was there before is
    // still there, which is the half CASCADE would have got wrong.
    assert.deepEqual(relationsAfter,
      targetRelations.filter((name) => !addedRelations.includes(name)),
      "the downgrade removed exactly the six relations 0209-0211 added, and nothing else");
    // Functions and triggers are compared the same way, so a down file that
    // dropped a shared helper is caught here rather than in a later migration.
    const mine = (row: string) => {
      const [name, table] = row.split("|");
      return installedTriggers.get(name ?? "") === table;
    };
    assert.deepEqual(triggersAfter, targetTriggers.filter((row) => !mine(row)),
      "the downgrade removed exactly its own triggers, on every table it touched");
    assert.deepEqual(functionsAfter, targetFunctions.filter((name) => !addedFunctions.includes(name)),
      "the downgrade removed exactly its own functions");

    // --- the grants -------------------------------------------------------
    // Compared against the TARGET state (0208's), not against the pre-tail
    // snapshot: the tail's own down files revoke the tail's grants, and crediting
    // that to 0209-0211 would both read as a defect and hide a real one.
    const grantsAfter = await grants(db);
    const added = grantsAfter.filter((grant) => !targetGrants.includes(grant));
    assert.deepEqual(added, [], "a downgrade grants nothing");
    for (const gone of targetGrants.filter((grant) => !grantsAfter.includes(grant))) {
      const [table] = gone.split("|");
      assert.ok(addedRelations.includes(String(table)) || justifiedOnForeignTables.has(String(table)),
        `the downgrade revoked ${gone}, and nothing in 0209-0211's own SQL justifies a revoke on `
        + `${String(table)}: a down file may remove what its own up file required, and nothing else`);
    }
    // The catalog is where a careless REVOKE does its damage, so it is worth
    // being exact about what SHOULD change and what must not.
    //
    // The SELECT the gateway holds on the two catalog tables goes: 0209's
    // SECURITY INVOKER reservation guard is what required it, and 0209 is down.
    // Every OTHER catalog grant is part 1's - 0206-0208 - and is untouched.
    const catalog = (rows: string[]) => rows.filter((grant) => grant.startsWith("control_result_file"));
    const expectedCatalogChanges = ["control_result_file_sets|control_room_fleet_gateway|SELECT|NO",
      "control_result_files|control_room_fleet_gateway|SELECT|NO"];
    assert.deepEqual(catalog(targetGrants).filter((grant) => !catalog(grantsAfter).includes(grant))
      .sort(), expectedCatalogChanges,
    "the only catalog grants a 0209-0211 downgrade removes are the two SELECTs 0209's guard required");
    assert.deepEqual(catalog(grantsAfter), catalog(targetGrants)
      .filter((grant) => !expectedCatalogChanges.includes(grant)),
    "and no part 1 catalog grant is touched");
    // The UPDATE grants 0210's publication path needs also go with it.
    for (const grant of catalog(targetGrants))
      assert.ok(grant.startsWith("control_result_file_sets|control_room_fleet_gateway|SELECT")
        || grant.startsWith("control_result_files|control_room_fleet_gateway|SELECT")
        || catalog(grantsAfter).includes(grant),
      `the downgrade removed part 1's ${grant}`);

    // --- the column grants -------------------------------------------------
    // The same three rules for column privileges: nothing granted, nothing
    // revoked on a table 0209-0211 cannot justify, and -- the one B3 was about --
    // the gateway's column UPDATE on part 1's catalog is gone with the guards
    // that narrowed it. Part 1 never gave the gateway any write on the catalog,
    // so after the downgrade it must hold none.
    const columnGrantsAfter = await columnGrants(db);
    assert.deepEqual(columnGrantsAfter.filter((grant) => !targetColumnGrants.includes(grant)), [],
      "a downgrade grants no column privilege");
    for (const gone of targetColumnGrants.filter((grant) => !columnGrantsAfter.includes(grant))) {
      const [table] = gone.split("|");
      assert.ok(addedRelations.includes(String(table)) || justifiedOnForeignTables.has(String(table)),
        `the downgrade revoked column privilege ${gone}, which 0209-0211 cannot justify`);
    }
    const gatewayCatalogWrites = (rows: string[]) => rows.filter((grant) => {
      const [table, , grantee, privilege] = grant.split("|");
      return (table === "control_result_files" || table === "control_result_file_sets")
        && grantee === "control_room_fleet_gateway" && privilege !== "SELECT";
    });
    assert.ok(gatewayCatalogWrites(targetColumnGrants).length >= 5,
      `the gateway held its catalog column UPDATEs before the downgrade, so the check below is not vacuous: ${
        JSON.stringify(gatewayCatalogWrites(targetColumnGrants))}`);
    assert.deepEqual(gatewayCatalogWrites(columnGrantsAfter), [],
      "after the downgrade the gateway holds no write privilege on any column of part 1's catalog");

    // --- and it re-applies ------------------------------------------------
    // The applier is the real one, so this proves a retried upgrade works after
    // a failed one, not that a hand-written CREATE TABLE works.
    const client = new Client(postgres.admin());
    await client.connect();
    try {
      await applyMigrations({
        target: postgres.admin(),
        bootstrapTarget: postgres.admin(),
        migrateTarget: postgres.admin(),
        rootDir: REPOSITORY_ROOT,
        ledgerPath: join(REPOSITORY_ROOT, "deploy/postgres/migration-ledger.json"),
        env: process.env,
      });
    } finally { await client.end(); }
    // Step two, as production does it: reconcile the narrow logins' grants from
    // the role files. Reading the desired set from the FILES rather than from a
    // restated list is the point - a grant added to a role file has to arrive
    // here without anyone editing this test.
    //
    // Only the two role files 0209-0211 grant through. The attack-kit cluster
    // carries the role names but not every login the reconciler can write for -
    // `control_room_agent_reviewer` and the rest belong to subsystems this
    // stream does not touch, and the reconciler is right to refuse them here.
    // Scoping to the files that matter keeps the assertion about MY grants, and
    // the narrow provisioning path that grants the rest is the lifecycle
    // test's, not this one's.
    // `desiredMacGrantsV1` refuses a source set that is not the full list of
    // role files, because a partial set would reconcile a login's grants down
    // to nothing. So it gets every file, and the filter below is what scopes the
    // RESULT to the relations this stream added.
    const sources = Object.fromEntries(await Promise.all(ROLE_FILES.map(async (name) =>
      [name, await readFile(join(REPOSITORY_ROOT, "db", "roles", name), "utf8")])));
    const reconciler = new Client(postgres.admin());
    await reconciler.connect();
    try {
      const desired = desiredMacGrantsV1(sources);
      const actual = new Set([...(await readMacGrantCatalogV1(reconciler))]);
      const diff = diffMacGrantsV1(actual, desired);
      assert.ok(diff.missing.length > 0,
        "the downgrade really did take grants away, so this re-apply is doing work");
      // The tuples for the six relations this stream added, PLUS the two
      // catalog SELECTs 0209's SECURITY INVOKER guard required - those are on
      // part 1's tables but they are 0209's grant, which is the whole reason
      // 0209's down file revokes them and this test checks it comes back. The
      // other grants in those two files belong to tables other migrations own,
      // and reconciling them here would be asserting about another subsystem.
      const reconciled = new Set([...addedRelations, "control_result_file_sets", "control_result_files"]);
      const mine = (item: string) => reconciled.has(item.split("|")[2]?.split(".").pop() ?? "");
      await applyMacGrantDiffV1(reconciler, {
        extra: diff.extra.filter(mine),
        missing: diff.missing.filter(mine),
      });
    } finally { await reconciler.end(); }
    assert.deepEqual(await relations(db),
      relationsBefore, "a re-upgrade restores exactly the relations that were there before");
    assert.deepEqual(await triggers(db), triggersBefore, "and every trigger");
    assert.deepEqual(await functions(db), functionsBefore, "and every function");
    assert.deepEqual(await grants(db), grantsBefore,
      "and every grant, from the role file, for both roles");
    assert.deepEqual(await columnGrants(db), columnGrantsBefore,
      "and every column grant, including the gateway's catalog UPDATEs");

    // --- the down files are all still on disk ----------------------------
    // A down file that deletes itself, or a typo that made this test read a
    // file the branch never had, would pass the round trip and prove nothing.
    const onDisk = (await readdir(join(REPOSITORY_ROOT, "db", "down")));
    for (const name of DOWN_FILES) assert.ok(onDisk.includes(name), `db/down/${name} is on disk`);
  }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
});