// Mac `--prepare`/`--finish` bundled into a real, disposable PostgreSQL 17
// upgrade: one handoff code covers every login the role manifest still marks
// as missing, and the VPS apply path (already covered on its own by
// mac-local-database-upgrade-roles-pg17.test.mjs) creates both from it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { applyPendingMacMigrationsV1, runMacDatabaseUpgradeCommandV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";
import { captureProvisionedMacLocalConfigurationV1, finishMacLocalDatabaseUpgradeV1,
  prepareMacLocalDatabaseUpgradeV1 } from "../scripts/mac-local/provision-database.mjs";
import { MAC_LOCAL_DATABASE_ROLES_V1, captureMacLocalDatabaseRolesV1 } from "../src/web/v1/mac-local-database-roles.ts";
import { captureWorkIntakeServerConfigurationV1 } from "../src/work-intake/v1/installed-configuration.ts";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, findFreePort, needsPg, requestedPort } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const legacyMacLogins = ["control_room_web", "control_room_coordinator", "control_room_results",
  "control_room_queue_worker"];
const legacyPassword = login => `p${login.replaceAll("_", "")}`.padEnd(40, "x");
const mainCommit = "5".repeat(40);
const git = params => params[0] === "status" ? "" : mainCommit;
const state = {};

const exec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const operator = () => `host=${state.socket} port=${state.port} dbname=control_room user=postgres`;
const tcp = (user, secret) => `host=127.0.0.1 port=${state.port} dbname=control_room user=${user} password=${secret}`;

before(async () => {
  if (needsPg) return;
  state.root = await mkdtemp(join(tmpdir(), "acr-handoff-"));
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
  // A ledger-90-like fixture: applied through 0090, no publisher and no
  // work-intake role or group at all — both are new logins this upgrade adds.
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
  await state.client.query(`DROP OWNED BY control_room_work_intake_agent, control_room_work_intake;
    DROP ROLE control_room_work_intake_agent; DROP ROLE control_room_work_intake`);
  for (const login of legacyMacLogins) {
    await state.client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS PASSWORD ${state.client.escapeLiteral(legacyPassword(login))}`);
    await state.client.query(`GRANT control_room_application TO ${login}`);
  }
});

after(async () => {
  if (needsPg) return;
  try { await state.client?.end(); } catch {}
  try { await state.teardown?.stop(); } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("two missing logins bundle into one code, and the VPS upgrade creates both from it", {
  skip: needsPg,
}, async t => {
  const protectedRoot = await mkdtemp(join(tmpdir(), "mac-db-handoff-protected-"));
  t.after(() => rm(protectedRoot, { recursive: true, force: true }));
  const config = join(protectedRoot, "config"), passwords = join(config, "database-passwords");
  await mkdir(passwords, { recursive: true, mode: 0o700 });
  const web = { host: "127.0.0.1", port: state.port, database: "control_room",
    username: "control_room_web", password: legacyPassword("control_room_web"), majorVersion: 17 };
  const role = login => ({ ...web, username: login, password: legacyPassword(login) });
  const oldRoles = { schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator: role("control_room_coordinator"),
    results: role("control_room_results"), queueWorker: role("control_room_queue_worker") };
  for (const login of legacyMacLogins)
    await writeFile(join(passwords, `${login}.txt`), `${legacyPassword(login)}\n`, { mode: 0o600 });
  const mac = captureProvisionedMacLocalConfigurationV1({ database: web, ownerCode: "owner-code",
    workers: [{ workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/codex", recordedVersion: "codex 1.2.3" }] });
  await writeFile(join(config, "mac-local.json"), JSON.stringify(mac), { mode: 0o600 });
  const roleFile = join(config, "database-roles.json");
  await writeFile(roleFile, JSON.stringify(oldRoles), { mode: 0o600 });

  // Everything the CLI entry point would print to stdout for `--prepare` is
  // exactly `JSON.stringify(result)`: capture that string and prove neither
  // generated password appears in it.
  const prepared = await prepareMacLocalDatabaseUpgradeV1({ protectedRoot, mainCommit });
  const preparedOutput = JSON.stringify(prepared);
  const codes = JSON.parse(prepared.code);
  assert.deepEqual(Object.keys(codes).sort(), ["control_room_publisher", "control_room_work_intake_agent"]);
  const publisherPassword = (await readFile(join(passwords, "control_room_publisher.txt"), "utf8")).trim();
  const intakePassword = (await readFile(join(passwords, "control_room_work_intake_agent.txt"), "utf8")).trim();
  for (const secret of [publisherPassword, intakePassword])
    assert.equal(preparedOutput.includes(secret), false, "the prepare output must never contain a password");

  // The VPS apply path, exactly as cr-db-upgrade would run it, fed the one bundled code.
  const { digest } = await runMacDatabaseUpgradeCommandV1({ args: ["--plan", "--expected-main", mainCommit],
    git, openClient: () => connectTarget(operator()) });
  const applyResult = await runMacDatabaseUpgradeCommandV1({
    args: ["--apply", "--expected-main", mainCommit, "--expected-plan-digest", digest],
    readVerifier: async () => prepared.code, git, openClient: () => connectTarget(operator()),
    applyPending: () => applyPendingMacMigrationsV1(operator()) });
  assert.equal(applyResult.upgraded, true);
  for (const [login, secret] of [["control_room_publisher", publisherPassword],
    ["control_room_work_intake_agent", intakePassword]]) {
    const session = connectTarget(tcp(login, secret));
    await session.connect();
    try { assert.equal((await session.query("SELECT current_user AS role")).rows[0].role, login); }
    finally { await session.end(); }
  }

  // Finish with no `verifyLogin` override at all: it must authenticate each
  // new login over a real TCP connection to this disposable cluster before
  // writing anything for it.
  const finished = await finishMacLocalDatabaseUpgradeV1({ protectedRoot, mainCommit });
  const finishedOutput = JSON.stringify(finished);
  assert.equal(finished.finished, true);
  assert.equal(finished.nothingToFinish, undefined);
  for (const secret of [publisherPassword, intakePassword])
    assert.equal(finishedOutput.includes(secret), false, "the finish output must never contain a password");

  const changedRoles = captureMacLocalDatabaseRolesV1(JSON.parse(await readFile(roleFile, "utf8")));
  assert.equal(changedRoles.publisher.username, "control_room_publisher");
  assert.equal(changedRoles.publisher.password, publisherPassword);
  const intakeFile = join(config, "work-intake-server.json");
  const intake = captureWorkIntakeServerConfigurationV1(JSON.parse(await readFile(intakeFile, "utf8")));
  assert.equal(intake.database.username, "control_room_work_intake_agent");
  assert.equal(intake.database.password, intakePassword);
  assert.deepEqual(intake.credentials, []);

  for (const file of ["control_room_publisher.txt", "control_room_work_intake_agent.txt"])
    assert.equal((await stat(join(passwords, file))).mode & 0o777, 0o600);
  assert.equal((await stat(roleFile)).mode & 0o777, 0o600);
  assert.equal((await stat(intakeFile)).mode & 0o777, 0o600);
  assert.equal((await stat(protectedRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(config)).mode & 0o777, 0o700);
  assert.equal((await stat(passwords)).mode & 0o777, 0o700);

  // A repeat prepare/finish is now a clean no-op, not a refusal.
  assert.deepEqual(await prepareMacLocalDatabaseUpgradeV1({ protectedRoot, mainCommit }),
    { mainCommit, nothingToPrepare: true });
  assert.deepEqual(await finishMacLocalDatabaseUpgradeV1({ protectedRoot, mainCommit }),
    { finished: true, mainCommit, nothingToFinish: true });
});
