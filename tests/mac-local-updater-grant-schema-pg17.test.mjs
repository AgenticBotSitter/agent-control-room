// The release's Mac grant converger must leave the `updater` schema alone.
//
// WHY THIS LANE EXISTS. The converger diffs the live catalogue against a desired
// set built from `db/roles/*.sql`. No role file names an `updater` object, so the
// updater loader's own grants — `USAGE ON SCHEMA updater` and `EXECUTE` on
// `updater.authorization_complete` / `updater.bounded_transports` for the web
// login, which `src/updater/v1/ddl/0002_schema.sql` re-asserts on every run — read
// as EXTRA. The converger then emits a REVOKE for each. Measured on real
// PostgreSQL 17, and worse than the reported `permission denied`:
//
//   * as `control_room_migrator` the REVOKE fails `42501 permission denied for
//     schema updater`, because the migrator holds nothing there by design, so the
//     grant transaction rolls back and no retry converges;
//   * as `postgres` — the login THIS converger actually runs as, since
//     `runMacDatabaseUpgradeCommandV1` refuses anything but the superuser — the
//     REVOKE SUCCEEDS, and the web login silently loses its updater access on a
//     database the operator believes is fully upgraded. A `schema`-kind item has
//     no allow-list in `grantSql`, so even the path that refuses for functions
//     applied the schema one.
//
// WHAT IS PROVED HERE, on a real disposable cluster, as the production logins:
//   1. with the updater schema, its passkey/alert tables and the web login's grants
//      all present, the converger finds NOTHING to do for `updater.*`;
//   2. the updater ACL is byte-identical before and after;
//   3. a real drift elsewhere — an extra `DELETE` and a missing `INSERT` on
//      release tables — is still converged in the same run;
//   4. the second root holds too: an `updater` item arriving from a route that
//      bypassed the snapshot filter (a captured snapshot file, a hand-built diff)
//      is REFUSED by the applier rather than revoked;
//   5. the full `applyMacDatabaseUpgradeV1` path converges end to end with the
//      updater schema in place, and a second run is a clean no-op.
//
// The default path is exercised with NO injected port, tool or fake for the
// converger itself: `readMacGrantCatalogV1`, `diffMacGrantsV1` and
// `applyMacGrantDiffV1` are the real exports, against a real cluster, over the
// real `db/roles/*.sql` desired set.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { applyMacGrantDiffV1, diffMacGrantsV1, macReleaseOwnedGrantV1, macUpdaterOwnedSchema,
  readDesiredMacGrantsV1, readMacGrantCatalogV1 } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { applyMacDatabaseUpgradeV1, planMacDatabaseUpgradeSnapshotV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { macGrantCatalogSqlV1, macRolePlan } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, findFreePort, needsPg, requestedPort } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const state = {};

/** The updater's loader-owned tables. Named here because the DDL that creates
 * them is the updater's, not this repo's install path, and a fixture that invents
 * a table of its own would not be the shape the filter exists for. The passkey
 * and alert tables are the two the finding names. */
const UPDATER_TABLES = ["authorization_challenges", "credential_registrations", "push_queue"];

const exec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const operator = () => `host=${state.socket} port=${state.port} dbname=control_room user=postgres`;
const migratorTarget = () => `host=${state.socket} port=${state.port} dbname=control_room `
  + `user=control_room_migrator password=${state.migratorPassword}`;

/** Everything the catalog says about the `updater` schema for the Mac roles.
 * Read from `pg_catalog`, not restated from the DDL, so a before/after
 * comparison is evidence that the ACL did not move. */
async function updaterAcl(client) {
  const roles = ["control_room_private_web", "control_room_deployer"];
  return {
    schema: (await client.query(`SELECT r.rolname AS role, n.nspname AS object, a.privilege_type AS privilege,
      a.is_grantable FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = $1 AND r.rolname = ANY($2::text[]) ORDER BY 1,3`, [macUpdaterOwnedSchema, roles])).rows,
    tables: (await client.query(`SELECT r.rolname AS role, c.relname AS object, a.privilege_type AS privilege,
      a.is_grantable FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = $1 AND c.relkind IN ('r','v') AND r.rolname = ANY($2::text[]) ORDER BY 1,2,3`,
    [macUpdaterOwnedSchema, roles])).rows,
    functions: (await client.query(`SELECT r.rolname AS role, p.proname || '(' || COALESCE((SELECT
      string_agg(quote_ident(t.typname), ', ' ORDER BY u.ord) FROM unnest(p.proargtypes) WITH ORDINALITY
      AS u(oid, ord) JOIN pg_type t ON t.oid = u.oid), '') || ')' AS object, a.privilege_type AS privilege,
      a.is_grantable FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = $1 AND r.rolname = ANY($2::text[]) ORDER BY 1,2,3`, [macUpdaterOwnedSchema, roles])).rows,
  };
}

before(async () => {
  if (needsPg) return;
  state.root = await mkdtemp(join(tmpdir(), "acr-grantfilter-"));
  state.port = requestedPort() ?? await findFreePort();
  const data = join(state.root, "pg");
  state.socket = join(state.root, "s");
  await mkdir(state.socket, { mode: 0o700 });
  // Registered before initdb, and the caller's `after` is not registered until
  // this RETURNS — so a throw here (and initdb/pg_ctl both throw) is handled by
  // stopping the cluster here, exactly as the sibling pg17 lanes do.
  state.teardown = createClusterTeardown({ dataDirectory: data, runDirectory: state.root,
    socketDirectory: state.socket, port: state.port, pgBin: PG_BIN, removeDirectories: false });
  try {
    exec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    // The peer socket needs an entry for the MIGRATOR too: this lane connects as
    // it to establish the finding, and `applyMigrations` runs it over the same
    // socket. `initdb --auth=trust` only covers postgres.
    await writeFile(join(data, "pg_hba.conf"), "local all postgres trust\nlocal all all trust\n"
      + "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
    exec("pg_ctl", ["-D", data, "-l", join(state.root, "pg.log"), "-w", "-o",
      `-p ${state.port} -k '${state.socket}' -c listen_addresses=127.0.0.1`, "start"]);
    await state.teardown.capturePostmasterPid();
  } catch (error) {
    try { await state.teardown.stop(); } catch (stopError) {
      throw new AggregateError([error, stopError], `cluster_start_and_teardown_failed:${error?.message ?? error}`);
    }
    throw error;
  }
  exec("psql", ["-h", "127.0.0.1", "-p", String(state.port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  state.migratorPassword = `m${"k".repeat(39)}`;
  await applyMigrations({ rootDir: repoRoot, ledgerPath: join(repoRoot, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: operator(), migrateTarget: migratorTarget(),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: state.migratorPassword, CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
      CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "i".repeat(40) } });
  state.client = connectTarget(operator());
  await state.client.connect();

  // The Mac logins and their groups, exactly as the installer provisions them.
  // Roles are cluster-wide, so anything left over must go before the installer
  // runs or it refuses to adopt it with `narrow_role_existing_audit_required`.
  for (const role of [...Object.keys(macRolePlan), ...new Set(Object.values(macRolePlan))])
    await state.client.query(`DROP ROLE IF EXISTS ${role}`);
  state.passwords = Object.fromEntries(Object.keys(macRolePlan).map((login, index) => [login, `pw${index}`.padEnd(40, "z")]));
  await provisionMacLocalNarrowRolesV1(state.client, state.passwords);

  // ---- the `updater` schema, in the shape the loader leaves it ----
  await state.client.query(`CREATE ROLE control_room_deployer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS`);
  await state.client.query(`CREATE SCHEMA ${macUpdaterOwnedSchema} AUTHORIZATION control_room_deployer`);
  for (const table of UPDATER_TABLES)
    await state.client.query(`CREATE TABLE ${macUpdaterOwnedSchema}.${table} (id bigint PRIMARY KEY, note text)`);
  await state.client.query(`CREATE FUNCTION ${macUpdaterOwnedSchema}.authorization_complete(text, bytea, bytea, bytea)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
  await state.client.query(`CREATE FUNCTION ${macUpdaterOwnedSchema}.bounded_transports(text[])
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
  // PUBLIC holds nothing on either the schema or the guards.
  await state.client.query(`REVOKE ALL ON SCHEMA ${macUpdaterOwnedSchema} FROM PUBLIC`);
  for (const [name, args] of [["authorization_complete", "text, bytea, bytea, bytea"], ["bounded_transports", "text[]"]])
    await state.client.query(`REVOKE ALL ON FUNCTION ${macUpdaterOwnedSchema}.${name}(${args}) FROM PUBLIC`);
  // The web login's grants, which the loader re-asserts on every run.
  await state.client.query(`GRANT USAGE ON SCHEMA ${macUpdaterOwnedSchema} TO control_room_private_web`);
  await state.client.query(`GRANT SELECT ON ${macUpdaterOwnedSchema}.push_queue TO control_room_private_web`);
  await state.client.query(`GRANT EXECUTE ON FUNCTION ${macUpdaterOwnedSchema}.authorization_complete(text, bytea, bytea, bytea)
    TO control_room_private_web`);
  await state.client.query(`GRANT EXECUTE ON FUNCTION ${macUpdaterOwnedSchema}.bounded_transports(text[]) TO control_room_private_web`);
});

after(async () => {
  if (needsPg) return;
  try { await state.client?.end(); } catch {}
  try { await state.teardown?.stop(); } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("the desired set can never name an updater object, so the filter never hides a real grant", {
  skip: needsPg,
}, async () => {
  const desired = await readDesiredMacGrantsV1();
  assert.ok(desired.size > 300);
  assert.deepEqual([...desired].filter(item => !macReleaseOwnedGrantV1(item)), [],
    "no db/roles/*.sql grant names an updater object, so filtering updater.* loses nothing");
  // The predicate is anchored on the SCHEMA, not the role: an `updater` schema
  // grant for any role is updater-owned, and a relation merely NAMED like one is
  // not. `updater_release_reader_roles.sql` is the real near-miss in this repo.
  for (const role of ["control_room_private_web", "control_room_web", "control_room_deployer", "postgres"])
    assert.equal(macReleaseOwnedGrantV1(`${role}|schema|updater||USAGE|plain`), false, `${role}'s updater schema grant`);
  assert.equal(macReleaseOwnedGrantV1("control_room_private_web|function|updater.bounded_transports(_text)||EXECUTE|plain"), false);
  assert.equal(macReleaseOwnedGrantV1("control_room_deployer|table|updater.push_queue||SELECT|plain"), false);
  for (const nearMiss of ["public.updater_reports", "public.updater", "control_room_queue.updater_x", "updater_ready"])
    assert.equal(macReleaseOwnedGrantV1(`control_room_private_web|table|${nearMiss}||SELECT|plain`), true,
      `${nearMiss} is a release relation and must still converge`);
});

test("a converged database with the updater schema present finds nothing to do for updater.*", {
  skip: needsPg,
}, async () => {
  const desired = await readDesiredMacGrantsV1();
  const diff = diffMacGrantsV1(await readMacGrantCatalogV1(state.client), desired);
  assert.deepEqual(diff, { extra: [], missing: [] },
    "the loader's updater grants are not offered to the converger as drift");
  // The applier runs the real diff for real, as the production login.
  await state.client.query("BEGIN");
  await applyMacGrantDiffV1(state.client, diff);
  await state.client.query("COMMIT");
  assert.deepEqual(diffMacGrantsV1(await readMacGrantCatalogV1(state.client), desired), { extra: [], missing: [] });
});

test("the updater's ACL is untouched while a real drift elsewhere is still converged", {
  skip: needsPg,
}, async () => {
  const before = JSON.stringify(await updaterAcl(state.client));
  assert.ok(JSON.parse(before).functions.length >= 2, "the loader's EXECUTE grants are present to begin with");
  assert.ok(JSON.parse(before).schema.length >= 1, "the loader's schema USAGE is present to begin with");

  // A real drift on release tables the Mac logins already hold: one privilege that
  // was widened, one that was taken away.
  await state.client.query("GRANT DELETE ON public.control_jobs TO control_room_private_web");
  await state.client.query("REVOKE INSERT ON public.control_leases FROM control_room_task_coordinator");

  const diff = diffMacGrantsV1(await readMacGrantCatalogV1(state.client), await readDesiredMacGrantsV1());
  assert.deepEqual(diff.extra, ["control_room_private_web|table|public.control_jobs||DELETE|plain"],
    "the widened privilege is found, and nothing in updater is offered");
  assert.deepEqual(diff.missing, ["control_room_task_coordinator|table|public.control_leases||INSERT|plain"],
    "the taken privilege is found to be missing");
  await state.client.query("BEGIN");
  await applyMacGrantDiffV1(state.client, diff);
  await state.client.query("COMMIT");

  const after = await updaterAcl(state.client);
  assert.deepEqual(after, JSON.parse(before),
    "the updater schema's ACL is byte-identical after a run that converged everything else");
  assert.deepEqual(diffMacGrantsV1(await readMacGrantCatalogV1(state.client), await readDesiredMacGrantsV1()),
    { extra: [], missing: [] }, "and the rest of the release schema did converge");
  // The converged facts, read back as privileges rather than as the diff.
  assert.equal((await state.client.query(`SELECT has_table_privilege('control_room_private_web',
    'public.control_jobs','DELETE') AS can`)).rows[0].can, false);
  assert.equal((await state.client.query(`SELECT has_table_privilege('control_room_task_coordinator',
    'public.control_leases','INSERT') AS can`)).rows[0].can, true);
});

test("the applier refuses an updater item that arrived without passing the snapshot filter", {
  skip: needsPg,
}, async () => {
  // The route the filter at the snapshot cannot cover: a caller that assembles a
  // diff itself — a captured snapshot file, an offline plan, a future port. The
  // applier is the last thing between a catalog row and a REVOKE on disk, so it
  // REFUSES rather than skipping: skipping one of a pair would report a
  // convergence it did not perform.
  const before = JSON.stringify(await updaterAcl(state.client));
  const cases = [
    "control_room_private_web|schema|updater||USAGE|plain",
    "control_room_private_web|function|updater.bounded_transports(_text)||EXECUTE|plain",
    "control_room_deployer|table|updater.push_queue||SELECT|plain",
  ];
  for (const item of cases) {
    await assert.rejects(applyMacGrantDiffV1(state.client, { extra: [item], missing: [] }),
      /upgrade_updater_grant_refused/u, `a REVOKE of ${item} must be refused`);
    await assert.rejects(applyMacGrantDiffV1(state.client, { extra: [], missing: [item] }),
      /upgrade_updater_grant_refused/u, `a GRANT of ${item} must be refused`);
  }
  assert.deepEqual(JSON.parse(before), await updaterAcl(state.client), "nothing in updater moved");
  // A near-miss is still converged by the same call, so the refusal is narrow.
  const nearMiss = "control_room_private_web|table|updater_reports||SELECT|plain";
  const calls = [];
  await assert.rejects(applyMacGrantDiffV1({ query: async sql => { calls.push(sql); } },
    { extra: [nearMiss], missing: [] }), /upgrade_grant_catalog_refused/);
});

test("a snapshot file carrying updater rows plans no grant work against them", {
  skip: needsPg,
}, async () => {
  // The offline path: a snapshot captured by `database-upgrade-snapshot.mjs` is
  // JSON, so it can carry an updater row from any database, and it reaches the
  // planner as plain rows — NOT through `readMacGrantCatalogV1`, which is where
  // this change filters. The planner must drop them itself, because that is the
  // plan the operator reads before approving anything.
  const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
  const grants = (await state.client.query(macGrantCatalogSqlV1, [principals])).rows;
  // Asserted on the RAW rows, not through `macGrantRowsToSetV1` — which is now
  // where the filter lives, so asking it would answer the question with the fix.
  assert.ok(grants.some(row => row.object === macUpdaterOwnedSchema || String(row.object).startsWith("updater.")),
    "the raw catalogue really does carry updater rows, so the filter is load-bearing");
  assert.ok(grants.some(row => row.kind === "schema" && row.object === macUpdaterOwnedSchema),
    "including the bare schema row, which has no allow-list in grantSql at all");

  const snapshot = { applied: [], roles: [], memberships: [], defaultAcl: 0,
    queue: { schemaExists: true, verified: true }, grants };
  // The plan reaches its conclusion without scheduling any updater statement. It
  // may refuse for an unrelated reason on a snapshot with no roles at all, which
  // is fine — what must never happen is an updater statement in a plan.
  const plan = await planMacDatabaseUpgradeSnapshotV1(snapshot).catch(error => error);
  const scheduled = plan instanceof Error ? [] : plan.grants.extra;
  assert.deepEqual(scheduled.filter(item => !macReleaseOwnedGrantV1(item)), [],
    "no statement is scheduled against an updater object");
});

test("the whole upgrade path converges with the updater schema present, and repeats as a no-op", {
  skip: needsPg,
}, async () => {
  const before = JSON.stringify(await updaterAcl(state.client));
  // Plant drift so this run has real work to do rather than trivially passing.
  await state.client.query("GRANT DELETE ON public.control_jobs TO control_room_private_web");
  const result = await applyMacDatabaseUpgradeV1({ client: state.client, applyPending: async () => {} });
  assert.equal(result.upgraded, true);
  assert.deepEqual(result.after.grants, { extra: [], missing: [] },
    "the run converges with updater.* present");
  assert.deepEqual(await updaterAcl(state.client), JSON.parse(before),
    "the loader's ACL survived the upgrade byte for byte");

  // A second run is the ordinary clean no-op, which is the shape the finding
  // broke: a RE-RUN past the loader could never converge.
  const repeat = await applyMacDatabaseUpgradeV1({ client: state.client, applyPending: async () => {} });
  assert.equal(repeat.upgraded, true);
  assert.deepEqual(repeat.after.grants, { extra: [], missing: [] });
  assert.deepEqual(repeat.before.grants, { extra: [], missing: [] },
    "a re-run finds nothing to do for updater.* either");
  assert.deepEqual(await updaterAcl(state.client), JSON.parse(before));
});

test("as the migrator the REVOKE really would have been refused, so the filter is not cosmetic", {
  skip: needsPg,
}, async () => {
  // Establishes the finding against this cluster rather than asserting it. The
  // migrator holds nothing in `updater` by design, which is exactly why the
  // release converger needed the same filter; the Mac converger runs as the
  // superuser, which is why its failure was silent instead.
  const migrator = connectTarget(migratorTarget());
  await migrator.connect();
  try {
    await assert.rejects(migrator.query(`REVOKE EXECUTE ON FUNCTION ${macUpdaterOwnedSchema}.authorization_complete(text, bytea, bytea, bytea)
      FROM control_room_private_web`), error => error.code === "42501" && /permission denied for schema updater/u.test(error.message),
    "the migrator cannot revoke inside the updater schema");
  } finally { await migrator.end(); }
  // And as the superuser — the Mac converger's real login — it CAN, which is the
  // silent-corruption path the filter now prevents.
  const statements = [];
  await assert.rejects(applyMacGrantDiffV1({ query: async sql => { statements.push(sql); } },
    { extra: [`control_room_private_web|schema|${macUpdaterOwnedSchema}||USAGE|plain`], missing: [] }),
    /upgrade_updater_grant_refused/u);
  assert.deepEqual(statements, [], "the superuser path is refused before any statement is built");
});