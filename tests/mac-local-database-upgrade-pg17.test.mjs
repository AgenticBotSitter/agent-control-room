import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { applyMacDatabaseUpgradeV1, inspectMacDatabaseUpgradeV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";
import { macDatabaseUpgradeReadOnlySqlV1 } from "../scripts/mac-local/provision-database.mjs";
import { planMacDatabaseUpgradeSnapshotV1 } from "../scripts/mac-local/database-upgrade-remote.mjs";
import { macRolePlan, readMacGrantCatalogV1 } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";

const oldRoot = "/private/tmp/acr-db-0085";
const headRoot = resolve(new URL("../", import.meta.url).pathname);
const oldRoles = Object.entries(macRolePlan).filter(([login]) => login !== "control_room_publisher");
const exec = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const connection = port => `host=127.0.0.1 port=${port} dbname=control_room user=postgres`;
const migrator = (port, password) => `host=127.0.0.1 port=${port} dbname=control_room user=control_room_migrator password=${password}`;

async function cluster(root, port) {
  const data = join(root, "pg"), log = join(root, "pg.log");
  await mkdir(root, { recursive: true, mode: 0o700 });
  exec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await writeFile(join(data, "pg_hba.conf"), "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
  exec("pg_ctl", ["-D", data, "-l", log, "-w", "-o", `-p ${port} -k '' -c listen_addresses=127.0.0.1`, "start"]);
  return { port, log, data };
}

async function baseDatabase(root, port, suffix) {
  exec("psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f",
    join(root, "deploy/postgres/provision-database.sql")]);
  const secrets = { migrator: `m${suffix}`.repeat(36), application: `a${suffix}`.repeat(36),
    scheduler: `s${suffix}`.repeat(36) };
  await applyMigrations({ rootDir: root, ledgerPath: join(root, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: connection(port), migrateTarget: migrator(port, secrets.migrator),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator,
      CONTROL_ROOM_APP_PASSWORD: secrets.application, CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler } });
  return secrets;
}

async function installOldRoles(client) {
  await client.query(getConstructionPlans("control_room_queue"));
  const boss = new PgBoss({ db: { executeSql: (sql, values) => client.query(sql, values) },
    schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false });
  await boss.start();
  try { await boss.createQueue("native-task-delivery", { retryLimit: 0 }); }
  finally { await boss.stop({ graceful: false }); }
  for (const file of ["private_web_database.sql", "private_web_roles.sql", "task_coordinator_roles.sql",
    "native_queue_producer_roles.sql", "native_results_roles.sql", "native_queue_worker_roles.sql"])
    await client.query(await readFile(join(oldRoot, "db/roles", file), "utf8"));
  for (const [login, group] of oldRoles) {
    await client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD ${client.escapeLiteral("p".repeat(40) + login)}`);
    await client.query(`GRANT ${group} TO ${login}`);
  }
}

async function snapshot(client) {
  const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
  const roles = (await client.query(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,
    rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [principals])).rows;
  const membership = (await client.query(`SELECT parent.rolname AS parent, member.rolname AS member,
    m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m
    JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
    WHERE member.rolname=ANY($1::text[]) ORDER BY parent.rolname,member.rolname`, [principals])).rows;
  return { roles, membership, grants: [...await readMacGrantCatalogV1(client)].sort() };
}

test("0085 PostgreSQL 17 installation upgrades to exactly fresh HEAD roles, with no extra grants, then converges", {
  skip: process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL !== "1",
  timeout: 240_000,
}, async t => {
  assert.match(exec("postgres", ["--version"]), /^postgres \(PostgreSQL\) 17\./u);
  assert.equal((await readFile(join(oldRoot, "deploy/postgres/migration-ledger.json"), "utf8")).includes("0086_"), false);
  const root = await mkdtemp(join(tmpdir(), "mac-db-pg17-"));
  const old = await cluster(join(root, "old"), 15581);
  const fresh = await cluster(join(root, "fresh"), 15582);
  const clients = [];
  t.after(async () => {
    for (const client of clients) { try { await client.end(); } catch {} }
    for (const item of [old, fresh]) {
      try { exec("pg_ctl", ["-D", item.data, "-m", "fast", "stop"]); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  const oldSecrets = await baseDatabase(oldRoot, old.port, "o");
  const oldClient = connectTarget(connection(old.port)); await oldClient.connect();
  clients.push(oldClient);
  await installOldRoles(oldClient);
  await oldClient.query("GRANT DELETE ON control_jobs TO control_room_private_web");
  const prior = await snapshot(oldClient);
  const plan = await inspectMacDatabaseUpgradeV1({ client: oldClient });
  const raw = execFileSync("psql", ["-h", "127.0.0.1", "-p", String(old.port), "-U", "postgres",
    "-d", "control_room", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
  { input: macDatabaseUpgradeReadOnlySqlV1(), encoding: "utf8", timeout: 30_000 });
  const readOnlySnapshot = JSON.parse(raw.split(/\r?\n/u).find(line => line.startsWith("{")));
  assert.deepEqual(await planMacDatabaseUpgradeSnapshotV1(readOnlySnapshot), plan);
  assert.equal(plan.pendingMigrations.length, 5);
  assert.ok(plan.createRoles.includes("control_room_publisher"));
  assert.ok(plan.grants.extra.some(item => item.includes("control_room_private_web|table|public.control_jobs||DELETE|plain")));
  assert.deepEqual(await snapshot(oldClient), prior, "dry run does not change PostgreSQL");
  const request = { client: oldClient, publisherPassword: "q".repeat(40), migratorPassword: oldSecrets.migrator,
    bootstrapConnection: connection(old.port), migrateConnection: migrator(old.port, oldSecrets.migrator) };
  await applyMacDatabaseUpgradeV1(request);
  const upgraded = await snapshot(oldClient);
  const repeat = await applyMacDatabaseUpgradeV1(request);
  assert.deepEqual(repeat.before.grants, { extra: [], missing: [] });
  assert.deepEqual(repeat.before.pendingMigrations, []);
  assert.deepEqual(await snapshot(oldClient), upgraded);

  await baseDatabase(headRoot, fresh.port, "f");
  const freshClient = connectTarget(connection(fresh.port)); await freshClient.connect();
  clients.push(freshClient);
  const passwords = Object.fromEntries(Object.keys(macRolePlan).map((login, index) => [login, `x${index}`.repeat(36)]));
  await provisionMacLocalNarrowRolesV1(freshClient, passwords);
  assert.deepEqual(upgraded, await snapshot(freshClient));
});
