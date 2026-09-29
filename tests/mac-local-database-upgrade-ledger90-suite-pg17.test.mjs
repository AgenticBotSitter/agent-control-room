// Proves the first batched live upgrade end to end on disposable PostgreSQL
// 17: a database shaped like the live one at ledger 90 (see
// upgrade-streamline-DESIGN.md section 4) is upgraded through the real PR 1-3
// tooling (`database-upgrade-remote.mjs`, `database-upgrade-vps-step.mjs`) to
// HEAD, and the result is compared byte-for-byte against an independently
// provisioned fresh HEAD install. Two more tests kill the real OS process
// mid-apply — once during the migration loop, once inside the grants
// transaction — and show the database is left at a clean, resumable point
// rather than half-written.
//
// This file complements tests/mac-local-database-upgrade-vps-pg17.test.mjs
// (PR 3), which already proves the wrapper's plan wording and its refusal
// ladder end to end. This file does not repeat that: it calls the same
// production module one layer down (the VPS step, and the apply/inspect
// functions it wraps) so the equal-to-fresh and mid-apply-kill proofs do not
// need the wrapper's interactive prompts. It still goes through a real git
// checkout for every `apply` call, because `runMacDatabaseUpgradeCommandV1`
// (PR 1) itself refuses to apply from anywhere that is not a clean checkout
// of the commit it was told to expect — so a fabricated commit hash or a
// dirty working tree is refused exactly as it would be on the VPS.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectTarget, readSchemaDigest } from "../deploy/postgres/evidence.mjs";
import { inspectMacDatabaseUpgradeV1, macDatabaseUpgradePlanDigestV1 } from
  "../scripts/mac-local/database-upgrade-remote.mjs";
import { macDatabaseUpgradePlanIsEmptyV1 } from "../scripts/mac-local/database-upgrade-vps-step.mjs";
import { postgresScramVerifierV1 } from "../scripts/mac-local/database-upgrade-scram.mjs";
import { macRolePlan } from "../scripts/mac-local/database-upgrade-grants.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { PG_BIN, needsPg } from "./helpers/disposable-postgres-cluster.ts";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const skip = needsPg;
const legacyMacLogins = ["control_room_web", "control_room_coordinator", "control_room_results",
  "control_room_queue_worker"];
const legacyPassword = login => `p${login.replaceAll("_", "")}`.padEnd(40, "x");
const publisherPassword = "q".repeat(40), intakePassword = "w".repeat(40);
const bothLoginCodes = JSON.stringify({ control_room_publisher: postgresScramVerifierV1(publisherPassword),
  control_room_work_intake_agent: postgresScramVerifierV1(intakePassword) });
const pgExec = (file, args) => execFileSync(join(PG_BIN ?? "", file), args, { encoding: "utf8", timeout: 120_000,
  env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000,
  env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const never = async () => { throw new Error("a run that needs no login must never read one"); };

/** A dedicated port per cluster, all inside 58520-58529. */
const PORTS = { old: 58520, fresh: 58521, migrationsKill: 58522, grantsKill: 58523 };

// ---------------------------------------------------------------------------
// PostgreSQL clusters and the ledger-90 / fresh-HEAD database fixtures.
// ---------------------------------------------------------------------------
async function startCluster(prefix, port) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const data = join(root, "pg"), socket = join(root, "s");
  await mkdir(socket, { recursive: true, mode: 0o700 });
  const teardown = createClusterTeardown({ dataDirectory: data, runDirectory: root, socketDirectory: socket,
    port, pgBin: PG_BIN, removeDirectories: false });
  pgExec("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await writeFile(join(data, "pg_hba.conf"), "local all postgres trust\nhost all postgres 127.0.0.1/32 trust\n"
    + "host all all 127.0.0.1/32 scram-sha-256\n");
  pgExec("pg_ctl", ["-D", data, "-l", join(root, "pg.log"), "-w", "-o",
    `-p ${port} -k '${socket}' -c listen_addresses=127.0.0.1`, "start"]);
  await teardown.capturePostmasterPid();
  pgExec("psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-v", "dbname=control_room", "-v", "ON_ERROR_STOP=1", "-f", join(repoRoot, "deploy/postgres/provision-database.sql")]);
  return { root, socket, port, teardown };
}

const socketTarget = cluster => `host=${cluster.socket} port=${cluster.port} dbname=control_room user=postgres`;
const tcp = (cluster, user, password) => `host=127.0.0.1 port=${cluster.port} dbname=control_room user=${user}`
  + `${password === undefined ? "" : ` password=${password}`}`;

/** Builds the live database's shape at ledger 90: no queue, no publisher, no
 * work-intake roles, and the four Mac logins still inheriting the broad
 * application role. Mirrors the fixture in PR 3's own VPS suite. Applied
 * through the repo's own migration ledger, unrelated to any git checkout. */
async function ledger90Fixture(cluster) {
  const { applyMigrations } = await import("../deploy/postgres/apply-migrations.mjs");
  const ledger = JSON.parse(await readFile(join(repoRoot, "deploy/postgres/migration-ledger.json"), "utf8"));
  ledger.entries = ledger.entries.filter(entry => entry.kind !== undefined && entry.kind !== "migrate"
    || entry.file < "db/migrations/0091");
  const ledgerPath = join(cluster.root, "ledger-0090.json");
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const migratorPassword = "m".repeat(40);
  await applyMigrations({ rootDir: repoRoot, ledgerPath, bootstrapTarget: tcp(cluster, "postgres"),
    migrateTarget: tcp(cluster, "control_room_migrator", migratorPassword),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: migratorPassword, CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
      CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "i".repeat(40) } });
  const client = connectTarget(socketTarget(cluster));
  await client.connect();
  await client.query(`DROP OWNED BY control_room_work_intake_agent, control_room_work_intake;
    DROP ROLE control_room_work_intake_agent; DROP ROLE control_room_work_intake`);
  for (const login of legacyMacLogins) {
    await client.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD ${client.escapeLiteral(legacyPassword(login))}`);
    await client.query(`GRANT control_room_application TO ${login}`);
  }
  return client;
}

/** A fresh HEAD install, built the same way the Mac's own first-owner setup
 * builds one: full migration ledger, then the five narrow Mac roles. This is
 * the independent baseline the upgraded ledger-90 database is compared to. */
async function freshHeadDatabase(cluster) {
  const { applyMigrations } = await import("../deploy/postgres/apply-migrations.mjs");
  const secrets = { migrator: "m2".repeat(20), application: "a2".repeat(20), scheduler: "s2".repeat(20),
    workIntake: "w2".repeat(20) };
  await applyMigrations({ rootDir: repoRoot, ledgerPath: join(repoRoot, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: tcp(cluster, "postgres"), migrateTarget: tcp(cluster, "control_room_migrator", secrets.migrator),
    env: { CONTROL_ROOM_MIGRATOR_PASSWORD: secrets.migrator, CONTROL_ROOM_APP_PASSWORD: secrets.application,
      CONTROL_ROOM_SCHEDULER_PASSWORD: secrets.scheduler, CONTROL_ROOM_WORK_INTAKE_PASSWORD: secrets.workIntake } });
  const client = connectTarget(socketTarget(cluster));
  await client.connect();
  const passwords = Object.fromEntries(Object.keys(macRolePlan).map((login, index) => [login, `f${index}`.repeat(20)]));
  await provisionMacLocalNarrowRolesV1(client, passwords);
  return client;
}

/** Roles, memberships, table/sequence ACLs and RLS policies for every
 * non-system role, plus the applied-migration ledger. Deliberately excludes
 * `rolpassword`: two independently built databases use different synthetic
 * passwords by construction, and password equality is asserted separately,
 * only for logins that pre-date the upgrade. */
async function catalog(client) {
  const rows = async text => (await client.query(text)).rows;
  return {
    roles: await rows(`SELECT rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
      rolbypassrls FROM pg_authid WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`),
    memberships: await rows(`SELECT member.rolname AS member,parent.rolname AS parent FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member ORDER BY 1,2`),
    // aclexplode with an acldefault() fallback normalizes two representations
    // PostgreSQL treats as equivalent but prints differently: a table whose
    // ACL was never touched (relacl IS NULL, implying the owner's default
    // rights) and one where some other grant made PostgreSQL materialize that
    // same default explicitly. It also removes any incidental ordering
    // difference between an incremental upgrade and a single fresh install.
    tables: await rows(`SELECT n.nspname,c.relname,r.rolname AS grantee,a.privilege_type,a.is_grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,
        acldefault((CASE c.relkind WHEN 'S' THEN 'S' ELSE 'r' END)::"char", c.relowner))) a
      JOIN pg_roles r ON r.oid=a.grantee
      WHERE n.nspname IN ('public','control_room_queue') AND c.relkind IN ('r','p','v','m','f','S')
      ORDER BY 1,2,3,4,5`),
    policies: await rows(`SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      FROM pg_policies WHERE schemaname IN ('public','control_room_queue') ORDER BY 1,2,3`),
    ledger: await rows("SELECT filename,digest FROM control_room_schema_migrations ORDER BY ledger_order"),
  };
}

async function backupRoot(cluster) {
  const dir = join(cluster.root, "backups");
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Git plumbing: every `apply` call runs from a clean checkout whose HEAD and
// `refs/remotes/origin/main` are the commit under test, exactly as the real
// `cr-db-upgrade` wrapper stages one — PR 1's own apply path refuses
// otherwise. `plan` performs no git check, so read-only calls use `repoRoot`
// directly and skip the checkout.
// ---------------------------------------------------------------------------

/** A one-commit repo mirroring this worktree's tracked files plus whatever is
 * modified or new on disk (this test file included), exactly as PR 3's own
 * suite builds its `upstream`. Returns the repo path; commits accumulate on
 * it across scenarios that need extra content, and are reverted afterward. */
async function buildUpstream(root) {
  // A fresh directory per call: some scenarios build a second upstream (for a
  // resumed run) inside the same cluster root as their first.
  const upstream = await mkdtemp(join(root, "upstream-"));
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--no-local", `file://${repoRoot}`, upstream]);
  const changed = git(repoRoot, "ls-files", "--modified", "--others", "--exclude-standard").split("\n").filter(Boolean);
  for (const file of changed) {
    if (existsSync(join(repoRoot, file))) {
      await mkdir(dirname(join(upstream, file)), { recursive: true });
      await cp(join(repoRoot, file), join(upstream, file));
    } else await rm(join(upstream, file), { force: true });
  }
  git(upstream, "checkout", "--quiet", "-B", "main");
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "--allow-empty", "-m", "code under test");
  return upstream;
}

/** A fresh, clean clone of `upstream` at its current tip, with `node_modules`
 * resolvable (a symlink to this worktree's own, excluded from git status so
 * the checkout stays clean) and its bin path known for spawning the step
 * module directly. */
async function checkout(upstream, dest) {
  execFileSync("git", ["clone", "--quiet", "--no-local", upstream, dest]);
  await symlink(join(repoRoot, "node_modules"), join(dest, "node_modules"));
  await appendFile(join(dest, ".git/info/exclude"), "node_modules\n");
  assert.equal(git(dest, "status", "--porcelain"), "", "a fresh checkout must be clean");
  const commit = git(dest, "rev-parse", "HEAD");
  return { dir: dest, commit, stepModule: join(dest, "scripts/mac-local/database-upgrade-vps-step.mjs") };
}

/** Adds one migration file after the real ledger, commits it to `upstream`,
 * and returns an undo function. The statement runs with no side effect on
 * schema, so it is safe to splice after any real migration. */
async function commitFixtureMigration(upstream, sql) {
  const file = "db/migrations/0105_test_fixture.sql";
  await writeFile(join(upstream, file), sql);
  const ledgerPath = join(upstream, "deploy/postgres/migration-ledger.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const migrateOrders = ledger.entries.filter(entry => (entry.kind ?? "migrate") === "migrate").map(entry => entry.order);
  ledger.entries.push({ file, order: Math.max(...migrateOrders) + 1,
    sha256: createHash("sha256").update(sql).digest("hex"), kind: "migrate" });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "add a HEAD+1 test fixture migration");
  return async () => { git(upstream, "revert", "--quiet", "--no-edit", "HEAD"); };
}

/** Runs `plan` (read-only, no git check, against repoRoot directly) then,
 * unless there is nothing to do, `apply` from a fresh checkout of `upstream`.
 * Used by every scenario that does not need to kill a real process. */
async function upgradeViaStep(upstream, target, root, { readCode = never } = {}) {
  const { runMacDatabaseUpgradeVpsStepV1 } = await import("../scripts/mac-local/database-upgrade-vps-step.mjs");
  const plan = await runMacDatabaseUpgradeVpsStepV1({ args: ["plan", "c".repeat(40), target, root, PG_BIN, "2"],
    write: () => {} });
  if (plan.nothingToDo) return { plan, applied: false };
  const dest = await mkdtemp(join(root, "..", "co-"));
  const { commit, stepModule } = await checkout(upstream, dest);
  const staged = await import(pathToFileURL(stepModule).href);
  const applied = await staged.runMacDatabaseUpgradeVpsStepV1({ args: ["apply", commit, target, root, PG_BIN, "2", plan.digest],
    readCode, write: () => {} });
  return { plan, applied };
}

before(async () => { if (!skip) await mkdir(join(repoRoot, ".p4tmp"), { recursive: true }); });

// ---------------------------------------------------------------------------
// Shared fixture for the first three tests below: one ledger-90 database and
// one git upstream, both built once and reused in order.
// ---------------------------------------------------------------------------
const shared = {};

before(async () => {
  if (skip) return;
  shared.cluster = await startCluster("acr-p4-old-", PORTS.old);
  shared.client = await ledger90Fixture(shared.cluster);
  shared.backupRoot = await backupRoot(shared.cluster);
  shared.upstream = await buildUpstream(shared.cluster.root);
});

after(async () => {
  if (skip) return;
  try { await shared.client?.end(); } catch { /* already closed by a test */ }
  try { await shared.cluster?.teardown.stop(); } finally { await rm(shared.cluster.root, { recursive: true, force: true }); }
});

test("a wrong code, then the real login code: the upgraded ledger-90 database equals an independent fresh HEAD install",
  { skip }, async () => {
    const target = socketTarget(shared.cluster);
    const before1 = await inspectMacDatabaseUpgradeV1({ client: shared.client });
    assert.equal(before1.installQueueSchema, true);
    assert.equal(before1.pendingMigrations.length, 7);
    assert.ok(before1.createRoles.some(item => item.role === "control_room_publisher"));
    const digest = macDatabaseUpgradePlanDigestV1(before1);

    // Wrong code first: refused, and nothing changed.
    const beforeCatalog = await catalog(shared.client);
    const wrongDest = await mkdtemp(join(shared.cluster.root, "co-"));
    const wrong = await checkout(shared.upstream, wrongDest);
    const wrongStep = await import(pathToFileURL(wrong.stepModule).href);
    await assert.rejects(wrongStep.runMacDatabaseUpgradeVpsStepV1({
      args: ["apply", wrong.commit, target, shared.backupRoot, PG_BIN, "2", digest],
      readCode: async () => "not-a-login-code", write: () => {} }), /upgrade_scram_verifier_refused/u);
    assert.deepEqual(await catalog(shared.client), beforeCatalog, "a wrong code changes nothing");

    const retainedLogins = ["control_room_migrator", "control_room_app", "control_room_scheduler", ...legacyMacLogins];
    const passwordsOf = async () => (await shared.client.query(`SELECT rolname,rolpassword FROM pg_authid
      WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [retainedLogins])).rows;
    const beforePasswords = await passwordsOf();

    const { applied } = await upgradeViaStep(shared.upstream, target, shared.backupRoot, { readCode: async () => bothLoginCodes });
    assert.equal(applied.done, true, JSON.stringify(applied));
    assert.equal(macDatabaseUpgradePlanIsEmptyV1(await inspectMacDatabaseUpgradeV1({ client: shared.client })), true);
    assert.deepEqual(await passwordsOf(), beforePasswords, "the migrator, app, scheduler and four Mac logins keep byte-identical verifiers");

    for (const [login, password] of [["control_room_publisher", publisherPassword],
      ["control_room_work_intake_agent", intakePassword]]) {
      const session = connectTarget(tcp(shared.cluster, login, password));
      await session.connect();
      await session.end();
    }

    const fresh = await startCluster("acr-p4-fresh-", PORTS.fresh);
    let freshClient;
    try {
      freshClient = await freshHeadDatabase(fresh);
      assert.equal(await readSchemaDigest(shared.client), await readSchemaDigest(freshClient),
        "the upgraded schema is byte-identical to a fresh HEAD install");
      assert.deepEqual(await catalog(shared.client), await catalog(freshClient),
        "roles, memberships, table/sequence grants and RLS policies match a fresh HEAD install exactly");
    } finally {
      try { await freshClient?.end(); } catch { /* already closed */ }
      try { await fresh.teardown.stop(); } finally { await rm(fresh.root, { recursive: true, force: true }); }
    }
  });

test("refuses a drifted schema and an unexpected login membership, each leaving the database unchanged", { skip },
  async () => {
    const target = socketTarget(shared.cluster);
    const { runMacDatabaseUpgradeVpsStepV1 } = await import("../scripts/mac-local/database-upgrade-vps-step.mjs");
    const before1 = await catalog(shared.client);
    await shared.client.query("CREATE TABLE public.drift_outside_the_ledger (id int)");
    try {
      await assert.rejects(runMacDatabaseUpgradeVpsStepV1({ args: ["plan", "c".repeat(40), target, shared.backupRoot, PG_BIN, "2"],
        write: () => {} }), /upgrade_schema_drift_refused/u);
    } finally { await shared.client.query("DROP TABLE public.drift_outside_the_ledger"); }
    assert.deepEqual(await catalog(shared.client), before1, "a drift refusal changes nothing");

    await shared.client.query("GRANT control_room_reader TO control_room_web");
    try {
      await assert.rejects(inspectMacDatabaseUpgradeV1({ client: shared.client }),
        /upgrade_non_login_membership_refused|upgrade_unexpected_login_membership_refused/u);
    } finally { await shared.client.query("REVOKE control_room_reader FROM control_room_web"); }
    assert.deepEqual(await catalog(shared.client), before1, "an unexpected membership refusal changes nothing");
  });

// This test runs last among the tests sharing `shared.client`: applying the
// fixture migration below records a ledger row the real (non-staged)
// migration-ledger.json does not know about, so every check after this point
// has to read the ledger through the same staged checkout that applied it.
test("a second run is nothing to do, and a HEAD+1 fixture migration afterward needs no code", { skip }, async () => {
  const target = socketTarget(shared.cluster);
  const { plan, applied } = await upgradeViaStep(shared.upstream, target, shared.backupRoot);
  assert.equal(plan.nothingToDo, true);
  assert.equal(applied, false);

  const dest = await mkdtemp(join(shared.cluster.root, "co-"));
  await commitFixtureMigration(shared.upstream, "SELECT 1;\n");
  const staged = await checkout(shared.upstream, dest);
  const step = await import(pathToFileURL(staged.stepModule).href);
  const remote = await import(pathToFileURL(join(dest, "scripts/mac-local/database-upgrade-remote.mjs")).href);
  const fixturePlan = await step.runMacDatabaseUpgradeVpsStepV1({
    args: ["plan", staged.commit, target, shared.backupRoot, PG_BIN, "2"], write: () => {} });
  assert.deepEqual(fixturePlan.plan.pendingMigrations, ["db/migrations/0105_test_fixture.sql"]);
  assert.equal(fixturePlan.needsLoginCode, false, "a schema-only migration never asks for a login code");
  const fixtureApplied = await step.runMacDatabaseUpgradeVpsStepV1({
    args: ["apply", staged.commit, target, shared.backupRoot, PG_BIN, "2", fixturePlan.digest],
    readCode: never, write: () => {} });
  assert.equal(fixtureApplied.done, true, JSON.stringify(fixtureApplied));
  assert.equal(macDatabaseUpgradePlanIsEmptyV1(await remote.inspectMacDatabaseUpgradeV1({ client: shared.client })), true);
});

// ---------------------------------------------------------------------------
// Mid-apply kill: between two migrations.
// ---------------------------------------------------------------------------
test("a real kill between migrations leaves the ledger at the last committed file, and a re-run resumes", { skip },
  async t => {
    const cluster = await startCluster("acr-p4-migkill-", PORTS.migrationsKill);
    let client;
    t.after(async () => {
      try { await client?.end(); } catch { /* already closed */ }
      try { await cluster.teardown.stop(); } finally { await rm(cluster.root, { recursive: true, force: true }); }
    });
    client = await ledger90Fixture(cluster);
    const target = socketTarget(cluster), root = await backupRoot(cluster);
    const before1 = await inspectMacDatabaseUpgradeV1({ client });
    assert.equal(before1.pendingMigrations.length, 7);

    const upstream = await buildUpstream(cluster.root);
    // A fixture migration appended after the 7 real ones, whose only statement
    // blocks on a transaction-scoped advisory lock this test controls. The 7
    // real files are untouched, so they commit normally; only the 8th (this
    // one) ever waits.
    const lockKey = 918_273_645;
    await commitFixtureMigration(upstream, `SELECT pg_advisory_xact_lock(${lockKey});\n`);
    const dest = await mkdtemp(join(cluster.root, "co-"));
    const staged = await checkout(upstream, dest);
    const step = await import(pathToFileURL(staged.stepModule).href);
    const plan = await step.runMacDatabaseUpgradeVpsStepV1({ args: ["plan", staged.commit, target, root, PG_BIN, "2"],
      write: () => {} });
    assert.deepEqual(plan.plan.pendingMigrations.slice(-1), ["db/migrations/0105_test_fixture.sql"]);
    assert.equal(plan.plan.pendingMigrations.length, 8);

    const blocker = connectTarget(target);
    await blocker.connect();
    await blocker.query(`SELECT pg_advisory_lock(${lockKey})`);
    const child = spawn(process.execPath, [staged.stepModule, "apply", staged.commit, target, root, PG_BIN, "2", plan.digest]);
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.write(bothLoginCodes);
    child.stdin.end();
    const exited = new Promise(resolveExit => child.on("close", code => resolveExit(code)));

    const deadline = Date.now() + 30_000;
    let committed = 0;
    while (Date.now() < deadline) {
      committed = (await blocker.query("SELECT count(*)::int AS n FROM control_room_schema_migrations")).rows[0].n;
      if (committed >= 97) break;
      await sleep(20);
    }
    assert.equal(committed, 97, "all 7 real migrations must commit before the 8th blocks on the advisory lock");
    child.kill("SIGKILL");
    await exited;
    await blocker.query(`SELECT pg_advisory_unlock(${lockKey})`);
    await blocker.end();

    assert.equal((await client.query("SELECT count(*)::int AS n FROM control_room_schema_migrations")).rows[0].n, 97,
      "the fixture migration never committed: the connection dropped mid-transaction and PostgreSQL rolled it back");
    // From the real ledger's point of view — the one every other test and the
    // actual upgrade tooling reads — all 7 real migrations are done and
    // nothing about the killed 8th file is visible.
    const resumed = await inspectMacDatabaseUpgradeV1({ client });
    assert.deepEqual(resumed.pendingMigrations, [], "ledger is at the last real file, with a clean, resumable state");
    assert.deepEqual(resumed.createRoles, [], "the roles transaction, which ran first, was unaffected by the kill");
    assert.equal(resumed.installQueueSchema, true, "queue install had not started yet");
    assert.ok(resumed.grants.missing.length > 0, "grants had not started yet");

    const freshUpstream = await buildUpstream(cluster.root);
    const resumedApply = await upgradeViaStep(freshUpstream, target, root, { readCode: never });
    assert.equal(resumedApply.plan.needsLoginCode, false, "a resumed run with the roles already made needs no code");
    assert.equal(resumedApply.applied.done, true, JSON.stringify(resumedApply.applied));
    assert.equal(macDatabaseUpgradePlanIsEmptyV1(await inspectMacDatabaseUpgradeV1({ client })), true);
    assert.doesNotMatch(stderr, new RegExp(publisherPassword.slice(0, 10)), "no secret leaked to stderr on the killed run");
  });

// ---------------------------------------------------------------------------
// Mid-apply kill: inside the grants transaction, before its commit.
// ---------------------------------------------------------------------------
test("a real kill inside the grants transaction rolls back every grant and membership, and a re-run converges", { skip },
  async t => {
    const cluster = await startCluster("acr-p4-grantkill-", PORTS.grantsKill);
    let client, blocker;
    t.after(async () => {
      try { await blocker?.end(); } catch { /* already closed */ }
      try { await client?.end(); } catch { /* already closed */ }
      try { await cluster.teardown.stop(); } finally { await rm(cluster.root, { recursive: true, force: true }); }
    });
    client = await ledger90Fixture(cluster);
    const target = socketTarget(cluster), root = await backupRoot(cluster);
    const upstream = await buildUpstream(cluster.root);
    const { applied } = await upgradeViaStep(upstream, target, root, { readCode: async () => bothLoginCodes });
    assert.equal(applied.done, true, JSON.stringify(applied));
    assert.equal(macDatabaseUpgradePlanIsEmptyV1(await inspectMacDatabaseUpgradeV1({ client })), true);

    // De-converge only the grants and membership transaction: control_jobs is
    // one of the tables private_web_roles.sql grants to control_room_private_web,
    // and control_room_web (login) is normally a member of that group.
    await client.query("REVOKE SELECT ON control_jobs FROM control_room_private_web");
    await client.query("REVOKE control_room_private_web FROM control_room_web");
    const diverged = await inspectMacDatabaseUpgradeV1({ client });
    assert.deepEqual(diverged.pendingMigrations, []);
    assert.deepEqual(diverged.createRoles, []);
    assert.equal(diverged.installQueueSchema, false);
    assert.ok(diverged.grants.missing.some(row => row.includes("control_room_private_web|table|public.control_jobs")),
      "the injected grant gap is the one this test controls");
    assert.ok(diverged.membership.grant.some(row => row.member === "control_room_web" && row.parent === "control_room_private_web"));
    const digest = macDatabaseUpgradePlanDigestV1(diverged);

    blocker = connectTarget(target);
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE control_jobs IN ACCESS EXCLUSIVE MODE");

    const dest = await mkdtemp(join(cluster.root, "co-"));
    const staged = await checkout(upstream, dest);
    const child = spawn(process.execPath, [staged.stepModule, "apply", staged.commit, target, root, PG_BIN, "2", digest]);
    child.stdin.end(); // no login code needed: createRoles is empty.
    const exited = new Promise(resolveExit => child.on("close", code => resolveExit(code)));

    const deadline = Date.now() + 30_000;
    let waiting = 0;
    while (Date.now() < deadline) {
      waiting = (await blocker.query("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted")).rows[0].n;
      if (waiting >= 1) break;
      await sleep(20);
    }
    assert.equal(waiting >= 1, true, "the apply must be blocked waiting for the lock this test holds");
    child.kill("SIGKILL");
    await exited;
    await blocker.query("ROLLBACK"); // releases the ACCESS EXCLUSIVE lock.

    const afterKill = await inspectMacDatabaseUpgradeV1({ client });
    assert.deepEqual(afterKill, diverged, "the grants transaction never committed: the whole diff is unchanged, not partially applied");

    const freshUpstream = await buildUpstream(cluster.root);
    const { applied: resumedApplied } = await upgradeViaStep(freshUpstream, target, root, { readCode: never });
    assert.equal(resumedApplied.done, true, JSON.stringify(resumedApplied));
    assert.equal(macDatabaseUpgradePlanIsEmptyV1(await inspectMacDatabaseUpgradeV1({ client })), true);
  });
