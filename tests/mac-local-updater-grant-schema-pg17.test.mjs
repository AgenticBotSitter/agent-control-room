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
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { createMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { applyMacLocalFirstOwnerV1 } from "../scripts/mac-local/first-owner-vps.mjs";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store.ts";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database.ts";
import { privatePgOptions } from "../src/web/v1/private-pg-options.ts";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight.ts";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store.ts";
import pg from "pg";
import { PG_BIN, findFreePort, needsPg, requestedPort } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const state = {};

/** The updater's loader-owned tables, named from the updater's own DDL
 * (`src/updater/v1/ddl/0002_schema.sql`) rather than invented here — a fixture
 * that invented a table of its own would not be the shape the filter exists for,
 * and a stale name would make this lane quietly weaker. The passkey and alert
 * (push) tables are the two the finding names. */
const UPDATER_TABLES = ["passkey_registrations", "passkey_open_registrations", "push_queue"];

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
    tables: (await client.query(`SELECT r.rolname AS role, n.nspname || '.' || c.relname AS object,
      a.privilege_type AS privilege, a.is_grantable FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = $1 AND c.relkind IN ('r','v') AND r.rolname = ANY($2::text[]) ORDER BY 1,2,3`,
    [macUpdaterOwnedSchema, roles])).rows,
    functions: (await client.query(`SELECT r.rolname AS role, n.nspname || '.' || p.proname || '(' || COALESCE((SELECT
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
  // Rebuilt from the shipped bytes; the committed ledger is held to the same bytes by db:verify.
  const shipped = await collectLedgerEntries(repoRoot);
  state.ledgerPath = join(state.root, "shipped-ledger.json");
  await writeFile(state.ledgerPath, `${JSON.stringify({ version: 1, digest: ledgerDigest(shipped), entries: shipped })}\n`);
  await applyMigrations({ rootDir: repoRoot, ledgerPath: state.ledgerPath,
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
  // The web login's grants, which the loader re-asserts on every run: the schema
  // USAGE, the passkey table reads, the alert (push) queue read and EXECUTE on
  // both guards.
  await state.client.query(`GRANT USAGE ON SCHEMA ${macUpdaterOwnedSchema} TO control_room_private_web`);
  await state.client.query(`GRANT SELECT ON ${macUpdaterOwnedSchema}.passkey_registrations TO control_room_private_web`);
  await state.client.query(`GRANT SELECT ON ${macUpdaterOwnedSchema}.passkey_open_registrations TO control_room_private_web`);
  await state.client.query(`GRANT SELECT, INSERT ON ${macUpdaterOwnedSchema}.push_queue TO control_room_private_web`);
  await state.client.query(`GRANT EXECUTE ON FUNCTION ${macUpdaterOwnedSchema}.authorization_complete(text, bytea, bytea, bytea)
    TO control_room_private_web`);
  await state.client.query(`GRANT EXECUTE ON FUNCTION ${macUpdaterOwnedSchema}.bounded_transports(text[]) TO control_room_private_web`);

  // The fixture must actually carry what the finding describes, or every test
  // below would pass against an empty schema. Asserted on the catalog. The
  // function spellings are exactly what the catalogue query renders — argument
  // types joined by `', '` — because a hand-written expectation that does not
  // match the render would pass or fail for the wrong reason.
  const acl = JSON.stringify(await updaterAcl(state.client));
  for (const expected of ["updater", "updater.passkey_registrations", "updater.passkey_open_registrations",
    "updater.push_queue", "updater.authorization_complete(text, bytea, bytea, bytea)",
    "updater.bounded_transports(_text)"])
    assert.ok(acl.includes(expected), `the fixture is missing a grant on ${expected}`);
  assert.ok(!acl.includes('"grantee":0'), "PUBLIC holds nothing in the updater schema");
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

// ---------------------------------------------------------------------------
// CR-E075: a real installed database from the release BEFORE the subscription
// update grant, upgraded through the real Mac upgrade path.
//
// The earlier install is rebuilt from bytes whose digests were CAPTURED from the
// pinned base release (2e5c622a): the migration ledger without 0299 and the
// private-web role file without its one new grant line. The two constants below
// are those captured digests -- never read from the current ledger -- so a
// derivation that drifted from the shipped base fails before anything installs.
const BASE_LEDGER_DIGEST = "c5b27220129a5201f7baeadf48f00d3134726ebe056cb456095b7a88ad4cca03";
const BASE_PRIVATE_WEB_ROLES_SHA256 = "0fea0207392fb36f5b8d9e8716984f80ad1b7d9975db658104434672d7c54e92"; // trailing whitespace trimmed
const SUBSCRIPTION_GRANT = /^GRANT UPDATE \([^)]*\) ON owner_web_push_subscriptions TO control_room_private_web;\n/gmu;
const UPGRADE_TENANT = "tenant:installed-upgrade";
const UPGRADE_WORKSPACE = "workspace:installed-upgrade";
const UPGRADE_SUBJECT = "installed-upgrade-owner";
const subscription = (endpoint, n) => ({ id: "", tenantId: UPGRADE_TENANT, endpoint, p256dh: String.fromCharCode(65 + n).repeat(87),
  auth: String.fromCharCode(97 + n).repeat(22), expiresAt: null });
const subscriptionFields = row => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, expiresAt: row.expiresAt });

async function installedCluster(label) {
  const root = await mkdtemp(join(tmpdir(), `acr-installed-${label}-`));
  const cluster = { root, port: requestedPort() ?? await findFreePort(), socket: join(root, "s") };
  await mkdir(cluster.socket, { mode: 0o700 });
  cluster.teardown = createClusterTeardown({ dataDirectory: join(root, "pg"), runDirectory: root,
    socketDirectory: cluster.socket, port: cluster.port, pgBin: PG_BIN, removeDirectories: false });
  try {
    exec("initdb", ["-D", join(root, "pg"), "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    await writeFile(join(root, "pg", "pg_hba.conf"), "local all postgres trust\nlocal all all trust\n"
      + "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
    exec("pg_ctl", ["-D", join(root, "pg"), "-l", join(root, "pg.log"), "-w", "-o",
      `-p ${cluster.port} -k '${cluster.socket}' -c listen_addresses=127.0.0.1`, "start"]);
    await cluster.teardown.capturePostmasterPid();
  } catch (error) {
    try { await cluster.teardown.stop(); } catch (stopError) {
      throw new AggregateError([error, stopError], `cluster_start_and_teardown_failed:${error?.message ?? error}`);
    }
    throw error;
  }
  cluster.operator = `host=${cluster.socket} port=${cluster.port} dbname=control_room user=postgres`;
  cluster.migratorPassword = `m${"k".repeat(39)}`;
  cluster.migrator = `host=${cluster.socket} port=${cluster.port} dbname=control_room user=control_room_migrator password=${cluster.migratorPassword}`;
  cluster.migrationEnv = { CONTROL_ROOM_MIGRATOR_PASSWORD: cluster.migratorPassword, CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
    CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "i".repeat(40) };
  exec("psql", ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  return cluster;
}

/** The base release's migration tree and ledger, checked against captured digests. */
async function baseReleaseTree(directory) {
  const current = await collectLedgerEntries(repoRoot);
  const migration = current.find(entry => entry.file.includes("0299_owner_web_push_subscription_update_grant"));
  assert.ok(migration, "the candidate ships migration 0299");
  const entries = current.filter(entry => entry !== migration).map((entry, index) => ({ ...entry, order: index + 1 }));
  assert.equal(ledgerDigest(entries), BASE_LEDGER_DIGEST, "the derived earlier ledger is byte-identical to the captured base ledger");
  await cp(join(repoRoot, "db"), join(directory, "db"), { recursive: true });
  await rm(join(directory, migration.file));
  await mkdir(join(directory, "deploy/postgres"), { recursive: true });
  await writeFile(join(directory, "deploy/postgres/migration-ledger.json"),
    `${JSON.stringify({ version: 1, digest: BASE_LEDGER_DIGEST, entries }, null, 2)}\n`);
  const roles = await readFile(join(repoRoot, "db/roles/private_web_roles.sql"), "utf8");
  assert.equal(roles.match(SUBSCRIPTION_GRANT)?.length, 1, "the current role file carries exactly one subscription column grant");
  const earlier = roles.replace(SUBSCRIPTION_GRANT, "");
  assert.equal(createHash("sha256").update(earlier.trimEnd()).digest("hex"), BASE_PRIVATE_WEB_ROLES_SHA256,
    "the derived earlier role file is byte-identical to the captured base role file");
  return { ledgerPath: join(directory, "deploy/postgres/migration-ledger.json"), rootDir: directory, roles, earlier };
}

const webLogin = (cluster, password) => {
  const config = { host: "127.0.0.1", port: cluster.port, database: "control_room", username: "control_room_web", password, majorVersion: 17 };
  const db = bindPrivatePgPool(new pg.Pool(privatePgOptions(config)));
  return { db, config, store: new PostgresOwnerPushStoreV1(db.client) };
};
const subscriptionAcl = async client => ({
  table: (await client.query(`SELECT r.rolname AS role, a.privilege_type AS privilege, a.is_grantable AS grantable
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee WHERE c.relname = 'owner_web_push_subscriptions' ORDER BY 1,2,3`)).rows,
  columns: (await client.query(`SELECT r.rolname AS role, att.attname AS column, a.privilege_type AS privilege, a.is_grantable AS grantable
    FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE c.relname = 'owner_web_push_subscriptions' ORDER BY 1,2,3`)).rows,
  structure: (await client.query(`SELECT a.attname AS column, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'owner_web_push_subscriptions' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows,
  constraints: (await client.query(`SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS definition
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    WHERE c.relname = 'owner_web_push_subscriptions' ORDER BY 1`)).rows,
});

test("CR-E075 installed subscription grant upgrade", { skip: needsPg, timeout: 600_000 }, async () => {
  const installed = await installedCluster("grant");
  const stores = [];
  const admin = connectTarget(installed.operator);
  try {
    // ---- the earlier release, installed through its own ledger and role file ----
    const base = await baseReleaseTree(await mkdtemp(join(installed.root, "base-")));
    await applyMigrations({ rootDir: base.rootDir, ledgerPath: base.ledgerPath, bootstrapTarget: installed.operator,
      migrateTarget: installed.migrator, env: installed.migrationEnv });
    await admin.connect();
    for (const role of [...Object.keys(macRolePlan), ...new Set(Object.values(macRolePlan))])
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    const passwords = Object.fromEntries(Object.keys(macRolePlan).map((login, index) => [login, `pw${index}`.padEnd(40, "z")]));
    // The earlier release's role file reaches the real provisioner through its normal read.
    const earlierClient = new Proxy(admin, { get: (target, property) => property === "query"
      ? (sql, ...rest) => target.query(sql === base.roles ? base.earlier : sql, ...rest)
      : (typeof target[property] === "function" ? target[property].bind(target) : target[property]) });
    await provisionMacLocalNarrowRolesV1(earlierClient, passwords);

    // ---- unrelated data and a retained subscription, from the real producers ----
    const at = new Date(Date.now() - 1_000).toISOString();
    const manifest = createMacLocalFirstOwnerManifestV1({ workspaceId: UPGRADE_WORKSPACE,
      localOwnerSession: { tenantId: UPGRADE_TENANT, provider: "local-owner", subject: UPGRADE_SUBJECT },
      enablement: { nodeId: "node:installed-upgrade", workers: [
        { kind: "hermes", workerId: "worker:upgrade-h" }, { kind: "claude-code", workerId: "worker:upgrade-c" },
        { kind: "codex", workerId: "worker:upgrade-x" }] }, workIntakeProjectIds: [] }, at,
    CompletionGateStoreV1.genesisIntegrityForKeyV1(UPGRADE_TENANT, new Uint8Array(32).fill(9)));
    await applyMacLocalFirstOwnerV1(admin, manifest);
    const scope = { tenantId: UPGRADE_TENANT, workspaceId: UPGRADE_WORKSPACE, ownerIdentityId: manifest.identity.id, issuer: "local-owner" };
    const retained = subscription("https://fcm.googleapis.com/fcm/send/installed-retained", 0);
    await new PostgresOwnerPushStoreV1(admin).subscribe(retained);
    const unrelated = (await admin.query("SELECT (SELECT count(*) FROM tenants)::int AS tenants, (SELECT count(*) FROM owner_web_push_subscriptions)::int AS subscriptions")).rows[0];
    assert.deepEqual(unrelated, { tenants: 1, subscriptions: 1 });
    const retainedBefore = (await admin.query("SELECT id, created_at, updated_at FROM owner_web_push_subscriptions")).rows[0];

    // ---- historical first use: the production login cannot save a subscription ----
    const old = webLogin(installed, passwords.control_room_web); stores.push(old);
    await assert.rejects(old.store.subscribe(subscription("https://fcm.googleapis.com/fcm/send/installed-first-use", 1)),
      error => error.code === "42501" || error.sqlState === "42501", "the earlier install refuses the first save with 42501");
    assert.deepEqual((await old.store.list(UPGRADE_TENANT)).map(subscriptionFields), [subscriptionFields(retained)],
      "the refused save left the retained row alone");
    assert.equal((await admin.query("SELECT has_column_privilege('control_room_web','owner_web_push_subscriptions','p256dh','UPDATE') AS ok")).rows[0].ok, false);
    await assert.rejects(verifyPrivateDatabase(old.db.client, old.config, scope, Date.now(), { nativeQueue: true }),
      "this release's startup check refuses the earlier install, so it cannot start against it unmigrated");
    await old.db.close(); stores.length = 0;

    // ---- the candidate, through the real release migration and grant convergence ----
    let postMigration;
    const upgraded = await applyMacDatabaseUpgradeV1({ client: admin, applyPending: async () => {
      await applyMigrations({ rootDir: repoRoot, ledgerPath: state.ledgerPath,
        bootstrapTarget: installed.operator, migrateTarget: installed.migrator, env: installed.migrationEnv });
      // Migration only, before any grant convergence: the migration itself must carry the grant.
      const probe = webLogin(installed, passwords.control_room_web);
      try { await probe.store.subscribe(subscription("https://fcm.googleapis.com/fcm/send/installed-post-migration", 2));
        postMigration = (await probe.store.list(UPGRADE_TENANT)).map(row => row.endpoint).sort();
      } catch (error) { postMigration = `refused:${error.sqlState ?? error.code ?? error.message}`;
      } finally { await probe.db.close(); }
    } });
    assert.equal(upgraded.upgraded, true);
    assert.deepEqual(postMigration, ["https://fcm.googleapis.com/fcm/send/installed-post-migration",
      "https://fcm.googleapis.com/fcm/send/installed-retained"], "the migration alone lets the production login save");
    assert.deepEqual(upgraded.after.grants, { extra: [], missing: [] });

    // ---- reopened: startup check, then first save, read and duplicate renewal ----
    const web = webLogin(installed, passwords.control_room_web); stores.push(web);
    await assert.doesNotReject(verifyPrivateDatabase(web.db.client, web.config, scope, Date.now(), { nativeQueue: true }),
      "the reopened startup check accepts the upgraded install");
    const fresh = subscription("https://fcm.googleapis.com/fcm/send/installed-after", 3);
    await web.store.subscribe(fresh);
    const renewed = { ...fresh, p256dh: "Z".repeat(87), auth: "y".repeat(22), expiresAt: "2099-01-01T00:00:00.000Z" };
    await web.store.subscribe(renewed);
    await web.store.subscribe({ ...retained, p256dh: "Q".repeat(87), expiresAt: "2099-01-01T00:00:00.000Z" });
    const listed = (await web.store.list(UPGRADE_TENANT)).map(subscriptionFields)
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    assert.deepEqual(listed.map(row => row.endpoint), ["https://fcm.googleapis.com/fcm/send/installed-after",
      "https://fcm.googleapis.com/fcm/send/installed-post-migration", "https://fcm.googleapis.com/fcm/send/installed-retained"]);
    assert.deepEqual(listed[0], subscriptionFields(renewed), "duplicate endpoint renews in place");
    const retainedAfter = (await admin.query("SELECT id, created_at FROM owner_web_push_subscriptions WHERE endpoint = $1", [retained.endpoint])).rows[0];
    assert.equal(retainedAfter.id, retainedBefore.id, "the retained row kept its identity");
    assert.deepEqual(retainedAfter.created_at, retainedBefore.created_at);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 1, "unrelated data survived");
    const narrow = new pg.Client({ host: "127.0.0.1", port: installed.port, database: "control_room", user: "control_room_web",
      password: passwords.control_room_web });
    await narrow.connect();
    try {
      await assert.rejects(narrow.query("UPDATE owner_web_push_subscriptions SET endpoint = endpoint"), { code: "42501" },
        "the grant is column-narrow: no table-wide UPDATE");
    } finally { await narrow.end(); }

    // ---- idempotent rerun ----
    const aclAfterFirst = await subscriptionAcl(admin);
    const rerun = await applyMacDatabaseUpgradeV1({ client: admin, applyPending: async () => {} });
    assert.equal(rerun.upgraded, true);
    assert.deepEqual(rerun.before.grants, { extra: [], missing: [] }, "a rerun finds no grant drift");
    assert.deepEqual(await subscriptionAcl(admin), aclAfterFirst);
    await verifyPrivateDatabase(web.db.client, web.config, scope, Date.now(), { nativeQueue: true });

    // ---- fresh candidate install versus the upgraded one: same ACL, schema and grants ----
    assert.deepEqual(await subscriptionAcl(state.client), aclAfterFirst, "upgraded ACL, columns and constraints equal a fresh install");
    const desired = await readDesiredMacGrantsV1();
    for (const client of [admin, state.client]) {
      const diff = diffMacGrantsV1(await readMacGrantCatalogV1(client), desired);
      assert.deepEqual(diff, { extra: [], missing: [] });
    }
  } finally {
    for (const store of stores) await store.db.close().catch(() => {});
    try { await admin.end(); } catch {}
    try { await installed.teardown.stop(); } finally { await rm(installed.root, { recursive: true, force: true }); }
  }
});
