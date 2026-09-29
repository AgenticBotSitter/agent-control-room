// The one VPS command of a live upgrade, `deploy/vps/cr-db-upgrade`, run for
// real against a disposable PostgreSQL 17: a real terminal (a pty), a real git
// source whose origin/main moves, a real offline dependency install and a real
// pg_dump backup. Only its paths are pointed at a temporary test root; that is
// honoured only when the caller is not root.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { connectTarget } from "../deploy/postgres/evidence.mjs";
import { inspectMacDatabaseUpgradeV1 } from "../scripts/mac-local/database-upgrade-remote.mjs";
import { postgresScramVerifierV1 } from "../scripts/mac-local/database-upgrade-scram.mjs";
import { createMacLocalDatabaseBackupV1 } from "../scripts/ops/backup-database.mjs";
import { verifyMacLocalDatabaseBackupV1 } from "../scripts/ops/verify-database-backup.mjs";
import { macDatabaseUpgradePlanIsEmptyV1, plainMacDatabaseUpgradePlanWordsV1 } from
  "../scripts/mac-local/database-upgrade-vps-step.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, findFreePort, needsPg, requestedPort } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const wrapper = join(repoRoot, "deploy/vps/cr-db-upgrade");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const skip = needsPg || (hasPython ? false : "needs python3 for a real terminal");
const legacyMacLogins = ["control_room_web", "control_room_coordinator", "control_room_results",
  "control_room_queue_worker"];
const password = login => `p${login.replaceAll("_", "")}`.padEnd(40, "x");
const publisherPassword = "q".repeat(40), intakePassword = "w".repeat(40);
const codes = {};
const state = {};
const operator = () => `host=${state.socket} port=${state.port} dbname=control_room user=postgres`;
const tcp = (user, secret) => `host=127.0.0.1 port=${state.port} dbname=control_room user=${user} password=${secret}`;
const pgExec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
const head = () => git(state.upstream, "rev-parse", "HEAD");
const sql = async (text, values) => (await state.client.query(text, values)).rows;

// A pty in front of the wrapper, so `[ -t 0 ]` is really true and answers are
// typed only after their prompt appears, exactly as an operator would.
const ptyRelay = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
inputs = [fd, 0]
while True:
    ready = select.select(inputs, [], [])[0]
    if 0 in ready:
        data = os.read(0, 4096)
        if data: os.write(fd, data)
        else: inputs.remove(0)
    if fd in ready:
        try: data = os.read(fd, 4096)
        except OSError: data = b""
        if not data: break
        os.write(1, data)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))`;

function upgrade(args, { tty = true, env = {}, answers = [], testRoot = true } = {}) {
  const base = { ...process.env, CR_UPGRADE_TEST_ROOT: state.vps, CR_UPGRADE_TEST_STORE: state.store,
    CR_UPGRADE_TEST_PG_BIN: PG_BIN, CR_UPGRADE_TEST_PG_TARGET: operator(), ...env };
  if (!testRoot) delete base.CR_UPGRADE_TEST_ROOT;
  const child = tty ? spawn("python3", ["-c", ptyRelay, wrapper, ...args], { env: base })
    : spawn(wrapper, args, { env: base });
  if (!tty) child.stdin.end();
  return new Promise((resolvePromise, rejectPromise) => {
    const reject = error => { child.kill("SIGKILL"); rejectPromise(error); };
    const timer = setTimeout(() => reject(new Error(`wrapper still running; output so far:\n${output}`)), 120_000);
    let output = "", seen = 0, busy = false;
    const pending = [...answers];
    const answer = async () => {
      if (busy || !pending.length || !pending[0][0].test(output.slice(seen))) return;
      busy = true;
      const [, text, hook] = pending.shift();
      seen = output.length;
      if (hook) await hook();
      child.stdin.write(text);
      busy = false;
      await answer();
    };
    const collect = chunk => { output += String(chunk); answer().catch(reject); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); child.stdin.destroy(); resolvePromise({ code, output: output.replaceAll("\r", "") }); });
  });
}

const codePrompt = /Paste the login code/u, applyPrompt = /Apply\? \[y\/N\] $/u;
const approve = (code, hook) => [[codePrompt, `${code}\n`], [applyPrompt, "y\n", hook]];

async function catalog() {
  return {
    roles: await sql(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
      rolbypassrls,rolpassword FROM pg_authid WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`),
    memberships: await sql(`SELECT member.rolname AS member,parent.rolname AS parent FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member ORDER BY 1,2`),
    tables: await sql(`SELECT n.nspname,c.relname,c.relacl::text AS acl FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','control_room_queue') ORDER BY 1,2`),
    ledger: await sql("SELECT filename,digest FROM control_room_schema_migrations ORDER BY ledger_order"),
  };
}
const stages = async () => (await readdir(join(state.vps, "stages"))).sort();
const backups = async () => (await readdir(join(state.vps, "backups"))).sort();

/** Asserts a refusal: the exact sanitized code, and nothing written anywhere. */
async function refused(run, code, stage, baseline) {
  const beforeCatalog = await catalog(), beforeBackups = await backups();
  const { code: exit, output } = await run();
  assert.notEqual(exit, 0, output);
  assert.match(output, new RegExp(`upgrade_error:${code} stage=${stage}`, "u"), output);
  assert.doesNotMatch(output, /DONE /u);
  assert.deepEqual(await catalog(), baseline?.() ?? beforeCatalog, "a refusal changes nothing");
  assert.deepEqual(await backups(), beforeBackups, "a refusal keeps no backup");
  assert.deepEqual(await stages(), ["cr-upgrade.keep"], "only its own stage directory is removed");
  assertNoSecret(output);
  return output;
}
function assertNoSecret(output) {
  for (const secret of [publisherPassword, intakePassword, ...legacyMacLogins.map(password),
    codes.publisher, codes.intake, codes.both, "SCRAM-SHA-256"]) assert.equal(output.includes(secret), false);
}

before(async () => {
  if (skip) return;
  state.root = await mkdtemp(join(tmpdir(), "acr-vps-"));
  state.port = requestedPort() ?? await findFreePort();
  const data = join(state.root, "pg");
  state.socket = join(state.root, "s");
  await mkdir(state.socket, { mode: 0o700 });
  state.teardown = createClusterTeardown({ dataDirectory: data, runDirectory: state.root,
    socketDirectory: state.socket, port: state.port, pgBin: PG_BIN, removeDirectories: false });
  pgExec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await writeFile(join(data, "pg_hba.conf"), "local all postgres trust\nhost all postgres 127.0.0.1/32 trust\n"
    + "host all all 127.0.0.1/32 scram-sha-256\n");
  pgExec("pg_ctl", ["-D", data, "-l", join(state.root, "pg.log"), "-w", "-o",
    `-p ${state.port} -k '${state.socket}' -c listen_addresses=127.0.0.1`, "start"]);
  await state.teardown.capturePostmasterPid();
  pgExec("psql", ["-h", "127.0.0.1", "-p", String(state.port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  // The live database's shape: ledger up to 0090, the four Mac logins still on
  // control_room_application, and neither the work-intake roles nor the publisher.
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
  await sql(`DROP OWNED BY control_room_work_intake_agent, control_room_work_intake;
    DROP ROLE control_room_work_intake_agent; DROP ROLE control_room_work_intake`);
  for (const login of legacyMacLogins) {
    await sql(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD ${state.client.escapeLiteral(password(login))}`);
    await sql(`GRANT control_room_application TO ${login}`);
  }
  codes.publisher = postgresScramVerifierV1(publisherPassword);
  codes.intake = postgresScramVerifierV1(intakePassword);
  codes.both = JSON.stringify({ control_room_publisher: codes.publisher, control_room_work_intake_agent: codes.intake });
  // GitHub stands in as `upstream`; the VPS's own clone of it is `source`.
  state.upstream = join(state.root, "upstream");
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--no-local", `file://${repoRoot}`, state.upstream]);
  const changed = git(repoRoot, "ls-files", "--modified", "--others", "--exclude-standard").split("\n").filter(Boolean);
  for (const file of changed) {
    if (existsSync(join(repoRoot, file))) {
      await mkdir(dirname(join(state.upstream, file)), { recursive: true });
      await cp(join(repoRoot, file), join(state.upstream, file));
    } else await rm(join(state.upstream, file), { force: true });
  }
  git(state.upstream, "checkout", "--quiet", "-B", "main");
  git(state.upstream, "add", "-A");
  git(state.upstream, "commit", "--quiet", "--allow-empty", "-m", "code under test");
  state.vps = join(state.root, "vps");
  for (const directory of ["stages/cr-upgrade.keep", "backups"]) {
    await mkdir(join(state.vps, directory), { recursive: true, mode: 0o755 });
  }
  execFileSync("git", ["clone", "--quiet", "--no-local", state.upstream, join(state.vps, "source")]);
  state.store = execFileSync("pnpm", ["store", "path"], { cwd: repoRoot, encoding: "utf8" }).trim();
});

after(async () => {
  if (skip) return;
  try { await state.client?.end(); } catch {}
  try { await state.teardown?.stop(); } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("the plan reads in plain words and an empty plan is nothing to do", () => {
  const plan = { pendingMigrations: ["db/migrations/0091_a.sql", "db/migrations/0092_b.sql", "db/migrations/0104_c.sql"],
    installQueueSchema: true, createRoles: [{ role: "control_room_work_intake" },
      { role: "control_room_publisher" }, { role: "control_room_work_intake_agent" }],
    membership: { grant: [{}, {}], revoke: [{}] }, grants: { extra: [{}], missing: [{}, {}, {}] } };
  assert.equal(plainMacDatabaseUpgradePlanWordsV1(plan), "3 migrations: 0091…0104 · queue tables: install"
    + " · new groups: 1 · new logins: 2 (control_room_publisher, control_room_work_intake_agent)"
    + " · membership changes: 3 · permission changes: 4");
  assert.equal(macDatabaseUpgradePlanIsEmptyV1(plan), false);
  assert.equal(macDatabaseUpgradePlanIsEmptyV1({ pendingMigrations: [], installQueueSchema: false, createRoles: [],
    membership: { grant: [], revoke: [] }, grants: { extra: [], missing: [] } }), true);
});

test("the offline upgrade tools are pinned to exactly the app's pg and pg-boss", async () => {
  const tool = JSON.parse(await readFile(join(repoRoot, "deploy/vps/upgrade-tool/package.json"), "utf8"));
  const app = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(tool.dependencies, { pg: app.dependencies.pg, "pg-boss": app.dependencies["pg-boss"] });
  const appLock = await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const pins = (await readFile(join(repoRoot, "deploy/vps/upgrade-tool/pnpm-lock.yaml"), "utf8"))
    .match(/integrity: sha512-[A-Za-z0-9+/=]+/gu);
  assert.ok(pins.length >= 2);
  for (const pin of pins) assert.ok(appLock.includes(pin), `${pin} is the same tarball the app installs`);
});

test("database code from main runs only through the postgres account", async () => {
  const source = await readFile(wrapper, "utf8");
  assert.match(source, /runuser -u postgres --/u);
  const nodeLines = source.split("\n").filter(line => /\bnode\b/u.test(line) && !/^\s*#/u.test(line));
  assert.ok(nodeLines.length > 0);
  for (const line of nodeLines) assert.match(line, /^\s*as_postgres /u, line);
});

test("refuses when not root, and when input is piped instead of typed", { skip }, async () => {
  if (process.getuid?.() !== 0)
    await refused(() => upgrade([head().slice(0, 7)], { tty: false, testRoot: false }), "upgrade_not_root", "start");
  const output = await refused(() => upgrade([head().slice(0, 7)], { tty: false }), "upgrade_terminal_required", "start");
  assert.match(output, /real terminal/u);
  await refused(() => upgrade(["--refresh-cache", head().slice(0, 7)], { tty: false }),
    "upgrade_terminal_required", "start");
});

test("refuses while another run holds the lock", { skip }, async () => {
  const holder = spawn("perl", ["-MFcntl=:flock", "-e",
    "open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print qq(locked\\n); sleep 120",
    join(state.vps, "upgrade.lock")]);
  try {
    await new Promise(ready => holder.stdout.once("data", ready));
    await refused(() => upgrade([head().slice(0, 7)]), "upgrade_lock_held", "lock");
  } finally { holder.kill(); }
});

test("refuses when main moved after the Mac built, naming the new commit", { skip }, async () => {
  const built = head();
  git(state.upstream, "commit", "--quiet", "--allow-empty", "-m", "merged meanwhile");
  const output = await refused(() => upgrade([built.slice(0, 7)]), "upgrade_main_moved", "commit");
  assert.match(output, new RegExp(`main moved to ${head().slice(0, 7)} — rerun mac:upgrade`, "u"));
});

test("refuses a cache miss and names the one-off --refresh-cache step", { skip }, async () => {
  const empty = await mkdtemp(join(state.root, "store-"));
  const output = await refused(() => upgrade([head().slice(0, 7)], { env: { CR_UPGRADE_TEST_STORE: empty } }),
    "upgrade_dependency_cache_missing", "dependencies");
  assert.match(output, new RegExp(`cr-db-upgrade --refresh-cache ${head().slice(0, 7)}`, "u"));
  const untouched = await mkdtemp(join(state.root, "store-"));
  await refused(() => upgrade(["--refresh-cache", head().slice(0, 7)], { env: { CR_UPGRADE_TEST_STORE: untouched },
    answers: [[/Download\? \[y\/N\] $/u, "\n"]] }), "upgrade_not_approved", "dependencies");
  assert.deepEqual(await readdir(untouched), [], "nothing is downloaded without a separate yes");
});

test("refuses while any Mac login is still connected", { skip }, async () => {
  const mac = connectTarget(tcp("control_room_web", password("control_room_web")));
  await mac.connect();
  try {
    const output = await refused(() => upgrade([head().slice(0, 7)]), "upgrade_mac_login_connected", "check");
    assert.match(output, /control_room_web/u);
  } finally { await mac.end(); }
});

test("refuses when the backup disk has less than twice the database size free", { skip }, async () => {
  await refused(() => upgrade([head().slice(0, 7)], { env: { CR_UPGRADE_TEST_DISK_FACTOR: "1000000000" } }),
    "upgrade_disk_space_low", "check");
});

test("refuses a drifted ledger, a changed ledger file and a drifted live schema", { skip }, async () => {
  const [last] = await sql(`SELECT ledger_order, digest FROM control_room_schema_migrations
    ORDER BY ledger_order DESC LIMIT 1`);
  await sql("ALTER TABLE control_room_schema_migrations DISABLE TRIGGER USER");
  await sql(`UPDATE control_room_schema_migrations SET digest=$1 WHERE ledger_order=$2`,
    [`sha256:${"0".repeat(64)}`, last.ledger_order]);
  try { await refused(() => upgrade([head().slice(0, 7)]), "upgrade_ledger_prefix_refused", "plan"); }
  finally {
    await sql(`UPDATE control_room_schema_migrations SET digest=$1 WHERE ledger_order=$2`, [last.digest, last.ledger_order]);
    await sql("ALTER TABLE control_room_schema_migrations ENABLE TRIGGER USER");
  }
  const migration = join(state.upstream, "db/migrations",
    (await readdir(join(state.upstream, "db/migrations"))).find(file => file.startsWith("0001")));
  await writeFile(migration, `${await readFile(migration, "utf8")}\n-- edited after review\n`);
  git(state.upstream, "commit", "--quiet", "-am", "edit an applied migration");
  try { await refused(() => upgrade([head().slice(0, 7)]), "upgrade_source_ledger_refused", "plan"); }
  finally { git(state.upstream, "revert", "--quiet", "--no-edit", "HEAD"); }
  await sql("CREATE TABLE public.drift_outside_the_ledger (id int)");
  try { await refused(() => upgrade([head().slice(0, 7)]), "upgrade_schema_drift_refused", "check"); }
  finally { await sql("DROP TABLE public.drift_outside_the_ledger"); }
});

test("refuses unexpected role attributes, memberships and default grants", { skip }, async () => {
  for (const [change, undo, code] of [
    ["ALTER ROLE control_room_web CREATEDB", "ALTER ROLE control_room_web NOCREATEDB", "upgrade_role_attributes_refused"],
    ["GRANT control_room_reader TO control_room_web", "REVOKE control_room_reader FROM control_room_web",
      "upgrade_unexpected_login_membership_refused"],
    ["ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO control_room_web",
      "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM control_room_web", "upgrade_unexpected_default_grant"],
  ]) {
    await sql(change);
    try { await refused(() => upgrade([head().slice(0, 7)]), code, "plan"); } finally { await sql(undo); }
  }
});

test("refuses a planned new login with no code, or with the wrong code, before any backup", { skip }, async () => {
  const output = await refused(() => upgrade([head().slice(0, 7)], { answers: [[codePrompt, "\n"]] }),
    "upgrade_new_login_needs_verifier", "approve");
  assert.match(output, /new logins: 2 \(control_room_publisher, control_room_work_intake_agent\)/u);
  const partial = await refused(() => upgrade([head().slice(0, 7)], { answers: approve(codes.publisher) }),
    "upgrade_new_login_needs_verifier", "plan");
  assert.match(partial, /does not cover every new login/u);
  await refused(() => upgrade([head().slice(0, 7)], { answers: approve("not-a-login-code") }),
    "upgrade_scram_verifier_refused", "plan");
});

test("a no at the prompt, a dirty stage, or a plan that changed after approval changes nothing", { skip }, async () => {
  await refused(() => upgrade([head().slice(0, 7)], { answers: [[codePrompt, `${codes.both}\n`], [applyPrompt, "n\n"]] }),
    "upgrade_not_approved", "approve");
  const dirty = async () => {
    const [stage] = (await stages()).filter(name => name !== "cr-upgrade.keep");
    await writeFile(join(state.vps, "stages", stage, "src", "package.json"), "{}\n");
  };
  await refused(() => upgrade([head().slice(0, 7)], { answers: approve(codes.both, dirty) }),
    "upgrade_stage_dirty", "apply");
  let changed;
  const inject = async () => { await sql("GRANT SELECT ON control_jobs TO control_room_web"); changed = await catalog(); };
  try {
    await refused(() => upgrade([head().slice(0, 7)], { answers: approve(codes.both, inject) }),
      "upgrade_plan_changed_refused", "plan", () => changed);
  } finally { await sql("REVOKE SELECT ON control_jobs FROM control_room_web"); }
});

test("refuses when the backup fails, and writes nothing", { skip }, async () => {
  const noTools = await mkdtemp(join(state.root, "no-pg-dump-"));
  const output = await refused(() => upgrade([head().slice(0, 7)], { env: { CR_UPGRADE_TEST_PG_BIN: noTools },
    answers: approve(codes.both) }), "upgrade_backup_failed", "backup");
  assert.match(output, /Nothing was changed/u);
});

test("refuses to stage under a folder another account could change", { skip }, async () => {
  const stageParent = join(state.vps, "stages");
  // A no-code answer ends a run that wrongly gets past the check, so it fails fast.
  const run = () => upgrade([head().slice(0, 7)], { answers: [[codePrompt, "\n"]] });
  for (const [dir, mode] of [[stageParent, 0o777], [stageParent, 0o775], [state.vps, 0o1777]]) {
    await chmod(dir, mode);
    try {
      const output = await refused(run, "upgrade_stage_unsafe", "stage");
      assert.match(output, /another account could change/u);
    } finally { await chmod(dir, 0o755); }
  }
  // Owned by another account (root): the stage parent is a link to "/".
  await rename(stageParent, `${stageParent}.real`);
  await symlink("/", stageParent);
  try {
    const { code, output } = await run();
    assert.notEqual(code, 0, output);
    assert.match(output, /upgrade_error:upgrade_stage_unsafe stage=stage/u, output);
  } finally { await rm(stageParent); await rename(`${stageParent}.real`, stageParent); }
  assert.deepEqual(await stages(), ["cr-upgrade.keep"]);
  // A missing stage parent is created passable but not listable by others.
  const fresh = await mkdtemp(join(state.root, "fresh-"));
  await symlink(join(state.vps, "source"), join(fresh, "source"));
  const { output } = await upgrade(["--refresh-cache", head().slice(0, 7)], { env: { CR_UPGRADE_TEST_ROOT: fresh },
    answers: [[/Download\? \[y\/N\] $/u, "\n"]] });
  assert.match(output, /upgrade_error:upgrade_not_approved stage=dependencies/u, output);
  assert.equal((await stat(join(fresh, "stages"))).mode & 0o7777, 0o711);
  assert.deepEqual(await readdir(join(fresh, "stages")), []);
});

test("a pnpm workspace or pnpmfile planted above the stage never runs, and the manifest cannot switch pnpm",
  { skip }, async () => {
    const stageParent = join(state.vps, "stages"), marker = join(state.root, "planted-code-ran");
    const planted = ["pnpm-workspace.yaml", ".pnpmfile.cjs"];
    await writeFile(join(stageParent, planted[0]), 'packages: ["*"]\n');
    await writeFile(join(stageParent, planted[1]),
      `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\nmodule.exports = {};\n`);
    // A pnpm version that does not exist: any attempt to switch to it fails the run.
    const tool = join(state.upstream, "deploy/vps/upgrade-tool/package.json");
    await writeFile(tool, JSON.stringify({ ...JSON.parse(await readFile(tool, "utf8")), packageManager: "pnpm@99.99.99" }));
    git(state.upstream, "commit", "--quiet", "-am", "name another pnpm");
    const beforeCatalog = await catalog(), beforeBackups = await backups();
    try {
      const declined = await upgrade([head().slice(0, 7)], { answers: [[codePrompt, `${codes.both}\n`],
        [applyPrompt, "n\n"]] });
      assert.equal(existsSync(marker), false, "the planted pnpmfile ran during the install");
      assert.match(declined.output, /upgrade_error:upgrade_not_approved stage=approve/u, declined.output);
      const refreshed = await upgrade(["--refresh-cache", head().slice(0, 7)],
        { answers: [[/Download\? \[y\/N\] $/u, "y\n"]] });
      assert.equal(existsSync(marker), false, "the planted pnpmfile ran during the download");
      assert.equal(refreshed.code, 0, refreshed.output);
      assert.match(refreshed.output, /Upgrade tools cached/u);
    } finally {
      for (const file of planted) await rm(join(stageParent, file), { force: true });
      git(state.upstream, "revert", "--quiet", "--no-edit", "HEAD");
    }
    assert.deepEqual(await catalog(), beforeCatalog);
    assert.deepEqual(await backups(), beforeBackups);
    assert.deepEqual(await stages(), ["cr-upgrade.keep"]);
});

test("rehearsal refuses without an intact bound backup before it starts PostgreSQL", { skip }, async () => {
  assert.deepEqual(await backups(), [], "this comes before any upgrade test creates a backup");
  const output = await refused(() => upgrade(["--rehearse", head().slice(0, 7)]),
    "upgrade_rehearse_no_verified_backup", "rehearse");
  assert.match(output, /Create and verify a backup first/u);
});

test("rehearsal refuses when its throwaway port is busy before it reads a backup", { skip }, async () => {
  const port = await findFreePort();
  const holder = createServer();
  await new Promise((resolvePort, rejectPort) => {
    holder.once("error", rejectPort);
    holder.listen(port, "127.0.0.1", resolvePort);
  });
  try {
    const output = await refused(() => upgrade(["--rehearse", head().slice(0, 7)],
      { env: { CR_UPGRADE_TEST_REHEARSE_PORT: String(port) } }), "upgrade_rehearse_port_busy", "rehearse");
    assert.match(output, /throwaway database port is busy/u);
  } finally { await new Promise(resolveClose => holder.close(resolveClose)); }
});

test("rehearsal restores and upgrades only a throwaway cluster, leaving the live data and port alone", { skip }, async () => {
  const out = join(state.vps, "backups", "pre-rehearsal-fixture");
  await createMacLocalDatabaseBackupV1({ source: operator(), out, pgBin: PG_BIN });
  const beforeCatalog = await catalog(), beforeBackups = await backups();
  const livePid = await readFile(join(state.root, "pg", "postmaster.pid"), "utf8");
  const wrapperSource = await readFile(wrapper, "utf8");
  const { code, output } = await upgrade(["--rehearse", head().slice(0, 7)], {
    // A live target that cannot connect proves the rehearsal branch never uses
    // the conventional live target, while the fixture's real cluster stays up.
    env: { CR_UPGRADE_TEST_PG_TARGET: "host=127.0.0.1 port=1 dbname=control_room user=postgres" },
  });
  assert.equal(code, 0, output);
  assert.match(output, new RegExp(`REHEARSAL DONE ${head().slice(0, 7)}·\\d{4}`, "u"));
  assert.deepEqual(await catalog(), beforeCatalog, "the live catalog is unchanged");
  assert.deepEqual(await backups(), beforeBackups, "the rehearsal keeps no new backup beside the live backup");
  assert.equal(await readFile(join(state.root, "pg", "postmaster.pid"), "utf8"), livePid,
    "the live cluster data directory was not restarted or replaced");
  assert.match(wrapperSource, /database-upgrade-vps-rehearse\.mjs[\s\S]*"\$backup_root" "\$pg_bin" "\$rehearse_port"/u);
  assert.doesNotMatch(wrapperSource, /database-upgrade-vps-rehearse\.mjs[\s\S]*\$pg_target/u,
    "the rehearsal command has no route to the live connection target");
  assert.deepEqual(await stages(), ["cr-upgrade.keep"]);
});

test("rehearsal refuses on low disk space and removes its cluster when the rehearsal apply fails", { skip }, async () => {
  await refused(() => upgrade(["--rehearse", head().slice(0, 7)],
    { env: { CR_UPGRADE_TEST_DISK_FACTOR: "1000000000" } }), "upgrade_disk_space_low", "check");
  const port = await findFreePort();
  let disposableRoot;
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: join(state.vps, "backups", "pre-rehearsal-fixture"), port,
    pgBin: PG_BIN, portRange: { min: port, max: port },
    afterRestore: async ({ root }) => { disposableRoot = root; throw new Error("rehearsal_apply_fixture_failed"); } }),
  /rehearsal_apply_fixture_failed/u);
  assert.equal(existsSync(disposableRoot), false, "a failed apply removes the throwaway cluster and its temporary backup");
});

test("upgrades an older ledger to HEAD with one code, a backup first and an empty after-plan", { skip }, async () => {
  const kept = ["control_room_migrator", "control_room_app", "control_room_scheduler", ...legacyMacLogins];
  const verifiers = () => sql("SELECT rolname,rolpassword FROM pg_authid WHERE rolname=ANY($1) ORDER BY 1", [kept]);
  const oldVerifiers = await verifiers();
  const { code, output } = await upgrade([head().slice(0, 7)], { answers: approve(codes.both) });
  assert.equal(code, 0, output);
  assert.match(output, /\d+ migrations: 0091…\d{4} · queue tables: install · new groups: \d+ · new logins: 2/u);
  assert.match(output, /Plan digest: sha256:[0-9a-f]{64}/u);
  const done = new RegExp(`DONE ${head().slice(0, 7)}·(\\d{4})`, "u").exec(output);
  assert.ok(done, output);
  assertNoSecret(output);
  const ledger = JSON.parse(await readFile(join(repoRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  assert.equal(ledger.entries.filter(entry => (entry.kind ?? "migrate") === "migrate").at(-1).file
    .slice("db/migrations/".length, "db/migrations/".length + 4), done[1]);
  assert.equal(macDatabaseUpgradePlanIsEmptyV1(await inspectMacDatabaseUpgradeV1({ client: state.client })), true);
  assert.deepEqual(await verifiers(), oldVerifiers, "existing passwords are byte-identical");
  for (const [login, secret] of [["control_room_publisher", publisherPassword],
    ["control_room_work_intake_agent", intakePassword]]) {
    const session = connectTarget(tcp(login, secret));
    await session.connect();
    await session.end();
  }
  const [backup] = await backups();
  assert.match(backup, new RegExp(`^pre-${head().slice(0, 7)}-\\d{8}T\\d{6}Z$`, "u"));
  assert.deepEqual((await readdir(join(state.vps, "backups", backup))).sort(),
    ["database.dump", "manifest.json", "metadata.json", "plan.json"]);
  const keptPlan = JSON.parse(await readFile(join(state.vps, "backups", backup, "plan.json"), "utf8"));
  assert.match(output, new RegExp(keptPlan.digest.replace("sha256:", ""), "u"));
  assertNoSecret(JSON.stringify(keptPlan));
  assert.deepEqual(await stages(), ["cr-upgrade.keep"]);
});

test("a second run is nothing to do: no code, no prompt, no backup, no change", { skip }, async () => {
  const beforeCatalog = await catalog(), beforeBackups = await backups();
  const { code, output } = await upgrade([head().slice(0, 7)]);
  assert.equal(code, 0, output);
  assert.match(output, new RegExp(`Nothing to do — the database already matches ${head().slice(0, 7)}·\\d{4}`, "u"));
  assert.doesNotMatch(output, /Paste the login code|Apply\?/u);
  assert.deepEqual(await catalog(), beforeCatalog);
  assert.deepEqual(await backups(), beforeBackups);
  assert.deepEqual(await stages(), ["cr-upgrade.keep"]);
});
