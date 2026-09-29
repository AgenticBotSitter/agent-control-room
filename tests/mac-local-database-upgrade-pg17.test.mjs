import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { applyMacDatabaseUpgradeV1, applyPendingMacMigrationsV1, inspectMacDatabaseUpgradeV1,
  macDatabaseUpgradePlanDigestV1, runMacDatabaseUpgradeCommandV1,
  sanitizedMacDatabaseUpgradeFailureV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";
import { macDatabaseUpgradeReadOnlySqlV1, planMacDatabaseUpgradeFromFileV1 } from
  "../scripts/mac-local/provision-database.mjs";
import { captureMacUpgradeSnapshotV1 } from "../scripts/mac-local/database-upgrade-snapshot.mjs";
import { planMacDatabaseUpgradeSnapshotV1 } from "../scripts/mac-local/database-upgrade-remote.mjs";
import { macRolePlan, readMacGrantCatalogV1 } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { postgresScramVerifierV1 } from "../scripts/mac-local/database-upgrade-scram.mjs";
import { fixedQueueShapeDigestForTestV1 } from "../scripts/mac-local/fixed-queue-schema.mjs";
// The shared disposable-cluster teardown. `.mjs` because
// `scripts/ops/verify-database-backup.mjs` imports it with bare `node`, and a
// `.ts` module could not be imported by one of its own callers.
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";

const oldRoot = "/private/tmp/acr-db-0085";
const headRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const oldRoles = Object.entries(macRolePlan).filter(([login]) => login !== "control_room_publisher");
const exec = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const connection = port => `host=127.0.0.1 port=${port} dbname=control_room user=postgres`;
const migrator = (port, password) => `host=127.0.0.1 port=${port} dbname=control_room user=control_room_migrator password=${password}`;

async function cluster(root, port) {
  const data = join(root, "pg"), log = join(root, "pg.log"), socket = join(root, "socket");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(socket, { mode: 0o700 });
  // Registered BEFORE initdb, and that ordering is the fix. This lane had no
  // SIGINT/SIGTERM handler at all, so a runner that stopped it at its bound, or
  // a Ctrl-C, skipped every `t.after()` and left four postmasters holding
  // 56-byte SysV shared-memory segments with dead creators. `pg_ctl start` runs
  // the postmaster with `setsid`, so it is its own session leader with PPID 1
  // and a group signal from the runner cannot reach it either. This machine has
  // 32 of those segments in total, and this one lane starts four clusters.
  const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: root,
    socketDirectory: socket, port, pgBin: undefined, removeDirectories: false });
  // The teardown is armed, and the caller's `t.after` is not registered until
  // this function RETURNS. A throw between here and there — and `initdb`,
  // `pg_hba.conf` and `pg_ctl start` all throw — would leave a live postmaster
  // with nothing that stops it, which is the exact window this whole change
  // exists to close. So a failure here stops the cluster itself.
  try {
    exec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
    await writeFile(join(data, "pg_hba.conf"), "local all postgres trust\nhost all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n");
    exec("pg_ctl", ["-D", data, "-l", log, "-w", "-o", `-p ${port} -k '${socket}' -c listen_addresses=127.0.0.1`, "start"]);
    // Retained while the cluster is up, so a teardown reached from a signal has a
    // pid even when the rest of the rehearsal is about to throw. Without it the
    // teardown has nothing to signal and the ladder never runs.
    await teardown.capturePostmasterPid();
  } catch (error) {
    // Stop what was started, then report the original failure. `stop()` may
    // itself refuse, and that refusal is attached rather than raised over the
    // top of the start failure that caused it.
    try { await teardown.stop(); }
    catch (stopError) { throw new AggregateError([error, stopError], `disposable_cluster_start_failed_and_teardown_failed: ${error?.message ?? String(error)}`); }
    throw error;
  }
  return { port, log, data, socket, teardown };
}

async function baseDatabase(root, port, suffix) {
  exec("psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f",
    join(root, "deploy/postgres/provision-database.sql")]);
  const secrets = { migrator: `m${suffix}`.repeat(36), application: `a${suffix}`.repeat(36),
    scheduler: `s${suffix}`.repeat(36), workIntake: `w${suffix}`.repeat(36) };
  await applyMigrations({ rootDir: root, ledgerPath: join(root, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: connection(port), migrateTarget: migrator(port, secrets.migrator),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator,
      CONTROL_ROOM_APP_PASSWORD: secrets.application, CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler,
      CONTROL_ROOM_WORK_INTAKE_PASSWORD: secrets.workIntake } });
  return secrets;
}

async function installOldRoles(client) {
  // Reproduce the inspected live shape: no queue schema, only the web group,
  // and all four Mac logins inheriting the broad application role.
  for (const file of ["private_web_database.sql", "private_web_roles.sql"])
    await client.query(await readFile(join(oldRoot, "db/roles", file), "utf8"));
  for (const [login, group] of oldRoles) {
    await client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD ${client.escapeLiteral("p".repeat(40) + login)}`);
    await client.query(`GRANT control_room_application TO ${login}`);
    if (login === "control_room_web") await client.query(`GRANT ${group} TO ${login}`);
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
  const queue = await fixedQueueShapeDigestForTestV1(client);
  const queueOwnership = (await client.query(`SELECT n.nspname,pg_get_userbyid(n.nspowner) AS owner
    FROM pg_namespace n WHERE n.nspname='control_room_queue'`)).rows;
  return { roles, membership, grants: [...await readMacGrantCatalogV1(client)].sort(),
    queue, queueOwnership };
}

test("live-shaped 0085 PostgreSQL 17 installation converges to fresh HEAD without changing old passwords", {
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
    // The shared ladder refuses to report success when a postmaster survives.
    // The old `catch {}` on each `pg_ctl` reported success for a cluster that
    // was still running and then removed its data directory — leaving a live
    // postmaster holding a segment and nothing left to stop it with.
    for (const item of [old, fresh]) {
      try { await item.teardown.stop(); } catch { /* the segment is the finding; report it below */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  await baseDatabase(oldRoot, old.port, "o");
  const oldClient = connectTarget(connection(old.port)); await oldClient.connect();
  clients.push(oldClient);
  await installOldRoles(oldClient);
  assert.equal(await fixedQueueShapeDigestForTestV1(oldClient), null);
  await oldClient.query("GRANT DELETE ON control_jobs TO control_room_private_web");
  const prior = await snapshot(oldClient);
  const plan = await inspectMacDatabaseUpgradeV1({ client: oldClient });
  const raw = execFileSync("psql", ["-h", "127.0.0.1", "-p", String(old.port), "-U", "postgres",
    "-d", "control_room", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
  { input: macDatabaseUpgradeReadOnlySqlV1(), encoding: "utf8", timeout: 30_000 });
  const readOnlySnapshot = JSON.parse(raw.split(/\r?\n/u).find(line => line.startsWith("{")));
  assert.deepEqual(await planMacDatabaseUpgradeSnapshotV1(readOnlySnapshot), plan);
  assert.equal(plan.installQueueSchema, true);
  assert.deepEqual(plan.createRoles, [
    "control_room_local_result_publisher", "control_room_native_queue_worker",
    "control_room_native_results", "control_room_publisher", "control_room_task_coordinator",
  ].map(role => ({ role, attributes: `${role === "control_room_publisher" ? "LOGIN" : "NOLOGIN"} INHERIT `
    + "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" })));
  assert.deepEqual(plan.membership.revoke, oldRoles.map(([member]) => ({ member,
    parent: "control_room_application" })).sort((a, b) => a.member.localeCompare(b.member)));
  assert.deepEqual(plan.membership.grant, Object.entries(macRolePlan)
    .filter(([member]) => member !== "control_room_web")
    .map(([member, parent]) => ({ member, parent })).sort((a, b) => a.member.localeCompare(b.member)));
  for (const [login] of oldRoles) {
    const broad = connectTarget(`host=127.0.0.1 port=${old.port} dbname=control_room user=${login}
      password=${"p".repeat(40) + login}`);
    await broad.connect();
    try { await broad.query("UPDATE control_jobs SET id=id WHERE false"); }
    finally { await broad.end(); }
  }
  const missingLogin = structuredClone(readOnlySnapshot);
  missingLogin.roles = missingLogin.roles.filter(role => role.rolname !== "control_room_results");
  await assert.rejects(planMacDatabaseUpgradeSnapshotV1(missingLogin), /upgrade_existing_role_missing/u);
  const changedLogin = structuredClone(readOnlySnapshot);
  changedLogin.roles.find(role => role.rolname === "control_room_results").rolcreatedb = true;
  await assert.rejects(planMacDatabaseUpgradeSnapshotV1(changedLogin), /upgrade_role_attributes_refused/u);
  const outsideMember = structuredClone(readOnlySnapshot);
  outsideMember.memberships.push({ member: "control_room_app", parent: "control_room_private_web",
    admin_option: false, inherit_option: true, set_option: true });
  await assert.rejects(planMacDatabaseUpgradeSnapshotV1(outsideMember), /upgrade_non_login_membership_refused/u);
  const unexpectedParent = structuredClone(readOnlySnapshot);
  unexpectedParent.memberships.push({ member: "control_room_results", parent: "control_room_backup",
    admin_option: false, inherit_option: true, set_option: true });
  await assert.rejects(planMacDatabaseUpgradeSnapshotV1(unexpectedParent),
    /upgrade_unexpected_login_membership_refused/u);
  const snapshotFile = join(root, "snapshot.json"), mainCommit = "a".repeat(40);
  await writeFile(snapshotFile, JSON.stringify(captureMacUpgradeSnapshotV1(mainCommit, raw)));
  assert.deepEqual(await planMacDatabaseUpgradeFromFileV1(snapshotFile, mainCommit), plan);
  assert.equal(plan.pendingMigrations.length, 5);
  assert.ok(plan.createRoles.some(item => item.role === "control_room_publisher"));
  assert.ok(plan.grants.extra.some(item => item.includes("control_room_private_web|table|public.control_jobs||DELETE|plain")));
  assert.deepEqual(await snapshot(oldClient), prior, "dry run does not change PostgreSQL");
  const publisherPassword = "q".repeat(40);
  const request = { client: oldClient, publisherVerifier: postgresScramVerifierV1(publisherPassword) };
  await assert.rejects(applyMacDatabaseUpgradeV1(request), /upgrade_pending_migrations_need_peer_runner/u);
  const retainedLogins = ["control_room_migrator", "control_room_app", "control_room_scheduler",
    ...oldRoles.map(([login]) => login)];
  const passwordSnapshot = async () => (await oldClient.query(`SELECT rolname,rolpassword FROM pg_authid
    WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [retainedLogins])).rows;
  const otherMemberships = async () => (await oldClient.query(`SELECT member.rolname AS member,
    parent.rolname AS parent, auth.admin_option, auth.inherit_option, auth.set_option
    FROM pg_auth_members auth JOIN pg_roles member ON member.oid=auth.member
    JOIN pg_roles parent ON parent.oid=auth.roleid
    WHERE member.rolname <> ALL($1::text[]) ORDER BY member.rolname,parent.rolname`,
  [Object.keys(macRolePlan)])).rows;
  const beforePasswords = await passwordSnapshot();
  const beforeOtherMemberships = await otherMemberships();
  assert.equal(beforePasswords.length, 7);
  const localPeer = `host=${old.socket} port=${old.port} dbname=control_room user=postgres`;
  await assert.rejects(applyMacDatabaseUpgradeV1({ ...request,
    expectedPlanDigest: `sha256:${"0".repeat(64)}` }), /upgrade_plan_changed_refused/u);
  let failureStage = "plan";
  const simulatedSqlError = Object.assign(new Error("private diagnostic must not print"), { code: "42501" });
  await assert.rejects(runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", mainCommit,
      "--expected-plan-digest", macDatabaseUpgradePlanDigestV1(plan)],
    readVerifier: async () => `${request.publisherVerifier}\n`,
    git: params => params[0] === "status" ? "" : mainCommit,
    openClient: () => connectTarget(connection(old.port)),
    applyPending: async () => { throw simulatedSqlError; },
    onStage: stage => { failureStage = stage; },
  }), error => error === simulatedSqlError);
  assert.equal(failureStage, "migrate");
  assert.deepEqual(await inspectMacDatabaseUpgradeV1({ client: oldClient }), plan,
    "a failure before migrations leaves the approved plan unchanged");
  const cli = await runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", mainCommit,
      "--expected-plan-digest", macDatabaseUpgradePlanDigestV1(plan)],
    readVerifier: async () => `${request.publisherVerifier}\n`,
    git: params => params[0] === "status" ? "" : mainCommit,
    openClient: () => connectTarget(connection(old.port)),
    applyPending: () => applyPendingMacMigrationsV1(localPeer),
  });
  assert.equal(cli.upgraded, true);
  assert.deepEqual(await passwordSnapshot(), beforePasswords,
    "migrator, app, scheduler and four existing login password verifiers are byte-identical");
  assert.deepEqual(await otherMemberships(), beforeOtherMemberships,
    "no non-Mac role membership is changed by the upgrade");
  for (const [login, password] of [...oldRoles.map(([name]) => [name, "p".repeat(40) + name]),
    ["control_room_publisher", publisherPassword]]) {
    const restricted = connectTarget(`host=127.0.0.1 port=${old.port} dbname=control_room user=${login} password=${password}`);
    await restricted.connect();
    try {
      await assert.rejects(restricted.query("UPDATE control_jobs SET id=id WHERE false"),
        error => error.code === "42501", `${login} must not update a forbidden job column`);
    } finally { await restricted.end(); }
  }
  const publisher = connectTarget(`host=127.0.0.1 port=${old.port} dbname=control_room user=control_room_publisher password=${publisherPassword}`);
  await publisher.connect();
  assert.equal((await publisher.query("SELECT current_user AS role")).rows[0].role, "control_room_publisher");
  await publisher.end();
  const upgraded = await snapshot(oldClient);
  assert.equal(upgraded.queue,
    "sha256:e7286b89b0c60f826438b2c49570897c9e3bdb90d534cc5acc5c9b2c0f09e25d");
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

test("post-incident ledger 90 with old memberships needs only the role and grant transaction", {
  skip: process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL !== "1",
  timeout: 240_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-ledger90-"));
  const live = await cluster(root, 15583);
  const client = connectTarget(connection(live.port));
  t.after(async () => {
    try { await client.end(); } catch {}
    try { await live.teardown.stop(); } catch { /* the segment is the finding; report it below */ }
    await rm(root, { recursive: true, force: true });
  });
  await baseDatabase(oldRoot, live.port, "n");
  await client.connect();
  await installOldRoles(client);
  const peer = `host=${live.socket} port=${live.port} dbname=control_room user=postgres`;
  await applyPendingMacMigrationsV1(peer);
  const before = await inspectMacDatabaseUpgradeV1({ client });
  assert.deepEqual(before.pendingMigrations, []);
  assert.equal(before.installQueueSchema, true);
  assert.equal(before.createRoles.length, 5);
  assert.equal(before.membership.revoke.length, 4);
  const oldVerifiers = (await client.query(`SELECT rolname,rolpassword FROM pg_authid
    WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [
    ["control_room_migrator", "control_room_app", "control_room_scheduler", ...oldRoles.map(([name]) => name)],
  ])).rows;
  let pendingCalled = false;
  const stages = [];
  const mainCommit = "b".repeat(40);
  const result = await runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", mainCommit,
      "--expected-plan-digest", macDatabaseUpgradePlanDigestV1(before)],
    readVerifier: async () => `${postgresScramVerifierV1("z".repeat(40))}\n`,
    git: params => params[0] === "status" ? "" : mainCommit,
    openClient: () => connectTarget(connection(live.port)),
    applyPending: () => { pendingCalled = true; throw new Error("unexpected_migration"); },
    onStage: stage => stages.push(stage),
  });
  assert.equal(pendingCalled, false);
  assert.ok(stages.includes("queue"));
  assert.equal(stages.at(-1), "verify");
  assert.deepEqual(result.after, { pendingMigrations: [], installQueueSchema: false, createRoles: [],
    membership: { grant: [], revoke: [] }, grants: { extra: [], missing: [] } });
  assert.deepEqual((await client.query(`SELECT rolname,rolpassword FROM pg_authid
    WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [oldVerifiers.map(row => row.rolname)])).rows,
  oldVerifiers);
  for (const [login, password] of [...oldRoles.map(([name]) => [name, "p".repeat(40) + name]),
    ["control_room_publisher", "z".repeat(40)]]) {
    const restricted = connectTarget(`host=127.0.0.1 port=${live.port} dbname=control_room user=${login} password=${password}`);
    await restricted.connect();
    try {
      await assert.rejects(restricted.query("UPDATE control_jobs SET id=id WHERE false"),
        error => error.code === "42501");
    } finally { await restricted.end(); }
  }
  await client.query("UPDATE control_room_queue.queue SET retry_limit=1 WHERE name='native-task-delivery'");
  await assert.rejects(inspectMacDatabaseUpgradeV1({ client }), /upgrade_queue_shape_refused/u,
    "an altered existing queue may not be adopted");
  await client.query("UPDATE control_room_queue.queue SET retry_limit=0 WHERE name='native-task-delivery'");
  await client.query("GRANT USAGE ON SCHEMA control_room_queue TO control_room_application");
  await assert.rejects(inspectMacDatabaseUpgradeV1({ client }), /upgrade_queue_shape_refused/u,
    "an extra non-Mac queue grant may not be adopted");
  await client.query("REVOKE USAGE ON SCHEMA control_room_queue FROM control_room_application");
  assert.equal((await inspectMacDatabaseUpgradeV1({ client })).installQueueSchema, false);
});

test("a post-install queue shape mismatch removes only this empty new schema and permits a clean retry", {
  skip: process.env.CONTROL_ROOM_PG17_UPGRADE_REHEARSAL !== "1",
  timeout: 240_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-db-queue-rollback-"));
  const local = await cluster(root, 15584);
  const client = connectTarget(connection(local.port));
  t.after(async () => {
    try { await client.end(); } catch {}
    try { await local.teardown.stop(); } catch { /* the segment is the finding; report it below */ }
    await rm(root, { recursive: true, force: true });
  });
  await baseDatabase(oldRoot, local.port, "r");
  await client.connect();
  await installOldRoles(client);
  await applyPendingMacMigrationsV1(`host=${local.socket} port=${local.port} dbname=control_room user=postgres`);
  const plan = await inspectMacDatabaseUpgradeV1({ client });
  assert.equal(plan.installQueueSchema, true);
  assert.deepEqual(plan.pendingMigrations, []);
  let altered = false;
  const mismatchedCatalogClient = {
    query: async (sql, values) => {
      const result = await client.query(sql, values);
      if (!altered && typeof sql === "string" && sql.includes("pg_get_functiondef(p.oid)")) {
        altered = true;
        return { ...result, rows: result.rows.map((row, index) => index === 0
          ? { ...row, definition: `${row.definition}\n-- simulated PG17 formatting difference` } : row) };
      }
      return result;
    },
    escapeLiteral: value => client.escapeLiteral(value),
  };
  let stage = "plan";
  const request = { publisherVerifier: postgresScramVerifierV1("r".repeat(40)),
    expectedPlanDigest: macDatabaseUpgradePlanDigestV1(plan), onStage: next => { stage = next; } };
  await assert.rejects(applyMacDatabaseUpgradeV1({ ...request, client: mismatchedCatalogClient }), error => {
    assert.match(error.message, /upgrade_queue_shape_refused/u);
    assert.match(sanitizedMacDatabaseUpgradeFailureV1(error, stage),
      /^upgrade_error:upgrade_queue_shape_refused stage=queue /u);
    return true;
  });
  assert.equal(altered, true);
  assert.equal(stage, "queue");
  assert.equal(await fixedQueueShapeDigestForTestV1(client), null, "failed attempt leaves no queue schema");
  assert.deepEqual(await inspectMacDatabaseUpgradeV1({ client }), plan,
    "the original reviewed plan remains valid after cleanup");
  const retry = await applyMacDatabaseUpgradeV1({ ...request, client });
  assert.equal(retry.after.installQueueSchema, false);
  assert.equal((await inspectMacDatabaseUpgradeV1({ client })).installQueueSchema, false);

  // A job arriving before cleanup must prevent removal, even on this
  // disposable cluster. The operator then receives a distinct stop reason.
  await client.query("DROP SCHEMA control_room_queue CASCADE");
  const occupiedPlan = await inspectMacDatabaseUpgradeV1({ client });
  let inserted = false;
  const occupiedClient = {
    query: async (sql, values) => {
      const result = await client.query(sql, values);
      if (!inserted && typeof sql === "string" && sql.includes("pg_get_functiondef(p.oid)")) {
        inserted = true;
        await client.query(`INSERT INTO control_room_queue.job(name,data)
          VALUES ('native-task-delivery','{}'::jsonb)`);
        return { ...result, rows: result.rows.map((row, index) => index === 0
          ? { ...row, definition: `${row.definition}\n-- simulated mismatch` } : row) };
      }
      return result;
    },
    escapeLiteral: value => client.escapeLiteral(value),
  };
  await assert.rejects(applyMacDatabaseUpgradeV1({ ...request, client: occupiedClient,
    expectedPlanDigest: macDatabaseUpgradePlanDigestV1(occupiedPlan) }),
  /upgrade_queue_cleanup_refused/u);
  assert.equal(inserted, true);
  assert.equal((await client.query("SELECT count(*)::int AS count FROM control_room_queue.job")).rows[0].count, 1);
  assert.notEqual(await fixedQueueShapeDigestForTestV1(client), null,
    "a queue with a job cannot be removed by failure cleanup");
});
