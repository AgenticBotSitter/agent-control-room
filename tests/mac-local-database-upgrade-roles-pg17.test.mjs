// Repeatable, roles-first live-database upgrade on a real disposable PostgreSQL 17.
// The upgrade runs exactly as on the VPS: the operator session is the local
// `postgres` peer login, and every migration runs through the restricted
// `control_room_migrator` identity that the peer path switches to.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { applyMacDatabaseUpgradeV1, applyPendingMacMigrationsV1, macDatabaseUpgradePlanDigestV1,
  plainMacDatabaseUpgradeRefusalV1, runMacDatabaseUpgradeCommandV1 } from "../scripts/mac-local/database-upgrade-remote.mjs";
import { postgresScramVerifierV1 } from "../scripts/mac-local/database-upgrade-scram.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, findFreePort, needsPg, requestedPort } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const legacyMacLogins = ["control_room_web", "control_room_coordinator", "control_room_results",
  "control_room_queue_worker"];
const password = login => `p${login.replaceAll("_", "")}`.padEnd(40, "x");
const publisherPassword = "q".repeat(40), intakePassword = "w".repeat(40), reviewerPassword = "v".repeat(40);
const fleetPassword = "f".repeat(40), fleetOwnerPassword = "o".repeat(40);
const mainCommit = "c".repeat(40);
const git = params => params[0] === "status" ? "" : mainCommit;
const state = {};

const exec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const operator = () => `host=${state.socket} port=${state.port} dbname=control_room user=postgres`;
const tcp = (user, secret) => `host=127.0.0.1 port=${state.port} dbname=control_room user=${user} password=${secret}`;
const peerMigrations = () => applyPendingMacMigrationsV1(operator());

async function catalog(client) {
  const query = async (sql, values) => (await client.query(sql, values)).rows;
  return {
    roles: await query(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
      rolbypassrls,rolpassword FROM pg_authid WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`),
    memberships: await query(`SELECT member.rolname AS member,parent.rolname AS parent,m.admin_option,
      m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
      JOIN pg_roles member ON member.oid=m.member ORDER BY 1,2`),
    tables: await query(`SELECT n.nspname,c.relname,c.relacl::text AS acl FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','control_room_queue')
      ORDER BY 1,2`),
    ledger: await query("SELECT filename,digest,ledger_order FROM control_room_schema_migrations ORDER BY ledger_order"),
  };
}

const unknownRole = async client => ({
  role: (await client.query(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolbypassrls,rolpassword
    FROM pg_authid WHERE rolname IN ('control_room_audit_viewer','outside_reporting') ORDER BY rolname`)).rows,
  grants: (await client.query(`SELECT has_table_privilege('control_room_audit_viewer','public.control_jobs','SELECT')
    AS viewer, has_table_privilege('outside_reporting','public.control_jobs','SELECT') AS outside`)).rows,
  memberships: (await client.query(`SELECT count(*)::int AS count FROM pg_auth_members m JOIN pg_roles r
    ON r.oid IN (m.member,m.roleid) WHERE r.rolname IN ('control_room_audit_viewer','outside_reporting')`)).rows,
});

before(async () => {
  if (needsPg) return;
  state.root = await mkdtemp(join(tmpdir(), "acr-roles-"));
  state.port = requestedPort() ?? await findFreePort();
  const data = join(state.root, "pg");
  state.socket = join(state.root, "s");
  await mkdir(state.socket, { mode: 0o700 });
  state.teardown = createClusterTeardown({ dataDirectory: data, runDirectory: state.root,
    socketDirectory: state.socket, port: state.port, pgBin: PG_BIN, removeDirectories: false });
  exec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await writeFile(join(data, "pg_hba.conf"), "local all postgres trust\nhost all postgres 127.0.0.1/32 trust\n"
    + "host all all 127.0.0.1/32 scram-sha-256\n");
  exec("pg_ctl", ["-D", data, "-l", join(state.root, "pg.log"), "-w", "-o",
    `-p ${state.port} -k '${state.socket}' -c listen_addresses=127.0.0.1`, "start"]);
  await state.teardown.capturePostmasterPid();
  exec("psql", ["-h", "127.0.0.1", "-p", String(state.port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  // An older ledger: every migration up to 0090, the file the live database last applied.
  const ledger = JSON.parse(await readFile(join(repoRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  ledger.entries = ledger.entries.filter(entry => entry.kind !== undefined && entry.kind !== "migrate"
    || entry.file < "db/migrations/0091");
  const ledgerPath = join(state.root, "ledger-0090.json");
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const migratorPassword = "m".repeat(40);
  await applyMigrations({ rootDir: repoRoot, ledgerPath, bootstrapTarget: tcp("postgres", "unused"),
    migrateTarget: tcp("control_room_migrator", migratorPassword),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: migratorPassword, CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
      CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "i".repeat(40) } });
  state.client = connectTarget(operator());
  await state.client.connect();
  // That ledger predates the work-intake group and its login.
  await state.client.query(`DROP OWNED BY control_room_work_intake_agent, control_room_work_intake;
    DROP ROLE control_room_work_intake_agent; DROP ROLE control_room_work_intake`);
  for (const login of legacyMacLogins) {
    await state.client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD ${state.client.escapeLiteral(password(login))}`);
    await state.client.query(`GRANT control_room_application TO ${login}`);
  }
  // Roles the manifest does not know about. The upgrade must never touch them.
  await state.client.query(`CREATE ROLE control_room_audit_viewer NOLOGIN;
    GRANT SELECT ON control_jobs TO control_room_audit_viewer;
    CREATE ROLE outside_reporting LOGIN PASSWORD 'outside-reporting-secret-value-000000';
    GRANT SELECT ON control_jobs TO outside_reporting`);
  state.unknown = await unknownRole(state.client);
});

after(async () => {
  if (needsPg) return;
  try { await state.client?.end(); } catch {}
  try { await state.teardown?.stop(); } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("a planned new login without its code is refused in plain words before anything is written", {
  skip: needsPg,
}, async () => {
  const { plan, digest } = await runMacDatabaseUpgradeCommandV1({ args: ["--plan", "--expected-main", mainCommit],
    git, openClient: () => connectTarget(operator()) });
  const beforeCatalog = await catalog(state.client);
  let migrated = false;
  await assert.rejects(runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", mainCommit, "--expected-plan-digest", digest],
    readVerifier: async () => "", git, openClient: () => connectTarget(operator()),
    applyPending: async () => { migrated = true; },
  }), /^Error: upgrade_new_login_needs_verifier:control_room_agent_reviewer_login,control_room_fleet,control_room_fleet_owner,control_room_publisher,control_room_work_intake_agent$/u);
  assert.equal(migrated, false);
  assert.deepEqual(await catalog(state.client), beforeCatalog, "a refused upgrade changes nothing");
  // Codes for every other new login are not enough: the reviewer login needs its own.
  await assert.rejects(runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", mainCommit, "--expected-plan-digest", digest],
    readVerifier: async () => JSON.stringify({ control_room_publisher: postgresScramVerifierV1(publisherPassword),
      control_room_work_intake_agent: postgresScramVerifierV1(intakePassword),
      control_room_fleet: postgresScramVerifierV1(fleetPassword),
      control_room_fleet_owner: postgresScramVerifierV1(fleetOwnerPassword) }),
    git, openClient: () => connectTarget(operator()),
    applyPending: async () => { migrated = true; },
  }), /^Error: upgrade_new_login_needs_verifier:control_room_agent_reviewer_login,/u);
  assert.equal(migrated, false);
  assert.deepEqual(await catalog(state.client), beforeCatalog, "a refused upgrade changes nothing");
  assert.equal(plainMacDatabaseUpgradeRefusalV1(new Error("upgrade_new_login_needs_verifier:"
    + "control_room_agent_reviewer_login")), "Refused: this upgrade adds the new database login "
    + "control_room_agent_reviewer_login, and each needs its login code from the Mac. Nothing was changed. "
    + "Run the upgrade again with the code on standard input.");
  assert.deepEqual(plan.createRoles.filter(item => item.role.startsWith("control_room_agent_reviewer")), [
    { role: "control_room_agent_reviewer", attributes: "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" },
    { role: "control_room_agent_reviewer_login", attributes: "LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" },
  ]);
  assert.ok(plan.createRoles.some(item => item.role === "control_room_work_intake_agent"));
});

test("an older ledger missing control_room_work_intake gets the group first, so its grants succeed", {
  skip: needsPg,
}, async () => {
  const plan = (await runMacDatabaseUpgradeCommandV1({ args: ["--plan", "--expected-main", mainCommit],
    git, openClient: () => connectTarget(operator()) })).plan;
  assert.ok(plan.pendingMigrations.includes("db/migrations/0093_work_batch_intake.sql"));
  const keptLogins = ["control_room_migrator", "control_room_app", "control_room_scheduler", ...legacyMacLogins];
  const verifiers = async () => (await state.client.query(`SELECT rolname,rolpassword FROM pg_authid
    WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [keptLogins])).rows;
  const oldVerifiers = await verifiers();
  const result = await applyMacDatabaseUpgradeV1({ client: state.client,
    expectedPlanDigest: macDatabaseUpgradePlanDigestV1(plan), applyPending: peerMigrations,
    publisherVerifier: postgresScramVerifierV1(publisherPassword),
    loginVerifiers: { control_room_work_intake_agent: postgresScramVerifierV1(intakePassword),
      control_room_agent_reviewer_login: postgresScramVerifierV1(reviewerPassword),
      control_room_fleet: postgresScramVerifierV1(fleetPassword),
      control_room_fleet_owner: postgresScramVerifierV1(fleetOwnerPassword) } });
  assert.equal(result.upgraded, true);
  assert.deepEqual(plan.createRoles.find(item => item.role === "control_room_work_intake"), {
    role: "control_room_work_intake", attributes: "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" });
  assert.deepEqual(result.after, { pendingMigrations: [], installQueueSchema: false, createRoles: [],
    membership: { grant: [], revoke: [] }, grants: { extra: [], missing: [] } });
  assert.deepEqual(await verifiers(), oldVerifiers, "existing passwords are byte-identical");
  const group = (await state.client.query(`SELECT rolcanlogin,rolsuper,rolcreaterole,rolbypassrls FROM pg_roles
    WHERE rolname='control_room_work_intake'`)).rows[0];
  assert.deepEqual(group, { rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolbypassrls: false });
  assert.equal((await state.client.query(`SELECT count(*)::int AS count FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE r.rolname='control_room_work_intake'`)).rows[0].count > 0, true, "table grants reached the new group");
  for (const [login, secret] of [["control_room_work_intake_agent", intakePassword],
    ["control_room_publisher", publisherPassword], ["control_room_agent_reviewer_login", reviewerPassword],
    ["control_room_fleet", fleetPassword], ["control_room_fleet_owner", fleetOwnerPassword],
    ...legacyMacLogins.map(login => [login, password(login)])]) {
    const session = connectTarget(tcp(login, secret));
    await session.connect();
    try { assert.equal((await session.query("SELECT current_user AS role")).rows[0].role, login); }
    finally { await session.end(); }
  }
  const intake = connectTarget(tcp("control_room_work_intake_agent", intakePassword));
  await intake.connect();
  try {
    assert.equal((await intake.query(`SELECT pg_has_role('control_room_work_intake','member') AS member`))
      .rows[0].member, true);
  } finally { await intake.end(); }
  const reviewer = connectTarget(tcp("control_room_agent_reviewer_login", reviewerPassword));
  await reviewer.connect();
  try {
    assert.equal((await reviewer.query(`SELECT pg_has_role('control_room_agent_reviewer','member') AS member`))
      .rows[0].member, true);
  } finally { await reviewer.end(); }
  for (const [login, secret, group] of [["control_room_fleet", fleetPassword, "control_room_fleet_gateway"],
    ["control_room_fleet_owner", fleetOwnerPassword, "control_room_fleet_owner_authority"]]) {
    const session = connectTarget(tcp(login, secret));
    await session.connect();
    try {
      assert.equal((await session.query("SELECT pg_has_role($1,'member') AS member", [group])).rows[0].member, true);
      assert.equal((await session.query("SELECT rolsuper OR rolcreaterole OR rolbypassrls AS dangerous FROM pg_roles WHERE rolname=current_user")).rows[0].dangerous, false);
    } finally { await session.end(); }
  }
});

test("a second upgrade of the same database needs no code and applies nothing new", { skip: needsPg }, async () => {
  const beforeCatalog = await catalog(state.client);
  for (let run = 0; run < 2; run += 1) {
    const { plan, digest } = await runMacDatabaseUpgradeCommandV1({ args: ["--plan", "--expected-main", mainCommit],
      git, openClient: () => connectTarget(operator()) });
    assert.deepEqual(plan, { pendingMigrations: [], installQueueSchema: false, createRoles: [],
      membership: { grant: [], revoke: [] }, grants: { extra: [], missing: [] } });
    const result = await runMacDatabaseUpgradeCommandV1({
      args: ["--apply", "--expected-main", mainCommit, "--expected-plan-digest", digest],
      readVerifier: async () => { throw new Error("the upgrade read a code it did not need"); },
      git, openClient: () => connectTarget(operator()),
      applyPending: async () => { throw new Error("no migration is pending"); },
    });
    assert.equal(result.upgraded, true);
    assert.deepEqual(result.after, plan);
  }
  assert.deepEqual(await catalog(state.client), beforeCatalog, "a repeat upgrade is a no-op");
});

test("roles outside the manifest are left exactly as they were", { skip: needsPg }, async () => {
  assert.deepEqual(await unknownRole(state.client), state.unknown);
  assert.deepEqual(state.unknown.grants, [{ viewer: true, outside: true }]);
});
