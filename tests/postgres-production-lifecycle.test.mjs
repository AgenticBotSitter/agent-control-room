// Live-cluster tests for the #63 package on a disposable PostgreSQL 17 cluster.
// Never touches an existing database: initdb into a temp dir, socket-only,
// --auth-host=reject. Needs the PG 17 bin directory (PG_BIN or the Debian default).
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client, Pool } from "pg";
import { applyMigrations, readSchemaDigest } from "../deploy/postgres/apply-migrations.mjs";
// The shared disposable-cluster teardown. `.mjs` because
// `scripts/ops/verify-database-backup.mjs` imports it with bare `node`, and a
// `.ts` module could not be imported by one of its own callers.
import { createClusterTeardown, pidAlive } from "../scripts/dev/postgres-cluster-lifecycle.mjs";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { collectDatabaseEvidence, digestOf } from "../deploy/postgres/evidence.mjs";
import { computeDatabaseRestoreIdentity, verifyRestoredIdentity } from "../deploy/postgres/restore-identity.mjs";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { provisionMacLocalNarrowRolesV1 } from "../scripts/mac-local/narrow-role-provision.mjs";
import { applyMacGrantDiffV1, diffMacGrantsV1, macRolePlan, readDesiredMacGrantsV1, readMacGrantCatalogV1 }
  from "../scripts/mac-local/database-upgrade-grants.mjs";
import { inspectFixedQueueSchemaV1, installFixedQueueSchemaV1 } from "../scripts/mac-local/fixed-queue-schema.mjs";
import { createMacLocalDatabaseBackupV1 } from "../scripts/ops/backup-database.mjs";
import { parseDatabaseBackupVerificationPortRangeV1, verifyMacLocalDatabaseBackupV1 }
  from "../scripts/ops/verify-database-backup.mjs";
import { AuditStore } from "../src/audit/audit-store.ts";
import { WorkBatchStoreV1 } from "../src/work-intake/v1/store.ts";
import { WorkBatchOwnerServiceV1 } from "../src/work-intake/v1/owner-service.ts";
import { workBatchProposalDigestV1 } from "../src/work-intake/v1/digest.ts";
import { sha256Digest, canonicalJson } from "../src/security/canonical-digest.ts";
import { hmacSha256Tag, computeAuthorityDigest } from "../src/security/digest.ts";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery.ts";
import { derivePipelineBuildPublicationEvidenceKeyV1 } from "../src/pipelines/v1/build-publication-authority.ts";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/rollback-checkpoint.ts";
import { SecurityStore } from "../src/security/security-store.ts";
import { LinearPipelineServiceV1, PipelineAdvanceServiceV1, ProductionPipelineAdvanceAuthorityV1,
  ProductionPipelineAdvanceCapabilityV1 } from "../src/pipelines/v1/index.ts";
import { AgentReviewServiceV1, CompletionGateStoreV1 } from "../src/completion-gate/v1/index.ts";
import { nativeReviewPlanTag, nativeReviewTarget } from "../src/completion-gate/v1/native-review-plan.ts";
import { buildTaskResultManifestV1 } from "../src/artifacts/v1/durable-result-publication.ts";
import { resultBytesHash } from "../src/artifacts/v1/native-results.ts";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { WebTaskService } from "../src/web/v1/task-service.ts";
import { captureTaskModelCatalogV1 } from "../src/web/v1/task-model-selection.ts";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { privateWebSchemaDigest, readPrivateWebSchemaDigest, verifyAgentReviewerDatabase, verifyPrivateDatabase,
  verifyTaskCoordinatorDatabase } from "../src/web/v1/private-database-preflight.ts";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database.ts";
import { privatePgOptions } from "../src/web/v1/private-pg-options.ts";
import { now as webNow, request as webRequest, trust as webTrust } from "./helpers/web-foundation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.PG_BIN ?? "/usr/lib/postgresql/17/bin";
// Graceful skip for lanes without PostgreSQL binaries (e.g. the merge-gate
// catch-up entry, which has no PG install step): the tests run wherever the
// components job provisions PG17, and report as skipped elsewhere instead of
// failing the whole lane for an unrelated pull request.
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN or /usr/lib/postgresql/17/bin)" };
// Socket-only clusters; the base is overridable so concurrent local runs can
// stay inside an assigned port range. PORT..PORT+2 are the shared fixtures, and
// PORT+3 is reused by the six backup-verification calls below, which run one at a
// time and tear each cluster down before the next starts.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 15630);
// The backup verifier refuses any port outside its own accepted block
// (15620..15649 by default), so this lane has to say which block it is in before
// a local run can move the base into a different assigned range.
//
// The verification port is `PORT+3`, and the accepted block is that lane's own:
// `CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE` when the operator set one, otherwise
// THIS lane's own assigned block, `PORT+1`..`PORT+9`. The test-runner sets the
// variable from the same base (`scripts/test-runner/service.mjs`), so a run
// under the runner and a bare local run now agree, and the documented default
// base still lands in the module's own default block.
//
// The DIRECT calls need this as much as the CLI, and the missing half was the
// fifth failure after S7b: `--port-range` was forwarded to the CLI but the
// programmatic calls got only a port, so a moved base reached
// `verifyMacLocalDatabaseBackupV1`, it fell back to the module's default block,
// and it refused with `database_backup_verification_arguments_refused` — an
// error naming no port and no range. `backupVerify()` passes the range for both,
// from the one source below, so the two cannot drift apart again.
const BACKUP_VERIFY_PORT = PORT + 3;
const BACKUP_VERIFY_RANGE = process.env.CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE ?? `${PORT + 1}-${PORT + 9}`;
// The verifier's own `MIN-MAX` validation, run here so a typo in this lane's
// environment fails with the verifier's message rather than as a confusing port
// refusal much later in the journey test.
const verifyRange = parseDatabaseBackupVerificationPortRangeV1(BACKUP_VERIFY_RANGE);
assert.ok(BACKUP_VERIFY_PORT >= verifyRange.min && BACKUP_VERIFY_PORT <= verifyRange.max,
  `the backup-verification port ${BACKUP_VERIFY_PORT} is outside this run's range ${BACKUP_VERIFY_RANGE}`);
const backupVerify = () => ({ port: BACKUP_VERIFY_PORT, portRange: BACKUP_VERIFY_RANGE });
/** The same two settings for the CLI, which takes its range as a flag. */
const backupVerifyFlags = () => ["--port", String(BACKUP_VERIFY_PORT), "--port-range", BACKUP_VERIFY_RANGE];
const exec = promisify(execFile);

let run = "", socket = "", data = "";
/** The shared teardown, created before `initdb` and released by `after()`. */
let teardown = null;
const target = (database, user = "fixture_admin") =>
  ({ host: socket, port: PORT, database, user, password: "fixture_only" });
const adminDb = () => target("postgres");
const passwords = { CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24), CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24), CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24) };
// Production-correct migrator target: the bootstrap phase creates the
// control_room_migrator login with the password from CONTROL_ROOM_MIGRATOR_PASSWORD,
// then the migrate phase connects as that login (IN ROLE schema_owner) and runs
// each migration under SET ROLE control_room_schema_owner. Tests construct both
// targets up-front and pass them to applyMigrations.
const bootstrapTarget = (database) => target(database, "fixture_admin");
const migrateTarget = (database) => ({ host: socket, port: PORT, database,
  user: "control_room_migrator", password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD });

// The postmaster refuses to run as root (UID 0). Detect whether the current
// process is root and, if so, de-escalate via setpriv to the postgres
// pseudo-user (UID 102, GID 105 — the same defaults Debian and Ubuntu
// packages use). On a GitHub Actions runner the job runs as the `runner`
// user (UID 1001), so the de-escalation is a no-op. This is the only place
// the test driver hard-codes a UID/GID: any non-root environment (CI, a dev
// box with a non-root shell, a container) needs no special handling.
const ROOT_UID = 0;
const POSTGRES_UID = 102;
const POSTGRES_GID = 105;
const native = (name, args) => {
  const runAsPostgres = process.getuid?.() === ROOT_UID;
  const binaryPath = join(BIN, name);
  const command = runAsPostgres && ["initdb", "pg_ctl", "postgres"].includes(name)
    ? ["setpriv", `--reuid=${POSTGRES_UID}`, `--regid=${POSTGRES_GID}`, "--clear-groups", binaryPath, ...args]
    : [binaryPath, ...args];
  return exec(command[0], command.slice(1),
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 60000, maxBuffer: 1 << 26 });
};

async function query(target, sql, params = []) {
  const { connectTarget } = await import("../deploy/postgres/evidence.mjs");
  const client = connectTarget(target);
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

// `hooks` lets a concurrency test act inside a transaction: `afterBegin` runs
// first on the session, and `beforeCommit` is awaited with the work done and
// every lock still held.
function postgresDatabase(target, hooks = {}) {
  const one = async (callback) => {
    const client=new Client(target); await client.connect();
    try { return await callback(client); } finally { await client.end(); }
  };
  const database={
    query:(sql,params=[])=>one(client=>client.query(sql,params)),
    transaction:(callback)=>one(async client=>{ await client.query("BEGIN");
      try { const session={query:(sql,params=[])=>client.query(sql,params)};
        await hooks.afterBegin?.(session);
        const result=await callback(session);
        await hooks.beforeCommit?.();
        await client.query("COMMIT"); return result; }
      catch(error){ await client.query("ROLLBACK"); throw error; } }),
    transactionWithPreCommitCheck:(callback,check)=>one(async client=>{ await client.query("BEGIN");
      try { const result=await callback({query:(sql,params=[])=>client.query(sql,params)});
        await check(); await client.query("COMMIT"); return result; }
      catch(error){ await client.query("ROLLBACK"); throw error; } }),
  };
  return Object.freeze(database);
}

before(async () => {
  if (!PG_AVAILABLE) return;
  run = await mkdtemp(join(tmpdir(), "cr-pg63-"));
  socket = join(run, "socket");
  data = join(run, "data");
  await mkdir(socket, { mode: 0o700 });
  // Registered BEFORE initdb, and that ordering is the fix. This lane had no
  // SIGINT/SIGTERM handler at all, so a runner that stopped it at its bound, or
  // a Ctrl-C, skipped `after()` and left a postmaster holding a 56-byte SysV
  // shared-memory segment with a dead creator. `pg_ctl start` runs the postmaster
  // with `setsid`, so it is its own session leader with PPID 1 and a group
  // signal from the runner cannot reach it either. This machine has 32 of those
  // segments in total.
  teardown = createClusterTeardown({ dataDirectory: data, runDirectory: run,
    socketDirectory: socket, port: PORT, pgBin: BIN });
  // On a root dev box, chown the run directory to the postgres pseudo-user
  // so initdb/pg_ctl/postgres (which run with that UID) can write the data
  // directory. Non-root CI runners skip the chown — the test driver already
  // owns the temp dir.
  if (process.getuid?.() === ROOT_UID) {
    await exec("chown", ["-R", `${POSTGRES_UID}:${POSTGRES_GID}`, run]);
  }
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-k ${socket} -p ${PORT} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
  // Retained while the cluster is up. WITHOUT this the teardown has no pid to
  // signal, so it takes the branch that can only try one `pg_ctl` and then give
  // up: the ladder — the whole point of this change — would never run for this
  // lane, and the one path that can stop a wedged postmaster would be unused.
  await teardown?.capturePostmasterPid();
});

after(async () => {
  if (!PG_AVAILABLE || !run) return;
  // The shared ladder decides the order and refuses to report success when the
  // postmaster survives. The old `finally { rm }` deleted the data directory
  // even when the stop had failed, which is how a leaked segment became
  // unreapable: nothing was left to stop the postmaster with.
  await teardown?.stop();
});

async function freshDatabase(name) {
  await query(adminDb(), `CREATE DATABASE "${name}" OWNER fixture_admin`);
}

async function roleMemberships(conn) {
  return (await query(conn,
    `SELECT m.rolname AS member, r.rolname AS role, am.admin_option FROM pg_auth_members am
     JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
     WHERE m.rolname LIKE 'control@_room@_%' ESCAPE '@' OR r.rolname LIKE 'control@_room@_%' ESCAPE '@'
     ORDER BY 1, 2`)).rows;
}

async function stageRoot(fileCount) {
  const stage = await mkdtemp(join(tmpdir(), "cr-pg63stage-"));
  await mkdir(join(stage, "deploy/postgres"), { recursive: true });
  await mkdir(join(stage, "db/migrations"), { recursive: true });
  await mkdir(join(stage, "db/roles"), { recursive: true });
  await mkdir(join(stage, "db/setup"), { recursive: true });
  const all = (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort().slice(0, fileCount);
  for (const file of all) await cp(join(ROOT, "db/migrations", file), join(stage, "db/migrations", file));
  for (const file of ["production_roles.sql", "production_table_grants.sql", "agent_reviewer_roles.sql", "production_provision.sql"]) {
    await cp(join(ROOT, "db/roles", file), join(stage, "db/roles", file));
  }
  await cp(join(ROOT, "db/setup/production_migration_ledger.sql"), join(stage, "db/setup/production_migration_ledger.sql"));
  const entries = await collectLedgerEntries(stage);
  const ledgerPath = join(stage, "deploy/postgres/migration-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
  return { stage, ledgerPath };
}

test("clean install applies the full ledger, creates logins, then reruns as no-op", needsPg, async () => {
  await freshDatabase("cr_prod_install");
  const expectedMigrations = (await collectLedgerEntries(ROOT)).filter(entry => (entry.kind ?? "migrate") === "migrate");
  const first = await applyMigrations({ target: target("cr_prod_install"), bootstrapTarget: bootstrapTarget("cr_prod_install"), migrateTarget: migrateTarget("cr_prod_install"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  assert.equal(first.planned, false);
  assert.equal(first.applied.length, expectedMigrations.length);
  assert.equal(first.logins, "applied");
  assert.ok(first.objects > 50);
  assert.match(first.schemaDigest, /^sha256:[a-f0-9]{64}$/);
  const orders = (await query(target("cr_prod_install"), "SELECT ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
  assert.deepEqual(orders.map(row => row.ledger_order), Array.from({ length: expectedMigrations.length }, (_, index) => index + 1));
  const second = await applyMigrations({ target: target("cr_prod_install"), bootstrapTarget: bootstrapTarget("cr_prod_install"), migrateTarget: migrateTarget("cr_prod_install"), rootDir: ROOT });
  assert.equal(second.noOp, true);
  assert.deepEqual(second.applied, []);
  assert.equal(second.schemaDigest, first.schemaDigest);
  // The private hosts refuse any schema whose structural digest differs from the
  // reviewed constant; pin it against a real cluster installed the production way.
  assert.equal(await readPrivateWebSchemaDigest(postgresDatabase(target("cr_prod_install"))), privateWebSchemaDigest);
});

test("ordered upgrade applies a pending suffix in two phases", needsPg, async () => {
  const { stage, ledgerPath } = await stageRoot(5);
  try {
    await freshDatabase("cr_prod_upgrade");
    const phase1 = await applyMigrations({ target: target("cr_prod_upgrade"), bootstrapTarget: bootstrapTarget("cr_prod_upgrade"), migrateTarget: migrateTarget("cr_prod_upgrade"), rootDir: stage, ledgerPath, env: { ...process.env, ...passwords } });
    assert.equal(phase1.applied.length, 5);
    assert.match(phase1.grants, /^deferred_partial_schema:/);
    const all = (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort().slice(0, 10);
    for (const file of all.slice(5)) await cp(join(ROOT, "db/migrations", file), join(stage, "db/migrations", file));
    const entries = await collectLedgerEntries(stage);
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
    const phase2 = await applyMigrations({ target: target("cr_prod_upgrade"), bootstrapTarget: bootstrapTarget("cr_prod_upgrade"), migrateTarget: migrateTarget("cr_prod_upgrade"), rootDir: stage, ledgerPath });
    assert.equal(phase2.applied.length, 5);
    assert.deepEqual(phase2.applied.map(entry => entry.order), [6, 7, 8, 9, 10]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

// A database at an older applied ledger must upgrade by appending only the
// migrations it lacks after its last applied order, never by slotting one in
// before an applied order (which duplicates a ledger_order and wedges every
// later apply with migration_gap).
//
// The staged release's production_table_grants.sql is this head's file with
// every withheld object name removed from it. That is derived from the withheld
// migrations, never listed here, so a migration added later brings its own
// grants with it. It is also exactly the set the pre-migration release's file
// did not carry: a REVOKE naming a table that does not exist raises 42P01,
// which apply-migrations.mjs surfaces as `deferred_partial_schema`, and the
// S-slice tests assert `grants === "applied"`.
const UNATTENDED_OBJECTS = ["pipeline_unattended_transitions", "pipeline_advance_receipts"];

const SHARED_LOGINS = ["control_room_work_intake", "control_room_work_intake_agent", "control_room_reader",
  "control_room_application", "control_room_schedule_admissions", "control_room_github_broker"];
// A rung's expected suffix is read from `pendingFromLedger` below, which takes the
// real ledger order, never from a list of the migrations that happened to follow
// 0135 when the test was written. Such a list is a constant that goes stale in
// silence: `AFTER_0135` named thirteen files and the shipped ledger now orders
// twenty-eight after 0135, so it was missing every one of S7b's 0150-0154, the
// operations-mode 0155-0157, 0185/0186/0195/0196, and this stream's 0200-0204.
// Nothing read it, so nothing failed — a restated copy of the ledger that looks
// checked because it compiles. It is gone rather than extended; the derivation is
// the check.

/** Splits a SQL file into its top-level statements, keeping each one's text.
 *
 * `production_table_grants.sql` writes one statement per line group, so a
 * statement is recovered by splitting on the start of a GRANT/REVOKE/ALTER
 * line. Comments are stripped first: a `--` line never carries a statement, but
 * keeping it would make the verbatim check below compare against text the
 * staged file no longer has. */
function sqlStatements(sql) {
  return sql.replace(/--[^\n]*/g, "").split(/(?=^\s*(?:GRANT|REVOKE|ALTER)\b)/mu)
    .map(statement => statement.trim()).filter(statement => statement !== "");
}

/**
 * This head's grants file with every withheld object removed from it.
 *
 * A staged release that lacks the withheld migrations has none of those objects,
 * and PostgreSQL raises 42P01 on a statement naming a relation that is not
 * there. `apply-migrations.mjs` turns that into `deferred_partial_schema`, and
 * the S-slice tests assert the applier reported `applied` — so the staged file
 * must not name a withheld object at all.
 *
 * Only the withheld NAME is removed, never the whole statement, because this
 * file groups several relations into one statement whenever they share a
 * privilege class: `REVOKE ALL ON pipeline_templates, pipeline_runs, ...,
 * pipeline_unattended_transitions, pipeline_advance_receipts FROM ...` holds
 * four relations the staged release still has alongside two it does not. Dropping
 * that statement wholesale would leave the staged release WITHOUT the revoke on
 * the four it does have, so every shared login would keep its blanket
 * `GRANT SELECT, INSERT, UPDATE ON ALL TABLES` on them — a baseline no release
 * was ever in, and the down-migration comparison against it would fail for a
 * reason that is not about the withheld migrations at all.
 *
 * A column-scoped privilege loses only its withheld columns, and a privilege or
 * a statement left naming nothing is dropped, because `GRANT INSERT () ON t` is
 * not valid SQL. A statement no withheld object touches is kept VERBATIM, so an
 * edit to a grant this did not have to touch cannot silently change what the
 * comparison proves.
 */
function grantsWithoutObjects(sql, objects, columns) {
  const statements = sqlStatements(sql);
  const rebuilt = [], rewritten = [];
  for (const statement of statements) {
    // `ALL TABLES`/`ALL SEQUENCES`/`SCHEMA` name no single withheld object and so
    // are kept whole; everything else has a relation or function list worth
    // reading. `ALTER DEFAULT PRIVILEGES` is kept whole for the same reason.
    //
    // A FUNCTION list is read by SIGNATURE, not by relation name (R4-B3). The
    // function grants in this file (`work_intake_split_suggestion_visible` from
    // 0203) name an object a partial ledger does not have, and PostgreSQL answers
    // 42883 rather than 42P01 for them -- so the exclusion above is the wrong shape
    // of guard for exactly the statement that used to break. Excluding FUNCTION
    // removed the only arm that could prune them, so it is read here instead.
    const matched = /^(GRANT|REVOKE)\s+([\s\S]*?)\s+ON\s+(?!ALL\b|SCHEMA\b|SEQUENCE\b)([\s\S]*?)\s+(?:FROM|TO)\s+([\s\S]*?);$/u
      .exec(statement);
    if (!matched) { rebuilt.push(statement); continue; }
    // The privilege list and each privilege's own column list: a column list
    // belongs to the privilege, never to the object list.
    const privileges = splitTopLevel(matched[2]).map(value => {
      const parsed = /^([A-Z]+)\s*(?:\(([^)]*)\))?$/u.exec(value.trim());
      assert.ok(parsed, `unreadable privilege: ${value}`);
      return { text: parsed[1],
        scoped: parsed[2] !== undefined,
        columns: parsed[2] === undefined ? [] : splitTopLevel(parsed[2]).map(column => column.trim()) };
    });
    const isFunction = /^FUNCTION\s/iu.test(matched[3]);
    // Split on a comma that is NOT inside a parenthesis, so a signature's argument
    // list stays one name. The plain split is what produced
    // `read_plan(text), bytea)`, which is not SQL.
    const listed = splitTopLevel(matched[3]).map(value => value.trim().replace(/^public\./u, ""));
    const bare = (name) => name.replace(/^FUNCTION\s+/iu, "").split("(")[0].trim();
    const survivors = listed.filter(object => !objects.has(isFunction ? bare(object) : object.replace(/^public\./u, "")));
    const heldColumn = !isFunction && privileges.some(privilege => privilege.columns.some(column =>
      listed.some(object => columns.has(`${object}.${column}`))));
    if (survivors.length === listed.length && !heldColumn) { rebuilt.push(statement); continue; }
    const kept = [];
    for (const privilege of privileges) {
      if (!privilege.scoped) { kept.push(privilege.text); continue; }
      const remaining = privilege.columns.filter(column =>
        !listed.some(object => columns.has(`${object}.${column}`)));
      if (remaining.length === 0) continue;
      kept.push(`${privilege.text} (${remaining.join(", ")})`);
    }
    rewritten.push(statement);
    // A privilege or a statement left naming nothing is dropped: `GRANT
    // INSERT () ON t` is not valid SQL, and a statement with no surviving
    // object would raise 42P01 (or 42883) on the first withheld name.
    if (kept.length === 0 || survivors.length === 0) continue;
    // The `FUNCTION` keyword is part of the object list in PostgreSQL's grammar
    // (`GRANT EXECUTE ON FUNCTION f(...)`), so it has to be put back with the
    // survivors. Rebuilding without it produces `ON f(...)`, which names a
    // relation and would raise 42P01 -- a different failure, on the same statement.
    rebuilt.push(`${matched[1]} ${kept.join(", ")} ON ${isFunction ? `FUNCTION ${survivors.join(", ")}` : survivors.join(", ")}`
      + ` ${matched[1] === "REVOKE" ? "FROM" : "TO"} ${matched[4].trim()};`);
  }
  // If nothing was rewritten the derivation did not work: the staged file
  // would name a withheld object and the applier would report
  // `deferred_partial_schema` instead of `applied`.
  assert.ok(rewritten.length > 0,
    "no production_table_grants.sql statement named a withheld object; the staged grants would be wrong");
  return rebuilt.join("\n");
}

// The S-slice tests below each name ONE migration by its filename suffix and
// stage every migration that is not that one or anything after it. `sliceOrder`
// says which ledger order that suffix sits at, and it is DERIVED, never a
// literal: adding a later migration leaves every S-slice's own suffix where it
// was.
//
// `pendingFromLedger` returns every migration from that ledger order onwards —
// the real pending suffix the applier will actually apply. The assertions
// compare against that whole list, so a migration added later is part of the
// expected apply set instead of breaking the test.
const sliceOrders = await collectLedgerEntries(ROOT)
  .then(entries => new Map(entries.filter(entry => (entry.kind ?? "migrate") === "migrate")
    .map(entry => [entry.file.replace("db/migrations/", ""), entry.order])));
/** The ledger order of the one migration whose filename ends with `ending`. */
const sliceOrder = (ending) => {
  const found = [...sliceOrders].filter(([file]) => file.endsWith(ending));
  assert.equal(found.length, 1, ending);
  return found[0][1];
};
/** Every migration the named one and all later ledger orders: the real suffix. */
const pendingFromLedger = async (head) => (await readdir(join(ROOT, "db/migrations")))
  .filter(name => name.endsWith(".sql")).sort().slice(head - 1);

/** The shipped ledger's migrate entries in ledger order, with the UP SQL read
 * once. Read once, so every derivation below compares the same files the applier
 * would run. */
const shippedLedger = await collectLedgerEntries(ROOT)
  .then(entries => entries.filter(entry => (entry.kind ?? "migrate") === "migrate")
    .sort((a, b) => a.order - b.order)
    .map(entry => ({ file: entry.file.replace("db/migrations/", ""), order: entry.order,
      up: readFileSync(join(ROOT, entry.file), "utf8") })))
  .then(entries => entries.map(entry => ({ ...entry,
    down: (() => { const path = join(ROOT, "db/down", entry.file);
      return existsSync(path) ? readFileSync(path, "utf8") : null; })() })));

/** SQL with its comments and quoted literals removed, so a name that only
 * appears in prose is never read as a dependency. */
function sqlCodeV1(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, " ")
    .replace(/'[^']*'/gu, "''");
}

/** Every `CREATE POLICY` statement's own text, each terminated at the `;` that
 * ends it. A policy's OWN table is not a dependency on that table, so the
 * table is read off each statement rather than guessed. */
function policyStatementsV1(sql) {
  const body = sqlCodeV1(sql);
  return [...body.matchAll(/CREATE\s+POLICY\b/giu)].map(match => {
    const end = body.indexOf(";", match.index);
    return body.slice(match.index, end < 0 ? body.length : end);
  });
}

/** Every `CREATE VIEW`/`CREATE MATERIALIZED VIEW` statement's own text, for the
 * same reason. A view is a real dependency: PostgreSQL refuses to drop the
 * relation it selects from while the view exists. */
function viewStatementsV1(sql) {
  const body = sqlCodeV1(sql);
  return [...body.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/giu)]
    .map(match => {
      const end = body.indexOf(";", match.index);
      return body.slice(match.index, end < 0 ? body.length : end);
    });
}

/** What a down file removes: the relations, views and functions it drops. This
 * is the down file's own record of the footprint it reverses, so a dependant is
 * found from the two shipped files rather than from any list. */
function removedByDownFileV1(down) {
  return new Set([...down.matchAll(
    /^\s*DROP\s+(?:TABLE|VIEW|MATERIALIZED VIEW|FUNCTION|INDEX|SCHEMA|TYPE|DOMAIN)\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)/gmu)]
    .map(match => match[1]));
}

/** The four dependency shapes PostgreSQL actually refuses to drop through,
 * each read from a later migration's UP file.
 *
 * 1. `FOREIGN KEY ... REFERENCES <table>` — 0110 points one at 0093's
 *    `work_batches` without naming anything else of 0093's, which is exactly
 *    why a derivation watching only the binding table missed it.
 * 2. `EXECUTE FUNCTION <fn>` on a trigger — S7b's 0151 and 0153 build their
 *    append-only triggers on 0109's `reject_pipeline_unattended_history_mutation()`,
 *    so 0109's own guard refuses until they are reversed first.
 * 3. A policy or view whose body names the object. Verified against a live
 *    PostgreSQL 17: `DROP TABLE` on a relation a view selects from fails with
 *    `view X depends on table Y`, and a policy's expression fails the same way.
 * 4. `ALTER TABLE <table>` — 0152 and 0154 both add a column to 0109's
 *    `pipeline_advance_receipts`. A staged release that never applied 0109
 *    cannot apply them at all, and the applier reports
 *    `relation "pipeline_advance_receipts" does not exist`, naming no cause.
 *
 * A plpgsql FUNCTION body is deliberately NOT one of the shapes. A live probe
 * on PostgreSQL 17 dropped a table a plpgsql function selected from with no
 * error at all: the body is parsed at run time, so the dependency is not a
 * catalog one. Including it would pull in 0141, whose down file refuses
 * unconditionally, and turn a derivable teardown into an impossible one. */
function upFileDependsOnV1(up, removed) {
  const body = sqlCodeV1(up);
  const named = object => {
    const pattern = `(?<![a-z0-9_])${object}(?![a-z0-9_])`;
    return {
      fk: new RegExp(`REFERENCES\\s+(?:ONLY\\s+)?(?:public\\.)?${pattern}`, "iu"),
      trigger: new RegExp(`EXECUTE FUNCTION\\s+(?:public\\.)?${pattern}\\s*\\(`, "iu"),
      alter: new RegExp(`ALTER TABLE\\s+(?:ONLY\\s+)?(?:public\\.)?${pattern}\\s`, "iu"),
      named: new RegExp(pattern, "iu") };
  };
  const statements = [...policyStatementsV1(up), ...viewStatementsV1(up)];
  const reasons = [];
  for (const object of removed) {
    const shape = named(object);
    if (shape.fk.test(body)) reasons.push(`foreign key into ${object}`);
    if (shape.trigger.test(body)) reasons.push(`trigger on ${object}()`);
    if (shape.alter.test(body)) reasons.push(`alters ${object}`);
    // A policy or view that names a relation it does not itself own.
    if (statements.some(statement => {
      const own = /\bON\s+(?:public\.)?([a-z_][a-z0-9_]*)/iu.exec(statement);
      return !(own && own[1].toLowerCase() === object.toLowerCase()) && shape.named.test(statement);
    })) reasons.push(`policy or view reads ${object}`);
  }
  return [...new Set(reasons)];
}

/** Every migration that has to be reversed before `roots` can be, derived from
 * the shipped up and down files and closed to a fixed point, in LEDGER ORDER
 * (oldest first), so a caller that walks it in reverse takes the newest down
 * first.
 *
 * A hard-coded list is what this replaces twice over. S7b's 0151 and 0153 reused
 * 0109's history-guard function, and 0155 read 0093's intake binding; a list
 * naming only 0110 left all three out, and three tests failed with errors that
 * name no migration at all:
 *
 *   - `pipeline unattended down migration refused: a later migration depends on
 *     its history guard` — the work-intake teardown reaching 0109's down;
 *   - `function public.reject_pipeline_unattended_history_mutation() does not
 *     exist` — the STAGED baseline withheld 0109 and then applied 0151, which
 *     builds a trigger on the function 0109 was supposed to have created. This
 *     one is not a guard at all: in a release that never applied 0109, 0151
 *     cannot be applied either, so the whole closure has to be withheld.
 *
 * Every entry must ship a down file. A migration that does not cannot be
 * reversed here, and the assertion says so by name instead of failing later
 * with a 42P01 nobody can read. */
async function dependentMigrationsV1(roots) {
  const rootsSet = new Set(roots), withheld = new Set(roots), reasons = new Map();
  for (let pass = 0; pass < 20; pass += 1) {
    const removed = new Set();
    for (const entry of shippedLedger)
      if (withheld.has(entry.file) && entry.down)
        for (const object of removedByDownFileV1(entry.down)) removed.add(object);
    let added = false;
    for (const entry of shippedLedger) {
      if (withheld.has(entry.file) || !entry.down) continue;
      const found = upFileDependsOnV1(entry.up, removed);
      if (found.length === 0) continue;
      withheld.add(entry.file);
      reasons.set(entry.file, found);
      added = true;
    }
    if (!added) break;
  }
  const ordered = shippedLedger.filter(entry => withheld.has(entry.file));
  for (const entry of ordered) assert.ok(entry.down, `${entry.file} has no down file to reverse`);
  const unexplained = [...withheld].filter(file => !rootsSet.has(file) && !reasons.has(file));
  assert.deepEqual(unexplained, [], "a withheld migration was derived with no dependency reason");
  return ordered.map(entry => entry.file);
}

// Stages an older release's root: every migration except the withheld ones,
// and this head's grants file without the withheld objects' grants.
//
// `withheld` names the migrations the staged release does NOT have. Every
// other migration the ledger orders — including any added after this test was
// written — is staged, so both sides of a down-migration comparison carry the
// same newer work and the comparison is still exactly about what the withheld
// migrations' down files revoke.
async function stageAppliedPrefix({ withheld, withDependants = false }) {
  const stage = await mkdtemp(join(tmpdir(), "cr-pg63prefix-"));
  try {
    for (const dir of ["deploy/postgres", "db/migrations", "db/roles", "db/setup"])
      await mkdir(join(stage, dir), { recursive: true });
    const migrations = (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
    const held = withheld.map(ending => {
      const found = migrations.filter(name => name.endsWith(ending));
      assert.equal(found.length, 1, ending);
      return found[0];
    });
    // A down-migration rung stages a release that never applied the withheld
    // migrations, so every migration that DEPENDS on them has to be withheld
    // too. S7b's 0151 builds a trigger on 0109's history-guard function, and
    // staging it after a release without 0109 fails the apply outright with
    // `function public.reject_pipeline_unattended_history_mutation() does not
    // exist` — naming no migration and no cause. The closure is derived from
    // the shipped up and down files, so a later slice is covered by itself.
    if (withDependants) {
      const closure = await dependentMigrationsV1(held);
      assert.deepEqual([...new Set([...held, ...closure])].sort(), [...new Set(closure)].sort());
      held.push(...closure.filter(file => !held.includes(file)));
    }
    // A withheld migration may not be staged twice, and the staged set must be
    // the real ledger order with exactly those files removed.
    assert.equal(new Set(held).size, held.length);
    const applied = migrations.filter(file => !held.includes(file));
    assert.deepEqual([...applied, ...migrations.filter(file => held.includes(file))].sort(), migrations);
    for (const shipped of ["0100_ownership_lease_collision_guard.sql", "0101_owner_review_job_lock.sql",
      "0102_work_batch_owner_approval.sql"]) assert.ok(applied.includes(shipped), shipped);
    // The staged set plus the withheld set is the whole ledger exactly once:
    // never a hole and never a duplicate. `applied` above already asserts that
    // the staged set is the ledger with exactly those files removed.
    for (const file of applied)
      await cp(join(ROOT, "db/migrations", file), join(stage, "db/migrations", file));
    // The reviewer role file is a grants entry the production applier verifies
    // but never executes, so the older ledger can carry this head's copy.
    for (const file of ["production_roles.sql", "production_provision.sql", "agent_reviewer_roles.sql"])
      await cp(join(ROOT, "db/roles", file), join(stage, "db/roles", file));
    // The older grants: this head's file with every object the withheld
    // migrations create removed from it. Derived from those migrations, so a
    // migration added later is covered without editing this test.
    const { objects, columns } = await withheldObjects(ROOT, withheld);
    const grants = grantsWithoutObjects(
      await readFile(join(ROOT, "db/roles/production_table_grants.sql"), "utf8"), objects, columns);
    await writeFile(join(stage, "db/roles/production_table_grants.sql"), grants);
    await cp(join(ROOT, "db/setup/production_migration_ledger.sql"), join(stage, "db/setup/production_migration_ledger.sql"));
    const entries = await collectLedgerEntries(stage);
    const ledgerPath = join(stage, "deploy/postgres/migration-ledger.json");
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
    // `suffix` is the withheld set in ledger order: for an upgrade test that is
    // exactly the pending migrations the next apply must append.
    return { stage, ledgerPath, applied, suffix: held };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

// `pending` is the migration this slice's upgrade must apply: its own
// migration plus everything the ledger orders after it, derived by
// `pendingFromLedger` so a migration added later is part of the real apply set
// rather than a hard-coded count that goes stale.
async function upgradeFromAppliedPrefix({ database, pending, newObjects }) {
  const { stage, ledgerPath, applied, suffix } = await stageAppliedPrefix({ withheld: pending });
  try {
    await freshDatabase(database);
    const db = target(database);
    const before = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget(database),
      migrateTarget: migrateTarget(database), rootDir: stage, ledgerPath, env: { ...process.env, ...passwords } });
    assert.equal(before.grants, "applied");
    const priorLedger = (await query(db, "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    assert.deepEqual(priorLedger.map(row => row.filename), applied.map(file => `db/migrations/${file}`));
    for (const object of newObjects)
      assert.equal((await query(db, "SELECT to_regclass($1) AS present", [`public.${object}`])).rows[0].present, null, object);

    const upgraded = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget(database),
      migrateTarget: migrateTarget(database), rootDir: ROOT });
    assert.deepEqual(upgraded.applied.map(entry => [entry.file, entry.order]),
      suffix.map((file, index) => [`db/migrations/${file}`, applied.length + index + 1]));
    assert.equal(upgraded.grants, "applied");
    assert.deepEqual((await query(db, `SELECT ledger_order, count(*)::int AS rows FROM control_room_schema_migrations
      GROUP BY ledger_order HAVING count(*) > 1`)).rows, []);
    const ledger = (await query(db, "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;
    assert.deepEqual(ledger.map(row => row.ledger_order), ledger.map((_, index) => index + 1));
    assert.deepEqual(ledger.slice(0, priorLedger.length), priorLedger);
    assert.deepEqual(ledger.slice(priorLedger.length), suffix.map((file, index) =>
      ({ filename: `db/migrations/${file}`, ledger_order: applied.length + index + 1 })));
    // Grants converged on the new objects in the same run: no shared or agent login reaches them.
    assert.deepEqual((await query(db, `SELECT r.role, t.name
      FROM unnest($1::text[]) r(role) CROSS JOIN unnest($2::text[]) t(name)
      WHERE has_table_privilege(r.role, t.name, 'SELECT') OR has_table_privilege(r.role, t.name, 'INSERT')
        OR has_table_privilege(r.role, t.name, 'UPDATE') OR has_table_privilege(r.role, t.name, 'DELETE')`,
    [SHARED_LOGINS, newObjects])).rows, []);

    const rerun = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget(database),
      migrateTarget: migrateTarget(database), rootDir: ROOT });
    assert.equal(rerun.noOp, true);
    assert.equal(rerun.grants, "applied");
    assert.deepEqual((await query(db, "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows,
      ledger);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

test("the staged grants keep every object the staged release still has", () => {
  // The surgery that builds a pre-migration release's grants file is the one
  // piece of this test that runs without a database, so it is checked here
  // directly. Dropping a whole statement instead of the withheld names would
  // leave the staged release without the revoke on the relations it DOES have,
  // and every shared login would keep its blanket `ON ALL TABLES` grant on
  // them — a state no release was ever in.
  const objects = new Set(["pipeline_unattended_transitions", "pipeline_advance_receipts",
    "control_pipeline_build_publications"]);
  const staged = grantsWithoutObjects(
    "REVOKE ALL ON pipeline_templates, pipeline_runs, pipeline_stage_runs, pipeline_ordered_stage_runs,\n"
    + "  pipeline_unattended_transitions, pipeline_advance_receipts\n"
    + "  FROM control_room_application, control_room_reader;\n"
    + "REVOKE ALL ON control_pipeline_build_publications FROM control_room_application;\n"
    + "GRANT SELECT ON ALL TABLES IN SCHEMA public TO control_room_reader;\n",
    objects, new Set());
  // The four surviving pipeline relations keep their revoke; the two withheld
  // ones are gone from the file entirely, so it cannot raise 42P01.
  assert.match(staged, /REVOKE ALL ON pipeline_templates, pipeline_runs, pipeline_stage_runs, pipeline_ordered_stage_runs FROM control_room_application, control_room_reader;/);
  assert.ok(!staged.includes("pipeline_unattended_transitions"));
  assert.ok(!staged.includes("pipeline_advance_receipts"));
  // A statement naming ONLY withheld objects goes whole, and a blanket
  // `ON ALL TABLES` grant names no withheld object so it is untouched.
  assert.ok(!staged.includes("control_pipeline_build_publications"));
  assert.match(staged, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO control_room_reader;/);
  // A column-scoped privilege loses only its withheld columns. `GRANT` names
  // its grantee with `TO` and `REVOKE` with `FROM`, so the rebuilt statement
  // has to keep the verb's own keyword.
  assert.equal(grantsWithoutObjects(
    "GRANT UPDATE (state, withheld_col) ON kept_table TO control_room_reader;\n",
    new Set(), new Set(["kept_table.withheld_col"])),
  "GRANT UPDATE (state) ON kept_table TO control_room_reader;");
  // Every column withheld leaves no invalid `GRANT () (...)` behind.
  assert.equal(grantsWithoutObjects(
    "GRANT UPDATE (withheld_col) ON kept_table TO control_room_reader;\n",
    new Set(), new Set(["kept_table.withheld_col"])), "");
  // A file whose withheld object no statement names is refused, not silently
  // passed through: that would stage a file the applier cannot run.
  assert.throws(() => grantsWithoutObjects("GRANT SELECT ON kept_table TO control_room_reader;\n",
    new Set(["absent_table"]), new Set()), /no production_table_grants\.sql statement named a withheld object/u);
});

// The pending suffix is always the newest migration files, so every rung below
// names 0107 and 0135 as well as its own stage: a rung that did not would be
// asserting a pending set the applier never sees. 0107 grants on roles and
// creates no object, and 0135's object reaches the shared roles through
// production_table_grants.sql's blanket `ON ALL TABLES` grants rather than a
// per-table REVOKE, so neither appears in `newObjects`; the 0107 grant
// convergence itself is asserted against a purpose-built cluster in
// tests/project-activity-lifecycle-postgres.test.ts, which applies the real
// role files to its own database and reads the privileges as the server reports
// them.
//
// A database already at S2 (S1 0093, 0100, 0101 and S2 0102 applied) takes
// everything the ledger orders from S3's queue migration onwards, in that
// order — 0107's activity grants, 0135's project settings and every migration
// after them included. Each test names only the migration its slice STARTS at;
// the rest of the pending suffix is derived from the ledger, so a migration
// added later is part of the expected apply set rather than a failure.
test("upgrade from S2's applied ledger appends only the agent-queue, pipeline, agent-review, activity, build-publication, unattended-advance and project-settings migrations", needsPg, async () =>
  upgradeFromAppliedPrefix({ database: "cr_prod_upgrade_s2",
    pending: await pendingFromLedger(sliceOrder("_work_batch_agent_queue.sql")),
    newObjects: ["work_batch_queue_admissions", "work_batch_agent_queue_heads", "work_batch_effective_queue_admissions",
      "pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs", "control_agent_review_plans",
      "control_pipeline_build_publications", ...UNATTENDED_OBJECTS] }));

// A database at main (S3's 0104 applied) takes S4's pipeline migration onwards.
test("upgrade from main's applied ledger appends only the pipeline, agent-review, activity, build-publication, unattended-advance and project-settings migrations", needsPg, async () =>
  upgradeFromAppliedPrefix({ database: "cr_prod_upgrade_main",
    pending: await pendingFromLedger(sliceOrder("_linear_pipeline_runs.sql")),
    newObjects: ["pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs",
      "control_agent_review_plans", "control_pipeline_build_publications", ...UNATTENDED_OBJECTS] }));

// A database at main plus S4 (0105 applied) takes S5's agent-review migration onwards.
test("upgrade from main plus S4's applied ledger appends only the agent-review, activity, build-publication, unattended-advance and project-settings migrations", needsPg, async () =>
  upgradeFromAppliedPrefix({ database: "cr_prod_upgrade_s4",
    pending: await pendingFromLedger(sliceOrder("_agent_review_plans.sql")),
    newObjects: ["control_agent_review_plans", "control_pipeline_build_publications", ...UNATTENDED_OBJECTS] }));

// A database at main plus S4 and S5 (0106 applied) is the first that takes
// 0107's activity grants, then S6's build-publication migration onwards.
test("upgrade from main plus S4 and S5's applied ledger appends only the activity, build-publication, unattended-advance and project-settings migrations", needsPg, async () =>
  upgradeFromAppliedPrefix({ database: "cr_prod_upgrade_s5",
    pending: await pendingFromLedger(sliceOrder("_pipeline_build_publications.sql")),
    newObjects: ["control_pipeline_build_publications", ...UNATTENDED_OBJECTS] }));

// A database at main plus S4, S5 and 0107 (0108 applied) takes S7's 0109,
// 0135 and whatever the ledger orders after it: no duplicate ledger_order,
// and a second run is a clean no-op.
test("upgrade from main plus S4, S5 and 0107's applied ledger appends only the unattended-advance and project-settings migrations", needsPg, async () =>
  upgradeFromAppliedPrefix({ database: "cr_prod_upgrade_s6",
    pending: await pendingFromLedger(sliceOrder("_pipeline_unattended_advance.sql")),
    newObjects: UNATTENDED_OBJECTS }));

test("tampered history fails closed: altered, deleted-row and forged-digest states", needsPg, async () => {
  await freshDatabase("cr_prod_tamper");
  await applyMigrations({ target: target("cr_prod_tamper"), bootstrapTarget: bootstrapTarget("cr_prod_tamper"), migrateTarget: migrateTarget("cr_prod_tamper"), rootDir: ROOT });
  await query(target("cr_prod_tamper"), "DELETE FROM control_room_schema_migrations WHERE ledger_order = 36");
  await assert.rejects(applyMigrations({ target: target("cr_prod_tamper"), bootstrapTarget: bootstrapTarget("cr_prod_tamper"), migrateTarget: migrateTarget("cr_prod_tamper"), rootDir: ROOT }), /migration_gap:/);
  await freshDatabase("cr_prod_forge");
  await applyMigrations({ target: target("cr_prod_forge"), bootstrapTarget: bootstrapTarget("cr_prod_forge"), migrateTarget: migrateTarget("cr_prod_forge"), rootDir: ROOT });
  await query(target("cr_prod_forge"), "UPDATE control_room_schema_migrations SET digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE ledger_order = 10");
  await assert.rejects(applyMigrations({ target: target("cr_prod_forge"), bootstrapTarget: bootstrapTarget("cr_prod_forge"), migrateTarget: migrateTarget("cr_prod_forge"), rootDir: ROOT }), /migration_ledger_digest_mismatch:/);
});

test("live schema drift refuses closed before any grants or logins are applied", needsPg, async () => {
  await freshDatabase("cr_prod_drift");
  await applyMigrations({ target: target("cr_prod_drift"), bootstrapTarget: bootstrapTarget("cr_prod_drift"), migrateTarget: migrateTarget("cr_prod_drift"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  // Simulate drift by dropping a table and re-applying. The ledger still
  // claims the schema is intact; the live schema is now missing a table.
  // The next applyMigrations must refuse closed with the drift error before
  // any grants or logins run — proving the no-op rerun path is protected.
  await query(target("cr_prod_drift"), "DROP TABLE tenants CASCADE");
  await assert.rejects(applyMigrations({ target: target("cr_prod_drift"), bootstrapTarget: bootstrapTarget("cr_prod_drift"), migrateTarget: migrateTarget("cr_prod_drift"), rootDir: ROOT }), /migration_live_schema_drift:/);
});

test("altered and missing files fail closed without connecting past validation", needsPg, async () => {
  const { stage, ledgerPath } = await stageRoot(76);
  try {
    await freshDatabase("cr_prod_files");
    await applyMigrations({ target: target("cr_prod_files"), bootstrapTarget: bootstrapTarget("cr_prod_files"), migrateTarget: migrateTarget("cr_prod_files"), rootDir: stage, ledgerPath });
    const all = (await readdir(join(stage, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
    await writeFile(join(stage, "db/migrations", all[20]), `${await readFile(join(stage, "db/migrations", all[20]), "utf8")}\n-- tampered`);
    await assert.rejects(applyMigrations({ target: target("cr_prod_files"), bootstrapTarget: bootstrapTarget("cr_prod_files"), migrateTarget: migrateTarget("cr_prod_files"), rootDir: stage, ledgerPath }), /migration_altered:/);
    // Restore the tampered file so the missing-file refusal is proven in isolation
    // (validation reports the earliest ledger entry first).
    await cp(join(ROOT, "db/migrations", all[20]), join(stage, "db/migrations", all[20]));
    await rm(join(stage, "db/migrations", all[21]));
    await assert.rejects(applyMigrations({ target: target("cr_prod_files"), bootstrapTarget: bootstrapTarget("cr_prod_files"), migrateTarget: migrateTarget("cr_prod_files"), rootDir: stage, ledgerPath }), /migration_missing:/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("failed migration rolls back with no ledger row and a reusable database", needsPg, async () => {
  const { stage, ledgerPath } = await stageRoot(3);
  try {
    // Phase A: the good prefix applies; record the schema digest the failed
    // file must leave untouched.
    await freshDatabase("cr_prod_broken");
    await applyMigrations({ target: target("cr_prod_broken"), bootstrapTarget: bootstrapTarget("cr_prod_broken"), migrateTarget: migrateTarget("cr_prod_broken"), rootDir: stage, ledgerPath });
    const { connectTarget: connect } = await import("../deploy/postgres/evidence.mjs");
    const digestOf = async () => {
      const client = connect(target("cr_prod_broken"));
      await client.connect();
      try {
        return await readSchemaDigest(client);
      } finally {
        await client.end();
      }
    };
    const before = await digestOf();
    // Phase B: append the broken file and re-apply; only it may fail.
    await writeFile(join(stage, "db/migrations/9999_broken.sql"), "CREATE TABLE broken (id true_false_type;");
    const entries = await collectLedgerEntries(stage);
    await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
    await assert.rejects(applyMigrations({ target: target("cr_prod_broken"), bootstrapTarget: bootstrapTarget("cr_prod_broken"), migrateTarget: migrateTarget("cr_prod_broken"), rootDir: stage, ledgerPath }), /migration_failed:db\/migrations\/9999_broken\.sql/);
    const rows = (await query(target("cr_prod_broken"), "SELECT filename FROM control_room_schema_migrations")).rows;
    assert.ok(!rows.some(row => row.filename.includes("9999_broken")));
    assert.equal(await digestOf(), before);
    const databases = (await query(adminDb(), "SELECT datname FROM pg_database WHERE datname LIKE 'cr\\_prod\\_%' ORDER BY datname")).rows;
    assert.ok(databases.length >= 4);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test("least-privilege denial: application login reads and writes exactly its grants", needsPg, async () => {
  await freshDatabase("cr_prod_privs");
  await applyMigrations({ target: target("cr_prod_privs"), bootstrapTarget: bootstrapTarget("cr_prod_privs"), migrateTarget: migrateTarget("cr_prod_privs"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  const app = target("cr_prod_privs", "control_room_app");
  await assert.rejects(query(app, "CREATE TABLE rogue (id int)"), /permission denied|not permitted/);
  await assert.rejects(query(app, "DELETE FROM tenants WHERE true"), /permission denied|not permitted/);
  await query(app, "INSERT INTO tenants(id, display_name) VALUES('tenant:privs', 'privs')");
  const rows = (await query(app, "SELECT id FROM tenants WHERE id = 'tenant:privs'")).rows;
  assert.equal(rows.length, 1);
  await assert.rejects(query(app, "SELECT * FROM control_room_schema_migrations"), /permission denied|not permitted/);
  await query(target("cr_prod_privs"), "DELETE FROM tenants WHERE id = 'tenant:privs'");
});

test("schedule-admission service gets narrow grants on fresh install and upgrade, never the reader", needsPg, async () => {
  await freshDatabase("cr_prod_sched");
  await applyMigrations({ target: target("cr_prod_sched"), bootstrapTarget: bootstrapTarget("cr_prod_sched"), migrateTarget: migrateTarget("cr_prod_sched"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  const db = target("cr_prod_sched");
  const sched = target("cr_prod_sched", "control_room_scheduler");
  const matrix = (await query(db,
    `SELECT has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'INSERT') AS sched_insert,
            has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'SELECT') AS sched_select,
            has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'UPDATE') AS sched_update,
            has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'DELETE') AS sched_delete,
            has_table_privilege('control_room_scheduler', 'control_requests', 'SELECT') AS sched_ref_select,
            has_table_privilege('control_room_scheduler', 'control_requests', 'INSERT') AS sched_ref_insert,
            has_table_privilege('control_room_reader', 'control_scheduled_task_admissions', 'INSERT') AS reader_insert,
            has_table_privilege('control_room_reader', 'control_scheduled_task_admissions', 'SELECT') AS reader_select`)).rows[0];
  assert.equal(matrix.sched_insert, true);
  assert.equal(matrix.sched_select, true);
  assert.equal(matrix.sched_update, false);
  assert.equal(matrix.sched_delete, false);
  assert.equal(matrix.sched_ref_select, true);
  assert.equal(matrix.sched_ref_insert, false);
  assert.equal(matrix.reader_insert, false);
  assert.equal(matrix.reader_select, true);
  // Privilege-checked before execution: denied even with zero rows matched.
  await assert.rejects(query(sched, "UPDATE control_scheduled_task_admissions SET payload = '{}' WHERE false"), /permission denied|not permitted/);
  // Existing-installation upgrade: strip the grants, re-apply, they converge back.
  await query(db, "REVOKE ALL ON control_scheduled_task_admissions FROM control_room_schedule_admissions");
  const reconverged = await applyMigrations({ target: db, bootstrapTarget: bootstrapTarget("cr_prod_sched"), migrateTarget: migrateTarget("cr_prod_sched"), rootDir: ROOT });
  assert.equal(reconverged.noOp, true);
  const back = (await query(db, "SELECT has_table_privilege('control_room_scheduler', 'control_scheduled_task_admissions', 'INSERT') AS sched_insert")).rows[0];
  assert.equal(back.sched_insert, true);
});

test("work-intake login cannot read or forge another subsystem's shared-ledger records", needsPg, async () => {
  await freshDatabase("cr_prod_intake_guard");
  const db=target("cr_prod_intake_guard");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_intake_guard"),
    migrateTarget:migrateTarget("cr_prod_intake_guard"), rootDir:ROOT, env:{...process.env,...passwords} });
  await query(db,"INSERT INTO tenants(id,display_name) VALUES('tenant:intake-guard','intake guard')");
  await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:intake-guard')");
  await query(db,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:intake-guard','tenant:intake-guard','workspace')");
  await query(db,`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:intake-guard','tenant:intake-guard','manual','1',
    'control_room_native','fixture','v1',1)`);
  for(const projectId of ["project:intake-guard","project:intake-other"])
    await query(db,`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES($1,'tenant:intake-guard',
      'workspace:intake-guard','adapter:intake-guard',$1,'1','Project','ready','ready','healthy',
      'control_room_native','2026-09-27T12:00:00.000Z','{}')`,[projectId]);
  await query(db,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:intake-guard','tenant:intake-guard','agent',
    'Intake agent','work-intake',$1,'active','2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`,
    [`sha256:${"6".repeat(64)}`]);
  await query(db,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:intake-guard',
    'tenant:intake-guard','identity:intake-guard','work_batch_proposer','["work_batches.propose"]',
    '["project:intake-guard"]','low',false,false,'2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`);
  await query(db,`INSERT INTO control_idempotency
    (tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:intake-guard','other.operation/v1','other-key-0001',$1,'processing')`,[`sha256:${"1".repeat(64)}`]);
  await query(db,`INSERT INTO audit_events
    (id,tenant_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at)
    VALUES('audit:other:1','tenant:intake-guard','identity:other','service','other.action','tenant',
      'tenant:intake-guard','{}'::jsonb,'2026-09-27T12:00:00.000Z')`);
  await query(db,`INSERT INTO control_audit_chain_heads
    (tenant_id,chain_partition,head_hash,event_count,updated_at)
    VALUES('tenant:intake-guard','month:2026-09',$1,0,'2026-09-27T12:00:00.000Z')`,[`sha256:${"0".repeat(64)}`]);
  const intake={...target("cr_prod_intake_guard","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  assert.deepEqual((await query(intake,"SELECT operation_scope FROM control_idempotency")).rows,[]);
  assert.deepEqual((await query(intake,"SELECT id FROM audit_events")).rows,[]);
  await assert.rejects(query(intake,`INSERT INTO control_idempotency
    (tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:intake-guard','other.operation/v1','attack-key-0001',$1,'processing')`,
    [`sha256:${"2".repeat(64)}`]),/work intake idempotency insert rejected/u);
  await assert.rejects(query(intake,`INSERT INTO audit_events
    (id,tenant_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at,
      chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    VALUES('audit:work-intake:forged','tenant:intake-guard','identity:other','agent','other.action',
      'project','project:other','{}'::jsonb,'2026-09-27T12:00:00.000Z',1,'month:2026-09',1,$1,$2,$3)`,
    [`sha256:${"3".repeat(64)}`,`sha256:${"0".repeat(64)}`,`sha256:${"4".repeat(64)}`]),
    /work intake audit event insert rejected/u);
  await assert.rejects(query(intake,`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:not-a-batch','tenant:intake-guard','project:intake-guard','other','approval','open',
      'delivered','2026-09-27T12:00:00.000Z','{}'::jsonb)`),/work batch notification insert rejected/u);
  await assert.rejects(query(intake,`UPDATE control_audit_chain_heads SET head_hash=$1,event_count=1
    WHERE tenant_id='tenant:intake-guard' AND chain_partition='month:2026-09'`,[`sha256:${"5".repeat(64)}`]),
    /work intake audit head update rejected/u);

  // Grants and the binding retain the group OID across a rename. Every guard
  // and restrictive policy must therefore remain active without matching the
  // group's original display name.
  await query(db,"ALTER ROLE control_room_work_intake RENAME TO control_room_work_intake_renamed");
  try {
    assert.deepEqual((await query(intake,"SELECT operation_scope FROM control_idempotency")).rows,[]);
    await assert.rejects(query(intake,`INSERT INTO control_idempotency
      (tenant_id,operation_scope,idempotency_key,request_digest,status)
      VALUES('tenant:intake-guard','other.operation/v1','renamed-key-0001',$1,'processing')`,
      [`sha256:${"a".repeat(64)}`]),/work intake idempotency insert rejected/u);
  } finally {
    await query(db,"ALTER ROLE control_room_work_intake_renamed RENAME TO control_room_work_intake");
  }

  await query(db,"GRANT control_room_work_intake TO control_room_scheduler");
  try {
    const alternate={...target("cr_prod_intake_guard","control_room_scheduler"),
      password:passwords.CONTROL_ROOM_SCHEDULER_PASSWORD};
    await assert.rejects(query(alternate,`INSERT INTO control_idempotency
      (tenant_id,operation_scope,idempotency_key,request_digest,status)
      VALUES('tenant:intake-guard','other.operation/v1','alternate-key-0001',$1,'processing')`,
      [`sha256:${"7".repeat(64)}`]),/work intake idempotency insert rejected/u);
  } finally { await query(db,"REVOKE control_room_work_intake FROM control_room_scheduler"); }

  const intakeDb=postgresDatabase(intake), store=new WorkBatchStoreV1(intakeDb,new Uint8Array(32).fill(8));
  const lockPrivileges=(await query(db,`SELECT
    has_column_privilege('control_room_work_intake','control_identities','web_lock','UPDATE') AS identity_lock,
    has_column_privilege('control_room_work_intake','control_role_grants','web_lock','UPDATE') AS grant_lock,
    has_column_privilege('control_room_work_intake','projects','coordinator_lock','UPDATE') AS project_lock,
    has_column_privilege('control_room_work_intake','control_identities','state','UPDATE') AS identity_state,
    has_column_privilege('control_room_work_intake','projects','domain_state','UPDATE') AS project_state`)).rows[0];
  assert.deepEqual(lockPrivileges,{identity_lock:true,grant_lock:true,project_lock:true,identity_state:false,project_state:false});
  const principal={tenantId:"tenant:intake-guard",identityId:"identity:intake-guard",actorType:"agent",
    authenticatedAt:"2026-09-27T11:00:00.000Z",expiresAt:"2027-09-27T12:00:00.000Z"};
  const positiveClient=new Client(intake); await positiveClient.connect();
  try {
    await positiveClient.query("BEGIN");
    const statements=[];
    const session={query:(sql,params=[])=>{statements.push(sql);return positiveClient.query(sql,params);}};
    const transactionalDb={query:session.query,transaction:callback=>callback(session),
      transactionWithPreCommitCheck:async(callback,check)=>{const value=await callback(session);await check();return value;}};
    const positiveStore=new WorkBatchStoreV1(transactionalDb,new Uint8Array(32).fill(8));
    const positiveProposal={schema:"control-room.work-batch-proposal/v1",projectId:"project:intake-guard",tasks:[{
      localId:"build",title:"Build",instructions:"Build the bounded change.",requiredCapability:"code.change",
      role:"builder",acceptanceCriteria:"The change is bounded.",acceptanceTests:"Run focused tests."}],edges:[]};
    const receipt=await positiveStore.create({principal,proposal:positiveProposal,
      proposalDigest:workBatchProposalDigestV1(positiveProposal),idempotencyKey:"positive-notification-0001",
      now:"2026-09-27T12:00:15.000Z",queueDepthLimit:10});
    assert.match(receipt.batchId,/^batch:/u);
    assert.equal(statements.filter(sql=>/^INSERT INTO control_action_inbox/iu.test(sql.trim())).length,1,
      "the successful real-PostgreSQL transaction issued one canonical notification insert");
  } finally {
    await positiveClient.query("ROLLBACK").catch(()=>{}); await positiveClient.end();
  }
  const auditCountBeforeNonAgent=(await query(intake,"SELECT count(*)::int AS count FROM audit_events")).rows[0].count;
  assert.deepEqual(await store.authorize({...principal,actorType:"human"},"project:intake-guard",
    "2026-09-27T12:00:30.000Z"),{allowed:false,safeReasonCode:"credential_inactive"});
  assert.equal((await query(intake,"SELECT count(*)::int AS count FROM audit_events")).rows[0].count,
    auditCountBeforeNonAgent,"non-agent refusal is not misattributed as intake-agent activity");
  assert.equal((await store.authorizeAction(principal,"project:intake-other","work_batches.propose",
    "2026-09-27T12:01:00.000Z")).allowed,false,"wrong-project refusal is recorded");
  await query(db,"UPDATE control_role_grants SET revoked_at='2026-09-27T12:01:30.000Z' WHERE id='grant:intake-guard'");
  assert.equal((await store.authorizeAction(principal,"project:intake-guard","work_batches.propose",
    "2026-09-27T12:02:00.000Z")).allowed,false,"revoked-grant refusal is recorded");
  await query(db,"UPDATE control_role_grants SET revoked_at=NULL,expires_at='2026-09-27T12:02:30.000Z' WHERE id='grant:intake-guard'");
  assert.equal((await store.authorizeAction(principal,"project:intake-guard","work_batches.propose",
    "2026-09-27T12:03:00.000Z")).allowed,false,"expired-grant refusal is recorded");
  await query(db,"UPDATE control_role_grants SET expires_at=NULL WHERE id='grant:intake-guard'; UPDATE control_identities SET state='suspended' WHERE id='identity:intake-guard'");
  assert.equal((await store.authorizeAction(principal,"project:intake-guard","work_batches.propose",
    "2026-09-27T12:04:00.000Z")).allowed,false,"inactive-identity refusal is recorded");
  const verified=await new AuditStore(intakeDb).verify("tenant:intake-guard","month:2026-09");
  assert.equal(verified.valid,true); assert.equal(verified.checkedEvents,4);

  await query(db,`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:ordinary','tenant:intake-guard','project:intake-guard','ordinary','question','open',
      'delivered','2026-09-27T12:04:30.000Z','{"state":"open"}'::jsonb)`);
  const privateWebClient=new Client(db);
  await privateWebClient.connect();
  try {
    // Role definitions are cluster-global. Install this probe transactionally so
    // the later role-matrix attack test observes a clean cluster.
    await privateWebClient.query("BEGIN");
    await privateWebClient.query((await readFile(join(ROOT,"db/roles/private_web_roles.sql"),"utf8"))
      .replace(/^(?:BEGIN|COMMIT);$/gmu,""));
    await privateWebClient.query("SET LOCAL ROLE control_room_private_web");
    await assert.rejects(privateWebClient.query(`UPDATE control_action_inbox
      SET state='resolved',payload='{"state":"resolved"}'::jsonb
      WHERE tenant_id='tenant:intake-guard' AND id='attention:ordinary'`),
    /work batch notification update rejected/u);
  } finally {
    await privateWebClient.query("ROLLBACK").catch(()=>{});
    await privateWebClient.end();
  }
  assert.equal((await query(db,`SELECT state FROM control_action_inbox
    WHERE tenant_id='tenant:intake-guard' AND id='attention:ordinary'`)).rows[0].state,"open");
  await query(db,"DELETE FROM control_action_inbox WHERE tenant_id='tenant:intake-guard' AND id='attention:ordinary'");

  const head=(await query(intake,`SELECT head_hash,event_count::int FROM control_audit_chain_heads
    WHERE tenant_id='tenant:intake-guard' AND chain_partition='month:2026-09'`)).rows[0];
  const orphanMaterial={id:"audit:work-intake-refusal:orphan",tenantId:"tenant:intake-guard",workspaceId:null,
    projectId:"project:intake-guard",actorId:"identity:intake-guard",actorType:"agent",
    action:"work_batches.propose.refused",targetType:"project",targetId:"project:intake-guard",
    correlationId:null,idempotencyKey:null,safeMetadata:{reasonCode:"no_matching_grant"},
    occurredAt:"2026-09-27T12:05:00.000Z"};
  const orphanDigest=sha256Digest(orphanMaterial), orphanSequence=head.event_count+1;
  const orphanHash=sha256Digest({chainVersion:1,partition:"month:2026-09",sequence:orphanSequence,
    previousHash:head.head_hash,eventDigest:orphanDigest});
  await assert.rejects(query(intake,`INSERT INTO audit_events
    (id,tenant_id,project_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at,
      chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    VALUES($1,'tenant:intake-guard','project:intake-guard','identity:intake-guard','agent',
      'work_batches.propose.refused','project','project:intake-guard',$2::jsonb,
      '2026-09-27T12:05:00.000Z',1,'month:2026-09',$3,$4,$5,$6)`,
    [orphanMaterial.id,JSON.stringify(orphanMaterial.safeMetadata),orphanSequence,
      `sha256:${"8".repeat(64)}`,head.head_hash,`sha256:${"9".repeat(64)}`]),/work intake audit hash rejected/u);
  await assert.rejects(query(intake,`INSERT INTO audit_events
    (id,tenant_id,project_id,actor_id,actor_type,action,target_type,target_id,safe_metadata,occurred_at,
      chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    SELECT 'audit:work-intake-refusal:orphan','tenant:intake-guard','project:intake-guard',
      'identity:intake-guard','agent','work_batches.propose.refused','project','project:intake-guard',$1::jsonb,
      '2026-09-27T12:05:00.000Z',1,'month:2026-09',$2,$3,$4,$5`,
    [JSON.stringify(orphanMaterial.safeMetadata),orphanSequence,orphanDigest,head.head_hash,orphanHash]),
    /committed without head advance/u);

  const queueDown=await readFile(join(ROOT,"db/down/0104_work_batch_agent_queue.sql"),"utf8");
  const ownerDown=await readFile(join(ROOT,"db/down/0102_work_batch_owner_approval.sql"),"utf8");
  const down=await readFile(join(ROOT,"db/down/0093_work_batch_intake.sql"),"utf8");
  // Every migration that attached anything to what 0093 drops has to be rolled
  // back first, or PostgreSQL refuses with 2BP01. Which migrations those is
  // DERIVED from the shipped up and down files — the dependency lives in what a
  // migration creates and in what the reversed migration removes, not in a list
  // that goes stale the moment the next slice lands.
  //
  // Four dependencies, and deriving only the first is what broke this teardown
  // three times:
  //
  //   1. A row-level policy, trigger or view READING work_intake_tenant_binding.
  //      0155 added `installation_operations_mode_revisions_work_intake_scope`
  //      and the teardown began failing with a dependency error naming a
  //      migration the test had never heard of.
  //   2. A FOREIGN KEY pointing AT a table 0093 drops. 0110 declares
  //      `FOREIGN KEY (tenant_id,batch_id,project_id) REFERENCES
  //      work_batches(tenant_id,id,project_id)`, so its
  //      `work_batch_intake_flag_dismissals` table holds a constraint on
  //      work_batches even though its up file never mentions the binding
  //      table. Deriving on the binding name alone therefore left 0110 out and
  //      `DROP TABLE work_batches` failed with
  //      `2BP01 cannot drop table work_batches because other objects depend on
  //      it`, naming no migration.
  //   3. A trigger's EXECUTE FUNCTION naming a function an earlier down file
  //      drops. S7b's 0151 and 0153 build their append-only triggers on 0109's
  //      `reject_pipeline_unattended_history_mutation()`, so 0109's own guard
  //      refused with `pipeline unattended down migration refused: a later
  //      migration depends on its history guard` — a correct refusal pointed at
  //      no migration, because 0151 and 0153 were not in the order.
  //   4. An ALTER TABLE against a table one of the reversed migrations drops.
  //      0152 and 0154 add columns to 0109's `pipeline_advance_receipts`, so
  //      reversing 0109 first would leave them holding a column on a table that
  //      is gone.
  //
  // `dependentMigrationsV1` closes over the whole set, newest first, so nothing
  // still reading the binding is attached to it when 0093 drops the table, and
  // nothing is still built on 0109's function when 0109's down runs. Only down
  // files that exist are applied, and 0093 itself is the table being dropped.
  const INTAKE_TABLES = ["work_intake_tenant_binding", "work_batches", "work_batch_revisions"];
  const explicitlyRolledBack = ["0109_pipeline_unattended_advance.sql", "0108_pipeline_build_publications.sql",
    "0104_work_batch_agent_queue.sql", "0102_work_batch_owner_approval.sql"];
  const intakeBindingDeps = (await dependentMigrationsV1(["0093_work_batch_intake.sql"]))
    .filter(file => file !== "0093_work_batch_intake.sql" && !explicitlyRolledBack.includes(file))
    .reverse();
  assert.ok(intakeBindingDeps.length>0,
    "no migration's up file depends on the work-intake tables; the teardown order is wrong");
  // The derivation has to stay a comparison rather than an assumption. Each of
  // the three shapes above was a real failure, and each is named so the
  // derivation is proven to have found it. A future migration adding the same
  // shape is found by the derivation, and these keep proving it did.
  const intakeUpt = new Map(shippedLedger.map(entry => [entry.file, entry.up]));
  for (const [file, shape] of [
    ["0110_work_batch_intake_flag_dismissals.sql", /REFERENCES\s+work_batches\b/u],
    ["0151_pipeline_stage_loop_counts.sql", /EXECUTE FUNCTION\s+(?:public\.)?reject_pipeline_unattended_history_mutation\s*\(/u],
    ["0152_pipeline_advance_unknown_cost.sql", /ALTER TABLE\s+pipeline_advance_receipts\b/u],
    ["0155_installation_operations_modes.sql", /work_intake_tenant_binding/u]]) {
    assert.ok(intakeBindingDeps.includes(file), `${file} was not derived: the teardown order is wrong`);
    assert.match(intakeUpt.get(file) ?? "", shape, `${file} no longer has the dependency it was derived for`);
  }
  await query(db,"CREATE POLICY test_dependent_policy ON audit_events AS RESTRICTIVE USING (true)");
  await assert.rejects(query(db,down),/shared-ledger RLS policies depend on it/u);
  const retained=(await query(db,`SELECT
    has_column_privilege('control_room_work_intake','control_idempotency','status','UPDATE') AS column_update,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname='control_idempotency_work_intake_guard' AND NOT tgisinternal) AS guard_count,
    (SELECT count(*)::int FROM pg_policies WHERE policyname='audit_events_work_intake_scope') AS policy_count`)).rows[0];
  assert.deepEqual(retained,{column_update:true,guard_count:1,policy_count:1});
  await query(db,"DROP POLICY test_dependent_policy ON audit_events");
  // The derived dependants, newest first, so nothing still reading
  // work_intake_tenant_binding, and nothing still built on 0109's history
  // guard, is attached when the migrations that own them are reversed.
  for (const file of [...intakeBindingDeps, "0109_pipeline_unattended_advance.sql",
    "0108_pipeline_build_publications.sql"]) await query(db, await readFile(join(ROOT, "db/down", file), "utf8"));
  await query(db,queueDown);
  await query(db,ownerDown);
  // Nothing from the derived set may still be attached to the relations 0093
  // drops, so the base teardown below is the assertion that the order was
  // complete rather than merely successful.
  const restoredSearchPath=(await query(db,`SELECT proconfig FROM pg_proc
    WHERE oid='public.guard_initial_work_batch_revision_insert()'::regprocedure`)).rows[0]?.proconfig;
  assert.deepEqual(restoredSearchPath,["search_path=pg_catalog, public, pg_temp"]);
  await query(db,down);
  // Nothing the derived set owned may still be attached once 0093 has gone.
  // This runs AFTER 0093's own down, so it is the whole set's state and not
  // 0093's, and the guard function is counted by name rather than by
  // `::regprocedure`, which would now raise on the function 0109 dropped.
  const stillAttached=(await query(db,`SELECT
    (SELECT count(*)::int FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname='reject_pipeline_unattended_history_mutation') AS guard_triggers,
    (SELECT count(*)::int FROM pg_policies WHERE policyname LIKE '%\_work\_intake\_scope'
      AND tablename NOT IN ('control_idempotency','audit_events')) AS intake_policies,
    (SELECT count(*)::int FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.confrelid
      WHERE con.contype='f' AND rel.relname IN ('work_batches','work_batch_revisions','work_intake_tenant_binding'))
      AS batch_keys,
    (SELECT count(*)::int FROM pg_class WHERE relname IN ('pipeline_stage_loop_counts',
      'pipeline_machine_capacity_observations','pipeline_installation_allowances')) AS s7b_relations`)).rows[0];
  assert.deepEqual(stillAttached,{guard_triggers:0,intake_policies:0,batch_keys:0,s7b_relations:0});
  const remaining=(await query(db,`SELECT
    has_table_privilege('control_room_work_intake','control_idempotency','SELECT') AS table_select,
    has_column_privilege('control_room_work_intake','control_idempotency','status','UPDATE') AS column_update,
    has_column_privilege('control_room_work_intake','control_audit_chain_heads','head_hash','UPDATE') AS head_update,
    has_column_privilege('control_room_work_intake','control_identities','web_lock','UPDATE') AS identity_lock,
    has_column_privilege('control_room_work_intake','projects','coordinator_lock','UPDATE') AS project_lock`)).rows[0];
  assert.deepEqual(remaining,{table_select:false,column_update:false,head_update:false,identity_lock:false,project_lock:false});
  await assert.rejects(query(intake,"SELECT * FROM control_idempotency"),/permission denied/u);
});

// A fully migrated database with the Mac-local logins the real narrow-role
// installer creates from the real role files, each on a private-pool client
// with production session settings.
async function withMacLocalLogins(database,callback){
  await freshDatabase(database);
  const admin=target(database), client=postgresDatabase(admin);
  await applyMigrations({target:admin,bootstrapTarget:bootstrapTarget(database),migrateTarget:migrateTarget(database),
    rootDir:ROOT,env:{...process.env,...passwords}});
  // The Mac-local login set comes from the role plan the installer itself
  // provisions from, never from a list restated here.
  // `provisionMacLocalNarrowRolesV1` refuses any password set that is not
  // exactly its plan's logins (`narrow_role_login_set_refused`), so a
  // restatement goes stale the moment the plan gains a login — which is
  // exactly what happened when 0140/0141 added the two fleet logins, and it
  // failed sixteen of these tests at once with an error that says nothing
  // about the login set.
  const logins=Object.keys(macRolePlan);
  assert.ok(logins.length>0, "the Mac role plan names no logins");
  const loginPasswords=Object.fromEntries(logins.map((name,index)=>[name,`${index}`.repeat(40)]));
  // The installer's fixed queue shape assumes the cluster superuser is named
  // postgres, as on the documented Mac cluster (see the journey test below).
  const createdPostgres=!(await query(admin,"SELECT 1 FROM pg_roles WHERE rolname='postgres'")).rows.length;
  if (createdPostgres) await query(admin,"CREATE ROLE postgres SUPERUSER LOGIN");
  // Every role the plan installs, logins and the groups they inherit, is
  // dropped afterwards, so a later test in this cluster cannot inherit one.
  const macRoles=[...logins,...new Set(Object.values(macRolePlan))];
  // Roles are cluster-wide: the installer refuses any that already exist, and
  // later tests in this cluster must not inherit these logins.
  assert.deepEqual((await query(admin,"SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",[macRoles])).rows,[]);
  const pools=[];
  const provisioner=new Client(target(database,"postgres")); await provisioner.connect();
  try { await provisionMacLocalNarrowRolesV1(provisioner,loginPasswords); } finally { await provisioner.end(); }
  const login=name=>{
    const config={host:"127.0.0.1",port:PORT,database,username:name,password:loginPasswords[name],majorVersion:17};
    const bound=bindPrivatePgPool(new Pool({...privatePgOptions(config),host:socket}));
    // `direct` is the same login on a plain client, which keeps the server's
    // refusal text that the private driver deliberately withholds.
    pools.push(bound); return {config,db:bound.client,direct:postgresDatabase({...target(database,name),password:loginPasswords[name]})};
  };
  try {
    await callback({client,login});
  } finally {
    await Promise.all(pools.map(pool=>pool.close()));
    await query(adminDb(),`DROP DATABASE ${database}`);
    for (const role of [...macRoles,...createdPostgres ? ["postgres"] : []]) await query(adminDb(),`DROP ROLE IF EXISTS ${role}`);
  }
}

// Every S5 statement runs on the Mac-local login that executes it in
// production (mac-local-default-task-provider.ts, codex-results.ts,
// native-result-submission.ts).
test("S5 agent-review reads and writes run on the Mac-local production logins", needsPg, () =>
  withMacLocalLogins("cr_agent_review_logins",async({client,login})=>{
    const coordinator=login("control_room_coordinator"), reviewer=login("control_room_agent_reviewer_login");
    const results=login("control_room_results"), publisher=login("control_room_publisher");
    const at=new Date(webNow).toISOString(), reviewKey=new Uint8Array(32).fill(54);
    const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true});
    // The coordinator login creates the plan (the plan-binding trigger runs as it).
    const own=await seedAgentReviewTenant(client,"logins",reviewKey,checkpoints,at,coordinator.db);
    await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[own.tenantId]);
    // The reviewer's startup preflight accepts the real provisioned database.
    await verifyAgentReviewerDatabase(reviewer.db,reviewer.config,{tenantId:own.tenantId,workspaceId:own.workspaceId,
      ownerIdentityId:"identity:web-logins",issuer:webTrust.issuer},Date.now(),{nativeQueue:true});
    const committed=await new AgentReviewServiceV1(reviewer.db,own.tenantId,reviewKey,checkpoints,own.routes,()=>at)
      .record({planId:own.plan.planId,decision:"changes_requested",assessedRisk:"medium",
        evidenceDigests:[sha256Digest("probe evidence")],findingStatementDigest:sha256Digest("probe finding")});
    assert.equal(committed.review.effectiveRisk,"critical");
    assert.deepEqual(committed.review.findingIds,[own.plan.findingId]);
    await own.gate.verifyProvisionedTenantV1(own.tenantId);
    // The producer-principal reads S5 added to result publication and submission.
    const attemptId="attempt:review-logins", checkJob=own.pipeline.jobIds[1];
    for (const [name,db] of [["coordinator",coordinator.db],["results",results.db],["publisher",publisher.db]]) {
      assert.deepEqual((await db.query("SELECT job_id,node_id,worker_id FROM control_attempts WHERE tenant_id=$1 AND id=$2",
        [own.tenantId,attemptId])).rows,[{job_id:checkJob,node_id:"node:check:logins",worker_id:"worker:check:logins"}],name);
      assert.equal((await db.query("SELECT model,effort FROM control_task_model_selections WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3",
        [own.tenantId,own.project.projectId,checkJob])).rows.length,1,name);
    }
  }));

// The build stage's retained execution: the attempt, harness run, verified
// artifact and canonical Codex result that the Completion Gate accepted.
// `deferResultRows` omits the artifact manifest and receipt, for the caller that
// writes a receipt the real result store can verify. Both relations are
// append-only, so such a row cannot be corrected after the fact.
async function seedBuildExecution(client,own,suffix,at,{deferResultRows=false}={}){
  const tenantId=own.tenantId, projectId=own.project.projectId, jobId=own.pipeline.jobIds[0];
  const nodeId=`node:build:${suffix}`, workerId=`worker:build:${suffix}`, attemptId=`attempt:build-${suffix}`;
  const runId=`run:build-${suffix}`, artifactId=`artifact:build-${suffix}`, contentHash=own.targetRecord.subjectDigest;
  await client.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',1,'key:build',$3::jsonb,$4,$4)`,
  [nodeId,tenantId,JSON.stringify({id:nodeId,tenantId,state:"active",version:1,identityKeyId:"key:build"}),at]);
  await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,'succeeded',1,$4,$5,1,$6::jsonb,$7,$7)`,
  [attemptId,tenantId,jobId,workerId,nodeId,JSON.stringify({id:attemptId,tenantId,state:"succeeded",version:1,jobId,
    attemptNumber:1,workerId,nodeId,leaseEpoch:1}),at]);
  await client.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,
    native_session_key_digest,parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
    VALUES($1,$2,$3,$4,$5,$6,'connector:codex-owner-trusted-local-v1','codex',$7,NULL,NULL,'succeeded',1,$8,$9,'{}'::jsonb,$10,$10,$10)`,
  [runId,tenantId,projectId,jobId,attemptId,nodeId,`sha256:${"4".repeat(64)}`,`sha256:${"5".repeat(64)}`,
    `hmac-sha256:${"6".repeat(64)}`,at]);
  if(!deferResultRows){
    await client.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,content_hash,
      state,version,payload,created_at,updated_at) VALUES($1,$2,$3,NULL,$4,$5,$6,'verified',1,$7::jsonb,$8,$8)`,
    [artifactId,tenantId,projectId,jobId,attemptId,contentHash,JSON.stringify({id:artifactId,tenantId,state:"verified",
      version:1,projectId,jobId,attemptId,contentHash}),at]);
    await client.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,
      receipt,auth_tag) VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7)`,
    [tenantId,projectId,jobId,attemptId,runId,artifactId,`hmac-sha256:${"7".repeat(64)}`]);
  }
  const publicationId=`publication:build-${suffix}`, recordDigest=sha256Digest(`canonical ${suffix}`);
  await client.query(`INSERT INTO control_codex_result_publications(tenant_id,project_id,job_id,attempt_id,run_id,publication_id,
    record_digest,record,auth_tag,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
  [tenantId,projectId,jobId,attemptId,runId,publicationId,recordDigest,JSON.stringify({
    schema:"control-room.codex-canonical-result-record/v1",recordDigest,
    publication:{publicationId,identity:{tenantId,projectId,jobId,attemptId,runId}}}),`hmac-sha256:${"8".repeat(64)}`,at]);
  return {jobId,nodeId,workerId,attemptId,runId,artifactId,contentHash};
}

// A worker-custody plan and evidence pair for one retained build, signed with
// the evidence key exactly as createPullRequestPublisherV1 signs it.
function signedBuildPublication(key,{snapshot,deliveryDigest,modelSelection,commitDigest,url}){
  const planMaterial={schema:"control-room.pull-request-publication-plan/v1",deliveryDigest,
    worktreeLeaseDigest:sha256Digest("lease"),worktreeAuditPlanDigest:sha256Digest("audit plan"),
    worktreeAuditEvidenceDigest:sha256Digest("audit evidence"),commitDigest,repositoryUrl:snapshot.repositoryUrl,
    modelSelection,retainedResultDigest:snapshot.retainedResultDigest,
    publicationContentDigest:sha256Digest({title:snapshot.title,body:snapshot.body}),
    authoritySnapshotDigest:snapshot.snapshotDigest};
  const signedPlan={...planMaterial,planDigest:sha256Digest(planMaterial)};
  const plan={...signedPlan,authenticationTag:hmacSha256Tag(key,{purpose:"pull-request-publication-plan/v1",value:signedPlan})};
  const evidenceMaterial={schema:"control-room.pull-request-publication-evidence/v1",planDigest:plan.planDigest,
    deliveryDigest,worktreeAuditEvidenceDigest:plan.worktreeAuditEvidenceDigest,
    retainedResultDigest:plan.retainedResultDigest,url,commitDigest,modelSelection,usage:"unknown"};
  const evidenceDigest=sha256Digest(evidenceMaterial);
  const evidence={...evidenceMaterial,evidenceDigest,authenticationTag:hmacSha256Tag(key,
    {purpose:"pull-request-publication-evidence/v1",value:{...evidenceMaterial,evidenceDigest}})};
  return {plan,evidence};
}

// Every S6 statement runs on the Mac-local login that executes it in
// production: private-task-application.ts builds the publication controller
// on the coordinator pool, and private-process.ts builds the run view on the
// web pool. The retained record then stays out of the shared intake login.
test("S6 build publication runs on the Mac-local production logins and stays tenant-bound", needsPg, () =>
  withMacLocalLogins("cr_build_publication_logins",async({client,login})=>{
    const coordinator=login("control_room_coordinator"), web=login("control_room_web");
    const at=new Date(webNow).toISOString(), key=new Uint8Array(32).fill(56);
    const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true});
    const own=await seedAgentReviewTenant(client,"publish",key,checkpoints,at);
    const build=await seedBuildExecution(client,own,"publish",at);
    const scope={tenantId:own.tenantId,workspaceId:own.workspaceId};
    const repositoryUrl="https://example.invalid/controller/repository";
    const proof={executionJobId:build.jobId,attemptId:build.attemptId,harnessRunId:build.runId,
      artifactId:build.artifactId,contentHash:build.contentHash,revision:1};
    const selection={assertCurrent:()=>true,isAcceptedResultCurrent:()=>true,acceptedResultProof:async()=>proof};
    const controller=new LinearPipelineServiceV1(coordinator.db,scope,key,selection,()=>webNow,
      {resolve:async()=>({repositoryUrl})});
    const delivery=createControllerWorkerDeliveryV1({identity:{tenantId:own.tenantId,projectId:own.project.projectId,
      jobId:build.jobId,attemptId:build.attemptId,runId:build.runId,nodeId:build.nodeId},
    worker:{workerId:build.workerId,adapterId:"adapter:test",adapterRevision:"1234567"},
    input:{prompt:"Build.",instructions:"Commit bounded work."},authorityDigest:sha256Digest("authority"),
    connectorProfileDigest:sha256Digest("profile"),acceptanceProfileId:own.profile.id,
    acceptanceProfileDigest:sha256Digest(own.profile),issuedAt:at,expiresAt:new Date(webNow+3_600_000).toISOString()});
    const snapshot=await controller.createBuildPublicationAuthority(delivery);
    assert.deepEqual([snapshot.allowedPaths,snapshot.maximumChangedFiles,snapshot.maximumChangedBytes],
      [["src/**"],10,100_000]);
    await controller.assertBuildPublicationAuthorityCurrent(snapshot);
    const {plan,evidence}=signedBuildPublication(derivePipelineBuildPublicationEvidenceKeyV1(key),{snapshot,
      deliveryDigest:delivery.deliveryDigest,modelSelection:{workerId:build.workerId,model:"build-test",effort:"medium"},
      commitDigest:"b".repeat(40),url:`${repositoryUrl}/pull/7`});
    assert.deepEqual(await controller.retainBuildPublication({snapshot,plan,evidence}),
      {evidenceDigest:evidence.evidenceDigest,replayed:false});
    assert.deepEqual(await controller.retainBuildPublication({snapshot,plan,evidence}),
      {evidenceDigest:evidence.evidenceDigest,replayed:true});
    const retained={url:evidence.url,commitDigest:evidence.commitDigest,modelSelection:evidence.modelSelection,
      usage:"unknown",evidenceDigest:evidence.evidenceDigest};
    assert.deepEqual(await controller.readRetainedBuildPublication(delivery.deliveryDigest),retained);
    const identity=createAccessVerifier(webTrust)(webRequest(),webNow);
    const view=await new LinearPipelineServiceV1(web.db,scope,key,selection,()=>webNow)
      .view(identity,own.project.projectId,own.pipeline.runId);
    assert.deepEqual(view.stages[0].pullRequestEvidence,retained);
    assert.deepEqual(view.stages[0].writePolicy,{allowedPaths:["src/**"],maximumChangedFiles:10,maximumChangedBytes:100_000});

    // The retained record is append-only and the stage bound is write-once,
    // whatever login or grant attempts the change.
    await assert.rejects(coordinator.direct.query("UPDATE control_pipeline_build_publications SET recorded_at=now()"),
      /permission denied/u);
    await assert.rejects(web.direct.query(`INSERT INTO control_pipeline_build_publications
      SELECT * FROM control_pipeline_build_publications`),/permission denied/u);
    for (const agent of [coordinator,web])
      await assert.rejects(agent.direct.query("UPDATE pipeline_stage_runs SET maximum_changed_files=500"),/permission denied/u);
    await assert.rejects(client.query("UPDATE pipeline_stage_runs SET maximum_changed_files=500 WHERE tenant_id=$1",
      [own.tenantId]),/pipeline stage immutable selection rejected/u);
    await assert.rejects(client.query("DELETE FROM control_pipeline_build_publications"),/append-only/u);

    // The shared intake login holds no grant. Were one ever added, the tenant
    // binding would still hide every other tenant's publication.
    const intake={...target("cr_build_publication_logins","control_room_work_intake_agent"),
      password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
    await assert.rejects(query(intake,"SELECT tenant_id FROM control_pipeline_build_publications"),/permission denied/u);
    await client.query("INSERT INTO tenants(id,display_name) VALUES('tenant:publish-other','Other tenant')");
    await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:publish-other')");
    await client.query("GRANT SELECT ON control_pipeline_build_publications TO control_room_work_intake");
    try {
      assert.deepEqual((await query(intake,"SELECT tenant_id FROM control_pipeline_build_publications")).rows,[]);
      await client.query("DELETE FROM work_intake_tenant_binding");
      assert.deepEqual((await query(intake,"SELECT tenant_id FROM control_pipeline_build_publications")).rows,[]);
      await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[own.tenantId]);
      assert.deepEqual((await query(intake,"SELECT tenant_id FROM control_pipeline_build_publications")).rows,
        [{tenant_id:own.tenantId}]);
    } finally {
      await client.query("REVOKE SELECT ON control_pipeline_build_publications FROM control_room_work_intake");
      await client.query("DELETE FROM work_intake_tenant_binding");
    }
  }));

// An owner delegation policy and the active coordinator head it is bound to,
// for the S7 advance path.
async function seedAdvancePolicy(client,own,policyId,at){
  const identityId="identity:web-advance", owner=sha256Digest(identityId);
  await client.query(`INSERT INTO control_project_coordinator_heads(tenant_id,project_id,state,coordinator_identity_id,
    coordinator_actor_type,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
    VALUES($1,$2,'active',$3,'human',$3,1,$4,$4,'{}')`,[own.tenantId,own.project.projectId,identityId,at]);
  await client.query(`INSERT INTO control_project_delegation_policies(tenant_id,id,project_id,coordinator_identity_id,
    coordinator_version,state,version,policy_digest,owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,
    risk_ceiling,effect_ceiling,max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,
    created_at,updated_at) VALUES($1,$2,$3,$4,1,'active',1,$5,$4,$5,'["tasks.assign"]',
    '["node:build:advance","node:check:advance","node:validate:advance"]','low','none',
    3,1000,2,$6,$7,'{}',$6,$6)`,[own.tenantId,policyId,own.project.projectId,identityId,owner,
    new Date(webNow-1000).toISOString(),new Date(webNow+600_000).toISOString()]);
}

// Every S7 statement runs on the Mac-local login that executes it in
// production: private-process.ts builds the owner consent and history routes
// on the web pool, and task-coordinator-lifecycle.ts builds the advance and
// the bounded sweep on the coordinator pool. Row locks need UPDATE privilege,
// so a lock the login may not take fails here and nowhere else.
test("S7 unattended consent, advance, sweep and history run on the Mac-local production logins", needsPg, () =>
  withMacLocalLogins("cr_unattended_logins",async({client,login})=>{
    const coordinator=login("control_room_coordinator"), web=login("control_room_web");
    const at=new Date(webNow).toISOString(), key=new Uint8Array(32).fill(57);
    const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true});
    const own=await seedAgentReviewTenant(client,"advance",key,checkpoints,at);
    const scope={tenantId:own.tenantId,workspaceId:own.workspaceId}, projectId=own.project.projectId;
    const runId=own.pipeline.runId, buildJob=own.pipeline.jobIds[0];
    await seedAdvancePolicy(client,own,"policy:advance",at);
    // Both logins' startup preflights accept the real installed grants,
    // including S7's column grants and its two tables.
    const preflightScope={tenantId:own.tenantId,workspaceId:own.workspaceId,ownerIdentityId:"identity:web-advance",
      issuer:webTrust.issuer};
    await verifyPrivateDatabase(web.db,web.config,preflightScope,Date.now(),{nativeQueue:true});
    await verifyTaskCoordinatorDatabase(coordinator.db,coordinator.config,preflightScope,Date.now(),{nativeQueue:true});
    const identity=createAccessVerifier(webTrust)(webRequest(),webNow);
    const view=await new LinearPipelineServiceV1(web.db,scope,key,{assertCurrent:()=>true,isAcceptedResultCurrent:()=>false},
      ()=>webNow).view(identity,projectId,runId);

    // Owner consent on the web login, then an exact replay.
    const owner=new PipelineAdvanceServiceV1(web.db,scope,key,{},()=>webNow);
    const command={runId,templateId:view.templateId,policyId:"policy:advance",enabled:true,
      expectedRunVersion:view.runVersion,expectedTemplateVersion:view.templateVersion};
    const consent=await owner.setUnattended(identity,projectId,command,"pipeline-unattended-logins-0001");
    assert.equal(consent.replayed,false);
    assert.equal((await owner.setUnattended(identity,projectId,command,"pipeline-unattended-logins-0001")).replayed,true);

    // S7b made the installation allowance a prerequisite of every advance, so
    // the owner sets the ceilings before the coordinator claims anything. This
    // is the same owner operation the Mac-local pipeline run page drives, and
    // the only writer of the column grants this test's preflight just verified.
    // The cluster count is the owner's own report; nothing in the system can
    // observe a host-level postmaster.
    const allowance=await owner.setAllowance(identity,{runsPerHour:6,runsPerAgentPerDay:12,
      machineMaxAgentProcesses:12,machineMaxDbClusters:6,dollarCapMicroUsd:null,observedDbClusters:1});
    assert.deepEqual([allowance.allowanceVersion,allowance.replayed,allowance.recordedDbClusters,allowance.startsWork],
      [1,false,1,false]);
    // Reading it back is a replay, not a second write: the owner sees their own
    // signed record, and the web login may never claim it wrote work.
    assert.deepEqual((await owner.allowance()).replayed,true);

    // The coordinator advances stage 0 through the production read authority.
    // Assignment and the native queue are the existing protected composition,
    // so they are stubbed to one real attempt row.
    // The coordinator advances each stage through the production read
    // authority. The Completion Gate acceptance, assignment and the native
    // queue are the existing protected composition, so they are stubbed: the
    // stub accepts the stages in `accepted` and returns one real attempt row.
    const [,checkJob,signoffJob]=own.pipeline.jobIds;
    await client.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
      VALUES($1,$2,$3,$3,'{}'::jsonb,$4)`,[own.tenantId,projectId,signoffJob,`hmac-sha256:${"9".repeat(64)}`]);
    const attempts=new Map();
    for (const [job,stage] of [[buildJob,"build"],[signoffJob,"validate"]]) {
      const nodeId=`node:${stage}:advance`, workerId=`worker:${stage}:advance`, attemptId=`attempt:${stage}-advance`;
      await client.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
        VALUES($1,$2,'active',1,'key:stage',$3::jsonb,$4,$4)`,
      [nodeId,own.tenantId,JSON.stringify({id:nodeId,tenantId:own.tenantId,state:"active",version:1,identityKeyId:"key:stage"}),at]);
      await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,
        payload,created_at,updated_at) VALUES($1,$2,$3,1,'offered',1,$4,$5,1,$6::jsonb,$7,$7)`,
      [attemptId,own.tenantId,job,workerId,nodeId,JSON.stringify({id:attemptId,tenantId:own.tenantId,state:"offered",version:1,
        jobId:job,attemptNumber:1,workerId,nodeId,leaseEpoch:1}),at]);
      attempts.set(job,attemptId);
    }
    attempts.set(checkJob,"attempt:review-advance");
    const accepted=new Set();
    let queued=0;
    const supporting=new ProductionPipelineAdvanceAuthorityV1(scope,{assertCurrent:()=>true},
      {acceptedResultProof:async(_tx,value)=>accepted.has(value.sourceJobId)?{executionJobId:value.sourceJobId}:null,
        isAcceptedResultCurrent:async(_tx,value)=>accepted.has(value.sourceJobId)},
      {currentCost:async()=>({kind:"known",admittedCostMicroUsd:10,evidenceDigest:sha256Digest("cost")})},()=>webNow);
    const capability=new ProductionPipelineAdvanceCapabilityV1(supporting,
      {assignScheduledInSession:async(_tx,value)=>({receipt:{attemptId:attempts.get(value.jobId),
        leaseId:`lease:${value.jobId}`,leaseEpoch:1},replayed:false})},
      {enqueueAssignedInSession:async()=>{queued+=1;return {queueId:`queue:advance-logins-${queued}`,replayed:false};}});
    const advance=new PipelineAdvanceServiceV1(coordinator.db,scope,key,{unattendedEnabled:()=>true,capability},()=>webNow);
    const receipt=await advance.advance(runId,"policy:advance");
    assert.deepEqual([receipt.startsWork,receipt.stageOrdinal,receipt.jobId,receipt.attemptId,receipt.replayed],
      [true,0,buildJob,"attempt:build-advance",false]);
    // The bounded sweep selects the consented run, moves its cursor and
    // replays the stored receipt without a second queue effect.
    const swept=await advance.advanceReady(8);
    assert.equal(swept.checked,1);
    assert.deepEqual(swept.advanced.map(value=>[value.stageOrdinal,value.replayed]),[[0,true]]);
    assert.equal(queued,1);
    assert.notEqual((await client.query("SELECT unattended_last_swept_at FROM pipeline_runs WHERE id=$1",[runId]))
      .rows[0].unattended_last_swept_at,null);
    // A later stage's acceptance cannot skip the unaccepted current stage:
    // the run stays on stage 0 and replays its receipt.
    accepted.add(checkJob);
    assert.deepEqual(await advance.advance(runId,"policy:advance").then(value=>[value.stageOrdinal,value.replayed]),[0,true]);
    accepted.delete(checkJob);
    // The coordinator login may write the run's ordinal column, but an
    // unsigned move is refused before any stage is resolved or queued.
    const signed=(await client.query("SELECT current_stage_ordinal FROM pipeline_runs WHERE id=$1",[runId])).rows[0];
    await coordinator.direct.query("UPDATE pipeline_runs SET current_stage_ordinal=2 WHERE id=$1",[runId]);
    await assert.rejects(advance.advance(runId,"policy:advance"),error=>error.safeReason==="pipeline_integrity_failed");
    await coordinator.direct.query("UPDATE pipeline_runs SET current_stage_ordinal=$2 WHERE id=$1",
      [runId,signed.current_stage_ordinal]);
    // The sweep cursor is the one unsigned column; moving it only reorders
    // sweeps and never authorizes anything.
    await coordinator.direct.query("UPDATE pipeline_runs SET unattended_last_swept_at='1970-01-01' WHERE id=$1",[runId]);
    assert.equal(queued,1);
    // Each accepted stage moves the run exactly one ordinal, checking the
    // predecessor edge; the accepted final stage completes the run.
    accepted.add(buildJob);
    assert.deepEqual(await advance.advance(runId,"policy:advance").then(value=>[value.stageOrdinal,value.jobId]),[1,checkJob]);
    // A stored ceiling the service cannot re-verify is not a ceiling, and the
    // OWNER's own read proves it on the login the owner reads it on. 0150's
    // write guard is satisfied here — the version moves forward one step and the
    // timestamp does not go back — so only re-verification of the signed
    // material can catch a forged digest and tag. The advance path re-verifies
    // the same record inside its transaction (proven by the caps lane), so one
    // forged ceiling cannot be read, reported or enforced.
    const ceilings=await client.query(`SELECT runs_per_hour FROM pipeline_installation_allowances
      WHERE tenant_id=$1 AND workspace_id=$2`,[own.tenantId,own.workspaceId]);
    assert.deepEqual(ceilings.rows.map(row=>Number(row.runs_per_hour)),[6]);
    await client.query(`UPDATE pipeline_installation_allowances SET version=version+1,
      record_digest='sha256:'||repeat('a',64), auth_tag='hmac-sha256:'||repeat('b',64)
      WHERE tenant_id=$1 AND workspace_id=$2`,[own.tenantId,own.workspaceId]);
    await assert.rejects(owner.allowance(),
      error=>error?.name==="PipelineAdvanceErrorV1"&&error.safeReason==="pipeline_integrity_failed",
      "a re-signed allowance the service cannot verify is never reported as the owner's ceiling");
    // The advance path re-verifies the same record inside its own transaction
    // and refuses on the same reason, which the caps lane proves on real
    // PostgreSQL; here the owner-facing read is the one this login performs.
    // The row cannot simply be deleted — 0150 refuses that too — so the owner
    // restores it the only way it can be written, a version-2 update carrying a
    // freshly signed digest and tag, and the rest of the test runs on that.
    await assert.rejects(client.query("DELETE FROM pipeline_installation_allowances WHERE tenant_id=$1",
      [own.tenantId]),/pipeline installation allowance rejected/u,
      "0150 refuses to delete the one allowance record");
    const before=Number((await client.query(`SELECT version FROM pipeline_installation_allowances
      WHERE tenant_id=$1 AND workspace_id=$2`,[own.tenantId,own.workspaceId])).rows[0].version);
    const restored=await owner.setAllowance(identity,{runsPerHour:6,runsPerAgentPerDay:12,
      machineMaxAgentProcesses:12,machineMaxDbClusters:6,dollarCapMicroUsd:null,observedDbClusters:1});
    assert.equal(restored.allowanceVersion,before+1,
      "the owner's re-set moves the version forward exactly one step, never back");
    accepted.add(checkJob);
    assert.deepEqual(await advance.advance(runId,"policy:advance").then(value=>[value.stageOrdinal,value.jobId]),[2,signoffJob]);
    accepted.add(signoffJob);
    const done=await advance.advance(runId,"policy:advance");
    assert.deepEqual([done.startsWork,done.state],[false,"succeeded"]);
    assert.equal(queued,3);
    assert.deepEqual((await client.query(`SELECT state,current_stage_ordinal,(SELECT count(*)::int FROM pipeline_advance_receipts
      WHERE pipeline_run_id=$1) receipts FROM pipeline_runs WHERE id=$1`,[runId])).rows[0],
    {state:"succeeded",current_stage_ordinal:null,receipts:3});
    // The Hermes route's owner re-check locks the policy and identity rows as
    // the coordinator; both carry a column the coordinator may update.
    assert.deepEqual((await client.query(`SELECT
      has_any_column_privilege('control_room_task_coordinator','control_project_delegation_policies','UPDATE') policies,
      has_any_column_privilege('control_room_task_coordinator','control_identities','UPDATE') identities`)).rows[0],
    {policies:true,identities:true});

    // The shared intake login holds no grant on either new table. Were one
    // ever added, the tenant binding would still hide every other tenant's rows.
    const intake={...target("cr_unattended_logins","control_room_work_intake_agent"),
      password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
    await client.query("INSERT INTO tenants(id,display_name) VALUES('tenant:advance-other','Other tenant')");
    for (const table of ["pipeline_unattended_transitions","pipeline_advance_receipts"]) {
      await assert.rejects(query(intake,`SELECT tenant_id FROM ${table}`),/permission denied/u,table);
      await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:advance-other')");
      await client.query(`GRANT SELECT ON ${table} TO control_room_work_intake`);
      try {
        assert.deepEqual((await query(intake,`SELECT DISTINCT tenant_id FROM ${table}`)).rows,[],table);
        await client.query("DELETE FROM work_intake_tenant_binding");
        assert.deepEqual((await query(intake,`SELECT DISTINCT tenant_id FROM ${table}`)).rows,[],table);
        await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[own.tenantId]);
        assert.deepEqual((await query(intake,`SELECT DISTINCT tenant_id FROM ${table}`)).rows,[{tenant_id:own.tenantId}],table);
      } finally {
        await client.query(`REVOKE SELECT ON ${table} FROM control_room_work_intake`);
        await client.query("DELETE FROM work_intake_tenant_binding");
      }
    }

    // Owner history on the web login includes the consent and the advance.
    const history=await owner.historyForOwner(identity,projectId,runId);
    assert.ok(history.events.some(event=>event.action==="pipelines.unattended.enabled"));
    assert.ok(history.events.some(event=>event.action==="pipelines.stage.advanced"));
  }));

// A minimal valid native planning template authority, exactly the shape
// captureNativeTaskTemplates accepts. The proof path never plans, so the
// envelope only has to be well formed.
async function nativeTemplateAuthority(projectId) {
  const authority = { projectId, allowedExecutor: "executor:hermes-native",
    allowedOperations: ["harness.hermes.native.start"], credentialRefs: ["credential:test"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: ["https://agent.example.test:443"],
    effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1,
    expiresAt: new Date(webNow + 300_000).toISOString(), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  return authority;
}

// A genuinely accepted build stage on the real Mac-local logins.
//
// The S5 review found that the pipeline run view called the real
// acceptedResultProof on the WEB transaction, and that proof reads
// control_transition_events, which control_room_web may not read. The view
// therefore aborted with database_unavailable on the production login.
//
// The review target is DERIVED from the review plan and the retained receipt by
// nativeReviewTarget, exactly as the real publisher registers it. This
// reconstructs the seeded review target (own.targetRecord) from a real plan and
// receipt, so the plan, receipt, target and transition event all agree on the
// same subject. If the derivation ever stopped reproducing the registered
// target, the real verifyTaskReviewTargetV1 would refuse the proof — so this
// asserts the equality rather than trusting it.
function acceptedResultRecords(own, build, profile, reviewKey, at) {
  const tenantId = own.tenantId, projectId = own.project.projectId, artifactId = build.artifactId;
  // The seeded target's subject digest is sha256Digest("retained result"), which
  // is the digest of the canonical JSON encoding of that string, so the retained
  // bytes are those bytes, quotes included.
  const bytes = new TextEncoder().encode(JSON.stringify("retained result"));
  const contentHash = resultBytesHash(bytes);
  const manifest = buildTaskResultManifestV1({ artifactId, tenantId, projectId, jobId: build.jobId,
    attemptId: build.attemptId, workflowId: own.pipeline.workflowId, nodeId: build.nodeId,
    contentHash, sizeBytes: bytes.byteLength, storageClass: "local", opaqueLocator: `local:${artifactId}`, createdAt: at });
  const receipt = { schema: "control-room.native-result-receipt/v1", artifactId, tenantId, projectId,
    jobId: build.jobId, attemptId: build.attemptId, runId: build.runId, nodeId: build.nodeId,
    snapshotDigest: sha256Digest("snapshot"), snapshotVersion: 1, contentHash, sizeBytes: bytes.byteLength,
    manifestDigest: sha256Digest(manifest), receivedAt: at, byteCheck: "matched_recorded_claim", qualityAccepted: false };
  const plan = nativeReviewPlanRowV1(reviewKey, { tenantId, projectId, jobId: build.jobId,
    runId: build.runId, attemptId: build.attemptId, nodeId: build.nodeId,
    targetId: own.targetRecord.id, profile, producer: own.targetRecord.producer, at });
  const target = nativeReviewTarget(plan.plan, receipt);
  if (canonicalJson(target) !== canonicalJson(own.targetRecord)) throw new Error("accepted target does not match the registered target");
  return { targetId: target.id, target, targetDigest: sha256Digest(target), plan, receipt, manifest, bytes, contentHash };
}

// Writes the chain the real proof path reads. The succeeded job state and the
// appended transition event come first: the proof query joins on them, and the
// event's idempotency_key must match 'native-completion:%:job'. The canonical
// payload mirror trigger requires payload.state and payload.version to track the
// columns, and jsonb_set needs to_jsonb for the number.
async function writeAcceptedBuildStage(client, own, build, resultKey, records, at) {
  const tenantId = own.tenantId, projectId = own.project.projectId, { receipt, manifest, plan } = records;
  const key = sha256Digest(`native completion ${build.artifactId}`).slice(7);
  await client.query("UPDATE control_jobs SET state='succeeded',version=2,updated_at=$1,payload=jsonb_set(jsonb_set(payload,'{state}',to_jsonb('succeeded'::text)),'{version}',to_jsonb(2)) WHERE tenant_id=$2 AND id=$3",
    [at, tenantId, build.jobId]);
  await client.query(`INSERT INTO control_transition_events(id,tenant_id,entity_kind,entity_id,from_state,to_state,
      from_version,to_version,actor_id,actor_type,idempotency_key,safe_metadata,occurred_at)
    VALUES($1,$2,'job',$3,'running','succeeded',1,2,'service:native-task-completion','service',$4,$5::jsonb,$6)`,
    [`transition:native-completion:${key}:job`, tenantId, build.jobId, `native-completion:${key}:job`,
      JSON.stringify({ receipt: { targetDigest: records.targetDigest } }), at]);
  // The manifest must precede the receipt: the receipt's foreign key names it.
  await client.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,content_hash,
      state,version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',$8,$9::jsonb,$10,$10)`,
    [build.artifactId, tenantId, projectId, manifest.workflowId, build.jobId, build.attemptId, records.contentHash,
      manifest.version, JSON.stringify(manifest), at]);
  await client.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,
      receipt,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [tenantId, projectId, build.jobId, build.attemptId, build.runId, build.artifactId, JSON.stringify(receipt),
      hmacSha256Tag(resultKey, { purpose: "native-result-receipt/v1", receipt })]);
  await client.query(`INSERT INTO control_native_review_plans(tenant_id,project_id,job_id,run_id,plan,auth_tag)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [tenantId, projectId, build.jobId, build.runId,
    JSON.stringify(plan.plan), plan.auth_tag]);
}

// The authenticated review plan the proof path selects before reading bytes.
// A native-review-plan/v1 is the matching pair for a native result receipt, and
// the review target is derived from it by nativeReviewTarget, exactly as the
// real publisher registers it. The seeded review tenant's target is a fixture
// for the agent-review tests; the run-view test derives the production target
// instead, so the plan, receipt, target and transition event all agree.
function nativeReviewPlanRowV1(reviewKey, { tenantId, projectId, jobId, runId, attemptId, nodeId, targetId,
  profile, producer, at }) {
  const material = { schema: "control-room.native-review-plan/v1", tenantId, runId,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile), plannedAt: at,
    projectId, jobId, attemptId, nodeId, inputDigest: sha256Digest("input"), authorityDigest: sha256Digest("authority"),
    bindingDigest: sha256Digest("binding"), targetId, producer };
  return { plan: material, auth_tag: nativeReviewPlanTag(reviewKey, material) };
}

// A genuinely accepted build stage and the REAL task-coordinator lifecycle,
// composed on the coordinator login exactly as mac-local-host.ts composes it.
// Completion Gate acceptance is an independent reviewer's accepted decision and
// the profile's one required verification scenario, both committed through the
// real store so its tenant state digest advances. The target is already
// registered by seedAgentReviewTenant, and acceptedResultRecords proved the plan
// and receipt derive exactly that record. `fill` keeps each tenant's keys apart.
async function acceptedBuildOnRealAuthority(client, coordinator, suffix, fill) {
  const at = new Date(webNow).toISOString(), reviewKey = new Uint8Array(32).fill(fill);
  const harnessKey = new Uint8Array(32).fill(fill + 1), resultKey = new Uint8Array(32).fill(fill + 2);
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const own = await seedAgentReviewTenant(client, suffix, reviewKey, checkpoints, at);
  const build = await seedBuildExecution(client, own, suffix, at, { deferResultRows: true });
  const scope = { tenantId: own.tenantId, workspaceId: own.workspaceId };
  const accepted = acceptedResultRecords(own, build, own.profile, reviewKey, at);
  await writeAcceptedBuildStage(client, own, build, resultKey, accepted, at);
  const gate = new CompletionGateStoreV1(client, reviewKey, checkpoints, () => at);
  const { targetId, targetDigest } = accepted;
  const projectId = own.project.projectId;
  // The reviewer is the check stage's protected agent principal, which the
  // seeded tenant already proved independent of the build producer: different
  // worker, agent profile, harness and model family.
  await gate.recordReview({ ...own.reviewPayload(), id: `review:${targetId}`, targetId, targetDigest });
  await gate.recordVerification({ schemaVersion: "control-room-completion-gate/v1",
    id: `verification:${targetId}`, tenantId: own.tenantId, projectId, targetId, targetDigest,
    acceptanceProfileId: own.profile.id, acceptanceProfileDigest: sha256Digest(own.profile),
    scenarioId: own.profile.requiredVerificationScenarioIds[0], outcome: "passed",
    verifier: { actorId: `identity:web-${suffix}`, actorType: "human" },
    evidenceDigests: [sha256Digest(`${suffix} verification`)], verifiedAt: at,
    grantsApproval: false, grantsExecutionAuthority: false });
  // Only the host-generation selection check is supplied. The retained bytes
  // are served by the local result store's own read port, keyed by artifact id.
  const storage = { read: async artifactId => artifactId === build.artifactId ? accepted.bytes : undefined };
  const lifecycle = createTaskCoordinatorLifecycle({
    scope, database: { client: coordinator.db, close: async () => {}, isAvailable: () => true },
    planning: { template: { id: `template:${suffix}`, adapter: "hermes-native-runs/v1",
      instructions: "Use only the supplied information.", acceptanceProfileId: own.profile.id,
      acceptanceProfileDigest: sha256Digest(own.profile),
      authority: await nativeTemplateAuthority(projectId) },
      integrityKey: new Uint8Array(32).fill(fill + 3), reviewIntegrityKey: reviewKey, checkpoints },
    routes: own.routes,
    workBatches: { integrityKey: reviewKey, selectionAuthority: { assertCurrent: () => true } },
    quality: { integrityKey: reviewKey, harnessIntegrityKey: harnessKey, scenarios: [],
      results: { integrityKey: resultKey, storageClass: "local", storage }, checkpoints },
    clock: () => webNow });
  // A second, independent completion-gate reviewer requesting changes with one
  // finding. Completion Gate then reads the target as changes_requested, so the
  // acceptance the proof relied on is superseded.
  const changesRequested = () => {
    const reviewId = `review:${targetId}:changes`, findingId = `finding:${targetId}:changes`;
    const evidence = [sha256Digest(`${suffix} changes`)];
    return [{ schemaVersion: "control-room-completion-gate/v1", id: reviewId, tenantId: own.tenantId, projectId,
      targetId, targetDigest, acceptanceProfileId: own.profile.id, acceptanceProfileDigest: sha256Digest(own.profile),
      reviewer: { actorId: `identity:second-reviewer-${suffix}`, actorType: "human" }, authority: "completion_gate",
      decision: "changes_requested", assessedRisk: "low", effectiveRisk: "critical", evidenceDigests: evidence,
      findingIds: [findingId], reviewedAt: at, grantsApproval: false, grantsExecutionAuthority: false },
    [{ schemaVersion: "control-room-completion-gate/v1", id: findingId, tenantId: own.tenantId, projectId, targetId,
      targetDigest, reviewId, code: "code:stale-result", severity: "high",
      statementDigest: sha256Digest(`${suffix} finding`), evidenceDigests: evidence, raisedAt: at }]];
  };
  return { at, reviewKey, checkpoints, own, build, scope, accepted, lifecycle, changesRequested,
    selection: { sourceJobId: build.jobId, workerId: build.workerId, nodeId: build.nodeId } };
}

// The S5 defect, proved on the real logins with the REAL lifecycle.
//
// The pipeline run view runs on the private-web login. Its accepted-result
// proof reads control_transition_events through the task coordinator, and
// control_room_web holds no SELECT on that table. Running that read on the
// caller's transaction aborted it, so the page failed with
// database_unavailable even though the JavaScript error was caught. The web
// therefore holds the coordinator snapshot (workBatchView), which takes no
// session and resolves on the coordinator's own pool. The transaction-bound
// authority (workBatchAuthority) keeps running on its caller's session, which is
// exactly why it cannot serve the web login. This test builds a real accepted
// result, renders the view AS control_room_web, and asserts the working proof,
// both forms' binding, and the unchanged narrow web privilege.
test("the pipeline run view renders on the production web login through the real accepted-result authority", needsPg, () =>
  withMacLocalLogins("cr_run_view_authority", async ({ client, login }) => {
    const coordinator = login("control_room_coordinator"), web = login("control_room_web");
    const { own, build, scope, accepted, lifecycle, selection, reviewKey } =
      await acceptedBuildOnRealAuthority(client, coordinator, "view", 63);
    const view = lifecycle.workBatchView, authority = lifecycle.workBatchAuthority;
    assert.equal(view?.binding, "coordinator_snapshot");
    assert.equal(authority?.binding, "caller_transaction");

    // The snapshot takes the selection only; no caller session reaches it.
    const expected = { executionJobId: build.jobId, attemptId: build.attemptId, harnessRunId: build.runId,
      artifactId: build.artifactId, contentHash: accepted.contentHash, revision: 0 };
    assert.deepEqual(await view.acceptedResultProof(selection), expected);
    assert.equal(await view.isAcceptedResultCurrent(selection), true);
    // An unbound selection resolves to no proof, never to another stage's.
    assert.equal(await view.acceptedResultProof({ ...selection, nodeId: "node:build:other" }), null);

    // The transaction-bound form runs on the session it is given: on the
    // coordinator login it proves the same result, and on the web login it
    // aborts that caller's own transaction rather than reading elsewhere.
    assert.deepEqual(await coordinator.db.transaction(tx => authority.acceptedResultProof(tx, selection)), expected);
    assert.equal(await coordinator.db.transaction(tx => authority.isAcceptedResultCurrent(tx, selection)), true);
    assert.equal(await coordinator.db.transaction(tx => authority.acceptedResultRevision(tx, selection)), 0);
    for (const [operation, refused] of [["acceptedResultProof", null], ["isAcceptedResultCurrent", false],
      ["acceptedResultRevision", null]])
      await assert.rejects(web.db.transaction(async tx => {
        assert.equal(await authority[operation](tx, selection), refused);
        await tx.query("SELECT 1");
      }), /database_unavailable/u, `the transaction-bound ${operation} must use the caller's session`);

    // The reason the view cannot run on the caller, and the exact symptom the
    // review reported: on the production web login this statement fails the
    // request with database_unavailable, because the private driver withholds
    // the server's refusal text. Catching the JavaScript error does not repair
    // the aborted transaction, so the view died here.
    const proofStatement = `SELECT j.id FROM control_task_execution_plans p JOIN control_jobs j
      ON j.tenant_id=p.tenant_id AND j.id=p.job_id
      JOIN control_transition_events e ON e.tenant_id=j.tenant_id AND e.entity_kind='job' AND e.entity_id=j.id
      WHERE p.tenant_id=$1 AND p.source_job_id=$2`;
    await assert.rejects(web.db.transaction(tx => tx.query(proofStatement, [own.tenantId, build.jobId])),
      /database_unavailable/u, "the web login cannot run the proof's own statement");
    await assert.rejects(web.direct.query(proofStatement, [own.tenantId, build.jobId]), /permission denied/u,
      "the web login's plain client names the missing grant");
    assert.equal((await coordinator.db.query(proofStatement, [own.tenantId, build.jobId])).rows.length, 1,
      "the coordinator login runs the identical statement");

    // The view, rendered AS control_room_web, on the web transaction.
    const identity = createAccessVerifier(webTrust)(webRequest(), webNow);
    const page = await new LinearPipelineServiceV1(web.db, scope, reviewKey, view, () => webNow)
      .view(identity, own.project.projectId, own.pipeline.runId);
    assert.equal(page.stages[0].state, "completed",
      "the accepted build stage must read as completed, not uncertain");
    assert.equal(page.stages[0].round, 0);
    assert.equal(page.stages[0].predecessorResultDigest, null);
    assert.equal(page.stages[1].predecessorResultDigest, accepted.contentHash,
      "the next stage must show the accepted predecessor result digest");
    // The same view through the transaction-bound authority on the coordinator login.
    const coordinatorPage = await new LinearPipelineServiceV1(coordinator.db, scope, reviewKey, authority, () => webNow)
      .view(identity, own.project.projectId, own.pipeline.runId);
    assert.deepEqual(coordinatorPage.stages, page.stages,
      "the snapshot and the transaction-bound proof must present the same result");

    // Least privilege is unchanged: the web login still cannot read the
    // lifecycle table the proof reads, which is the whole reason the view
    // resolves on the coordinator pool.
    const catalog = target("cr_run_view_authority");
    assert.equal((await query(catalog, `SELECT has_table_privilege('control_room_web',
      'control_transition_events','SELECT') AS allowed`)).rows[0].allowed, false);
    assert.equal((await query(catalog, `SELECT has_table_privilege('control_room_task_coordinator',
      'control_transition_events','SELECT') AS allowed`)).rows[0].allowed, true);
    await assert.rejects(web.direct.query("SELECT id FROM control_transition_events"), /permission denied/u);
    await lifecycle.close();
  }));

// Settles true when `promise` settles within `ms`, false while it still waits.
const settlesWithin = (promise, ms) => Promise.race([promise.then(() => true, () => true),
  new Promise(resolve => setTimeout(() => resolve(false), ms))]);

// The race the transaction-bound proof exists for, on the real logins.
//
// The web's coordinator snapshot releases its Completion Gate lock when its own
// short transaction commits. Build publication's creation, currentness and
// retention must instead hold that lock until their own transaction commits:
// otherwise a review landing between the proof and the insert leaves a
// publication recorded against an acceptance that no longer holds. Each of those
// transactions looks up the repository right after its proof, so pausing that
// lookup pauses the path after proof resolution with its locks still held.
test("build publication holds the Completion Gate lock from its accepted-result proof to its commit", needsPg, () =>
  withMacLocalLogins("cr_publication_race", async ({ client, login }) => {
    const coordinator = login("control_room_coordinator"), web = login("control_room_web");
    const admin = target("cr_publication_race"), repositoryUrl = "https://example.invalid/controller/repository";
    // A failed assertion must not leave a paused transaction behind: that
    // would surface as a pool-close rejection and hide the real failure.
    let pause;
    const releases = [], inflight = [];
    const pauseNextLookup = () => {
      let reached, release;
      const hit = new Promise(resolve => { reached = resolve; }), released = new Promise(resolve => { release = resolve; });
      pause = { reached, released }; releases.push(release);
      return { hit, release };
    };
    const tracked = promise => { inflight.push(promise.catch(() => {})); return promise; };
    const repositories = { resolve: async () => {
      const current = pause; pause = undefined;
      if (current) { current.reached(); await current.released; }
      return { repositoryUrl };
    } };
    const acceptedPublication = async (suffix, fill) => {
      const accepted = await acceptedBuildOnRealAuthority(client, coordinator, suffix, fill);
      const { own, build, at, reviewKey } = accepted;
      assert.equal(accepted.lifecycle.workBatchAuthority.binding, "caller_transaction");
      const controller = new LinearPipelineServiceV1(coordinator.db, accepted.scope, reviewKey,
        accepted.lifecycle.workBatchAuthority, () => webNow, repositories);
      const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: own.tenantId,
        projectId: own.project.projectId, jobId: build.jobId, attemptId: build.attemptId, runId: build.runId,
        nodeId: build.nodeId }, worker: { workerId: build.workerId, adapterId: "adapter:test", adapterRevision: "1234567" },
      input: { prompt: "Build.", instructions: "Commit bounded work." }, authorityDigest: sha256Digest("authority"),
      connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: own.profile.id,
      acceptanceProfileDigest: sha256Digest(own.profile), issuedAt: at,
      expiresAt: new Date(webNow + 3_600_000).toISOString() });
      const snapshot = await controller.createBuildPublicationAuthority(delivery);
      assert.deepEqual([snapshot.resultRevision, snapshot.retainedResultDigest], [0, accepted.accepted.contentHash],
        "a first-round Completion Gate acceptance must produce a publishable revision-0 snapshot");
      const { plan, evidence } = signedBuildPublication(derivePipelineBuildPublicationEvidenceKeyV1(reviewKey), {
        snapshot, deliveryDigest: delivery.deliveryDigest,
        modelSelection: { workerId: build.workerId, model: "build-test", effort: "medium" },
        commitDigest: "c".repeat(40), url: `${repositoryUrl}/pull/${fill}` });
      const publications = async () => (await client.query(`SELECT count(*)::int AS n
        FROM control_pipeline_build_publications WHERE tenant_id=$1`, [own.tenantId])).rows[0].n;
      return { ...accepted, controller, delivery, snapshot, retained: { snapshot, plan, evidence }, publications };
    };

    try {
    // 1. The review arrives after the proof, inside the window.
    const late = await acceptedPublication("race", 71);
    // Currentness, paused after its proof: a review from a second transaction
    // cannot take the lock, so it is refused instead of committing underneath.
    let gap = pauseNextLookup();
    const checking = tracked(late.controller.assertBuildPublicationAuthorityCurrent(late.snapshot));
    await gap.hit;
    const impatient = new CompletionGateStoreV1(postgresDatabase(admin, { afterBegin: session =>
      session.query("SET LOCAL lock_timeout='300ms'") }), late.reviewKey, late.checkpoints, () => late.at);
    await assert.rejects(impatient.recordReview(...late.changesRequested()), /lock timeout/u,
      "the currentness check must hold the Completion Gate lock after its proof");
    gap.release(); await checking;

    // Retention, paused after its proof: the review waits on the lock, the
    // publication commits while its acceptance still holds, and only then can
    // the review land.
    gap = pauseNextLookup();
    const retaining = tracked(late.controller.retainBuildPublication(late.retained));
    await gap.hit;
    const superseding = tracked(new CompletionGateStoreV1(client, late.reviewKey, late.checkpoints, () => late.at)
      .recordReview(...late.changesRequested()));
    assert.equal(await settlesWithin(superseding, 400), false,
      "a review must not commit between the retention proof and its insert");
    gap.release();
    assert.deepEqual(await retaining, { evidenceDigest: late.retained.evidence.evidenceDigest, replayed: false });
    assert.equal(await late.publications(), 1,
      "the first-round acceptance must be retained as one build publication");
    assert.equal((await superseding).replayed, false);

    // Once the acceptance is superseded every path refuses: currentness,
    // creation, a retention replay, the retained read and the run view.
    await assert.rejects(late.controller.assertBuildPublicationAuthorityCurrent(late.snapshot),
      /pipeline_build_publication_unavailable/u);
    await assert.rejects(late.controller.createBuildPublicationAuthority(late.delivery),
      /pipeline_build_publication_unavailable/u);
    await assert.rejects(late.controller.retainBuildPublication(late.retained), /pipeline_build_publication_unavailable/u);
    assert.equal(await late.controller.readRetainedBuildPublication(late.delivery.deliveryDigest), undefined);
    const identity = createAccessVerifier(webTrust)(webRequest(), webNow);
    const page = await new LinearPipelineServiceV1(web.db, late.scope, late.reviewKey, late.lifecycle.workBatchView,
      () => webNow).view(identity, late.own.project.projectId, late.own.pipeline.runId);
    assert.notEqual(page.stages[0].state, "completed");
    assert.equal(page.stages[0].pullRequestEvidence, null);
    await late.lifecycle.close();

    // 2. The review takes the lock first and holds it uncommitted. The
    // retention proof waits for it, then refuses: nothing stale is recorded.
    const early = await acceptedPublication("racewin", 81);
    let reached, release;
    const holding = new Promise(resolve => { reached = resolve; }), released = new Promise(resolve => { release = resolve; });
    releases.push(release);
    const first = tracked(new CompletionGateStoreV1(postgresDatabase(admin, { beforeCommit: async () => { reached(); await released; } }),
      early.reviewKey, early.checkpoints, () => early.at).recordReview(...early.changesRequested()));
    await holding;
    const refused = tracked(early.controller.retainBuildPublication(early.retained));
    assert.equal(await settlesWithin(refused, 400), false, "the retention proof must wait for the review's lock");
    release(); await first;
    await assert.rejects(refused, /pipeline_build_publication_unavailable/u);
    assert.equal(await early.publications(), 0);
    await assert.rejects(early.controller.assertBuildPublicationAuthorityCurrent(early.snapshot),
      /pipeline_build_publication_unavailable/u);
    await early.lifecycle.close();
    } finally {
      for (const release of releases) release();
      await Promise.all(inflight);
    }
  }));

// The commit boundary stores the payloads it is given, and the Completion Gate
// store re-parses every stored row, so one malformed review would leave the
// tenant's gate unreadable for good. Each probe calls the boundary as the
// production reviewer login with the correct key; every malformed shape must be
// refused before anything is written, and the tenant must still take a valid
// review afterwards.
function malformedReviewProbe(database,probe){
  return withMacLocalLogins(database,async({client,login})=>{
    const coordinator=login("control_room_coordinator"), reviewer=login("control_room_agent_reviewer_login");
    const at=new Date(webNow).toISOString(), reviewKey=new Uint8Array(32).fill(55);
    const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true});
    const own=await seedAgentReviewTenant(client,"shape",reviewKey,checkpoints,at,coordinator.db);
    await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[own.tenantId]);
    const {plan,targetRecord,profile,state}=own;
    const review=own.reviewPayload();
    const negative={...review,decision:"changes_requested",findingIds:[plan.findingId]};
    const finding={schemaVersion:"control-room-completion-gate/v1",id:plan.findingId,tenantId:own.tenantId,
      projectId:own.project.projectId,targetId:targetRecord.id,targetDigest:sha256Digest(targetRecord),reviewId:plan.reviewId,
      code:"agent:changes_requested",severity:"critical",statementDigest:sha256Digest("probe finding"),
      evidenceDigests:[sha256Digest("probe evidence")],raisedAt:at};
    const records=async()=>(await client.query(
      "SELECT count(*)::int AS rows FROM control_completion_gate_records WHERE tenant_id=$1",[own.tenantId])).rows[0].rows;
    const before=await state(), recordsBefore=await records();
    const refused=async(label,reviewPayload,findingPayload,pattern)=>{
      await assert.rejects(reviewer.direct.query("SELECT * FROM commit_agent_review($1,$2::jsonb,$3::jsonb,$4::bytea)",
        [plan.planId,JSON.stringify(reviewPayload),findingPayload&&JSON.stringify(findingPayload),reviewKey]),pattern,label);
      assert.deepEqual(await state(),before,`${label} moved the integrity row`);
      assert.equal(await records(),recordsBefore,`${label} wrote a record`);
    };
    await probe({review,negative,finding,reviewer:plan.reviewer,refused,client,coordinator,plan,
      verify:()=>own.gate.verifyProvisionedTenantV1(own.tenantId)});
    // The tenant's gate is untouched and still takes a valid review.
    await own.gate.verifyProvisionedTenantV1(own.tenantId);
    const committed=await new AgentReviewServiceV1(reviewer.db,own.tenantId,reviewKey,checkpoints,own.routes,()=>at)
      .record({planId:plan.planId,decision:"changes_requested",assessedRisk:"medium",
        evidenceDigests:[sha256Digest("probe evidence")],findingStatementDigest:sha256Digest("probe finding")});
    assert.equal(committed.replayed,false);
    assert.equal(Number((await state()).revision),Number(before.revision)+1);
    await own.gate.verifyProvisionedTenantV1(own.tenantId);
    assert.equal((await own.gate.getRecord(own.tenantId,plan.reviewId,"review")).effectiveRisk,"critical");
    assert.equal((await own.gate.getRecord(own.tenantId,plan.findingId,"finding")).severity,"critical");
    assert.equal((await own.gate.getRecord(own.tenantId,profile.id,"profile")).id,profile.id);
  });
}
const withoutKeys=(payload,...keys)=>Object.fromEntries(Object.entries(payload).filter(([key])=>!keys.includes(key)));

test("production reviewer login cannot commit a review or finding with a missing field", needsPg, () =>
  malformedReviewProbe("cr_agent_review_missing",async({review,negative,finding,refused})=>{
    for (const key of ["effectiveRisk","grantsApproval","decision","authority","schemaVersion","evidenceDigests","reviewedAt"])
      await refused(`review without ${key}`,withoutKeys(review,key),null,new RegExp(`agent review payload missing field: ${key}$`,"u"));
    await refused("review without both authority flags",withoutKeys(review,"grantsApproval","grantsExecutionAuthority"),null,
      /agent review payload missing field: grantsApproval,grantsExecutionAuthority$/u);
    await refused("finding without severity",negative,withoutKeys(finding,"severity"),/agent review finding missing field: severity$/u);
  }));

test("production reviewer login cannot commit a review or finding with a null field", needsPg, () =>
  malformedReviewProbe("cr_agent_review_null",async({review,negative,finding,refused})=>{
    for (const key of ["effectiveRisk","grantsApproval","reviewer"])
      await refused(`review with null ${key}`,{...review,[key]:null},null,new RegExp(`agent review payload null field: ${key}$`,"u"));
    await refused("finding with null statementDigest",negative,{...finding,statementDigest:null},
      /agent review finding null field: statementDigest$/u);
  }));

test("production reviewer login cannot commit a review or finding with an extra field", needsPg, () =>
  malformedReviewProbe("cr_agent_review_extra",async({review,negative,finding,refused})=>{
    await refused("review with an extra field",{...review,ownerApproved:true},null,/agent review payload extra field: ownerApproved$/u);
    await refused("finding with an extra field",negative,{...finding,note:"extra"},/agent review finding extra field: note$/u);
  }));

test("production reviewer login cannot commit a review or finding with a wrong-typed field", needsPg, () =>
  malformedReviewProbe("cr_agent_review_type",async({review,negative,finding,reviewer,refused})=>{
    for (const [key,value] of [["grantsApproval","false"],["grantsExecutionAuthority",0],["effectiveRisk",4],
      ["reviewer",JSON.stringify(reviewer)],["evidenceDigests",sha256Digest("probe evidence")],["findingIds","[]"]])
      await refused(`review with a ${typeof value} ${key}`,{...review,[key]:value},null,
        new RegExp(`agent review payload wrong type: ${key}$`,"u"));
    // A list the store could not parse back: not digests, empty, unsorted or repeated.
    for (const value of [[123],[],["not-a-digest"],[sha256Digest("a"),sha256Digest("b")].sort().reverse(),
      [sha256Digest("probe evidence"),sha256Digest("probe evidence")]])
      await refused(`review with evidenceDigests ${JSON.stringify(value)}`,{...review,evidenceDigests:value},null,
        /agent review payload wrong type: evidenceDigests$/u);
    await refused("finding with a numeric severity",negative,{...finding,severity:4},/agent review finding wrong type: severity$/u);
    await refused("finding with a malformed statementDigest",negative,{...finding,statementDigest:"sha256:short"},
      /agent review finding wrong type: statementDigest$/u);
  }));

// The store re-parses both timestamps with zod's ISO datetime, which takes
// exactly four year digits. PostgreSQL reads and prints a 5-digit year, so a
// round trip alone would store a review the tenant could never read again.
test("production reviewer login cannot commit a review or finding with a timestamp outside the store's format", needsPg, () =>
  malformedReviewProbe("cr_agent_review_time",async({review,negative,finding,refused,verify})=>{
    // Refused by the format itself; each would otherwise reach the round trip
    // (or fail PostgreSQL's parse) with a different message.
    for (const [label,value] of [["a 5-digit year","10000-01-01T00:00:00.000Z"],["no Z","2026-09-29T12:00:00.000"],
      ["a +00:00 offset","2026-09-29T12:00:00.000+00:00"],["no milliseconds","2026-09-29T12:00:00Z"],
      ["a leading letter","x2026-09-29T12:00:00.000Z"],["trailing text","2026-09-29T12:00:00.000Zx"]]) {
      await refused(`review reviewedAt with ${label}`,{...review,reviewedAt:value},null,/agent review payload wrong type: reviewedAt$/u);
      await verify();
      await refused(`finding raisedAt with ${label}`,negative,{...finding,raisedAt:value},/agent review finding wrong type: raisedAt$/u);
      await verify();
    }
    // The right shape, but PostgreSQL would normalise it to another instant.
    for (const [label,value] of [["hour 24","2026-09-29T24:00:00.000Z"],["a leap second","2026-09-29T23:59:60.000Z"]]) {
      await refused(`review reviewedAt with ${label}`,{...review,reviewedAt:value},null,
        /agent review payload timestamp out of range: reviewedAt$/u);
      await verify();
      await refused(`finding raisedAt with ${label}`,negative,{...finding,raisedAt:value},
        /agent review finding timestamp out of range: raisedAt$/u);
      await verify();
    }
  }));

// Every plan id and principal field lands in a stored review or finding, so the
// plan itself must already hold ids the store's zod schema accepts.
test("coordinator login cannot create an agent-review plan whose ids the store could not parse back", needsPg, () =>
  malformedReviewProbe("cr_agent_review_plan_ids",async({client,coordinator,plan})=>{
    const [row]=(await client.query("SELECT * FROM control_agent_review_plans WHERE id=$1",[plan.planId])).rows;
    const insert=changes=>{
      const value={...row,id:`agent-review-plan:copy-${Object.keys(changes).join("-")}`,review_id:"review:copy",
        finding_id:"finding:copy",...changes};
      const columns=Object.keys(value);
      return coordinator.direct.query(`INSERT INTO control_agent_review_plans(${columns.join(",")}) VALUES(${
        columns.map((column,index)=>`$${index+1}${column==="reviewer"?"::jsonb":""}`).join(",")})`,
      columns.map(column=>column==="reviewer"?JSON.stringify(value[column]):value[column]));
    };
    // Control: an otherwise identical plan passes the binding and hits the one-plan-per-run key.
    await assert.rejects(insert({}),error=>error.code==="23505");
    for (const changes of [{review_id:"r:"},{finding_id:`finding:${"f".repeat(180)}`},{review_id:"review:has space"},
      {reviewer:{...row.reviewer,agentProfileId:"agent-profile:has space"}},{reviewer:{...row.reviewer,harness:"_harness"}}])
      await assert.rejects(insert(changes),/agent review plan identifier rejected$/u,JSON.stringify(changes));
  }));


test("agent-review down migration removes every surviving direct privilege", needsPg, async () => {
  await freshDatabase("cr_agent_review_down");
  const db=target("cr_agent_review_down");
  await applyMigrations({target:db,bootstrapTarget:bootstrapTarget("cr_agent_review_down"),
    migrateTarget:migrateTarget("cr_agent_review_down"),rootDir:ROOT,env:{...process.env,...passwords}});
  await query(db,await readFile(join(ROOT,"db/roles/agent_reviewer_roles.sql"),"utf8"));
  const before=(await query(db,`SELECT
    has_schema_privilege('control_room_agent_reviewer','public','USAGE') AS schema_usage,
    EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl
      JOIN pg_roles role ON role.oid=acl.grantee WHERE n.nspname='public'
        AND role.rolname='control_room_agent_reviewer' AND acl.privilege_type='USAGE') AS direct_schema_usage,
    has_table_privilege('control_room_agent_reviewer','control_completion_gate_records','SELECT') AS gate_select,
    has_table_privilege('control_room_agent_reviewer','control_completion_gate_records','INSERT') AS gate_insert,
    has_column_privilege('control_room_agent_reviewer','control_completion_gate_records','web_lock','UPDATE') AS gate_update,
    has_column_privilege('control_room_agent_reviewer','control_completion_gate_integrity','revision','UPDATE') AS integrity_update,
    coalesce(has_function_privilege('control_room_agent_reviewer',to_regprocedure('commit_agent_review(text,jsonb,jsonb,bytea)'),'EXECUTE'),false) AS commit_execute,
    coalesce(has_function_privilege('control_room_agent_reviewer',to_regprocedure('read_agent_review_plan(text)'),'EXECUTE'),false) AS read_execute,
    has_table_privilege('control_room_agent_reviewer','control_harness_runs','SELECT') AS run_select`)).rows[0];
  assert.deepEqual(before,{schema_usage:true,direct_schema_usage:true,gate_select:false,gate_insert:false,gate_update:false,
    integrity_update:false,commit_execute:true,read_execute:true,run_select:false});
  await query(db,await readFile(join(ROOT,"db/down/0106_agent_review_plans.sql"),"utf8"));
  const afterDown=(await query(db,`SELECT
    has_schema_privilege('control_room_agent_reviewer','public','USAGE') AS schema_usage,
    EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) acl
      JOIN pg_roles role ON role.oid=acl.grantee WHERE n.nspname='public'
        AND role.rolname='control_room_agent_reviewer' AND acl.privilege_type='USAGE') AS direct_schema_usage,
    has_table_privilege('control_room_agent_reviewer','control_completion_gate_records','SELECT') AS gate_select,
    has_table_privilege('control_room_agent_reviewer','control_completion_gate_records','INSERT') AS gate_insert,
    has_column_privilege('control_room_agent_reviewer','control_completion_gate_records','web_lock','UPDATE') AS gate_update,
    has_column_privilege('control_room_agent_reviewer','control_completion_gate_integrity','revision','UPDATE') AS integrity_update,
    coalesce(has_function_privilege('control_room_agent_reviewer',to_regprocedure('commit_agent_review(text,jsonb,jsonb,bytea)'),'EXECUTE'),false) AS commit_execute,
    coalesce(has_function_privilege('control_room_agent_reviewer',to_regprocedure('read_agent_review_plan(text)'),'EXECUTE'),false) AS read_execute,
    has_table_privilege('control_room_agent_reviewer','control_harness_runs','SELECT') AS run_select`)).rows[0];
  assert.deepEqual(afterDown,{schema_usage:true,direct_schema_usage:false,gate_select:false,gate_insert:false,gate_update:false,
    integrity_update:false,commit_execute:false,read_execute:false,run_select:false});
  await query(adminDb(),"DROP DATABASE cr_agent_review_down");
  await query(adminDb(),"DROP ROLE control_room_agent_reviewer");
});

// Everything 0108 could touch, including privileges on every public object,
// so a down file that revokes more than its up migration granted is caught.
//
// An ACL's own text order is not part of what it means: PostgreSQL stores the
// grantee entries in whatever order they were granted, and applying a
// REVOKE/GRANT pair in a different order on two otherwise identical databases
// yields the same privileges written differently. Comparing the raw text
// therefore failed for a reason that is not a privilege difference, so each ACL
// is canonicalised to a sorted array of its entries. Every entry still has to
// match exactly, so a grant present on one side and absent (or differently
// scoped) on the other still fails here.
const aclEntries = (acl) => acl === null ? null : acl.slice(1, -1).split(",").sort();

async function catalogState(db){
  const client=postgresDatabase(db);
  const acl=(await client.query(`SELECT jsonb_build_object(
    -- An acl rendered as text lists its grantees in role-OID order, so two
    -- databases holding the IDENTICAL privilege set print it in a different
    -- order whenever the roles were created in a different sequence -- which is
    -- exactly what a baseline and a head database are. The grantee list is
    -- therefore sorted, so the comparison is over the privilege set rather than
    -- over an artefact of creation order, while still failing the moment a grant
    -- is added or dropped.
    'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,
      (SELECT string_agg('{x}'::text, ', ' ORDER BY '{x}'::text) FROM unnest(COALESCE(c.relacl, ARRAY[]::aclitem[])) AS x),
      c.relrowsecurity, pg_get_userbyid(c.relowner)) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','v','p','S') AND c.relname<>'control_room_schema_migrations'),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,
      (SELECT string_agg('{x}'::text, ', ' ORDER BY '{x}'::text) FROM unnest(COALESCE(a.attacl, ARRAY[]::aclitem[])) AS x))
      ORDER BY c.relname,a.attnum)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','v','p') AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),
    'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proacl::text,p.proconfig,
      pg_get_userbyid(p.proowner),p.prosecdef) ORDER BY p.oid::regprocedure::text) FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
    'policies',(SELECT jsonb_agg(jsonb_build_array(tablename,policyname,permissive,roles::text,cmd,qual,with_check)
      ORDER BY tablename,policyname) FROM pg_policies WHERE schemaname='public')) AS state`)).rows[0].state;
  // Sort each ACL's entries, wherever one appears in a relation, column or
  // function row, so the comparison is over privileges rather than grant order.
  for (const rows of Object.values(acl)) {
    for (const row of rows ?? []) for (const [index, value] of row.entries())
      if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) row[index] = aclEntries(value);
  }
  return {schema:await readSchemaDigest(client),acl};
}

/** Rewrites a role/grants file for a database that does not have every table the
 * file names, so it can be replayed against that database. Only the ABSENT NAMES are
 * pruned from a list: a statement is never dropped because one name in it is missing,
 * because that would take the grants that do apply down with it. A statement whose
 * whole list was absent is dropped, since there is then nothing left to grant. The
 * object list is read within a single statement, so it can never run past the `;`
 * into the next statement's own `ON ... TO`.
 *
 // A FUNCTION SIGNATURE IS NOT A TABLE NAME, so it is checked against the absent set
  * BY ITS OWN NAME (R4-B3). The grant files now carry `GRANT EXECUTE ON FUNCTION
  * work_intake_split_suggestion_visible(text, text, text) TO ...` and two more from
  * 0204/0205, all created by migrations a partial ledger never applied; replayed
  * verbatim they raise 42883 (`undefined_function`) and fail the upgrade. The
  * signature's own comma list is never split -- a parenthesised argument list is one
  * name, and splitting it produced `read_plan(text), bytea)`, which is not SQL.
  *
  * The name is taken from the SIGNATURE for a FUNCTION grant, and from the whole
  * entry otherwise, which is what lets one loop prune both kinds without treating a
  * signature's argument list as a list of names. */
 function pruneAbsentObjects(sql, present, isAbsent) {
   // Only GRANT and REVOKE statements are rewritten. The files also carry `BEGIN;`
   // and `DO $$ ... $$` blocks whose bodies contain semicolons, so splitting the
   // whole file on ";" would tear them apart; a line-oriented split keeps every other
   // byte of the file exactly as it was.
   const objectList = /\bON\s+([^;]*?)\s+(TO|FROM)\b/isu;
   return sql.split(/(?=^\s*(?:GRANT|REVOKE)\b)/gmu).map(statement => {
     if (!/^\s*(?:GRANT|REVOKE)\b/iu.test(statement)) return statement;
     const match = statement.match(objectList);
     if (!match) return statement;
     // Names the file writes with a type prefix or as a schema-wide sweep are left
     // alone: a sweep over the tables this database does have is still correct.
     if (/^\s*(?:ALL|SCHEMA|SEQUENCE|TABLE|FUNCTION)\b/iu.test(match[1].replace(/\s+/g, " "))
       && !/^\s*FUNCTION\s+[a-z_]/iu.test(match[1].trim())) return statement;
     // A relation list carrying a parenthesised argument type is not a list of
     // names -- `read_plan(text), bytea)` splits on its own commas -- so a relation
     // list with an unbalanced "(" is left exactly as written. A FUNCTION list is
     // exempt from that rule on purpose: a signature is exactly the thing that needs
     // pruning, and `splitTopLevel`-style depth counting keeps its argument list one
     // name.
     // The object list stops at the statement's own semicolon. Without that bound the
    // `.*?` runs past `;` into the next chunk -- so `COMMIT;` was consumed by the
    // GRANT that preceded it and a pruned role file lost its transaction terminator,
    // which is a different failure from the one this pruner is for.
    if (match[1].includes("(") && !/^\s*FUNCTION\s+/iu.test(match[1].trim())) return statement;
     // A list whose parentheses do NOT BALANCE is not a list this pruner can read,
     // whatever its kind: an unbalanced object list is left byte for byte rather than
     // repaired. That check comes FIRST because depth counting on an unbalanced list
     // is meaningless -- `read_plan(text), bytea)` drives the depth negative, every
     // later comma is read as top-level, and the statement is rebuilt as
     // `GRANT EXECUTE ON bytea) TO reviewer;`, which is not SQL and is worse than the
     // 42883 the guard was written to avoid.
     let objectLevel = 0;
     for (const char of match[1]) {
       if (char === "(") objectLevel += 1;
       else if (char === ")") objectLevel -= 1;
       if (objectLevel < 0) break;
     }
     if (objectLevel !== 0) return statement;
     // Split on TOP-LEVEL commas only. A negative lookahead ("a comma not inside
     // parentheses") is not enough for a FUNCTION list: the comma BETWEEN two
     // signatures is not inside either one's parentheses, and `text, jsonb` has its
     // own comma inside them, so a lookahead on the next characters mis-reads both.
     // Depth counting is what a signature list actually needs, and it is the same
     // rule `splitTopLevel` above already uses for the privilege and object lists.
     const names = [];
     let entry = "", level = 0;
     for (const char of match[1]) {
       if (char === "," && level === 0) { names.push(entry); entry = ""; continue; }
       if (char === "(") level += 1;
       else if (char === ")") level -= 1;
       entry += char;
     }
     names.push(entry);
     names.forEach((value, index) => { names[index] = value.trim(); });
     const kept = names.filter(name => {
       // The `FUNCTION` keyword is part of PostgreSQL's object list, so it is stripped
       // BEFORE the name is read. Left on, `FUNCTION read_agent_review_plan` fails the
       // identifier test and is never checked against the absent set -- which is why
       // the first attempt at R4-B3 changed nothing at all, silently, on exactly the
       // statements it was written for.
       const bare = name.replace(/^FUNCTION\s+/iu, "").split("(")[0].trim();
       return !/^[a-z_][a-z0-9_]*$/iu.test(bare) || !isAbsent(bare);
     });
     if (kept.length === names.length) return statement;
     // The grantee keyword is put back: it is part of the match, not part of the
     // object list, and a grant that lost its TO/FROM is not SQL.
     if (kept.length === 0) return "";
     // The `FUNCTION` keyword belongs to the LIST, not to the first name, so it is
     // put back on the survivors whenever it was on the original. Dropping it with
     // the first name turns `ON FUNCTION commit_agent_review(...)` into
     // `ON commit_agent_review(...)`, which names a relation and raises 42P01 -- a
     // different failure, on the statement the pruning was meant to repair.
     const list = /^\s*FUNCTION\s+/iu.test(match[1])
       ? [`FUNCTION ${kept[0].replace(/^FUNCTION\s+/iu, "")}`, ...kept.slice(1)] : kept;
     return statement.replace(/\s*\bON\s+.*?\s+(TO|FROM)\b/isu, ` ON ${list.join(", ")} ${match[2]}`);
   }).join("");
 }

test("pruning a role file for a database that lacks a table keeps the grants that do apply", () => {
  const prune = (sql, present) => pruneAbsentObjects(sql, new Set(present), name => !present.includes(name));
  // One absent name in a list: the statement survives with the rest of its list, and
  // keeps its grantee keyword. Losing the TO/FROM here produces invalid SQL, which
  // is the bug this test exists to prevent.
  assert.equal(prune("GRANT SELECT ON alpha, beta, gamma TO some_role;", ["alpha", "gamma"]),
    "GRANT SELECT ON alpha, gamma TO some_role;");
  assert.equal(prune("REVOKE ALL ON alpha, beta FROM some_role;", ["alpha"]),
    "REVOKE ALL ON alpha FROM some_role;");
  // A list that is entirely absent leaves nothing to grant, so the statement goes
  // and its neighbour is untouched.
  assert.equal(prune("GRANT SELECT ON beta TO some_role;\nGRANT INSERT ON alpha TO some_role;", ["alpha"]),
    "GRANT INSERT ON alpha TO some_role;");
  // A list spanning lines and a comma-continued grantee list is read whole: the
  // multi-line list is rebuilt on one line and the grantee list is left alone.
  assert.equal(prune("GRANT SELECT ON alpha,\n  beta, gamma\n  TO first_role, second_role;", ["alpha", "beta"]),
    "GRANT SELECT ON alpha, beta TO first_role, second_role;");
  // A name that is not a bare identifier -- a schema sweep, or a type prefix -- is
  // left alone rather than guessed at.
  assert.equal(prune("GRANT SELECT ON ALL TABLES IN SCHEMA public TO some_role;", []),
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO some_role;");
  // A `DO $$ ... $$` body carries semicolons of its own and must survive byte for
  // byte, or the role file it belongs to stops being valid SQL.
  const withBlock = "BEGIN;\nDO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles) THEN\n    CREATE ROLE r NOLOGIN;\n  END IF;\nEND $$;\nGRANT SELECT ON alpha, beta TO r;\nCOMMIT;";
  assert.equal(prune(withBlock, ["alpha"]), withBlock.replace("alpha, beta", "alpha"));
  // A MALFORMED signature is left exactly as written rather than repaired: the
  // object list carries an unbalanced "(", so it is not a signature this pruner can
  // read, and guessing at it produced `read_plan(text), bytea)` plus a dropped
  // grantee, which is not SQL.
  const signature = "GRANT EXECUTE ON FUNCTION read_plan(text), bytea) TO reviewer;";
  assert.equal(prune(signature, []), signature);
  // The same, with a name the database LACKS: without the guard the signature is
  // split on its own commas and rebuilt as `read_plan(text), bytea)` plus a dropped
  // grantee, which is the corruption this guard exists to prevent.
  assert.equal(prune(signature, ["unrelated"]), signature);

  // A WELL-FORMED multi-signature grant is pruned BY SIGNATURE (R4-B3), which is
  // the change this round exists for and the opposite of the old behaviour.
  //
  // `db/roles/agent_reviewer_roles.sql` grants EXECUTE on two functions in one
  // statement, and the chief-of-staff role files add three more in the same shape.
  // An upgrade rung whose applied ledger stops before the migration that creates
  // one of them has no such function, and replaying the grant verbatim raises 42883
  // (`function work_intake_split_suggestion_visible(text, text, text) does not
  // exist`) and fails the whole upgrade -- measured on the merged tree as
  // test:postgres-production #11-#15. So the pruner now reads a FUNCTION list as a
  // list of SIGNATURES: the argument list's own commas are not name separators, so
  // each signature survives whole or is dropped whole, and a signature that is
  // present keeps the statement alive with the FUNCTION keyword intact.
  const pair = "GRANT EXECUTE ON FUNCTION read_agent_review_plan(text),\n"
    + "  commit_agent_review(text, jsonb, jsonb, bytea) TO control_room_agent_reviewer;";
  // Both present: byte for byte, because nothing needs pruning.
  assert.equal(prune(pair, ["read_agent_review_plan", "commit_agent_review"]), pair);
  // One absent: the SURVIVOR keeps the `FUNCTION` keyword, which is part of
  // PostgreSQL's object list -- rebuilding without it produces `ON
  // read_agent_review_plan(text)`, which names a relation and raises 42P01, a
  // different failure on the same statement.
  assert.equal(prune(pair, ["read_agent_review_plan"]),
    "GRANT EXECUTE ON FUNCTION read_agent_review_plan(text) TO control_room_agent_reviewer;");
  assert.equal(prune(pair, ["commit_agent_review"]),
    "GRANT EXECUTE ON FUNCTION commit_agent_review(text, jsonb, jsonb, bytea) TO control_room_agent_reviewer;");
  // Both absent: nothing is left to grant, so the GRANT goes. It goes WITH the
  // `COMMIT;` that followed it, because the line-oriented split puts them in one
  // chunk -- a grant and its transaction terminator are written together, and the
  // pruner only ever rewrites a statement that names an object, never splices a
  // chunk in two. The production caller replays the PRUNED STATEMENTS, not the file,
  // so a missing terminator here is a test artefact rather than a defect; the
  // property being pinned is that nothing else in the file is disturbed.
  assert.equal(prune(`\n${pair}\nCOMMIT;`, []), "\n");
  assert.equal(prune(`\n${pair}\nCOMMIT;\nGRANT SELECT ON kept TO r;`, ["kept"]),
    "\nGRANT SELECT ON kept TO r;");
  // A chief-of-staff signature with an ARRAY argument type, which is the shape 0205
  // added and the one that is not an identifier: pruned by NAME like any other.
  const arrayed = "GRANT EXECUTE ON FUNCTION planner_failure_scope_key(text, jsonb),\n"
    + "  control_room_planner_grant_owner_retry(text, text, text[]) TO control_room_task_coordinator;";
  assert.equal(prune(arrayed, ["control_room_task_coordinator", "control_room_planner_grant_owner_retry"]),
    "GRANT EXECUTE ON FUNCTION control_room_planner_grant_owner_retry(text, text, text[])"
    + " TO control_room_task_coordinator;");

  // A real function grant out of a role file, against a database that HAS both of
  // the functions it names. Compared on the trimmed statement text: the pruner
  // preserves layout, and the surrounding file's own trailing lines are not what
  // this assertion is about. Before R4-B3 this compared against an empty
  // `present` set, which asserted that the pruner ignored function grants -- the
  // behaviour that refused the upgrade.
  const grant = readFileSync(join(ROOT, "db/roles", "agent_reviewer_roles.sql"), "utf8");
  const functionGrant = grant.split(/(?=\s*GRANT\b)/u)
    .find(statement => /ON FUNCTION\s+read_agent_review_plan\b/u.test(statement));
  assert.ok(functionGrant, "the reviewer role file grants read_agent_review_plan");
  assert.equal(prune(functionGrant, ["read_agent_review_plan", "commit_agent_review"]).trim(), functionGrant.trim());
  // A real role file pruned against a database holding only SOME of what it names
  // keeps the names that are present, drops the ones that are not, and keeps every
  // statement that still has a name. A pruner that quietly kept an absent name, or
  // dropped a statement whole, would pass a weaker check than this. Only GRANT and
  // REVOKE name an object; ALTER DEFAULT PRIVILEGES names a kind, and a name can
  // appear in several grants, so each distinct name is counted once.
  // The names are read the way the pruner reads them -- GRANT/REVOKE only, split at
  // a line that begins one -- so the present/absent split is derived from exactly the
  // names the pruner is deciding about. Reading them any other way would compute a
  // different set and the assertions below would be about the reader, not the pruner.
  // A FUNCTION signature's argument list is not a list of names, so the split is
  // depth-counted rather than done on every comma. Without that, `FUNCTION
  // planner_failure_scope_key(text, jsonb)` yields `planner_failure_scope_key(text`
  // and `jsonb)`, neither of which is a bare identifier, so BOTH are skipped -- the
  // name never enters the list, is therefore never halved into `present`, and is
  // pruned away by a pruner that is behaving correctly. The result was
  // `private_web_roles.sql: dropped text`, which names the symptom rather than the
  // cause.
  const names = sql => {
    const bare = name => /^[a-z_][a-z0-9_]*$/iu.test(name);
    const statements = sql.split(/(?=\s*(?:GRANT|REVOKE)\b)/gmu)
      .filter(statement => /^\s*(?:GRANT|REVOKE)\b/iu.test(statement));
    const found = [];
    for (const statement of statements)
      for (const match of statement.matchAll(/\bON\s+([^;]*?)\s+(?:TO|FROM)\b/giu)) {
        const entries = [];
        let entry = "", level = 0;
        for (const char of match[1]) {
          if (char === "," && level === 0) { entries.push(entry); entry = ""; continue; }
          if (char === "(") level += 1;
          else if (char === ")") level -= 1;
          entry += char;
        }
        entries.push(entry);
        for (const value of entries) {
          const name = value.replace(/^FUNCTION\s+/iu, "").split("(")[0].trim();
          if (bare(name)) found.push(name);
        }
      }
    return [...new Set(found)].sort();
  };
  for (const name of ["private_web_roles.sql", "task_coordinator_roles.sql", "production_table_grants.sql"]) {
    const sql = readFileSync(join(ROOT, "db/roles", name), "utf8");
    const all = names(sql);
    // Halve the DEDUPLICATED name list, so "present" and "absent" are decided from
    // the same list the assertions read. Deriving them from separate lists would let
    // a name be called present in one and absent in the other.
    const half = all.filter((_, index) => index % 2 === 0);
    const pruned = prune(sql, half);
    const kept = new Set(names(pruned));
    // Every name the database has is still granted somewhere, and nothing the file
    // did not name appears. The per-statement layout is deliberately not compared:
    // dropping a statement whose whole list was absent makes the surviving
    // statements run together in a split, which is a change of layout, not of grant.
    for (const object of half) assert.ok(kept.has(object), `${name}: dropped ${object}`);
    assert.deepEqual([...kept].filter(object => !all.includes(object)), [], name);
    // A pruner that kept an absent name would be caught here.
    assert.ok(all.length > half.length, `${name}: nothing was pruned`);
  }
});

/** Re-applies the shipped grants file as the schema owner, exactly as the applier
 * does at the end of every migration run. A down migration only reverses its own
 * statements; it does not re-converge the blanket grants, so a head that has been
 * rolled back holds a different privilege set from a baseline that was built by a
 * migration run. Replaying the grants file is the step that makes the two comparable,
 * and it is the same step a real upgrade takes.
 *
 * The file's blanket statements are `GRANT ... ON ALL TABLES`, which only ever
 * ADD: a head that had 0150-0154 when it was last converged keeps whatever
 * those grants were, and re-running the file grants over the survivors without
 * taking anything away. A baseline staged without those migrations never had
 * them, so the two databases then differ on every relation the downs removed a
 * migration from — `control_room_anchors` and friends kept an
 * `application/reader/backup` grant the baseline has no way to have. So the
 * blanket sweeps are resolved against the SURVIVING catalog and replayed in
 * both directions: the same `ON ALL TABLES` name list the applier would have
 * used, derived from what this database actually has now. That is what makes
 * the comparison about the down files rather than about which tables once
 * existed. */
async function replayGrants(db) {
  // The grants file is a forward-looking document: it names 0109's and 0108's tables,
  // which a rolled-back head no longer has, so 42P01 would stop it part way. Comments
  // are stripped first, so a comment's words are never replayed as SQL.
  const present = new Set([
    ...(await query(db, `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')`)).rows.map(r => r.name),
    ...(await query(db, `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'`)).rows.map(r => r.name),
  ]);
  const sql = (await readFile(join(ROOT, "db/roles/production_table_grants.sql"), "utf8")).replace(/--[^\n]*/gu, "");
  await query(db, "SET ROLE control_room_schema_owner");
  try {
    // One statement at a time, and only GRANT/REVOKE: the applier runs this file as
    // a single script, but running the rewritten GRANT/REVOKE statements one by one
    // keeps a pruned statement from taking the file down with it.
    const rewritten = pruneAbsentObjects(sql, present, name => !present.has(name));
    for (const statement of rewritten.split(/(?=^\s*(?:GRANT|REVOKE)\b)/gmu)) {
      const text = statement.trim();
      if (!/^(?:GRANT|REVOKE)\b/iu.test(text)) continue;
      await query(db, `${text.replace(/;\s*$/u, "")};`);
    }
  } finally { await query(db, "RESET ROLE"); }
}

// 0109's then 0108's down files return a head database to exactly the main + S4 + S5
// state: the same objects and function bodies, and the same privileges. The
// baseline withholds only 0108 and 0109, so a migration added after this test
// was written is applied to BOTH sides and the comparison stays the one that
// matters: what those two down files revoke, nothing more and nothing less.
test("0109 then 0108 down return a head database to exactly the main plus S4 and S5 state", needsPg, async () => {
  // Only 0108 and 0109 and the migrations that DEPEND on them are withheld, so
  // every migration the ledger orders after 0154 — 0155's project settings and
  // everything after it — is applied to BOTH sides. The comparison therefore
  // stays exactly about what these two down files revoke: the head is not
  // rolled back past a migration the baseline also carries.
  const withheld = ["_pipeline_build_publications.sql", "_pipeline_unattended_advance.sql"];
  const { stage, ledgerPath, suffix } = await stageAppliedPrefix({ withheld, withDependants: true });
  // The dependants the derivation found, and why. Both of S7b's 0151 and 0153
  // build append-only triggers on the function 0109 owns, so 0109's own guard
  // refuses until they are reversed; both have to come off the head too, or the
  // comparison would be against a database no release can be in.
  const dependants = suffix.filter(file => !withheld.some(ending => file.endsWith(ending)));
  // 0151 and 0153 build triggers on 0109's function; 0152 and 0154 add columns
  // to 0109's table. All four have to be off the head before 0109's own down
  // can run, and all four have to be off the staged release before it can
  // apply at all.
  assert.deepEqual(dependants, ["0151_pipeline_stage_loop_counts.sql", "0152_pipeline_advance_unknown_cost.sql",
    "0153_pipeline_machine_capacity_observations.sql", "0154_pipeline_advance_round_receipts.sql"],
    "the dependants of 0109's tables and history guard are no longer the derived set");
  // The narrow-role install runs as the cluster superuser, and both databases
  // are dropped afterwards, so the cluster is left as it was found.
  const admin = adminDb();
  const createdPostgres = !(await query(admin, "SELECT 1 FROM pg_roles WHERE rolname='postgres'")).rows.length;
  if (createdPostgres) await query(admin, "CREATE ROLE postgres SUPERUSER LOGIN");
  assert.deepEqual((await query(admin, "SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",
    [MAC_ROLE_GROUPS])).rows, []);
  try {
    await freshDatabase("cr_prod_s6_baseline");
    await applyMigrations({ target: target("cr_prod_s6_baseline"), bootstrapTarget: bootstrapTarget("cr_prod_s6_baseline"),
      migrateTarget: migrateTarget("cr_prod_s6_baseline"), rootDir: stage, ledgerPath, env: { ...process.env, ...passwords } });
    // The baseline carries the role state those migrations had not yet
    // produced, derived from the withheld migrations themselves rather than from
    // a hand-written list of the grants they add — the same derivation the
    // S-slice tests use for the staged grants file.
    // The baseline's role state is derived from the WHOLE withheld set, not
    // just the two files under test: the staged release also lacks 0151-0154,
    // so a baseline built from 0108/0109 alone would still grant on tables it
    // does not have, and the comparison would fail for a reason that has
    // nothing to do with the two down files. `suffix` holds file names, which
    // match exactly one migration each as endings.
    await installMacRoleFilesWithout("cr_prod_s6_baseline", suffix);
    await freshDatabase("cr_prod_s6_down");
    await applyMigrations({ target: target("cr_prod_s6_down"), bootstrapTarget: bootstrapTarget("cr_prod_s6_down"),
      migrateTarget: migrateTarget("cr_prod_s6_down"), rootDir: ROOT, env: { ...process.env, ...passwords } });
    // The 0177-0179 down files revoke from control_room_task_coordinator and 0190's
    // from control_room_private_web without an existence guard, so the head has to
    // carry the same narrow roles a real install has before it can be rolled back.
    // The baseline deliberately does not: it predates those migrations entirely.
    await installMacRoleFiles("cr_prod_s6_down");
    assert.notDeepEqual(await catalogState(target("cr_prod_s6_down")), await catalogState(target("cr_prod_s6_baseline")));

    // The dependants first, newest first, then the two down files under test.
    // None of them holds a row here — the head has never run unattended advance
    // — so their own refusal guards are not reached, which is the ordinary
    // state for a head that has not been used.
    for (const file of [...dependants].reverse())
      await query(target("cr_prod_s6_down"), await readFile(join(ROOT, "db/down", file), "utf8"));
    await query(target("cr_prod_s6_down"), await readFile(join(ROOT, "db/down/0109_pipeline_unattended_advance.sql"), "utf8"));
    await query(target("cr_prod_s6_down"), await readFile(join(ROOT, "db/down/0108_pipeline_build_publications.sql"), "utf8"));
    await replayGrants(target("cr_prod_s6_down"));
    // 0108/0109's down files revoke the grants they granted, so the head is now
    // in exactly the role state the pre-migration release had. Re-installing the
    // SHIPPED role files here would put 0109's own grants back, so the head is
    // compared as the rollback left it: the same state the baseline was built in.
    assert.deepEqual(await catalogState(target("cr_prod_s6_down")), await catalogState(target("cr_prod_s6_baseline")));
  } finally {
    await rm(stage, { recursive: true, force: true });
    for (const database of ["cr_prod_s6_baseline", "cr_prod_s6_down"]) await query(admin, `DROP DATABASE IF EXISTS ${database}`);
    for (const role of [...MAC_ROLE_GROUPS, ...createdPostgres ? ["postgres"] : []]) await query(admin, `DROP ROLE IF EXISTS ${role}`);
  }
});

// The Mac-local role files this database installs, and the group roles those
// files confer. Both come from the INSTALLER's own plan, because a restated
// list is what goes stale: 0140/0141 added `fleet_gateway_roles.sql` to the
// plan, and the copy here kept installing seven files and six groups while
// `readDesiredMacGrantsV1` and `provisionMacLocalNarrowRolesV1` moved on to
// eight and eight. `control_room_private_web` is named explicitly because its
// read-only fleet SELECTs come from the fleet file, so filtering by the plan's
// groups alone would drop them and then demand them as missing.
const MAC_ROLE_FILES = ["private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
  "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
  "agent_reviewer_roles.sql", "fleet_gateway_roles.sql"];
const MAC_ROLE_GROUPS = [...new Set([...Object.values(macRolePlan), "control_room_private_web"])];

// The grants each withheld migration's DOWN file revokes from a role that
// already exists. Read from the down file's own `EXECUTE 'REVOKE ...'`
// statements, because that is exactly the set the pre-migration release did not
// have: its role files did not carry them, and the down file takes them away
// again. A migration that revokes a grant its up file never issues is a real
// asymmetry, and this baseline removes it — so the comparison proves what the
// down file actually does rather than what it ought to do.
//
// Derived, so a revoke added later is picked up without editing this test.
async function withheldRevocations(root, withheld) {
  const tuples = new Set();
  for (const name of await withheldFilenames(root, withheld)) {
    const sql = await readFile(join(root, "db/down", name), "utf8");
    for (const [, statement] of sql.matchAll(/EXECUTE '(REVOKE [^']*)'/gu)) {
      const match = /^REVOKE\s+([A-Z]+)(?:\s*\(([^)]+)\))?\s+ON\s+([a-z_][a-z0-9_]*)\s+FROM\s+(control_room_[a-z_]+)$/u
        .exec(statement.trim());
      assert.ok(match, `unreadable withheld revoke: ${statement}`);
      const [, privilege, columns, object, role] = match;
      for (const column of columns ? columns.split(",").map(value => value.trim()) : [""]) {
        tuples.add([role, "table", `public.${object}`, column, privilege, "plain"].join("|"));
      }
    }
  }
  assert.ok(tuples.size > 0, "the withheld migration's down file must revoke a grant");
  return tuples;
}

/** The one migration file each `withheld` suffix names. */
async function withheldFilenames(root, withheld) {
  const migrations = (await readdir(join(root, "db/migrations"))).filter(name => name.endsWith(".sql")).sort();
  const names = [];
  for (const ending of withheld) {
    const found = migrations.filter(name => name.endsWith(ending));
    assert.equal(found.length, 1, ending);
    names.push(found[0]);
  }
  return names;
}

// The schema objects the withheld migrations create: their relations, and the
// columns they ADD to a relation that outlives them. A staged release without
// those migrations has neither, so a role file naming one cannot be installed
// verbatim there — and naming a column is how a role file would break.
async function withheldObjects(root, withheld) {
  const objects = new Set(), columns = new Set();
  for (const name of await withheldFilenames(root, withheld)) {
    const sql = await readFile(join(root, "db/migrations", name), "utf8");
    for (const [, object] of sql.matchAll(
      /CREATE (?:UNLOGGED )?(?:TABLE|VIEW|MATERIALIZED VIEW)\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/giu))
      objects.add(object);
    // FUNCTIONS TOO (R4-B3). The role files grant EXECUTE on functions as well as
    // on tables, so a staged release that withheld the migration which CREATES one
    // has to have that grant pruned for the same reason a table grant is: replayed
    // verbatim it raises 42883 (`function work_intake_split_suggestion_visible(text,
    // text, text) does not exist`) and fails the whole upgrade.
    //
    // TRIGGER functions are excluded: no login can call one and no role file grants
    // EXECUTE on one, so including them would prune grants that are correct on a
    // database that does have the trigger. Only NAMES are collected -- a function's
    // parameters belong to the GRANT, and the pruner matches on the bare name.
    // The header is read from the match's OWN groups rather than from the matched
    // text: `[, name]` would bind the function NAME to `name`, so `name[2]` would be
    // a character of it rather than the header, and the trigger test would read
    // `undefined` and never exclude anything. That is why the first attempt at
    // this collected zero functions while looking correct.
    for (const match of sql.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([\s\S]*?)AS\s+\$/giu)) {
      if (/RETURNS\s+trigger\b/iu.test(match[3])) continue;
      objects.add(match[1].toLowerCase());
    }
    for (const [, table, column] of sql.matchAll(
      /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/giu))
      if (!objects.has(table)) columns.add(`${table}.${column}`);
  }
  assert.ok(objects.size + columns.size > 0, "the withheld migration must add something the role files name");
  return { objects, columns };
}

/** Splits on commas that are not inside parentheses, the way the Mac installer
 * splits a GRANT's object and privilege lists. */
function splitTopLevel(source) {
  const parts = [];
  let part = "", level = 0;
  for (const char of source) {
    if (char === "(") level += 1;
    if (char === ")") level -= 1;
    assert.ok(level >= 0, "unbalanced role-file grant");
    if (char === "," && level === 0) { parts.push(part); part = ""; continue; }
    part += char;
  }
  assert.equal(level, 0, "unbalanced role-file grant");
  parts.push(part);
  return parts;
}

// Rebuilds a Mac-local role file for a staged release that lacks what the
// withheld migrations changed. Three cases, all derived from those migrations:
//   - a GRANT naming a relation they created loses that name, or goes if the
//     list was only theirs;
//   - a column-scoped GRANT naming a column they added loses that column;
//   - a GRANT asserting nothing but grants their DOWN file revokes goes
//     entirely, because the pre-migration release's role files did not carry it.
//
// The grant is taken apart with a top-level comma walk, so
// `INSERT (a,b), UPDATE (c)` and the plain `SELECT, INSERT` forms are both read
// the way the Mac installer reads them. Every `old` is matched VERBATIM against
// the real file text, so a role file that changes shape fails here instead of
// quietly dropping an edit and making the comparison prove less than it did.
function roleEditsWithoutObjects(sql, withheld, revocations) {
  const { objects, columns } = withheld;
  const statements = [...sql.replace(/--[^\n]*/gu, "").matchAll(/(?:^|\n)\s*(GRANT\s+[\s\S]*?;)/gmu)]
    .map(match => match[1]);
  const pairs = [];
  const tuple = (role, privilege, object, column) =>
    [role, "table", `public.${object}`, column, privilege, "plain"].join("|");
  for (const statement of statements) {
    const [, privileges, listedText, grantee] = /^GRANT\s+([\s\S]*?)\s+ON\s+([\s\S]*?)\s+TO\s+(control_room_[a-z_]+)$/u
      .exec(statement.trim().replace(/;$/u, "")) ?? [];
    assert.ok(privileges !== undefined, `unreadable role-file grant: ${statement}`);
    const listed = splitTopLevel(listedText).map(value => value.trim());
    // Each privilege may carry its own column list, so split those separately.
    // A privilege with NO column list is table-wide, which is distinct from a
    // privilege whose column list is empty because every column was withheld.
    const rights = splitTopLevel(privileges).map(value => {
      const [, privilege, list] = /^([A-Z]+)\s*(?:\(([^)]*)\))?$/u.exec(value.trim()) ?? [];
      assert.ok(privilege, `unreadable role-file privilege: ${value}`);
      return { privilege, scoped: list !== undefined,
        names: list === undefined ? [] : splitTopLevel(list).map(column => column.trim()),
        tupleFor: object => (list === undefined ? [""] : splitTopLevel(list).map(column => column.trim()))
          .map(column => tuple(grantee, privilege, object, column)) };
    });
    const asserted = rights.flatMap(right => listed.flatMap(object => right.tupleFor(object)));
    // Asserts nothing but what the withheld down files take away: the release
    // being reconstructed did not have it, so neither does this database.
    if (asserted.every(item => revocations.has(item))) { pairs.push([statement, ""]); continue; }
    const survivors = listed.filter(object => !objects.has(object));
    const held = rights.some(right => right.names.some(column =>
      listed.some(object => columns.has(`${object}.${column}`))));
    // Nothing withheld touches this grant: leave its text exactly as it is. The
    // test's business is the withheld migrations, and reformatting an untouched
    // grant (a schema-qualified object, a differently spaced column list) would
    // make a failure here mean nothing.
    if (survivors.length === listed.length && !held) continue;
    const kept = rights.flatMap(right => {
      // A table-wide privilege keeps its name, whether or not columns were
      // withheld elsewhere in the statement.
      if (!right.scoped) return [right.privilege];
      if (!right.names.some(column => listed.some(object => columns.has(`${object}.${column}`))))
        return [`${right.privilege} (${right.names.join(",")})`];
      const surviving = right.names.filter(column =>
        !listed.some(object => columns.has(`${object}.${column}`)));
      // Every column this privilege named was withheld: it cannot be granted.
      return surviving.length === 0 ? [] : [`${right.privilege} (${surviving.join(",")})`];
    });
    pairs.push([statement, kept.length === 0 || survivors.length === 0 ? ""
      : `GRANT ${kept.join(", ")} ON ${survivors.join(", ")} TO ${grantee};`]);
  }
  for (const [verbatim] of pairs) assert.ok(sql.includes(verbatim),
    `role file no longer contains this grant verbatim: ${verbatim}`);
  return pairs;
}

// Installs the real Mac-local role files against a staged release that lacks
// the withheld migrations, so this database carries exactly the role state
// those migrations had not yet produced — including the column grants they add
// to pre-existing tables, which no role-file edit can express.
async function installMacRoleFilesWithout(database, withheld) {
  const schema = await withheldObjects(ROOT, withheld);
  const revocations = await withheldRevocations(ROOT, withheld);
  const edits = {};
  for (const file of MAC_ROLE_FILES) {
    // `installMacRoleFiles` walks each file's pairs two at a time.
    const pairs = roleEditsWithoutObjects(await readFile(join(ROOT, "db/roles", file), "utf8"),
      schema, revocations).flat();
    if (pairs.length > 0) edits[file] = pairs;
  }
  const client = new Client(target(database, "postgres"));
  await client.connect();
  try {
    await installMacRoleFiles(database, edits);
    const actual = await readMacGrantCatalogV1(client);
    // Converge the live catalog on the head's desired grants MINUS everything
    // the withheld migrations produced: the relations they created, the
    // columns they added, and the grants their down files revoke. Driven
    // through the installer's own grant diff, so this stays correct as either
    // side changes. `missing` is emptied first, so a grant the role files make
    // on a relation this database does not have is not silently demanded.
    // A FUNCTION item's object is its SIGNATURE (`public.f(text, jsonb)`), so the
    // name has to be taken from before the parenthesis -- comparing the whole
    // signature against a set of bare names never matches, and the `missing`
    // assertion below then demanded EVERY function grant on a baseline that
    // legitimately holds most of them. `withheldObjects` collected function NAMES
    // (R4-B3), so this is where that decision is read.
    const without = (item) => {
      const [, kind, object, column] = item.split("|");
      const name = object.replace(/^public\./, "").split("(")[0].trim();
      if (kind === "function") return revocations.has(item) || schema.objects.has(name);
      return revocations.has(item) || schema.objects.has(name) || (column && schema.columns.has(`${name}.${column}`));
    };
    // `readDesiredMacGrantsV1` reads every Mac role file, so it also covers
    // grants on relations a particular staged release may not have. The
    // withheld migrations' own work is removed by `without`, and the role
    // filter keeps the comparison to the roles this database actually has —
    // without it a grant belonging to a role this baseline never created is
    // demanded as "missing" for a reason that has nothing to do with the
    // withheld migrations.
    const desired = new Set([...await readDesiredMacGrantsV1()]
      .filter(item => MAC_ROLE_GROUPS.includes(item.split("|")[0]))
      .filter(item => !without(item)));
    const diff = diffMacGrantsV1(actual, desired);
    assert.deepEqual(diff.missing, [], "the withheld work is the only role difference to remove");
    await applyMacGrantDiffV1(client, { extra: diff.extra, missing: [] });
  } finally { await client.end(); }
  // The applier runs the grants file as ONE script, so a single 42P01 on a
  // relation this release does not have rolls the WHOLE file back and the
  // database is left with no shared-role grants at all — a state no real
  // release is ever in, and one a head that was rolled back can never match.
  // Replaying the file with the absent names pruned, against this database's
  // own catalog, is the same convergence `replayGrants` gives the head, so
  // both sides of the comparison are in the applier's converged state and the
  // difference left is exactly what the withheld migrations' down files do.
  await replayGrants(target(database));
}

// The narrow-role installer's database steps, from the real role files with
// `edits` applied, as the cluster superuser the fixed queue expects. Roles are
// cluster-wide, so a second database skips the files' plain CREATE ROLE.
// A baseline that lacks the withheld migrations' objects cannot have the
// shipped role files replayed onto it verbatim, and a grant naming an absent
// relation raises 42P01. `installMacRoleFilesWithout` closes that gap by
// deriving the role state from the withheld migrations themselves, so this
// installs the files whole.
async function installMacRoleFiles(database, edits = {}) {
  const client = new Client(target(database, "postgres")); await client.connect();
  try {
    await client.query(await readFile(join(ROOT, "db/roles/production_roles.sql"), "utf8"));
    if (!(await inspectFixedQueueSchemaV1(client)).schemaExists) await installFixedQueueSchemaV1(client);
    await client.query(await readFile(join(ROOT, "db/roles/private_web_database.sql"), "utf8"));
    // The tables this database does not have, read from its own catalog: a prefix
    // that predates 0135, 0160 or 0190 lacks those tables, and replaying the shipped
    // role files onto it raises 42P01 naming one of them. `edits` is applied first,
    // so an S6-era edit that removes a grant is judged against the file it edits and
    // a new migration's tables need no edit here.
    const present = new Set([
      ...(await client.query(`SELECT c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')`)).rows.map(r => r.name),
      // Columns too: 0109 adds unattended_last_swept_at to pipeline_runs, so a
      // baseline that predates it fails 42703 on the column-level grant, not 42P01.
      ...(await client.query(`SELECT a.attname AS name FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped`)).rows.map(r => r.name),
    ]);
    for (const file of MAC_ROLE_FILES) {
      let sql = await readFile(join(ROOT, "db/roles", file), "utf8");
      const pairs = edits[file] ?? [];
      for (let index = 0; index < pairs.length; index += 2) {
        assert.ok(sql.includes(pairs[index]), `${file}: ${pairs[index]}`);
        sql = sql.replace(pairs[index], pairs[index + 1]);
      }
      // Grants on objects this database does not have are pruned by name, after
      // `edits` so an S6-era edit is judged against the text it edits. Only the absent
      // names go: the coordinator's SELECT grant names 0108's and 0109's tables
      // alongside tables this database has, and dropping the whole statement would
      // take the grants that do apply with it. A column-level grant keeps only the
      // columns that exist, because 0109 adds unattended_last_swept_at to
      // pipeline_runs and a baseline predating it fails 42703 rather than 42P01.
      // Comments are stripped before the list is read: a "-- ... table names ..."
      // line inside a statement would otherwise be read as part of its object list.
      // A column-level grant keeps only the columns that exist. The list may wrap
      // across lines, so newlines are part of the character class.
      // A grant naming an object this database does not have is pruned from
      // its statement, and a column list keeps only the columns that exist.
      sql = pruneAbsentObjects(sql.replace(/--[^\n]*/gu, ""), present, name => !present.has(name))
        .replace(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|REFERENCES|TRIGGER)\s*\(([^)]*)\)/giu,
        (whole, verb, list) => {
          const kept = list.split(",").map(entry => entry.trim()).filter(entry => entry && present.has(entry));
          return kept.length ? `GRANT ${verb} (${kept.join(", ")})` : whole;
        });
      for (const [statement, role] of sql.matchAll(/^CREATE ROLE (\w+)[^;]*;/gmu))
        if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length) sql = sql.replace(statement, "");
      await client.query(sql);
    }
  } finally { await client.end(); }
}

// 0109's down file returns a Mac-local head database to exactly the S6 state:
// the same objects, and the same privileges for every role, including the web
// and coordinator column grants that exist only in the Mac-local role files.
// Only 0109 is withheld, so every later migration the ledger orders is staged
// on BOTH sides and the comparison is still exactly about 0109's down file.
test("0109 down returns a Mac-local head database to exactly the main plus S4, S5 and S6 state", needsPg, async () => {
  // Only 0109 and the migrations that DEPEND on it are withheld, so every later
  // migration the ledger orders is installed on BOTH sides, and the comparison
  // is still exactly about what 0109's down file revokes.
  const withheld = ["_pipeline_unattended_advance.sql"];
  const { stage, ledgerPath, suffix } = await stageAppliedPrefix({ withheld, withDependants: true });
  const dependants = suffix.filter(file => !withheld.some(ending => file.endsWith(ending)));
  // 0151 and 0153 build triggers on 0109's function; 0152 and 0154 add columns
  // to 0109's table. All four have to be off the head before 0109's own down
  // can run, and all four have to be off the staged release before it can
  // apply at all.
  assert.deepEqual(dependants, ["0151_pipeline_stage_loop_counts.sql", "0152_pipeline_advance_unknown_cost.sql",
    "0153_pipeline_machine_capacity_observations.sql", "0154_pipeline_advance_round_receipts.sql"],
    "the dependants of 0109's tables and history guard are no longer the derived set");
  const admin = adminDb();
  const createdPostgres = !(await query(admin, "SELECT 1 FROM pg_roles WHERE rolname='postgres'")).rows.length;
  if (createdPostgres) await query(admin, "CREATE ROLE postgres SUPERUSER LOGIN");
  assert.deepEqual((await query(admin, "SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])", [MAC_ROLE_GROUPS])).rows, []);
  try {
    await freshDatabase("cr_prod_s7_baseline");
    await applyMigrations({ target: target("cr_prod_s7_baseline"), bootstrapTarget: bootstrapTarget("cr_prod_s7_baseline"),
      migrateTarget: migrateTarget("cr_prod_s7_baseline"), rootDir: stage, ledgerPath, env: { ...process.env, ...passwords } });
    await installMacRoleFilesWithout("cr_prod_s7_baseline", suffix);
    await freshDatabase("cr_prod_s7_down");
    await applyMigrations({ target: target("cr_prod_s7_down"), bootstrapTarget: bootstrapTarget("cr_prod_s7_down"),
      migrateTarget: migrateTarget("cr_prod_s7_down"), rootDir: ROOT, env: { ...process.env, ...passwords } });
    await installMacRoleFiles("cr_prod_s7_down");
    const head = await catalogState(target("cr_prod_s7_down"));
    assert.notDeepEqual(head, await catalogState(target("cr_prod_s7_baseline")));

    // The dependants first, newest first. 0151 and 0153 build append-only
    // triggers on the function 0109 owns, so 0109's own guard refuses with `a
    // later migration depends on its history guard` until they are gone; 0152
    // and 0154 add columns to 0109's receipts table. None holds a row on a head
    // that has never advanced unattended work.
    for (const file of [...dependants].reverse())
      await query(target("cr_prod_s7_down"), await readFile(join(ROOT, "db/down", file), "utf8"));
    await query(target("cr_prod_s7_down"), await readFile(join(ROOT, "db/down/0109_pipeline_unattended_advance.sql"), "utf8"));
    await replayGrants(target("cr_prod_s7_down"));
    assert.deepEqual(await catalogState(target("cr_prod_s7_down")), await catalogState(target("cr_prod_s7_baseline")));
  } finally {
    await rm(stage, { recursive: true, force: true });
    for (const database of ["cr_prod_s7_baseline", "cr_prod_s7_down"]) await query(admin, `DROP DATABASE IF EXISTS ${database}`);
    for (const role of [...MAC_ROLE_GROUPS, ...createdPostgres ? ["postgres"] : []]) await query(admin, `DROP ROLE IF EXISTS ${role}`);
  }
});

// One installation tenant with a server-created agent review plan: the build
// stage's target, the check stage's succeeded run, and the plan binding them.
// Every id carries the suffix, so a second tenant can live in the same database.
async function seedAgentReviewTenant(client,suffix,reviewKey,checkpoints,at,planDb=client){
  const tenantId=`tenant:review-${suffix}`, workspaceId=`workspace:review-${suffix}`;
  await client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Review probe')",[tenantId]);
  await client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Review probe')",[workspaceId,tenantId]);
  const identityId=suffix==="probe"?"identity:web":`identity:web-${suffix}`;
  await new SecurityStore(client).bootstrapOwner({tenantId,provider:webTrust.issuer,subject:"test-owner",
    identityId,grantId:suffix==="probe"?"grant:web":`grant:web-${suffix}`,displayName:"Test owner",
    verifiedAt:new Date(webNow-60_000).toISOString(),expiresAt:new Date(webNow+300_000).toISOString(),now:at});
  const identity=createAccessVerifier(webTrust)(webRequest(),webNow);
  const project=(await new WebProjectService(client,{tenantId,workspaceId},()=>webNow)
    .create(identity,{title:"Reviewer authority probe",summary:"Exercise the bounded reviewer role."},`review-${suffix}-project-0001`)).project;
  const template={name:"Reviewer authority probe",description:"Build and check one result.",stages:[
    {ordinal:0,stageKind:"build",role:"builder",description:"Build.",requiredCapability:"code.change",workerId:`worker:build:${suffix}`,
      workerKind:"codex",nodeId:`node:build:${suffix}`,selectionKey:"build.standard",model:"build-test",effort:"medium",maxLoops:3,
      allowedPaths:["src/**"],maximumChangedFiles:10,maximumChangedBytes:100_000},
    {ordinal:1,stageKind:"check",role:"checker",description:"Check.",requiredCapability:"code.review",workerId:`worker:check:${suffix}`,
      workerKind:"claude-code",nodeId:`node:check:${suffix}`,selectionKey:"check.standard",model:"check-test",effort:"high",maxLoops:3},
    {ordinal:2,stageKind:"signoff",role:"validator",description:"Validate.",requiredCapability:"code.validate",workerId:`worker:validate:${suffix}`,
      workerKind:"hermes",nodeId:`node:validate:${suffix}`,selectionKey:"validate.standard",model:"validate-test",effort:"default",
      provider:"openai",profile:"profile:openai",maxLoops:0}],maxTotalLoops:6,maxDurationSeconds:3600};
  const pipelines=new LinearPipelineServiceV1(client,{tenantId,workspaceId},reviewKey,
    {assertCurrent:()=>true,isAcceptedResultCurrent:()=>false},()=>webNow);
  const saved=await pipelines.createTemplate(identity,project.projectId,template);
  const pipeline=await pipelines.instantiate(identity,project.projectId,{templateId:saved.templateId,title:"Review bounded result"},`review-${suffix}-pipeline-0001`);
  for(const jobId of pipeline.jobIds.slice(0,2))await client.query(`INSERT INTO control_task_execution_plans
    (tenant_id,project_id,source_job_id,job_id,plan,auth_tag) VALUES($1,$2,$3,$3,'{}'::jsonb,$4)`,
  [tenantId,project.projectId,jobId,`hmac-sha256:${"9".repeat(64)}`]);
  const gate=new CompletionGateStoreV1(client,reviewKey,checkpoints,()=>at); await gate.provisionTenant(tenantId);
  const profile={schemaVersion:"control-room-completion-gate/v1",id:`profile:review-${suffix}`,tenantId,
    projectId:project.projectId,name:"Reviewer probe",targetKind:"document",requiredVerificationScenarioIds:[`scenario:review-${suffix}`],
    minimumIndependentReviews:1,reviewerSeparation:{actor:true,worker:true,agentProfile:true,harness:true,modelFamily:true},
    verificationRequiresProducerSeparation:true,minimumRisk:"critical",maximumRevisionRounds:3,automaticLowRiskDisposition:false,
    createdBy:{actorId:identityId,actorType:"human"},createdAt:at};
  await gate.registerProfile(profile);
  const targetRecord={schemaVersion:"control-room-completion-gate/v1",id:`target:review-${suffix}`,tenantId,
    projectId:project.projectId,kind:"document",subjectId:pipeline.jobIds[0],subjectDigest:sha256Digest("retained result"),
    acceptanceProfileId:profile.id,acceptanceProfileDigest:sha256Digest(profile),producer:{actorId:`node:build:${suffix}`,actorType:"agent",
      workerId:`worker:build:${suffix}`,agentProfileId:"agent-profile:build.standard",harness:"codex",
      adapterId:"connector:codex-owner-trusted-local-v1",modelFamily:"model-family:openai"},rootTargetId:`target:review-${suffix}`,
    revisionNumber:0,submittedAt:at};
  await gate.registerTarget(targetRecord);
  await client.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',1,'key:check',$3::jsonb,$4,$4)`,
  [`node:check:${suffix}`,tenantId,JSON.stringify({id:`node:check:${suffix}`,tenantId,state:"active",version:1,identityKeyId:"key:check"}),at]);
  await client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,'succeeded',1,$4,$5,1,$6::jsonb,$7,$7)`,
  [`attempt:review-${suffix}`,tenantId,pipeline.jobIds[1],`worker:check:${suffix}`,`node:check:${suffix}`,
    JSON.stringify({id:`attempt:review-${suffix}`,tenantId,state:"succeeded",version:1,jobId:pipeline.jobIds[1],attemptNumber:1,
      workerId:`worker:check:${suffix}`,nodeId:`node:check:${suffix}`,leaseEpoch:1}),at]);
  await client.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,
    native_session_key_digest,parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
    VALUES($1,$2,$3,$4,$5,$6,'connector:claude-code-local-v1','claude',$7,NULL,NULL,'succeeded',1,$8,$9,'{}'::jsonb,$10,$10,$10)`,
  [`run:review-${suffix}`,tenantId,project.projectId,pipeline.jobIds[1],`attempt:review-${suffix}`,`node:check:${suffix}`,
    `sha256:${"1".repeat(64)}`,`sha256:${"2".repeat(64)}`,`hmac-sha256:${"3".repeat(64)}`,at]);
  const routes=[{nodeId:`node:check:${suffix}`,executorId:`worker:check:${suffix}`,capabilityProbeId:"harness.claude-code.local.v1",
    maxConcurrentTasks:1,requiredScratchBytes:0,leaseSeconds:60}];
  const planner=new AgentReviewServiceV1(planDb,tenantId,reviewKey,checkpoints,routes,()=>at);
  const plan=await planner.createPlan({projectId:project.projectId,pipelineRunId:pipeline.runId,producerJobId:pipeline.jobIds[0],
    reviewerJobId:pipeline.jobIds[1],reviewerRunId:`run:review-${suffix}`,targetId:targetRecord.id});
  const state=async()=> (await client.query("SELECT revision,record_count,state_digest,state_auth_tag FROM control_completion_gate_integrity WHERE tenant_id=$1",[tenantId])).rows[0];
  const reviewPayload=()=>({schemaVersion:"control-room-completion-gate/v1",id:plan.reviewId,tenantId,projectId:project.projectId,
    targetId:targetRecord.id,targetDigest:sha256Digest(targetRecord),acceptanceProfileId:profile.id,acceptanceProfileDigest:sha256Digest(profile),
    reviewer:plan.reviewer,authority:"completion_gate",decision:"accepted",assessedRisk:"low",effectiveRisk:"critical",
    evidenceDigests:[sha256Digest("probe evidence")],findingIds:[],reviewedAt:at,grantsApproval:false,grantsExecutionAuthority:false});
  return {tenantId,workspaceId,project,pipeline,profile,targetRecord,routes,plan,gate,state,reviewPayload};
}

// The reviewer login the real Mac-local installer creates in the dedicated
// reviewer group, on a fully migrated database.
function withAgentReviewer(database,callback){
  return withMacLocalLogins(database,async({client,login})=>{
    const reviewer=login("control_room_agent_reviewer_login").direct;
    assert.equal((await reviewer.query("SELECT current_user AS role")).rows[0].role,"control_room_agent_reviewer_login");
    await callback({database,admin:target(database),client,reviewer});
  });
}

test("real reviewer login cannot replay the three raw authority attacks", needsPg, () =>
  withAgentReviewer("cr_agent_review_attacks",async({database,admin,client,reviewer})=>{
  const password="reviewer-probe-password-389";
  const at=new Date(webNow).toISOString(), reviewKey=new Uint8Array(32).fill(52);
  const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true});
  const own=await seedAgentReviewTenant(client,"probe",reviewKey,checkpoints,at);
  await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[own.tenantId]);
  const {targetRecord,plan,routes,gate,state}=own;
  const role=(await reviewer.query("SELECT rolsuper,pg_has_role(current_user,'control_room_agent_reviewer','MEMBER') AS member FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role,{rolsuper:false,member:true});
  const boundary=(await reviewer.query(`SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner,p.proconfig,
    p.proleakproof,p.proparallel,p.provolatile,
    NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.privilege_type<>'EXECUTE'
        OR acl.grantee NOT IN (p.proowner,(SELECT oid FROM pg_roles WHERE rolname='control_room_agent_reviewer'))
        OR acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='control_room_agent_reviewer') AND acl.is_grantable)
      AND 1=(SELECT count(*) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='control_room_agent_reviewer')
          AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable) AS exact_acl
    FROM pg_proc p WHERE p.oid='commit_agent_review(text,jsonb,jsonb,bytea)'::regprocedure`)).rows[0];
  assert.deepEqual(boundary,{prosecdef:true,owner:"control_room_schema_owner",proconfig:["search_path=pg_catalog, public, pg_temp"],
    proleakproof:false,proparallel:"u",provolatile:"v",exact_acl:true});
  // No UPDATE on any column: a row lock is never a reason to grant one.
  assert.deepEqual((await reviewer.query(`SELECT c.relname,a.attname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege(c.oid,a.attnum,'UPDATE')`)).rows,[]);
  const before=await state();
  await assert.rejects(reviewer.query("UPDATE control_completion_gate_integrity SET record_count=record_count+99 WHERE tenant_id='tenant:review-probe'"),/permission denied/u);
  const review={...own.reviewPayload(),effectiveRisk:"low"};
  const rawInsert=(payload,tag)=>reviewer.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,
    subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at) VALUES($1,$2,$3,'review',$4,$5,$5,$6,$7,$8::jsonb,$9)`,
  [payload.id,payload.tenantId,payload.projectId,sha256Digest({kind:"review",targetId:targetRecord.id,authority:"completion_gate",
    reviewerActorId:plan.reviewer.actorId}),targetRecord.id,sha256Digest(payload),tag,JSON.stringify(payload),at]);
  await assert.rejects(rawInsert(review,`hmac-sha256:${"5".repeat(64)}`),/permission denied/u);
  const floored={...review,effectiveRisk:"critical"};
  await assert.rejects(rawInsert(floored,`hmac-sha256:${"a".repeat(64)}`),/permission denied/u);
  // The raw-insert trigger is an independent layer: with a rogue INSERT grant
  // on the reviewer group, the real login is still refused by the trigger.
  await query(admin,"GRANT INSERT ON control_completion_gate_records TO control_room_agent_reviewer");
  try {
    await assert.rejects(rawInsert(review,`hmac-sha256:${"5".repeat(64)}`),/agent reviewer raw insert rejected/u);
    await assert.rejects(rawInsert(floored,`hmac-sha256:${"a".repeat(64)}`),/agent reviewer raw insert rejected/u);
  } finally {
    await query(admin,"REVOKE INSERT ON control_completion_gate_records FROM control_room_agent_reviewer");
  }
  await assert.rejects(reviewer.query("SELECT * FROM commit_agent_review($1,$2::jsonb,NULL,$3::bytea)",
    [plan.planId,JSON.stringify(floored),new Uint8Array(32).fill(99)]),/integrity key rejected/u);
  // With the right key, the database itself still enforces the risk floor: a
  // direct call below the profile's minimum risk is refused, not recorded.
  await assert.rejects(reviewer.query("SELECT * FROM commit_agent_review($1,$2::jsonb,NULL,$3::bytea)",
    [plan.planId,JSON.stringify(review),reviewKey]),/agent review commit binding rejected/u);
  // The in-function membership gate is its own layer: a restricted login outside
  // the reviewer group is refused even when EXECUTE is granted to it directly.
  await query(admin,`CREATE ROLE agent_review_nonmember_probe LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await query(admin,"GRANT USAGE ON SCHEMA public TO agent_review_nonmember_probe");
  await query(admin,"GRANT EXECUTE ON FUNCTION commit_agent_review(text,jsonb,jsonb,bytea) TO agent_review_nonmember_probe");
  try {
    await assert.rejects(postgresDatabase({...target(database,"agent_review_nonmember_probe"),password})
      .query("SELECT * FROM commit_agent_review($1,$2::jsonb,NULL,$3::bytea)",[plan.planId,JSON.stringify(floored),reviewKey]),
    /agent review commit caller rejected/u);
  } finally {
    await query(admin,"REVOKE ALL ON FUNCTION commit_agent_review(text,jsonb,jsonb,bytea) FROM agent_review_nonmember_probe");
    await query(admin,"REVOKE USAGE ON SCHEMA public FROM agent_review_nonmember_probe");
    await query(admin,"DROP ROLE agent_review_nonmember_probe");
  }
  assert.deepEqual(await state(),before);
  const service=new AgentReviewServiceV1(reviewer,"tenant:review-probe",reviewKey,checkpoints,routes,()=>at);
  const committed=await service.record({planId:plan.planId,decision:"accepted",assessedRisk:"low",evidenceDigests:[sha256Digest("probe evidence")]});
  assert.equal(committed.review.effectiveRisk,"critical");
  const replayed=await service.record({planId:plan.planId,decision:"accepted",assessedRisk:"low",evidenceDigests:[sha256Digest("probe evidence")]});
  assert.equal(replayed.replayed,true);
  await gate.verifyProvisionedTenantV1("tenant:review-probe");
  const beforeDrift=await state(), checkpointBeforeDrift=await checkpoints.read("completion-gate:tenant:review-probe");
  const rogue={...committed.review,id:"review:rogue-drift",reviewer:{...committed.review.reviewer,actorId:"node:rogue-drift"}};
  await client.query(`INSERT INTO control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,parent_id,
    record_digest,record_auth_tag,payload,occurred_at) VALUES($1,$2,$3,'review',$4,$5,$5,$6,$7,$8::jsonb,$9)`,
  [rogue.id,rogue.tenantId,rogue.projectId,sha256Digest({kind:"review",targetId:rogue.targetId,authority:"completion_gate",
    reviewerActorId:rogue.reviewer.actorId}),rogue.targetId,sha256Digest(rogue),`hmac-sha256:${"b".repeat(64)}`,
    JSON.stringify(rogue),at]);
  await assert.rejects(service.record({planId:plan.planId,decision:"accepted",assessedRisk:"low",
    evidenceDigests:[sha256Digest("probe evidence")]}),/existing record integrity rejected/u);
  assert.deepEqual(await state(),beforeDrift);
  assert.deepEqual(await checkpoints.read("completion-gate:tenant:review-probe"),checkpointBeforeDrift);
}));

// The reviewer login serves one installation. A second tenant in the same
// database (seeded the way the owner bootstrap and pipeline services seed any
// tenant) stays invisible to it and cannot receive a review through it, even
// with the same integrity key.
test("real reviewer login reads and commits only in its bound installation tenant", needsPg, () =>
  withAgentReviewer("cr_agent_review_tenants",async({client,reviewer})=>{
  const at=new Date(webNow).toISOString(), reviewKey=new Uint8Array(32).fill(53);
  const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true});
  const own=await seedAgentReviewTenant(client,"own",reviewKey,checkpoints,at);
  const other=await seedAgentReviewTenant(client,"other",reviewKey,checkpoints,at);
  await client.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[own.tenantId]);
  for (const table of ["control_agent_review_plans","control_completion_gate_records","control_completion_gate_integrity",
    "control_harness_runs","control_attempts","control_task_execution_plans","pipeline_stage_runs"]) {
    const seen=await reviewer.query(`SELECT count(*)::int AS rows FROM ${table} WHERE tenant_id=$1`,[other.tenantId])
      .then(result=>result.rows[0].rows,error=>{ assert.match(error.message,/permission denied/u,table); return 0; });
    assert.equal(seen,0,`${table} leaks the other tenant to the reviewer login`);
  }
  const otherBefore=await other.state(), otherCheckpoint=await checkpoints.read(`completion-gate:${other.tenantId}`);
  await assert.rejects(reviewer.query("SELECT * FROM commit_agent_review($1,$2::jsonb,NULL,$3::bytea)",
    [other.plan.planId,JSON.stringify(other.reviewPayload()),reviewKey]),/agent review plan unavailable/u);
  await assert.rejects(new AgentReviewServiceV1(reviewer,other.tenantId,reviewKey,checkpoints,other.routes,()=>at)
    .record({planId:other.plan.planId,decision:"accepted",assessedRisk:"low",evidenceDigests:[sha256Digest("probe evidence")]}),
  /agent_review_plan_unavailable/u);
  assert.deepEqual(await other.state(),otherBefore);
  assert.deepEqual(await checkpoints.read(`completion-gate:${other.tenantId}`),otherCheckpoint);
  assert.equal((await client.query("SELECT count(*)::int AS rows FROM control_completion_gate_records WHERE tenant_id=$1 AND kind='review'",
    [other.tenantId])).rows[0].rows,0);
  // The bound tenant still records through the same login.
  const committed=await new AgentReviewServiceV1(reviewer,own.tenantId,reviewKey,checkpoints,own.routes,()=>at)
    .record({planId:own.plan.planId,decision:"accepted",assessedRisk:"low",evidenceDigests:[sha256Digest("probe evidence")]});
  assert.equal(committed.review.effectiveRisk,"critical");
  await own.gate.verifyProvisionedTenantV1(own.tenantId);
  await other.gate.verifyProvisionedTenantV1(other.tenantId);
}));

// Two tenants, each registered for work intake exactly as the owner bootstraps
// register agents (auth_provider='work-intake' plus a valid proposer grant).
// A directly registered agent in the own tenant is not registered for intake.
const seededBatchAt = "2026-09-27T12:00:00.000Z";
const seededBatchProposal = JSON.stringify({ title: "Seeded proposal" });
const seededBatchDigest = `sha256:${"b".repeat(64)}`;
const seededBatchTag = `hmac-sha256:${"c".repeat(64)}`;
const seededBatches = [
  // [tenant, proposer, auth provider, batch, has revision]
  ["tenant:batch-own", "identity:work-intake:own", "work-intake", "batch:own", true],
  ["tenant:batch-own", "identity:batch-own-direct", "agent-key", "batch:own-direct", true],
  ["tenant:batch-other", "identity:work-intake:other", "work-intake", "batch:other", true],
  ["tenant:batch-other", "identity:work-intake:other", "work-intake", "batch:other-open", false],
];
const intakeScope = identityId => `work-batches.propose/v1:${identityId}`;
const intakeLedgerTables = ["work_batches", "work_batch_revisions", "work_batch_items", "control_idempotency", "audit_events"];
// Decided proposal content. Rejected items need no job, so each seeded batch
// can carry one while it is still proposed.
const seededItems = [["tenant:batch-own", "batch:own"], ["tenant:batch-own", "batch:own-direct"],
  ["tenant:batch-other", "batch:other"]];
const insertSeededItem = `INSERT INTO work_batch_items(id,tenant_id,batch_id,batch_revision,project_id,local_id,ordinal,
  role,required_capability,depends_on_local_ids,acceptance_criteria,acceptance_tests,decision_state,decision_reason_code,
  item_digest,auth_tag,created_at) VALUES($1,$2,$3,1,$4,'build',0,'builder','code.change','{}',$5,'Run the tests.',
  'rejected','not_selected',$6,$7,$8)`;
const seededProject = tenantId => `project:${tenantId.slice("tenant:".length)}`;
const insertSeededBatch = `INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,
  proposed_by_actor_type,proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
  VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,5,$7,$8,1,$5,$5)`;
const insertSeededRevision = `INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
  edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,1,$4,$5,'submitted',$6::jsonb,$7,$8)`;

async function seedWorkBatchTenants(db) {
  for (const tenantId of ["tenant:batch-own", "tenant:batch-other"]) {
    const suffix = tenantId.slice("tenant:".length);
    await query(db, "INSERT INTO tenants(id,display_name) VALUES($1,$1)", [tenantId]);
    await query(db, "INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'workspace')",
      [`workspace:${suffix}`, tenantId]);
    await query(db, `INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
      redaction_policy_version,cursor_retention_days) VALUES($1,$2,'manual','1','control_room_native','fixture','v1',1)`,
    [`adapter:${suffix}`, tenantId]);
    await query(db, `INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES($1,$2,$3,$4,$1,'1','Project',
      'ready','ready','healthy','control_room_native',$5,'{}')`,
    [seededProject(tenantId), tenantId, `workspace:${suffix}`, `adapter:${suffix}`, seededBatchAt]);
  }
  const identities = new Map(seededBatches.map(([tenantId, identityId, provider]) =>
    [`${tenantId}|${identityId}`, { tenantId, identityId, provider }]));
  let index = 0;
  for (const { tenantId, identityId, provider } of identities.values()) {
    index += 1;
    await query(db, `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Proposing agent',$3,$4,'active',$5,$5)`,
    [identityId, tenantId, provider, `sha256:${String(index).repeat(64)}`, seededBatchAt]);
    await query(db, `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES($1,$2,$3,
      'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
    [`grant:seeded-${index}`, tenantId, identityId, JSON.stringify([seededProject(tenantId)]), seededBatchAt]);
  }
  for (const [tenantId, identityId, , batchId, hasRevision] of seededBatches) {
    await query(db, insertSeededBatch, [batchId, tenantId, seededProject(tenantId), identityId, seededBatchAt,
      seededBatchProposal, seededBatchDigest, seededBatchTag]);
    if (hasRevision) await query(db, insertSeededRevision, [`${batchId}:revision:1`, tenantId, batchId, identityId,
      seededBatchAt, seededBatchProposal, seededBatchDigest, seededBatchTag]);
  }
  for (const [tenantId, batchId] of seededItems)
    await query(db, insertSeededItem, [`${batchId}:item:build`, tenantId, batchId, seededProject(tenantId),
      `SECRET criteria for ${batchId}`, seededBatchDigest, seededBatchTag, seededBatchAt]);
  // Each tenant's intake ledger rows, in the namespace the intake login may use.
  for (const [tenantId, identityId, batchId] of [["tenant:batch-own","identity:work-intake:own","batch:own"],
    ["tenant:batch-other","identity:work-intake:other","batch:other"]]) {
    const suffix = tenantId.slice("tenant:batch-".length);
    await query(db, `INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status,
      result,completed_at) VALUES($1,$2,$3,$4,'completed',$5::jsonb,$6)`, [tenantId, intakeScope(identityId),
      `${suffix}-intake-key-0001`, `sha256:${"d".repeat(64)}`, JSON.stringify({ batchId }), seededBatchAt]);
    await query(db, `INSERT INTO audit_events(id,tenant_id,project_id,actor_id,actor_type,action,target_type,target_id,
      safe_metadata,occurred_at) VALUES($1,$2,$3,$4,'agent','work_batches.propose','work_batch',$5,'{}'::jsonb,$6)`,
    [`audit:work-intake:${suffix}-1`, tenantId, seededProject(tenantId), identityId, batchId, seededBatchAt]);
  }
}

test("work-intake login reads and writes only its bound tenant's registered work batches", needsPg, async () => {
  await freshDatabase("cr_prod_intake_batches");
  const db=target("cr_prod_intake_batches");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_intake_batches"),
    migrateTarget:migrateTarget("cr_prod_intake_batches"), rootDir:ROOT, env:{...process.env,...passwords} });
  await seedWorkBatchTenants(db);
  const intake={...target("cr_prod_intake_batches","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  const intakeRows=async()=>Object.fromEntries(await Promise.all(intakeLedgerTables.map(async table=>
    [table,(await query(intake,`SELECT tenant_id FROM ${table} ORDER BY tenant_id`)).rows.map(row=>row.tenant_id)])));
  const nothing=Object.fromEntries(intakeLedgerTables.map(table=>[table,[]]));

  // Fail closed: with no binding row the intake login sees and writes nothing,
  // not even its own tenant's proposals.
  assert.deepEqual(await intakeRows(),nothing);
  await assert.rejects(query(intake,insertSeededBatch,["batch:unbound","tenant:batch-own",seededProject("tenant:batch-own"),
    "identity:work-intake:own",seededBatchAt,seededBatchProposal,seededBatchDigest,seededBatchTag]),/row-level security/u);
  await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:batch-own')");
  // One binding per cluster database, readable but never writable by the intake login.
  await assert.rejects(query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:batch-other')"),
    /duplicate key/u);
  await assert.rejects(query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(false,'tenant:batch-other')"),
    /check constraint/u);
  await assert.rejects(query(intake,"UPDATE work_intake_tenant_binding SET tenant_id='tenant:batch-other'"),/permission denied/u);
  await assert.rejects(query(intake,"DELETE FROM work_intake_tenant_binding"),/permission denied/u);
  await assert.rejects(query(intake,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:batch-other')"),
    /permission denied/u);
  assert.deepEqual(await intakeRows(),{work_batches:["tenant:batch-own"],work_batch_revisions:["tenant:batch-own"],
    work_batch_items:["tenant:batch-own"],control_idempotency:["tenant:batch-own"],audit_events:["tenant:batch-own"]});

  assert.deepEqual((await query(intake,"SELECT tenant_id,id FROM work_batches ORDER BY tenant_id,id")).rows,
    [{tenant_id:"tenant:batch-own",id:"batch:own"}]);
  assert.deepEqual((await query(intake,
    "SELECT tenant_id,batch_id FROM work_batch_revisions ORDER BY tenant_id,batch_id")).rows,
  [{tenant_id:"tenant:batch-own",batch_id:"batch:own"}]);
  assert.deepEqual((await query(intake,"SELECT proposal FROM work_batches WHERE tenant_id='tenant:batch-other'")).rows,[]);
  assert.deepEqual((await query(intake,
    "SELECT proposal FROM work_batch_revisions WHERE tenant_id='tenant:batch-other'")).rows,[]);
  assert.deepEqual((await query(intake,
    "SELECT operation_scope,result FROM control_idempotency WHERE tenant_id='tenant:batch-other'")).rows,[]);
  assert.deepEqual((await query(intake,"SELECT id FROM audit_events WHERE tenant_id='tenant:batch-other'")).rows,[]);
  // Items follow their batch: none from the other tenant, and none for a batch
  // whose proposer the owner did not register for intake.
  assert.deepEqual((await query(intake,"SELECT tenant_id,batch_id FROM work_batch_items ORDER BY batch_id")).rows,
    [{tenant_id:"tenant:batch-own",batch_id:"batch:own"}]);
  assert.deepEqual((await query(intake,
    "SELECT acceptance_criteria FROM work_batch_items WHERE tenant_id='tenant:batch-other'")).rows,[]);

  // Each forged proposer holds a valid proposer grant, so only the policy refuses it.
  for (const [tenantId, identityId] of [["tenant:batch-other","identity:work-intake:other"],
    ["tenant:batch-own","identity:batch-own-direct"]])
    await assert.rejects(query(intake,insertSeededBatch,[`batch:forged-${identityId.slice(9)}`,tenantId,
      seededProject(tenantId),identityId,seededBatchAt,seededBatchProposal,seededBatchDigest,seededBatchTag]),
    /row-level security/u, `${tenantId} ${identityId}`);
  // The registered identity named under the other tenant has no grant there either.
  await assert.rejects(query(intake,insertSeededBatch,["batch:forged-own-elsewhere","tenant:batch-other",
    seededProject("tenant:batch-other"),"identity:work-intake:own",seededBatchAt,seededBatchProposal,
    seededBatchDigest,seededBatchTag]),/row-level security|proposal-only work batch insert rejected/u);
  await assert.rejects(query(intake,insertSeededRevision,["batch:other-open:revision:1","tenant:batch-other",
    "batch:other-open","identity:work-intake:other",seededBatchAt,seededBatchProposal,seededBatchDigest,seededBatchTag]),
  /row-level security|(?:initial )?work batch revision insert rejected/u);
  // The other tenant's agent holds a valid grant, so the ledger guard admits the
  // row and only the tenant binding refuses it.
  await assert.rejects(query(intake,`INSERT INTO control_idempotency
    (tenant_id,operation_scope,idempotency_key,request_digest,status)
    VALUES('tenant:batch-other',$1,'forged-other-key-0001',$2,'processing')`,
  [intakeScope("identity:work-intake:other"),`sha256:${"e".repeat(64)}`]),/row-level security/u);
  await assert.rejects(query(intake,
    "UPDATE work_batches SET proposal='{}'::jsonb WHERE tenant_id='tenant:batch-other'"),/permission denied/u);
  await assert.rejects(query(intake,
    "UPDATE work_batch_revisions SET proposal='{}'::jsonb WHERE tenant_id='tenant:batch-other'"),/permission denied/u);
  assert.deepEqual((await query(db,`SELECT (SELECT count(*)::int FROM work_batches) AS batches,
    (SELECT count(*)::int FROM work_batch_revisions) AS revisions,
    (SELECT count(*)::int FROM work_batch_items) AS items`)).rows[0],{batches:4,revisions:3,items:3});

  // The registered identity still proposes and reads back through the real store.
  const store=new WorkBatchStoreV1(postgresDatabase(intake),new Uint8Array(32).fill(9));
  const principal={tenantId:"tenant:batch-own",identityId:"identity:work-intake:own",actorType:"agent",
    authenticatedAt:"2026-09-27T11:00:00.000Z",expiresAt:"2027-09-27T12:00:00.000Z"};
  const proposal={schema:"control-room.work-batch-proposal/v1",projectId:"project:batch-own",
    tasks:[{localId:"build",title:"Build",instructions:"Implement the bounded change.",
      requiredCapability:"code.change",role:"builder",requestedWorkerKind:"worker:code",
      requestedModelKey:"model:allowed",acceptanceCriteria:"The focused checks pass.",
      acceptanceTests:"Run the focused test lane."}],edges:[]};
  const receipt=await store.create({principal,proposal,proposalDigest:sha256Digest(proposal),
    idempotencyKey:"intake-batches-key-0001",now:"2026-09-27T12:10:00.000Z",queueDepthLimit:5});
  assert.equal(receipt.replayed,false);
  const status=await store.status(principal,"project:batch-own",receipt.batchId,"2026-09-27T12:11:00.000Z");
  assert.equal(status.batchId,receipt.batchId);
  assert.deepEqual((await query(intake,"SELECT id FROM work_batches ORDER BY id")).rows.map(row=>row.id).sort(),
    ["batch:own",receipt.batchId].sort());

  // Removing the binding closes the login again, including its own new rows.
  await query(db,"DELETE FROM work_intake_tenant_binding");
  assert.deepEqual(await intakeRows(),nothing);
  await assert.rejects(store.status(principal,"project:batch-own",receipt.batchId,"2026-09-27T12:12:00.000Z"),
    {safeCode:"batch_not_found"});
});

test("non-intake roles keep exactly their work-batch access", needsPg, async () => {
  await freshDatabase("cr_prod_batch_roles");
  const db=target("cr_prod_batch_roles");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_batch_roles"),
    migrateTarget:migrateTarget("cr_prod_batch_roles"), rootDir:ROOT, env:{...process.env,...passwords} });
  await seedWorkBatchTenants(db);
  const allBatches=seededBatches.map(([tenantId,,,batchId])=>`${tenantId}|${batchId}`).sort();
  const allRevisions=seededBatches.filter(row=>row[4]).map(([tenantId,,,batchId])=>`${tenantId}|${batchId}`).sort();
  const allItems=seededItems.map(([tenantId,batchId])=>`${tenantId}|${batchId}`).sort();
  const client=new Client(db);
  await client.connect();
  try {
    // Role files are cluster-global; install the owner-web and coordinator groups
    // only inside this transaction so no other test observes them.
    await client.query("BEGIN");
    for (const file of ["private_web_roles.sql","task_coordinator_roles.sql"])
      await client.query((await readFile(join(ROOT,"db/roles",file),"utf8")).replace(/^(?:BEGIN|COMMIT);$/gmu,""));
    const observe=async role=>{
      const seen={};
      for (const [table,column] of [["work_batches","id"],["work_batch_revisions","batch_id"],["work_batch_items","batch_id"]]) {
        await client.query("SAVEPOINT probe");
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          seen[table]=(await client.query(`SELECT tenant_id || '|' || ${column} AS row FROM ${table}`)).rows
            .map(row=>row.row).sort();
        } catch (error) { seen[table]=error.code==="42501" ? "permission denied" : error.message; }
        finally { await client.query("ROLLBACK TO SAVEPOINT probe"); }
      }
      return seen;
    };
    const denied={work_batches:"permission denied",work_batch_revisions:"permission denied",
      work_batch_items:"permission denied"};
    const all={work_batches:allBatches,work_batch_revisions:allRevisions,work_batch_items:allItems};
    const expected={
      control_room_schema_owner:all,
      control_room_backup:all,
      control_room_reader:denied, control_room_application:denied, control_room_schedule_admissions:denied,
      control_room_github_broker:denied,
      control_room_private_web:all,
      // The assignment gate reads batch and item records to verify admissions;
      // it never reads proposal revisions.
      control_room_task_coordinator:{work_batches:allBatches,work_batch_revisions:"permission denied",
        work_batch_items:allItems},
    };
    const observed={};
    for (const role of Object.keys(expected)) observed[role]=await observe(role);
    assert.deepEqual(observed,expected);
    const privileges=(await client.query(`SELECT r.role,t.table_name,
      has_table_privilege(r.role,t.table_name,'INSERT') AS insert,
      has_table_privilege(r.role,t.table_name,'UPDATE') AS update,
      has_table_privilege(r.role,t.table_name,'DELETE') AS delete
      FROM unnest($1::text[]) r(role) CROSS JOIN unnest(ARRAY['work_batches','work_batch_revisions']) t(table_name)
      WHERE has_table_privilege(r.role,t.table_name,'INSERT') OR has_table_privilege(r.role,t.table_name,'UPDATE')
        OR has_table_privilege(r.role,t.table_name,'DELETE') ORDER BY 1,2`,[Object.keys(expected)])).rows;
    assert.deepEqual(privileges,[
      {role:"control_room_private_web",table_name:"work_batch_revisions",insert:true,update:false,delete:false},
      {role:"control_room_schema_owner",table_name:"work_batch_revisions",insert:true,update:true,delete:true},
      {role:"control_room_schema_owner",table_name:"work_batches",insert:true,update:true,delete:true}]);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
});

// The owner revises and decides through the real owner service; the proposing
// agent then reads status and list over the production intake login, where
// the tenant-binding policies apply (the owner fixture's connection bypasses them).
test("intake status and list stay readable on the production login after owner revision and decision", needsPg, async () => {
  await freshDatabase("cr_prod_intake_owner");
  const db=target("cr_prod_intake_owner");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_intake_owner"),
    migrateTarget:migrateTarget("cr_prod_intake_owner"), rootDir:ROOT, env:{...process.env,...passwords} });
  const scope={tenantId:"tenant:web",workspaceId:"workspace:web"}, clock=()=>webNow;
  const at=new Date(webNow).toISOString();
  await query(db,"INSERT INTO tenants(id,display_name) VALUES('tenant:web','Test tenant')");
  await query(db,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Test workspace')");
  const admin=postgresDatabase(db);
  await new SecurityStore(admin).bootstrapOwner({ tenantId:"tenant:web", provider:webTrust.issuer, subject:"test-owner",
    identityId:"identity:web", grantId:"grant:web", displayName:"Test owner", verifiedAt:new Date(webNow-60_000).toISOString(),
    expiresAt:new Date(webNow+300_000).toISOString(), now:at });
  const identity=createAccessVerifier(webTrust)(webRequest(),webNow);
  const { project }=await new WebProjectService(admin,scope,clock).create(identity,
    { title:"Batch project", summary:"Real PostgreSQL owner review" },"intake-owner-project-0001");
  const projectId=project.projectId;
  await query(db,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:batch-agent','tenant:web','agent','Batch agent',
    'work-intake',$1,'active',$2,$2)`,[sha256Digest("batch-agent"),at]);
  await query(db,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:batch-agent','tenant:web',
    'identity:batch-agent','work_batch_proposer','["work_batches.propose"]',$1::jsonb,'low',false,false,$2,$2)`,
  [JSON.stringify([projectId]),at]);
  await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,'tenant:web')");

  const key=new Uint8Array(32).fill(7);
  const intake={...target("cr_prod_intake_owner","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  const store=new WorkBatchStoreV1(postgresDatabase(intake),key);
  const owner=new WorkBatchOwnerServiceV1(admin,new WebTaskService(admin,scope,clock),scope,key,clock);
  const principal={tenantId:"tenant:web",identityId:"identity:batch-agent",actorType:"agent",
    authenticatedAt:"2026-09-04T11:59:00.000Z",expiresAt:"2026-09-04T13:00:00.000Z"};
  const task=(localId,role,capability)=>({localId,title:`${localId} the change`,instructions:`${localId} the bounded change.`,
    requiredCapability:capability,role,acceptanceCriteria:`The ${localId} step is bounded.`,
    acceptanceTests:`Run the focused ${localId} tests.`});
  const proposalOf=(tasks,edges=[])=>({schema:"control-room.work-batch-proposal/v1",projectId,tasks,edges});
  const submit=async (value,keySuffix)=>store.create({principal,proposal:value,proposalDigest:workBatchProposalDigestV1(value),
    idempotencyKey:`intake-owner-submit-${keySuffix}`,now:at,queueDepthLimit:10});
  const batch=await submit(proposalOf([task("build","builder","code.change")]),"0001");
  const untouched=await submit(proposalOf([task("draft","builder","code.change")]),"0002");
  assert.equal((await store.status(principal,projectId,batch.batchId,at)).taskCount,1);

  const revised=proposalOf([task("build","builder","code.change"),task("check","checker","code.review"),
    task("validate","validator","code.validate")],[{fromLocalId:"build",toLocalId:"check"}]);
  await owner.command(identity,projectId,{ operation:"revise", batchId:batch.batchId, expectedRevision:1,
    reasonCode:"owner_edit", proposal:revised },"intake-owner-revise-0001");
  const afterRevision=await store.status(principal,projectId,batch.batchId,at);
  assert.equal(afterRevision.state,"proposed");
  assert.equal(afterRevision.taskCount,3);
  assert.equal(afterRevision.proposalDigest,workBatchProposalDigestV1(revised));
  // The intake login reads the owner's current revision, not only its own.
  assert.deepEqual((await query(intake,`SELECT revision::int,edited_by_identity_id FROM work_batch_revisions
    WHERE batch_id=$1 ORDER BY revision`,[batch.batchId])).rows,
  [{revision:1,edited_by_identity_id:"identity:batch-agent"},{revision:2,edited_by_identity_id:"identity:web"}]);
  assert.deepEqual((await store.list(principal,projectId,at)).map(row=>[row.batchId,row.state]).sort(),
    [[batch.batchId,"proposed"],[untouched.batchId,"proposed"]].sort());
  // Reading owner revisions never lets the intake login write one.
  await assert.rejects(query(intake,`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
    edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,'tenant:web',$2,3,'identity:web',$3,'owner_edit',
    $4::jsonb,$5,$6)`,[`${batch.batchId}:revision:3`,batch.batchId,at,JSON.stringify(revised),
    workBatchProposalDigestV1(revised),`hmac-sha256:${"a".repeat(64)}`]),/row-level security/u);

  const decided=await owner.command(identity,projectId,{ operation:"decide", batchId:batch.batchId, expectedRevision:2,
    items:[{localId:"build",decision:"approve"},{localId:"check",decision:"approve"},
      {localId:"validate",decision:"reject",reasonCode:"not_selected"}] },"intake-owner-decide-0001");
  assert.equal(decided.state,"partially_approved");
  const afterDecision=await store.status(principal,projectId,batch.batchId,at);
  assert.equal(afterDecision.state,"partially_approved");
  assert.equal(afterDecision.taskCount,3);
  assert.equal(afterDecision.proposalDigest,workBatchProposalDigestV1(revised));
  assert.deepEqual((await store.list(principal,projectId,at)).map(row=>[row.batchId,row.state]).sort(),
    [[batch.batchId,"partially_approved"],[untouched.batchId,"proposed"]].sort());
  assert.equal((await query(intake,"SELECT count(*)::int AS items FROM work_batch_items WHERE batch_id=$1",
    [batch.batchId])).rows[0].items,3);
});

// S3 queue records. Two realistic tenants: each has its own owner and a
// work-intake agent with a valid proposer grant, proposes through the real
// store as the production intake login, and is admitted to the exact-worker
// queue by the real owner service. The intake login must never reach the
// other tenant's queue records, and the owner web role must be able to write
// and render them on its own narrow grants.
test("agent-queue records stay in the bound intake tenant and work on the production logins", needsPg, async () => {
  await freshDatabase("cr_prod_agent_queue");
  const db=target("cr_prod_agent_queue");
  await applyMigrations({ target:db, bootstrapTarget:bootstrapTarget("cr_prod_agent_queue"),
    migrateTarget:migrateTarget("cr_prod_agent_queue"), rootDir:ROOT, env:{...process.env,...passwords} });
  const admin=postgresDatabase(db), clock=()=>webNow, at=new Date(webNow).toISOString();
  const key=new Uint8Array(32).fill(7);
  const identity=createAccessVerifier(webTrust)(webRequest(),webNow);
  const catalog=[{ workerId:"worker:codex-one", workerKind:"codex", nodeId:"node:mac.codex",
    modelPolicy:{ models:["gpt-build","gpt-check"], defaultModel:"gpt-build", efforts:["high"], defaultEffort:"high" } }];
  const modelCatalog=captureTaskModelCatalogV1(catalog.map(worker=>({ kind:worker.workerKind, policy:worker.modelPolicy })));
  const authority={ assertCurrent:()=>true, isAcceptedResultCurrent:()=>false };
  const intake={...target("cr_prod_agent_queue","control_room_work_intake_agent"),
    password:passwords.CONTROL_ROOM_WORK_INTAKE_PASSWORD};
  const store=new WorkBatchStoreV1(postgresDatabase(intake),key);
  const bind=async tenantId=>{ await query(db,"DELETE FROM work_intake_tenant_binding");
    await query(db,"INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)",[tenantId]); };
  const task=localId=>({localId,title:`${localId} the change`,instructions:`${localId} the bounded change.`,
    requiredCapability:"code.change",role:"builder",requestedWorkerId:"worker:codex-one",requestedWorkerKind:"codex",
    requestedModelKey:"gpt-build",acceptanceCriteria:`SECRET ${localId} criteria`,acceptanceTests:`Run the ${localId} tests.`});
  const tenants={};
  for (const [name,tenantId] of [["own","tenant:queue-own"],["other","tenant:queue-other"]]) {
    const scope={tenantId,workspaceId:`workspace:queue-${name}`};
    await query(db,"INSERT INTO tenants(id,display_name) VALUES($1,$1)",[tenantId]);
    await query(db,"INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'workspace')",[scope.workspaceId,tenantId]);
    await new SecurityStore(admin).bootstrapOwner({ tenantId, provider:webTrust.issuer, subject:"test-owner",
      identityId:`identity:queue-owner-${name}`, grantId:`grant:queue-owner-${name}`, displayName:"Test owner",
      verifiedAt:new Date(webNow-60_000).toISOString(), expiresAt:new Date(webNow+300_000).toISOString(), now:at });
    const { project }=await new WebProjectService(admin,scope,clock).create(identity,
      { title:"Queue project", summary:"Real PostgreSQL agent queue" },`queue-project-${name}-0001`);
    const agentId=`identity:work-intake:queue-${name}`;
    await query(db,`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Batch agent','work-intake',$3,'active',$4,$4)`,
    [agentId,tenantId,sha256Digest(`queue-agent-${name}`),at]);
    await query(db,`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES($1,$2,$3,
      'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
    [`grant:work-intake:queue-${name}`,tenantId,agentId,JSON.stringify([project.projectId]),at]);
    const principal={tenantId,identityId:agentId,actorType:"agent",
      authenticatedAt:"2026-09-04T11:59:00.000Z",expiresAt:"2026-09-04T13:00:00.000Z"};
    const owner=new WorkBatchOwnerServiceV1(admin,new WebTaskService(admin,scope,clock,{modelCatalog}),scope,key,clock,
      catalog,authority);
    tenants[name]={tenantId,scope,projectId:project.projectId,principal,owner};
  }
  // Each tenant's agent proposes while the owner has its tenant bound; the
  // owner then admits the batch to the exact worker queue.
  for (const name of ["other","own"]) {
    const t=tenants[name];
    await bind(t.tenantId);
    const value={schema:"control-room.work-batch-proposal/v1",projectId:t.projectId,tasks:[task("build")],edges:[]};
    t.batch=await store.create({principal:t.principal,proposal:value,proposalDigest:workBatchProposalDigestV1(value),
      idempotencyKey:`queue-${name}-submit-0001`,now:at,queueDepthLimit:5});
    const decided=await t.owner.command(identity,t.projectId,{ operation:"decide", batchId:t.batch.batchId,
      expectedRevision:1, items:[{localId:"build",decision:"approve"}] },`queue-${name}-decide-0001`);
    assert.equal(decided.state,"approved");
  }
  const byTenant=async (conn,table)=>(await query(conn,`SELECT tenant_id FROM ${table} ORDER BY tenant_id`)).rows
    .map(row=>row.tenant_id);
  const queueTables=["work_batch_agent_queue_heads","work_batch_queue_admissions"];
  for (const table of queueTables)
    assert.deepEqual(await byTenant(db,table),["tenant:queue-other","tenant:queue-own"],table);

  // Agent-facing reads on the production intake login, bound to its own tenant:
  // the decided batch (items now carry the exact requested worker) verifies.
  const own=tenants.own, other=tenants.other;
  const status=await store.status(own.principal,own.projectId,own.batch.batchId,at);
  assert.equal(status.state,"approved");
  assert.deepEqual((await store.list(own.principal,own.projectId,at)).map(row=>[row.batchId,row.state]),
    [[own.batch.batchId,"approved"]]);
  assert.deepEqual((await query(intake,"SELECT tenant_id,requested_worker_id FROM work_batch_items")).rows,
    [{tenant_id:"tenant:queue-own",requested_worker_id:"worker:codex-one"}]);
  await assert.rejects(store.status(other.principal,other.projectId,other.batch.batchId,at),{safeCode:"batch_not_found"});
  // The intake login holds no grant on the queue records at all.
  for (const table of [...queueTables,"work_batch_effective_queue_admissions"])
    await assert.rejects(query(intake,`SELECT tenant_id FROM ${table}`),/permission denied/u,table);
  // Defence in depth: even if a later grant exposed the queue tables to the
  // intake group, the tenant binding still hides and refuses the other tenant.
  await query(db,`GRANT SELECT,INSERT ON work_batch_agent_queue_heads,work_batch_queue_admissions
    TO control_room_work_intake`);
  try {
    for (const table of queueTables) {
      assert.deepEqual(await byTenant(intake,table),["tenant:queue-own"],table);
      assert.deepEqual((await query(intake,`SELECT * FROM ${table} WHERE tenant_id='tenant:queue-other'`)).rows,[],table);
    }
    await assert.rejects(query(intake,`INSERT INTO work_batch_agent_queue_heads(tenant_id,worker_id,next_position,updated_at)
      VALUES('tenant:queue-other','worker:forged',1,$1)`,[at]),/row-level security/u);
    await query(db,"DELETE FROM work_intake_tenant_binding");
    for (const table of queueTables) assert.deepEqual(await byTenant(intake,table),[],table);
  } finally {
    await query(db,`REVOKE SELECT,INSERT ON work_batch_agent_queue_heads,work_batch_queue_admissions
      FROM control_room_work_intake`);
    await bind(own.tenantId);
  }

  // Owner-facing queue writes and reads on the restricted private-web role.
  // Role definitions are cluster-global, so the role is installed inside one
  // transaction and every service transaction runs as a savepoint that fires
  // the deferred queue-head consistency check before it is released.
  const client=new Client(db);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query((await readFile(join(ROOT,"db/roles/private_web_roles.sql"),"utf8")).replace(/^(?:BEGIN|COMMIT);$/gmu,""));
    await client.query("SET LOCAL ROLE control_room_private_web");
    let savepoint=0;
    const session={query:(sql,params=[])=>client.query(sql,params)};
    const nested=async (work,check)=>{
      const name=`service_${++savepoint}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result=await work(session);
        if (check) await check();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw error; }
    };
    const web={query:(sql,params=[])=>client.query(sql,params),transaction:work=>nested(work),
      transactionWithPreCommitCheck:(work,check)=>nested(work,check)};
    const webOwner=new WorkBatchOwnerServiceV1(web,new WebTaskService(web,own.scope,clock,{modelCatalog}),own.scope,key,
      clock,catalog,authority);
    assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,"control_room_private_web");
    const view=await webOwner.view(identity,own.projectId,own.batch.batchId);
    assert.deepEqual(view.queue.map(item=>[item.localId,item.position,item.workerId,item.state]),
      [["build",1,"worker:codex-one","awaiting_preparation"]]);
    // The store needs the intake login; propose the second batch there, then
    // decide it on the private-web role inside this uncommitted transaction.
    await client.query("RESET ROLE");
    const second={schema:"control-room.work-batch-proposal/v1",projectId:own.projectId,tasks:[task("check")],edges:[]};
    const secondBatch=await new WorkBatchStoreV1(web,key).create({principal:own.principal,proposal:second,
      proposalDigest:workBatchProposalDigestV1(second),idempotencyKey:"queue-own-submit-0002",now:at,queueDepthLimit:5});
    await client.query("SET LOCAL ROLE control_room_private_web");
    const decided=await webOwner.command(identity,own.projectId,{ operation:"decide", batchId:secondBatch.batchId,
      expectedRevision:1, items:[{localId:"check",decision:"approve"}] },"queue-own-decide-0002");
    assert.equal(decided.state,"approved");
    assert.deepEqual((await webOwner.view(identity,own.projectId,secondBatch.batchId)).queue
      .map(item=>[item.localId,item.position,item.workerId]),[["check",2,"worker:codex-one"]]);
    assert.deepEqual((await client.query(`SELECT tenant_id,next_position::int FROM work_batch_agent_queue_heads
      ORDER BY tenant_id`)).rows,[{tenant_id:"tenant:queue-other",next_position:2},{tenant_id:"tenant:queue-own",next_position:3}]);
    // Narrow grants: no delete, no rewrite of an admission, no head rewind.
    await client.query("SAVEPOINT refusals");
    await assert.rejects(client.query("DELETE FROM work_batch_queue_admissions"),/permission denied/u);
    await client.query("ROLLBACK TO SAVEPOINT refusals");
    await assert.rejects(client.query("UPDATE work_batch_queue_admissions SET model='tampered'"),/permission denied/u);
    await client.query("ROLLBACK TO SAVEPOINT refusals");
    await assert.rejects(client.query(`UPDATE work_batch_agent_queue_heads SET next_position=1
      WHERE tenant_id='tenant:queue-own'`),/queue head update rejected/u);
    await client.query("ROLLBACK TO SAVEPOINT refusals");
    // The assignment gate's coordinator role reads the queue only through the
    // effective-admission view, never the raw records or heads.
    await client.query("RESET ROLE");
    await client.query((await readFile(join(ROOT,"db/roles/task_coordinator_roles.sql"),"utf8")).replace(/^(?:BEGIN|COMMIT);$/gmu,""));
    await client.query("SET LOCAL ROLE control_room_task_coordinator");
    assert.deepEqual((await client.query(`SELECT tenant_id,queue_position::int FROM work_batch_effective_queue_admissions
      WHERE tenant_id='tenant:queue-own' ORDER BY queue_position`)).rows,
    [{tenant_id:"tenant:queue-own",queue_position:1},{tenant_id:"tenant:queue-own",queue_position:2}]);
    await client.query("SAVEPOINT coordinator");
    for (const table of queueTables) {
      await assert.rejects(client.query(`SELECT 1 FROM ${table}`),/permission denied/u,table);
      await client.query("ROLLBACK TO SAVEPOINT coordinator");
    }
  } finally {
    await client.query("ROLLBACK").catch(()=>{});
    await client.end();
  }
  assert.deepEqual((await query(db,`SELECT rolname FROM pg_roles WHERE rolname IN
    ('control_room_private_web','control_room_task_coordinator')`)).rows,[]);
});

test("backup and disposable restore preserve rows, owners, grants and identity", needsPg, async () => {
  await freshDatabase("cr_prod_source");
  await applyMigrations({ target: target("cr_prod_source"), bootstrapTarget: bootstrapTarget("cr_prod_source"), migrateTarget: migrateTarget("cr_prod_source"), rootDir: ROOT, env: { ...process.env, ...passwords } });
  await query(target("cr_prod_source"), "INSERT INTO tenants(id, display_name) VALUES('tenant:restore', 'restore')");
  const ledger = JSON.parse(await readFile(join(ROOT, "deploy/postgres/migration-ledger.json"), "utf8"));
  const out = join(run, "backup-set");
  const backup = await backupDatabase({ source: target("cr_prod_source"), out, pgBin: BIN, ledgerDigest: `sha256:${ledger.digest}`, requiredTables: ["tenants"] });
  assert.equal(backup.planned, false);
  await freshDatabase("cr_prod_restored");
  const restored = await restoreDatabase({ backup: out, target: target("cr_prod_restored"), confirmTarget: target("cr_prod_restored"), pgBin: BIN, requiredTables: ["tenants"] });
  assert.equal(restored.identityDigest, backup.identityDigest);
  const sourceRows = (await query(target("cr_prod_source"), "SELECT id, display_name FROM tenants ORDER BY id")).rows;
  const restoredRows = (await query(target("cr_prod_restored"), "SELECT id, display_name FROM tenants ORDER BY id")).rows;
  assert.deepEqual(restoredRows, sourceRows);
  const ownerOf = async (conn) => (await query(conn, "SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tenants'")).rows[0].owner;
  assert.equal(await ownerOf(target("cr_prod_restored")), await ownerOf(target("cr_prod_source")));
  const viewOwnerOf = async (conn) => (await query(conn, "SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'work_batch_effective_queue_admissions' AND c.relkind = 'v'")).rows[0].owner;
  assert.equal(await viewOwnerOf(target("cr_prod_restored")), await viewOwnerOf(target("cr_prod_source")));
  // Role model preserved: the reconciled target carries exactly the source's
  // control-room memberships (roles are cluster-global in this fixture, which
  // is why the dedicated reconcile test below revokes first to prove the
  // re-grant path instead of merely observing shared state).
  assert.deepEqual(await roleMemberships(target("cr_prod_restored")), await roleMemberships(target("cr_prod_source")));
});

test("restore refuses unconfirmed and non-empty targets", needsPg, async () => {
  const out = join(run, "backup-set");
  await assert.rejects(restoreDatabase({ backup: out, target: target("cr_prod_restored"), confirmTarget: target("cr_prod_other"), pgBin: BIN }), /restore_refused_unconfirmed_target/);
  await assert.rejects(restoreDatabase({ backup: out, target: target("cr_prod_source"), confirmTarget: target("cr_prod_source"), pgBin: BIN }), /restore_refused_nonempty_target/);
});

test("restore reconciles a revoked membership from the recorded role model", needsPg, async () => {
  const out = join(run, "backup-set");
  // Revoke cluster-wide, then restore into a fresh database: the reconcile
  // step must re-grant the recorded membership or the identity check fails.
  await query(target("cr_prod_source"), "REVOKE control_room_application FROM control_room_app");
  const before = await roleMemberships(target("cr_prod_source"));
  assert.ok(!before.some(entry => entry.member === "control_room_app" && entry.role === "control_room_application"));
  await freshDatabase("cr_prod_reconcile");
  const restored = await restoreDatabase({ backup: out, target: target("cr_prod_reconcile"), confirmTarget: target("cr_prod_reconcile"), pgBin: BIN, requiredTables: ["tenants"] });
  assert.equal(restored.planned, false);
  const after = await roleMemberships(target("cr_prod_reconcile"));
  assert.ok(after.some(entry => entry.member === "control_room_app" && entry.role === "control_room_application" && entry.admin_option === false));
});

test("restore identity fails closed on a flipped sensitive role attribute", needsPg, async () => {
  const meta = JSON.parse(await readFile(join(run, "backup-set/metadata.json"), "utf8"));
  await query(target("cr_prod_restored"), "ALTER ROLE control_room_app WITH REPLICATION");
  try {
    const evidence = await collectDatabaseEvidence(target("cr_prod_restored"), { requiredTables: ["tenants"] });
    assert.ok(evidence.roles.some(role => role.rolname === "control_room_app" && role.rolreplication === true));
    const tampered = computeDatabaseRestoreIdentity({
      ledgerDigest: meta.ledgerDigest, rolesDigest: digestOf(evidence.roles),
      membershipsDigest: digestOf(evidence.memberships), schemaDigest: evidence.schemaDigest,
      rowsDigest: digestOf(evidence.rows), ownersDigest: digestOf(evidence.grants),
      ledgerRowsDigest: digestOf(evidence.ledger), databaseOwnerDigest: digestOf(evidence.databaseOwner),
    });
    assert.throws(() => verifyRestoredIdentity(meta.identity, tampered), /restore_identity_mismatch:rolesDigest/);
  } finally {
    await query(target("cr_prod_restored"), "ALTER ROLE control_room_app WITH NOREPLICATION");
  }
});

test("restore identity fails closed on a revoked membership", needsPg, async () => {
  const meta = JSON.parse(await readFile(join(run, "backup-set/metadata.json"), "utf8"));
  await query(target("cr_prod_restored"), "REVOKE control_room_application FROM control_room_app");
  try {
    const evidence = await collectDatabaseEvidence(target("cr_prod_restored"), { requiredTables: ["tenants"] });
    const tampered = computeDatabaseRestoreIdentity({
      ledgerDigest: meta.ledgerDigest, rolesDigest: digestOf(evidence.roles),
      membershipsDigest: digestOf(evidence.memberships), schemaDigest: evidence.schemaDigest,
      rowsDigest: digestOf(evidence.rows), ownersDigest: digestOf(evidence.grants),
      ledgerRowsDigest: digestOf(evidence.ledger), databaseOwnerDigest: digestOf(evidence.databaseOwner),
    });
    assert.throws(() => verifyRestoredIdentity(meta.identity, tampered), /restore_identity_mismatch:membershipsDigest/);
  } finally {
    await query(target("cr_prod_restored"), "GRANT control_room_application TO control_room_app");
  }
});

test("operator provision script creates logins via psql without exposing passwords", needsPg, async () => {
  await freshDatabase("cr_prod_provision");
  const psqlEnv = {
    PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run,
    PGHOST: socket, PGPORT: String(PORT), PGUSER: "fixture_admin",
    PGPASSWORD: "fixture_only", PGDATABASE: "cr_prod_provision",
  };
  const provision = (vars) => exec(join(BIN, "psql"),
    ["-v", `migrator_password=${vars.migrator}`, "-v", `app_password=${vars.app}`,
     "-v", `scheduler_password=${vars.scheduler}`,
     "-v", `work_intake_password=${vars.workIntake}`,
     "-f", join(ROOT, "db/roles/production_provision.sql"), "-X", "-q"],
    { env: psqlEnv, timeout: 60000, maxBuffer: 1 << 26 });
  // Short passwords fail closed before any login is created.
  const short = await provision({ migrator: "x".repeat(23), app: "y".repeat(24), scheduler: "z".repeat(24),
    workIntake: "w".repeat(24) }).then(
    () => { throw new Error("provision_accepted_short_password"); },
    (error) => error);
  assert.match(`${short.stderr ?? ""}`, /provision_refused_short_migrator_password/);
  // Full run: genuinely executable through real psql variable substitution.
  const pw = { migrator: "provision-test-migrator-0001", app: "provision-test-app-00001",
    scheduler: "provision-test-scheduler-0001", workIntake: "provision-test-work-intake-001" };
  const done = await provision(pw);
  for (const secret of Object.values(pw)) {
    assert.ok(!`${done.stdout ?? ""}${done.stderr ?? ""}`.includes(secret), "password leaked into psql output");
  }
  const roles = (await query(target("cr_prod_provision"),
    "SELECT rolname, rolcanlogin, rolpassword FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@' ORDER BY 1")).rows;
  const byName = new Map(roles.map(role => [role.rolname, role]));
  for (const login of ["control_room_migrator", "control_room_app", "control_room_scheduler",
      "control_room_work_intake_agent"]) {
    assert.equal(byName.get(login)?.rolcanlogin, true, `${login} can login`);
    assert.ok(byName.get(login)?.rolpassword, `${login} has a password set`);
  }
  assert.ok(!byName.get("control_room_migrator").rolpassword.includes(pw.migrator), "password stored hashed, not plaintext");
  const memberships = await roleMemberships(target("cr_prod_provision"));
  for (const [member, role] of [["control_room_migrator", "control_room_schema_owner"],
      ["control_room_app", "control_room_application"],
      ["control_room_scheduler", "control_room_schedule_admissions"],
      ["control_room_work_intake_agent", "control_room_work_intake"]]) {
    assert.ok(memberships.some(entry => entry.member === member && entry.role === role), `${member} in ${role}`);
  }
});

test("documented clean-cluster provision/migrate/backup/restore/verify journey", needsPg, async (t) => {
  // A second disposable cluster: cluster-global roles from earlier tests must
  // not mask a provision script that assumes groups already exist, and the
  // restore target must not inherit shared-cluster role state either. Every
  // step below is the documented operator flow, executed literally.
  const CLEAN_PORT = PORT + 1;
  const cleanSocket = join(run, "clean-socket"), cleanData = join(run, "clean-data");
  const cleanBackup = join(run, "clean-backup-set");
  // The restore target lives in its OWN disposable cluster: roles and
  // memberships are cluster-wide, so a second database in the source cluster
  // would inherit the source's role state before target provisioning.
  const TARGET_PORT = PORT + 2;
  const targetSocket = join(run, "clean-target-socket"), targetData = join(run, "clean-target-data");
  const asPostgres = process.getuid?.() === ROOT_UID;
  const ownDirs = async (...dirs) => {
    if (asPostgres) await exec("chown", ["-R", `${POSTGRES_UID}:${POSTGRES_GID}`, ...dirs]);
  };
  await mkdir(cleanSocket, { mode: 0o700 });
  await mkdir(targetSocket, { mode: 0o700 });
  await ownDirs(cleanSocket, targetSocket, run);
  const startCluster = async (socket, data, port, log) => {
    if (asPostgres) {
      await exec("mkdir", ["-p", data]);
      await ownDirs(data);
    } else {
      await mkdir(data, { recursive: true });
    }
    await native("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust",
      "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
    await native("pg_ctl", ["-D", data, "-l", join(run, log), "-w", "-t", "30", "-o",
      `-k ${socket} -p ${port} -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=20`, "start"]);
  };
  // Both teardowns are armed BEFORE either cluster starts, and both are released
  // here whatever the outcome. Creating them inside this hook — which is what
  // the first version of this change did — armed nothing during `startCluster`,
  // so a throw from the SECOND start left two live postmasters unsupervised:
  // the exact window this change exists to close.
  //
  // The ladder, whose order is what RELEASES a postmaster's SysV segment. The
  // old `catch {}` on each `pg_ctl` reported success for a cluster that was
  // still running and then removed its data directory — leaving a live
  // postmaster holding a segment and nothing left to stop it with.
  const inner = [
    createClusterTeardown({ dataDirectory: cleanData, runDirectory: cleanData,
      socketDirectory: cleanSocket, port: CLEAN_PORT, pgBin: BIN, removeDirectories: false }),
    createClusterTeardown({ dataDirectory: targetData, runDirectory: targetData,
      socketDirectory: targetSocket, port: TARGET_PORT, pgBin: BIN, removeDirectories: false }),
  ];
  t.after(async () => {
    // Every teardown is attempted and the failures are collected: a throw from
    // the first `.stop()` must not skip the second cluster, which would leave
    // precisely the orphan this is here to prevent.
    const failures = [];
    for (const [index, teardown] of inner.entries()) {
      try { await teardown.stop(); }
      catch (error) { failures.push(`cluster_${index}:${error?.message ?? String(error)}`); }
    }
    for (const directory of [cleanData, targetData, cleanSocket, targetSocket, cleanBackup]) {
      await rm(directory, { recursive: true, force: true });
    }
    if (failures.length > 0) throw new Error(`disposable_cluster_teardown_failed:${failures.join(" | ")}`);
  });
  await startCluster(cleanSocket, cleanData, CLEAN_PORT, "clean-server.log");
  // The pid is retained while the cluster is up. Without it the teardown has
  // nothing to signal, so it takes the branch that can only try one `pg_ctl` and
  // then give up: the ladder would never run for this cluster.
  await inner[0].capturePostmasterPid();
  await startCluster(targetSocket, targetData, TARGET_PORT, "clean-target-server.log");
  await inner[1].capturePostmasterPid();
  // origin/main added a fourth role password for the work-intake provisioning;
  // both are kept, and the consumer below already passes `-v work_intake_password`.
  const pw = { migrator: "clean-install-migrator-0001", app: "clean-install-app-000001",
    scheduler: "clean-install-scheduler-0001", workIntake: "clean-install-work-intake-001" };
  const psqlFor = (socket, port) => ({
    PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run,
    PGHOST: socket, PGPORT: String(port), PGUSER: "postgres",
    PGPASSWORD: "fixture_only",
  });
  const psqlBase = psqlFor(cleanSocket, CLEAN_PORT);
  const provisionRoles = (database, env = psqlBase) => exec(join(BIN, "psql"),
    ["-v", `migrator_password=${pw.migrator}`, "-v", `app_password=${pw.app}`,
     "-v", `scheduler_password=${pw.scheduler}`,
     "-v", `work_intake_password=${pw.workIntake}`,
     "-f", join(ROOT, "db/roles/production_provision.sql"), "-X", "-q"],
    { env: { ...env, PGDATABASE: database }, timeout: 60000, maxBuffer: 1 << 26 });
  const cleanConn = (socket, port, database, user = "postgres", password = "fixture_only") =>
    ({ host: socket, port, database, user, password });
  const sourceConn = (database, user, password) => cleanConn(cleanSocket, CLEAN_PORT, database, user, password);
  const targetConn = (database, user, password) => cleanConn(targetSocket, TARGET_PORT, database, user, password);
  const cleanQuery = async (socket, port, database, sql, params = []) => {
    const client = new Client(cleanConn(socket, port, database));
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
  const sourceQuery = (database, sql, params = []) => cleanQuery(cleanSocket, CLEAN_PORT, database, sql, params);
  // Step 0 of the documented fresh install: the database-creation script. The
  // owner stays the invoking superuser — the schema-owner role does not exist
  // yet on a genuinely empty cluster, so an OWNER clause would be rejected.
  await exec(join(BIN, "psql"),
    ["-v", "dbname=cr_clean_install", "-f", join(ROOT, "deploy/postgres/provision-database.sql"), "-X", "-q"],
    { env: { ...psqlBase, PGDATABASE: "postgres" }, timeout: 60000, maxBuffer: 1 << 26 });
  const preOwner = (await sourceQuery("postgres",
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'cr_clean_install'")).rows[0].owner;
  assert.equal(preOwner, "postgres", "database starts owned by the creating superuser");
  // Step 1: standalone role provisioning on the clean database.
  await provisionRoles("cr_clean_install");
  // Step 2: the documented two-connection migration command, via the real CLI.
  const adminConn = `host=${cleanSocket} port=${CLEAN_PORT} dbname=cr_clean_install user=postgres`;
  const migratorConn = `host=${cleanSocket} port=${CLEAN_PORT} dbname=cr_clean_install user=control_room_migrator password=${pw.migrator}`;
  const migrated = await exec(process.execPath,
    [join(ROOT, "deploy/postgres/apply-migrations.mjs"),
     "--bootstrap-target", adminConn, "--migrate-target", migratorConn],
    { cwd: ROOT, timeout: 300000, maxBuffer: 1 << 26,
      env: { ...process.env, PATH: "/usr/bin:/bin", LC_ALL: "C",
        CONTROL_ROOM_MIGRATOR_PASSWORD: pw.migrator, CONTROL_ROOM_APP_PASSWORD: pw.app,
        CONTROL_ROOM_SCHEDULER_PASSWORD: pw.scheduler,
        CONTROL_ROOM_WORK_INTAKE_PASSWORD: pw.workIntake } });
  const result = JSON.parse(migrated.stdout);
  assert.ok((result.applied?.length ?? 0) > 0, "migrations applied through the documented CLI");
  // The install is complete and least-privilege: logins, groups, memberships,
  // ledger rows, schema-owner object ownership and database ownership, all on
  // the clean cluster.
  const db = sourceConn("cr_clean_install");
  const cleanTargetQuery = async (sql, params = []) => {
    const client = new Client(db);
    await client.connect();
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  };
  const roles = (await cleanTargetQuery(
    "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@' ORDER BY 1")).rows;
  const byName = new Map(roles.map(role => [role.rolname, role]));
  for (const login of ["control_room_migrator", "control_room_app", "control_room_scheduler",
      "control_room_work_intake_agent"]) {
    assert.equal(byName.get(login)?.rolcanlogin, true, `${login} can login`);
  }
  for (const group of ["control_room_schema_owner", "control_room_application", "control_room_schedule_admissions"]) {
    assert.ok(byName.has(group), `${group} exists`);
  }
  const memberships = await roleMemberships(db);
  for (const [member, role] of [["control_room_migrator", "control_room_schema_owner"],
      ["control_room_app", "control_room_application"],
      ["control_room_scheduler", "control_room_schedule_admissions"],
      ["control_room_work_intake_agent", "control_room_work_intake"]]) {
    assert.ok(memberships.some(entry => entry.member === member && entry.role === role), `${member} in ${role}`);
  }
  const owners = (await cleanTargetQuery(
    "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")).rows;
  assert.deepEqual(owners.map(row => row.owner), ["control_room_schema_owner"]);
  const dbOwner = (await sourceQuery("postgres",
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'cr_clean_install'")).rows[0].owner;
  assert.equal(dbOwner, "control_room_schema_owner", "bootstrap transfers database ownership after roles exist");
  const ledgerRows = (await cleanTargetQuery("SELECT count(*)::int AS count FROM control_room_schema_migrations")).rows;
  const executable = (await collectLedgerEntries()).filter(entry => (entry.kind ?? "migrate") === "migrate");
  assert.equal(ledgerRows[0].count, executable.length, "every executable ledger entry applied");
  // Step 3: seed a row and back the clean install up (function inputs actually
  // consumed: source/out/pgBin/ledgerDigest/requiredTables).
  await cleanTargetQuery("INSERT INTO tenants(id, display_name) VALUES('tenant:clean', 'clean install')");
  const ledger = JSON.parse(await readFile(join(ROOT, "deploy/postgres/migration-ledger.json"), "utf8"));
  const backup = await backupDatabase({ source: db, out: cleanBackup, pgBin: BIN,
    ledgerDigest: `sha256:${ledger.digest}`, requiredTables: ["tenants"] });
  assert.equal(backup.planned, false);
  // Step 4: the documented recovery order on the SEPARATE target cluster —
  // database script, then role provisioning (restore reconciles memberships
  // but refuses a missing login, so the logins must pre-exist). The absence
  // proof first: the target cluster must carry none of the source's role
  // state before its own provisioning.
  const targetPsq = psqlFor(targetSocket, TARGET_PORT);
  const absent = (await cleanQuery(targetSocket, TARGET_PORT, "postgres",
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'control@_room@_%' ESCAPE '@'")).rows;
  assert.deepEqual(absent, [], "target cluster starts with no control-room roles");
  await exec(join(BIN, "psql"),
    ["-v", "dbname=cr_clean_restored", "-f", join(ROOT, "deploy/postgres/provision-database.sql"), "-X", "-q"],
    { env: { ...targetPsq, PGDATABASE: "postgres" }, timeout: 60000, maxBuffer: 1 << 26 });
  await provisionRoles("cr_clean_restored", targetPsq);
  // Step 5: restore into the provisioned empty target and verify the restored
  // identity field by field (restoreDatabase verifies internally, including
  // the new databaseOwnerDigest; the digest equality pins the same identity
  // the backup recorded). Only consumed inputs are passed — no unused
  // bootstrap/migrate descriptors.
  const cleanTarget = targetConn("cr_clean_restored");
  const restored = await restoreDatabase({ backup: cleanBackup, target: cleanTarget,
    confirmTarget: targetConn("cr_clean_restored"), pgBin: BIN, requiredTables: ["tenants"] });
  assert.equal(restored.identityDigest, backup.identityDigest, "restored identity matches the backup identity");
  const sourceRows = (await cleanTargetQuery("SELECT id, display_name FROM tenants ORDER BY id")).rows;
  const restoredClient = new Client(cleanTarget);
  await restoredClient.connect();
  try {
    const restoredRows = (await restoredClient.query("SELECT id, display_name FROM tenants ORDER BY id")).rows;
    assert.deepEqual(restoredRows, sourceRows, "seed row survives the clean-cluster round trip");
  } finally {
    await restoredClient.end();
  }
  assert.deepEqual(await roleMemberships(cleanTarget), memberships, "restored target carries the clean install memberships");
  const restoredOwners = (await cleanQuery(targetSocket, TARGET_PORT, "cr_clean_restored",
    `SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`)).rows;
  assert.deepEqual([...new Set(restoredOwners.map(row => row.owner))], ["control_room_schema_owner"],
    `unexpected restored public owners: ${JSON.stringify(restoredOwners.filter(row => row.owner!=="control_room_schema_owner"))}`);
  // Database ownership matches the source: the recorded owner is re-applied,
  // not the invoking administrator.
  const targetDbOwner = (await cleanQuery(targetSocket, TARGET_PORT, "postgres",
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'cr_clean_restored'")).rows[0].owner;
  assert.equal(targetDbOwner, dbOwner, "restored database owner matches the source database owner");
  assert.equal(targetDbOwner, "control_room_schema_owner");

  // The Mac-local wrapper adds the exact restricted roles the installer creates,
  // hashes the dump+metadata manifest, and proves the result in its own fresh
  // cluster. The login set comes from the plan, for the same reason the other
  // Mac-local fixture derives it: `provisionMacLocalNarrowRolesV1` refuses any
  // set that is not exactly its plan's, so a restated list fails the moment the
  // plan gains a login.
  // Queue construction and its guarded cleanup both contain transactions, so
  // provisioning must keep every statement on this one PostgreSQL session.
  const narrowRoleClient = new Client(db);
  await narrowRoleClient.connect();
  try {
    await provisionMacLocalNarrowRolesV1(narrowRoleClient, Object.fromEntries(
      Object.keys(macRolePlan).map((name, index) => [name, `${index}`.repeat(40)])));
  } finally {
    await narrowRoleClient.end();
  }
  const macBackup = join(run, "mac-local-backup-set");
  const manifest = await createMacLocalDatabaseBackupV1({ source: db, out: macBackup, pgBin: BIN,
    now: () => "2026-09-27T00:00:00.000Z" });
  assert.match(manifest.dumpDigest, /^sha256:[a-f0-9]{64}$/u);
  const verified = await verifyMacLocalDatabaseBackupV1({ backup: macBackup, ...backupVerify(), pgBin: BIN });
  assert.equal(verified.verified, true);
  assert.equal(verified.identityDigest, manifest.restoreIdentityDigest);
  // The same backup, verified again against a teardown whose `pg_ctl` stops all
  // refuse — a real `fast` shutdown that misses its 60 s window after this
  // script's write-heavy restore, with `immediate`/`SIGQUIT` ending it. The
  // verification is identical, the postmaster is gone, nothing leaked, and the
  // verdict must be the SAME `verified: true`.
  //
  // It used to be a `disposable_postgres_stop_degraded` throw out of the
  // `finally`, which the CLI turns into `database backup verification FAIL` and
  // `process.exitCode = 1` — a `FAIL` for a backup whose digests, ledger,
  // ownership and grants had all matched, and the response
  // docs/BACKUP_AND_RESTORE.md:41-44 prescribes for a mismatch. The degraded
  // port is one of this lane's own six verification slots; the degraded reason is
  // still logged, and the companion assertion is that a FORCED teardown is still
  // a failure.
  const degraded = [];
  const verifiedThroughSlowShutdown = await verifyMacLocalDatabaseBackupV1({ backup: macBackup,
    ...backupVerify(), pgBin: BIN, teardown: { degradedLogger: line => { degraded.push(line); },
      pgCtl: args => {
        if (args.includes("stop")) throw new Error("pg_ctl: server does not take a fast shutdown request");
        execFileSync(join(BIN, "pg_ctl"), args, { encoding: "utf8", timeout: 90_000 });
      } } });
  assert.equal(verifiedThroughSlowShutdown.verified, true,
    "a slow shutdown must not turn a verified backup into a failure");
  assert.equal(verifiedThroughSlowShutdown.identityDigest, manifest.restoreIdentityDigest,
    "the verdict is the backup's, and it is unchanged by how the cluster stopped");
  assert.ok(degraded.some(line => /disposable_postgres_stop_degraded/u.test(line)),
    `the degraded teardown must still be reported: ${degraded.join(" | ")}`);

  // The seam cannot be pointed at another cluster, and this is where that is
  // observable rather than asserted. The first call above hijacks
  // `dataDirectory`/`runDirectory`/`socketDirectory`/`port`/`pgBin`/
  // `removeDirectories` at the same time as supplying the refusing `pg_ctl` —
  // the exact combination a spread would have honoured, which would leave the
  // verifier's OWN postmaster running while `stop()` reported a clean teardown of
  // an empty directory. The allowlist means those keys never arrive, so the stop
  // below runs against the directory the verifier created and this `pgCtl` — the
  // one standing in for the real binary — sees the real `-D`.
  const hijack = { dataDirectory: join(run, "not-the-cluster"),
    runDirectory: join(run, "not-the-cluster"), socketDirectory: join(run, "not-the-cluster"),
    port: 1, pgBin: "/also/unused/bin", removeDirectories: false };
  const realDirectories = [], livePids = [];
  const notHijacked = await verifyMacLocalDatabaseBackupV1({ backup: macBackup,
    ...backupVerify(), pgBin: BIN, teardown: { ...hijack,
      degradedLogger: line => { degraded.push(line); },
      pgCtl: args => {
        const directory = args[args.indexOf("-D") + 1] ?? "";
        realDirectories.push(directory);
        // The pid is read HERE, at the first `pg_ctl` of the teardown, because
        // that is the last moment `postmaster.pid` exists: PostgreSQL removes it
        // on shutdown and the directory is then deleted. Reading it after
        // `stop()` returns would find nothing and prove nothing.
        if (livePids.length === 0) {
          try { livePids.push(Number(readFileSync(join(directory, "postmaster.pid"), "utf8").split("\n")[0])); }
          catch { /* recorded as missing below */ }
        }
        execFileSync(join(BIN, "pg_ctl"), args, { encoding: "utf8", timeout: 90_000 });
      } } });
  assert.equal(notHijacked.verified, true);
  assert.ok(realDirectories.length > 0 && realDirectories.every(directory => directory !== hijack.dataDirectory),
    `the stop must target the verifier's own cluster, not a caller-supplied path: ${realDirectories.join(", ")}`);
  // And the real cluster the verifier started for that call is gone, not orphaned.
  // Attributed by the postmaster pid recorded in the REAL `-D` at teardown time,
  // not by a directory listing: four test slots share this login, so another
  // job's cluster in the temp dir is not this test's leak, and counting them
  // would report someone else's.
  assert.deepEqual(livePids, [livePids[0]].filter(value => Number.isInteger(value) && value > 0),
    "the real cluster must have published a postmaster pid in the teardown's own data directory");
  for (const pid of livePids) assert.equal(pidAlive(pid), false,
    `a hijacked teardown left the verifier's own postmaster ${pid} running`);

  // The same thing through the ACTUAL command an operator types, as a real
  // subprocess, so the printed verdict and the exit code are observed rather
  // than inferred. The `pg_ctl` in `shimBin` refuses every `stop` and forwards
  // everything else to the real binary, so the verifier really does initdb,
  // restore and verify a backup, and really does reach the ladder, which then
  // ends the real postmaster on `immediate`/`SIGQUIT`. Nothing in the repository
  // is configured to do this: a `pg_bin` whose `pg_ctl` does not take a shutdown
  // request is a real condition (a wrapper, a wrapper script, a hardlinked
  // binary from another install), and it is the only way to reach the branch
  // from the CLI, which has no injection seam.
  const shimBin = join(run, "shim-bin");
  await mkdir(shimBin, { recursive: true });
  for (const name of ["initdb", "pg_restore", "pg_dump", "psql", "postgres", "pg_ctl"]) {
    await writeFile(join(shimBin, name), `#!/bin/sh\nexec ${JSON.stringify(join(BIN, name))} "$@"\n`, { mode: 0o755 });
  }
  await writeFile(join(shimBin, "pg_ctl"),
    `#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = "stop" ]; then\n    echo "pg_ctl: server does not take a fast shutdown request" >&2\n    exit 1\n  fi\ndone\nexec ${JSON.stringify(join(BIN, "pg_ctl"))} "$@"\n`, { mode: 0o755 });
  // `promisify(execFile)` REJECTS on a non-zero exit, so a plain `await` would
  // report "undefined !== 0" and hide the output that says why. The result is
  // captured either way, so a failure prints what the CLI actually said.
  const cli = await exec(process.execPath, [join(ROOT, "scripts/ops/verify-database-backup.mjs"),
    "--backup", macBackup, ...backupVerifyFlags(), "--pg-bin", shimBin],
    { encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 24 })
    .then(value => ({ stdout: value.stdout, stderr: value.stderr, code: 0 }),
      error => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? null }));
  assert.equal(cli.code, 0,
    `a verified backup must exit 0 even when its cluster needed several shutdown steps:\n${cli.stderr}`);
  assert.match(cli.stdout, /^database backup verification PASS: sha256:[a-f0-9]{64}$/mu,
    `a verified backup must print PASS: ${cli.stdout} ${cli.stderr}`);
  assert.match(cli.stderr, /disposable_postgres_stop_degraded/u,
    `the degraded teardown must still be visible to the operator: ${cli.stderr}`);

  // And the CLI still fails, loudly, on a real mismatch — the `FAIL` that
  // docs/BACKUP_AND_RESTORE.md:41-44 describes. Without this, "a degraded
  // teardown no longer fails the run" would be indistinguishable from "the run
  // can no longer fail".
  await exec(process.execPath, [join(ROOT, "scripts/ops/verify-database-backup.mjs"),
    "--backup", join(macBackup, "..", "does-not-exist"), ...backupVerifyFlags(), "--pg-bin", BIN],
    { encoding: "utf8", timeout: 60_000 }).then(
    () => assert.fail("the CLI must exit non-zero when the backup does not verify"),
    error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^database backup verification FAIL: /mu);
    });

  const dumpPath = join(macBackup, "database.dump"), altered = await readFile(dumpPath);
  altered[0] ^= 0xff;
  await writeFile(dumpPath, altered);
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: macBackup, ...backupVerify(), pgBin: BIN }),
    /database_backup_digest_refused/u);
});
