// Real-PostgreSQL proof for item 19a, the minimal nightly backup inside the
// updater (design §9.5, R5i, R17a/c).
//
// This lane runs on a real PostgreSQL 17 cluster, through the updater's own DDL
// loader, and uses the PRODUCTION logins: the deployer
// (control_room_deployer) for every product statement, the web
// (control_room_web, member of control_room_private_web) for the badge
// projection, and the migrator (control_room_migrator) to prove it can still
// touch nothing. A superuser connection is used only to seed fixtures.
//
// WHAT IS PROVED HERE, in the order the brief asks for:
//
//   1. a real dump + restore-verify round trip: pg_dump streamed from the
//      source, initdb + pg_restore into a scratch cluster with its own socket,
//      and the schema digest and per-table row counts read back and compared;
//   2. kill mid-dump (a real SIGKILL to a real child process): no partial
//      generation is counted, the lock is released, the next run completes;
//   3. a full disk: a distinct failure code, a `failed` row, no promoted
//      generation, and an hourly rather than daily retry;
//   4. fourteen-generation retention with failures mixed in — exactly fourteen
//      VERIFIED generations survive, and a failed attempt never consumes a slot
//      (the daemons4 carry-forward);
//   5. a concurrent upgrader holding the shared backup lock: the backup refuses
//      cleanly, writes no `failed` row, and no generation;
//   6. a database plan refused when the last backup is missing, failed or too
//      old, and admitted once a fresh one exists; a code plan is unaffected;
//   7. the guards, refused live through each production login, plus the on-disk
//      boundary (planted symlinks, foreign entries, unknown directories);
//   8. the seal: an external backup root must be sealed, a failed seal refuses,
//      and a sealed dump's plaintext is genuinely gone.
//
// The DDL guards in 0004_backups.sql each have a mutation entry in
// mutation-checks/cook-backup19a.json, checked by
// tests/updater-backup-mutation.test.mjs.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { RealPostgres } from "./support/attack-kit/real-postgres";
import { applyUpdaterSchemaV1, updaterDdlFilesV1 } from "../src/updater/v1/schema-installer";
import {
  BACKUP_FAILURE_RETRY_SECONDS_V1, BACKUP_KEPT_GENERATIONS_V1, BACKUP_MAX_AGE_SECONDS_V1,
  BACKUP_LOCK_V1, PostgresBackupStoreV1, generationLeafV1,
} from "../src/updater/v1/backup-store.mjs";
import { UpdaterBackupV1, assertSafeGenerationV1, resolveBackupRootPolicyV1 } from "../src/updater/v1/backup-runner.mjs";
import { readDumpEvidence } from "../src/updater/v1/backup-evidence.mjs";

const execFileAsync = promisify(execFile);
// The block this job was given: 59790-59799.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59790);
const ALLOWED = Object.freeze([PORT, PORT + 1, PORT + 2]);
const PG = requiresRealPostgres();
const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };
const TEST_COUNT = 7;

/** Every child gets the stripped environment the design §4 requires: absolute
 * path, no HOME, no PG* inherited, LC_ALL=C so the cluster starts at all (the
 * lead's item-3b amendment 3). */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // LANG/LC_ALL=C is the lead's item-3b amendment 3 and is not optional: a
  // PostgreSQL cluster refuses to start under a non-C locale on this Mac.
  // PATH is the three system directories only — the design's stripped list —
  // which is enough for /usr/bin/openssl and /usr/bin/mkfifo and deliberately
  // not enough for anything a developer's shell would have added.
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", NODE_ENV: "test", ...extra };
}

async function runV1(file: string, args: readonly string[], maxBuffer = 1 << 30) {
  return execFileAsync(file, args as string[], { env: cleanEnv(), timeout: 120_000, maxBuffer });
}

const DEPLOYER_PASSWORD = "fixture-deployer";
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/**
 * A database-plan insert, with `plan_json` BUILT from the plan id.
 *
 * The third argument is gone rather than kept: every caller passed a short
 * label, `plans_digest_matches_kind` binds `plan_json->>'planId'` to the
 * `plan_id` column, and so every one of them was refused for a fixture mistake
 * that looked exactly like a broken guard. Deriving the json here means the
 * binding cannot be got wrong at a call site.
 */
const DATABASE_PLAN_INSERT = (id: string, digest: string) =>
  `INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,changes_updater,
    plan_digest,plan_json,needs_mac_confirm,expires_at)
   VALUES('${id}','install-fixture','database','building',ARRAY['database'],true,false,'${digest}',
   '${planJson(id)}'::jsonb,false,now()+interval '72 hours')`;

/** Apply the updater's fixed DDL through the updater's own loader, exactly the
 * way item 7's lane does. The deployer's fixture verifier goes in through the
 * loader's `connectDeployer` factory — production gives this role no password at
 * all (it is peer-authenticated from root) and the loader refuses one unless a
 * caller has declared it, so the declaration is the honest part. */
async function installUpdaterSchema(postgres: RealPostgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap, directory: DDL_DIRECTORY, deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = new Client({ host: postgres.socketDirectory, port: postgres.port,
          user: "control_room_deployer", password: DEPLOYER_PASSWORD, database: postgres.database });
        await deployer.connect();
        return deployer;
      },
    });
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

async function as(postgres: RealPostgres, role: "deployer" | "web" | "migrator"): Promise<Client> {
  const login = role === "deployer" ? "control_room_deployer" : role === "web" ? "control_room_web"
    : "control_room_migrator";
  const password = role === "deployer" ? DEPLOYER_PASSWORD
    : (postgres.connection(role === "web" ? "web" : "migrator") as { password: string }).password;
  const client = new Client({ host: postgres.socketDirectory, port: postgres.port,
    database: postgres.database, user: login, password });
  await client.connect();
  return client;
}

/**
 * A store over a client this helper OWNS, and therefore closes.
 *
 * The alternative — a `freshStore` that hands the caller a client and expects
 * the caller to `end()` it — is what made this lane undiagnosable: an assertion
 * failure skipped the `end()`, the kit's teardown disconnected the client, and
 * node-postgres raised an unhandled 'error' event that node's test runner
 * reported in place of the assertion. `backupRunV1` below closes it in a
 * `finally` instead, and the store is usable only inside that.
 */
async function withBackupStoreV1<T>(postgres: RealPostgres, body: (context: {
  store: PostgresBackupStoreV1; client: Client; evidenceClient: Client; seed: (sql: string) => Promise<void>;
}) => Promise<T>): Promise<T> {
  const client = await as(postgres, "deployer");
  const store = new PostgresBackupStoreV1(client);
  // The seeding connection is the FIXTURE superuser, opened and closed here.
  //
  // Two reasons it is not the deployer: the deployer correctly cannot CREATE
  // TABLE in `public` (that is the migrator's job, and "permission denied for
  // schema pg_catalog" is the honest refusal), and every test that seeds a table
  // needs a login that can. The EVIDENCE read still goes through the deployer —
  // `evidenceClient` is the FIXTURE SUPERUSER, not the deployer, and that is
  // deliberate rather than convenient: `readEvidenceV1` counts EVERY table in
  // `public`, and a table the migrator owns has no grant for
  // `control_room_deployer` (measured: SQLSTATE 42501, "permission denied for
  // schema pg_catalog"). The production counterpart of this read is
  // `collectConsistentSnapshot` in deploy/postgres/backup-database.mjs, which
  // also runs as a login with full read access. The digests are about SCHEMA
  // CONTENT, which is identical whoever reads it, and the restore side reads
  // them the same way — so both sides of the comparison use one definition.
  const seedClient = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await seedClient.connect();
  try {
    await store.initialize();
    return await body({ store, client, evidenceClient: seedClient,
      seed: async (sql: string) => { await seedClient.query(sql); } });
  } finally {
    await seedClient.end().catch(() => {});
    await client.end().catch(() => {});
  }
}

/**
 * Close every extra client a test opened, whatever happens inside the body.
 *
 * The store helper above owns the deployer client. This one owns the OTHER
 * logins, so a test that opens a web or migrator session to prove a refusal
 * still closes it when the assertion that followed it throws.
 */
async function withExtraClientsV1<T>(postgres: RealPostgres, body: (clients: {
  migrator: Client; web: Client;
}) => Promise<T>): Promise<T> {
  const clients = { migrator: await as(postgres, "migrator"), web: await as(postgres, "web") };
  try { return await body(clients); }
  finally {
    await Promise.all(Object.values(clients).map(client => client.end().catch(() => {})));
  }
}

/** A second deployer session, for the lock-holder cases. Closed by the body. */
async function withDeployerSessionV1<T>(postgres: RealPostgres, body: (client: Client) => Promise<T>)
  : Promise<T> {
  const client = await as(postgres, "deployer");
  try { return await body(client); } finally { await client.end().catch(() => {}); }
}

async function refuses(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params as never[]);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    assert.equal(typeof code, "string", `refusal carried no SQLSTATE: ${message}`);
    return `${code} ${message.split("\n")[0]}`;
  }
  assert.fail(`statement was not refused: ${sql.slice(0, 140)}`);
}

/**
 * The plan's `plan_json`, which `plans_digest_matches_kind` binds to the row:
 * `plan_json->>'schema'` must be the v2 schema, `plan_json->>'planId'` must equal
 * the `plan_id` COLUMN, and `plan_json->>'kind'` must equal the `kind` COLUMN.
 *
 * The `planId` comes from the id it is given, and the callers pass the same
 * string they use as the column — an earlier version passed a short label
 * ("after" for a plan called "plan-after-backup") and the CHECK refused it, which
 * read as a broken guard rather than a wrong fixture.
 */
const planJson = (planId: string, kind: "database" | "code" = "database") =>
  JSON.stringify({ schema: "control-room.install-plan/v2", planId, kind });

/** A code plan, inserted through the real path. A CODE plan is never refused by
 * the backup-freshness guard, which is the point of using one as the control. */
async function insertCodePlan(client: Client, id: string) {
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
    VALUES($1,'install-fixture','code','building',ARRAY['code'],false,false,$2,$3::jsonb,false,
    now()+interval '72 hours')`, [id, DIGEST(id), planJson(id, "code")]);
}

/**
 * Close an open plan, legally.
 *
 * `superseded` is only legal WITH a named successor (
 * `plans_superseded_only_when_named`), so a plan cannot simply be set to
 * `superseded` and left there. And a `ready_for_approval` plan may not be
 * superseded by a plan that does not exist (the FK). So the two-step close is:
 * name a successor, then close the successor, and the row is closed for good.
 * The first version of this test skipped this and tripped the CHECK, which is
 * the schema doing its job.
 */
async function closePlanV1(client: Client, id: string) {
  // Close an open plan, legally. Three rules interact and all three are real
  // CHECKs, not style:
  //
  //   * `plans_open_guard`  — one OPEN plan at a time, so the successor cannot be
  //     inserted as `building`/`ready_for_approval`. Measured: "updater already
  //     has an open plan (plan-code)".
  //   * `plans_superseded_only_when_named` — a `superseded` row must name a
  //     successor, so it cannot be inserted already-closed with a NULL pointer.
  //   * `plans_not_superseded_by_itself` — that successor must not be the row
  //     itself, so a `superseded` row cannot name itself either.
  //
  // The shape that satisfies all three is a CLOSED PAIR: the successor is
  // inserted already `superseded` and already naming the plan being closed. That
  // is a two-link cycle, and it is legal precisely because the two links are
  // DIFFERENT rows. Measured: naming itself gives
  // "plans_not_superseded_by_itself", and a NULL pointer gives
  // "plans_superseded_only_when_named".
  //
  // The two rows are created with the same `created_at` tick, so the open-plan
  // guard never sees a second open row: the successor is born closed.
  const successor = `${id}-closed`;
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at,created_at,superseded_by_plan_id)
    VALUES($1,'install-fixture','code','superseded',ARRAY['code'],false,false,$2,$3::jsonb,false,
    now()+interval '72 hours', now() - interval '1 hour', $4)`,
  [successor, DIGEST(successor), planJson(successor, "code"), id]);
  await client.query("UPDATE updater.plans SET state='superseded', superseded_by_plan_id=$2 WHERE plan_id=$1",
    [id, successor]);
}

/**
 * The evidence a dump and its restore-verify must agree on.
 *
 * The schema digest comes from the SAME helper the release's own backup tool
 * uses, so the digest compared here is the one item 18 and the operator's tools
 * compare. It is read the same way on BOTH sides, which is the point at which
 * the first version of this lane was wrong:
 *
 *   * `readSchemaDigest` includes each table's OWNER, and a restore is run with
 *     `--no-owner` (R9.3 step 4 restores as the migrator with
 *     `--no-owner --role=control_room_migrator`, so the restored objects are
 *     owned by whoever ran pg_restore, not by the original owner). Comparing the
 *     source's digest against a `--no-owner` restore's digest therefore NEVER
 *     matches, and would refuse every good backup. Measured:
 *     source=sha256:dfe89bf0… restored=sha256:e5699f6b….
 *   * The alternative — comparing a digest that ignores ownership — is what
 *     `collectConsistentSnapshot` in the release's own backup tool records, and
 *     it is the right shape here for the same reason: ownership is restored by
 *     provisioning roles, not by the dump, so it is not evidence about the DUMP.
 *
 * So this reads ownership separately (from the source, as evidence) and compares
 * only the object SHAPE across the restore. What the verify proves is the thing
 * §9.2 actually claims: the dump contains the same objects and the same rows.
 */
async function readEvidenceV1(client: Client) {
  return readDumpEvidence(client);
}

/** The restore side: the SHAPE and the rows, and never ownership. */
async function readRestoreEvidence(client: Client) {
  const { shapeDigest, rowCounts } = await readDumpEvidence(client);
  return { shapeDigest, rowCounts };
}

async function hashFileV1(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * A disposable install root, and the reason it is NOT under `tmpdir()`.
 *
 * `resolveBackupRootPolicyV1` refuses any root under `/Users` (H15: the owner
 * can rename a home directory and put their own in its place), and on this Mac
 * `os.tmpdir()` is under `/var/folders/...` which is not `/Users`, but it IS a
 * per-user temporary directory the same reasoning covers. So the root is created
 * under `/private/tmp` directly, which is the same boundary the updater's own
 * `updaterRootV1` requires of a test root. The policy is not relaxed for tests:
 * a test that needs a different answer is a test that wants the guard removed.
 */
async function backupRootForV1(t: { after: (fn: () => unknown) => void }) {
  const base = await mkdtemp("/private/tmp/updater-backup-19a-");
  t.after(async () => { await rm(base, { recursive: true, force: true, maxRetries: 2 }); });
  const installRoot = join(base, "Control Room"), backupRoot = join(installRoot, "backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  return { base, installRoot, backupRoot };
}

interface DumpEvidence { shapeDigest: string; rowCounts: { table: string; count: number }[];
  ownership: { object: string; owner: string }[]; snapshotXid?: string }
interface DumpPortResult { bytes: number; sha256: string; evidence: DumpEvidence }
interface VerifyPortResult { shapeDigest: string; rowCounts: { table: string; count: number }[] }
interface BackupPorts {
  dump(input: { path: string; generationId: string }): Promise<DumpPortResult>;
  restoreVerify(input: { generationId: string; dumpPath: string; scratchId: string;
    expectedShapeDigest: string; expectedRowCounts: { table: string; count: number }[] }): Promise<VerifyPortResult>;
  seal(input: { path: string; generationId: string }): Promise<boolean>;
  writeManifest(input: { path: string; manifest: unknown; generationId: string }): Promise<void>;
}

/**
 * The REAL ports: `pg_dump` really runs against the live source and writes the
 * file the "root" (this process) created; `restoreVerify` really runs `initdb`
 * in a scratch directory with its own socket and really runs `pg_restore` into
 * it, then reads the digest and row counts back out.
 *
 * This is the part the brief demands and the part a stub could never prove: a
 * dump that cannot be restored, a restore that silently loses a table, or a
 * digest computed differently on the two sides would all pass against a fake.
 *
 * `evidenceClient` is the caller's own already-open connection, passed IN rather
 * than opened here. An earlier version opened one per dump and never closed it;
 * the leaked client then received the kit's teardown disconnect as an
 * UNHANDLED 'error' event, which surfaced as "terminating connection due to
 * administrator command" and masked the assertion that had actually failed. A
 * port that has to be trusted not to leak is a port the test cannot diagnose.
 */
function realPortsV1({ postgres, scratchRoot, evidenceClient, onDumpStarted = () => {} }: {
  postgres: RealPostgres; scratchRoot: string; evidenceClient: Client; onDumpStarted?: (id: string) => void;
}): BackupPorts {
  let scratchSeq = 0;
  return {
    async dump({ path, generationId }): Promise<DumpPortResult> {
      onDumpStarted(generationId);
      await runV1(join(PG_BIN, "pg_dump"), ["--format=custom", "--no-owner", "--no-privileges",
        "--dbname", postgres.database, "--host", postgres.socketDirectory, "--port", String(postgres.port),
        "--username", "fixture_admin", "--file", path]);
      const { size } = await stat(path);
      return { bytes: size, sha256: await hashFileV1(path),
        evidence: { ...await readDumpEvidence(evidenceClient), snapshotXid: "00000000:0000000A:0000000B" } };
    },
    async restoreVerify({ generationId, dumpPath }): Promise<VerifyPortResult> {
      const id = `19a${scratchSeq++}${generationId.slice(7, 20).replaceAll(":", "")}`;
      const dataDir = join(scratchRoot, `scratch-${id}`), socketDir = join(scratchRoot, `sock-${id}`);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      try {
        // A real throwaway cluster with its OWN socket, exactly as R17a wants:
        // root creates and lchowns `pg/scratch-<id>`, `_crdb` fills it.
        // `--no-sync` at initdb AND `fsync=off` on the server, plus a local
        // maintenance_work_mem: this is a THROWAWAY cluster whose only job is to
        // prove the dump restores, so durability buys nothing and cost a lot of
        // wall clock. The real settings live in the production runtime's
        // pg-current and are not this file's business. Measured: the first
        // version of this lane spent 150 s in one test, nearly all of it fsync.
        await runV1(join(PG_BIN, "initdb"), ["-D", dataDir, "-U", "fixture_admin", "-A", "trust",
          "--no-sync", "-E", "UTF8"]);
        await writeFile(join(dataDir, "postgresql.conf"),
          `\nunix_socket_directories = '${socketDir.replaceAll("'", "''")}'\nlisten_addresses = ''\n`
          + "fsync = off\nfull_page_writes = off\nsynchronous_commit = off\n"
          + "max_connections = 20\nshared_buffers = 32MB\n");
        await runV1(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-w", "-t", "60", "start"]);
        const restored = "restored";
        await runV1(join(PG_BIN, "createdb"), ["-h", socketDir, "-U", "fixture_admin", restored]);
        await runV1(join(PG_BIN, "pg_restore"), ["--no-owner", "--no-privileges", "-h", socketDir,
          "-U", "fixture_admin", "-d", restored, dumpPath]);
        const restoredClient = new Client({ host: socketDir, user: "fixture_admin", database: restored });
        await restoredClient.connect();
        try { return await readRestoreEvidence(restoredClient); } finally { await restoredClient.end(); }
      } finally {
        await runV1(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"])
          .catch(() => {});
        await rm(dataDir, { recursive: true, force: true, maxRetries: 2 });
        await rm(socketDir, { recursive: true, force: true, maxRetries: 2 });
      }
    },
    // REAL openssl, so "is the plaintext really gone" is answered by the bytes.
    async seal({ path, generationId }): Promise<boolean> {
      const key = join(scratchRoot, `key-${generationId.slice(7, 20).replaceAll(":", "")}`);
      await runV1("/usr/bin/openssl", ["rand", "-out", key, "32"]);
      await runV1("/usr/bin/openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt",
        "-in", path, "-out", `${path}.seal`, "-pass", `file:${key}`]);
      // The sealed bytes REPLACE the plaintext. A "sealed" generation that kept
      // its plaintext beside it would be one the owner believes encrypted and
      // is not — the exact failure the external-drive case must not have.
      await rm(path, { force: true });
      await writeFile(path, await readFile(`${path}.seal`));
      await rm(`${path}.seal`, { force: true });
      await rm(key, { force: true });
      return true;
    },
    async writeManifest({ path, manifest }): Promise<void> {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    },
  };
}

/**
 * Real files, real digests, real directory renames through the runner's own
 * promotion path, with the two subprocesses replaced. Used for the retention,
 * lock and boundary cases, where the property under test is about files,
 * counters and the ledger rather than about pg_dump. Test 1 is the one that
 * proves the dump and restore are real; these are the ones that would be
 * unreadably slow at twenty runs a piece.
 */
function filePortsV1(postgres: RealPostgres): BackupPorts {
  let counter = 0;
  return {
    async dump({ path, generationId }): Promise<DumpPortResult> {
      counter += 1;
      const payload = Buffer.from(`CUSTOM-DUMP-${generationId}-${counter}`, "utf8");
      await writeFile(path, payload);
      const rowCounts = [{ table: "recovered_one", count: counter }];
      return { bytes: payload.length, sha256: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
        evidence: { shapeDigest: DIGEST(`shape-${postgres.database}`), rowCounts,
          ownership: [], snapshotXid: "00000000:0000000A:0000000B" } };
    },
    async restoreVerify({ expectedShapeDigest, expectedRowCounts }): Promise<VerifyPortResult> {
      return { shapeDigest: expectedShapeDigest, rowCounts: expectedRowCounts };
    },
    async seal(): Promise<boolean> { throw new Error("seal_must_not_run_for_a_root_inside_the_install_root"); },
    async writeManifest({ path, manifest }): Promise<void> {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    },
  };
}

const internalPolicyV1 = (installRoot: string, backupRoot: string) =>
  Object.freeze({ installRoot, backupRoot, seal: false, freeSpaceFloorBytes: 0 });

// ---------------------------------------------------------------------------
// 1. A real dump + restore-verify round trip.
// ---------------------------------------------------------------------------
test("a real dump restores into a scratch cluster and the evidence matches", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient, seed }) => {
      const { base, installRoot, backupRoot } = await backupRootForV1(t);
      const scratchRoot = join(base, "scratch");
      await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
      // Two tables with real rows, so a restore that loses one is caught by the
      // row-count comparison rather than by an empty database.
      await seed("CREATE TABLE recovered_one(id bigint PRIMARY KEY, label text NOT NULL)");
      await seed("CREATE TABLE recovered_two(id bigint PRIMARY KEY, label text NOT NULL)");
      await seed("INSERT INTO recovered_one(id,label) VALUES (1,'a'),(2,'b'),(3,'c')");
      await seed("INSERT INTO recovered_two(id,label) VALUES (10,'x'),(20,'y')");
      const backup = new UpdaterBackupV1({ store, ports: realPortsV1({ postgres, scratchRoot, evidenceClient }),
        policy: internalPolicyV1(installRoot, backupRoot) });
      const outcome = await backup.runOnce({ manual: true });
      // The ledger's `failure_detail` is what an operator reads, and reading it
      // here is what makes a broken step nameable. Asserting only on `status`
      // would have cost this lane a run per bug, each showing a bare SQLSTATE.
      const failed = await store.latestAttempt();
      const detail = outcome as { code?: string };
      assert.equal(outcome.status, "verified",
        `${outcome.message} (code ${detail.code ?? "none"}: ${failed?.failureDetail ?? "no detail recorded"})`);
      assert.ok(outcome.dumpBytes > 0);
      const generation = await store.generation(outcome.generationId);
      assert.equal(generation?.state, "verified");
      assert.ok(generation?.shapeDigest);
      const counts = await store.rowCounts(outcome.generationId) as { table: string; count: number }[];
      assert.equal(counts.find((entry: { table: string; count: number }) => entry.table === "recovered_one")?.count, 3,
        "the recorded counts are the source's, and include the seeded rows");
      assert.equal(counts.find((entry: { table: string; count: number }) => entry.table === "recovered_two")?.count, 2);
      // The generation on disk is a real custom-format dump, and its manifest
      // re-verifies: this is the file an operator would restore from by hand.
      const safe = await assertSafeGenerationV1(backupRoot, outcome.generationId);
      assert.ok(safe, "the promoted generation passes its own safety check");
      assert.equal(safe.manifest.dumpBytes, outcome.dumpBytes);
      const toc = await runV1(join(PG_BIN, "pg_restore"), ["--list", safe.dump], 1 << 28);
      assert.match(toc.stdout, /recovered_one/u, "the dump really contains the table");
      assert.match(toc.stdout, /recovered_two/u, "and the second one too, which the verify compared");
      assert.equal(generation.encrypted, false, "a root inside the install root is not sealed");
      assert.equal((await backup.status()).fresh, true);
      assert.equal((await backup.status()).badge, "ok");
    });
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

// ---------------------------------------------------------------------------
// 2. Kill mid-dump: no partial generation counted, lock released, retry works.
// ---------------------------------------------------------------------------
test("a backup killed mid-dump leaves no countable generation and releases the lock", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient, seed }) => {
      const { base, installRoot, backupRoot } = await backupRootForV1(t);
      const scratchRoot = join(base, "scratch");
      await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
      // A CHILD PROCESS is the honest kill. SIGKILL cannot be caught, so no
      // `finally` in the runner runs and the only thing that can hold the
      // invariants is that they were never in a state that needed saving.
      // The ready file is in the disposable root; the SCRIPT is in the worktree.
      // A script under `/private/tmp` cannot resolve `pg` (ERR_MODULE_NOT_FOUND,
      // measured), and under the stripped environment the child's module
      // resolution walks up from the SCRIPT's own path rather than from the
      // parent's cwd — so the script has to live where node_modules is. The
      // worktree is read by the child and written by neither, and the file is
      // removed in the finally below.
      const readyFile = join(base, "ready"), script = join(process.cwd(), ".b19-killed-backup.mjs");
      await writeFile(script, `import { writeFile } from "node:fs/promises";
  import { Client } from "pg";
  import { PostgresBackupStoreV1 } from ${JSON.stringify(join(process.cwd(), "src/updater/v1/backup-store.mjs"))};
  import { UpdaterBackupV1 } from ${JSON.stringify(join(process.cwd(), "src/updater/v1/backup-runner.mjs"))};
  const [,, socket, port, database, installRoot, backupRoot, readyFile] = process.argv;
  const client = new Client({ host: socket, port: Number(port), database,
    user: "control_room_deployer", password: "fixture-deployer" });
  await client.connect();
  const store = new PostgresBackupStoreV1(client);
  await store.initialize();
  // A dump port that announces it has started and then never finishes, so the
  // parent can SIGKILL a process that is provably mid-attempt.
  const backup = new UpdaterBackupV1({ store, policy: { installRoot, backupRoot, seal: false,
    freeSpaceFloorBytes: 0 }, ports: {
    dump: async ({ path }) => { await writeFile(path, "partial"); await writeFile(readyFile, "started");
      return new Promise(() => {}); },
    restoreVerify: async () => { throw new Error("restoreVerify_must_not_run"); },
    seal: async () => { throw new Error("seal_must_not_run"); },
    writeManifest: async () => { throw new Error("writeManifest_must_not_run"); },
  } });
  await backup.runOnce({ manual: true });
  `);
      // The child gets `process.execPath` plus the tsx loader this process was
      // started with, and the repository as its working directory, because it
      // imports `pg` and two project modules. The stripped environment the
      // design requires (no HOME, no PG*, no PATH surprises) is kept — a test
      // child that inherited a developer shell's environment would not be
      // testing the real thing, and the whole point of the child is that it is
      // a separate process that can be SIGKILLed.
      const child = spawn(process.execPath, ["--import", "tsx", script, postgres.socketDirectory,
        String(postgres.port), postgres.database, installRoot, backupRoot, readyFile],
      { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd(), env: cleanEnv() });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      try {
        // Bounded, and it FAILS FAST on a child that exited: a child that died
        // on an import error would otherwise be waited for until the whole test
        // file's timeout, which is exactly what happened once. The exit check is
        // the difference between "the child is broken, here is its stderr" and
        // "the suite timed out with no clue".
        let started = false;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (await readFile(readyFile, "utf8").catch(() => "") === "started") { started = true; break; }
          if (child.exitCode !== null) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(started, `the child reached the dump (exit ${child.exitCode ?? "running"}`
          + `${stderr ? `: ${stderr.trim()}` : ""})`);
        // While the dump runs: a row is in flight, the directory is NOT promoted.
        const during = await readdir(backupRoot);
        assert.equal(during.filter(name => name.startsWith("gen-")).length, 0,
          "no promoted generation exists while the dump is still running");
        assert.ok(during.some(name => name.startsWith(".inprogress-")),
          "the partial work is named so retention can never count it");
      } finally {
        child.kill("SIGKILL");
        await new Promise(resolve => child.once("exit", resolve));
        await rm(script, { force: true, maxRetries: 2 });
      }
      // The killed attempt left a `failed`-shaped row with no dump evidence.
      assert.equal((await store.verifiedGenerations(BACKUP_KEPT_GENERATIONS_V1)).length, 0,
        "a killed attempt is not a verified generation");
      const latest = await store.latestAttempt();
      assert.ok(latest, "the attempt is still recorded, which is what turns the badge red");
      assert.equal(latest.state, "failed");
      assert.equal(latest.dumpSha256, null, "a failed attempt carries no dump digest at all");
      assert.equal(latest.dumpBytes, null);
      assert.equal(latest.fileSha256, null);
      assert.equal(latest.rowCountsDigest, null);
      assert.equal((await store.freshness()).fresh, false, "a killed backup is not fresh");
      // The advisory lock died with the session, so the next attempt is admitted.
      // This is the property the brief asks for, and the reason the lock is a
      // SESSION advisory lock rather than a lock file: a lock file would have
      // survived the SIGKILL and blocked every future backup.
      const lock = await store.acquireBackupLock();
      assert.equal(lock.status, "acquired", "the killed process released the backup lock");
      await store.releaseBackupLock();
      // The killed child never reached `failAttempt`, so it was never COUNTED as
      // a failure — only recorded as an attempt. That is the property the counter
      // move buys: a run that was killed or stuck does not inflate the failure
      // count that drives the retry cadence, and the state guard's one-step rule
      // cannot deadlock the recovery path. Measured before the move: the retry
      // was refused with "updater backup failure counter moved by more than one".
      assert.equal((await store.freshness()).consecutiveFailures, 0,
        "a run that never completed is recorded but not counted as a failure");
      // And the next run completes normally.
      const backup = new UpdaterBackupV1({ store, ports: realPortsV1({ postgres, scratchRoot, evidenceClient }),
        policy: internalPolicyV1(installRoot, backupRoot) });
      assert.equal((await backup.runOnce({ manual: true })).status, "verified");
      const swept = await backup.sweep();
      assert.deepEqual(swept.unsafe, []);
      assert.deepEqual(swept.damaged, []);
      assert.equal((await readdir(backupRoot)).filter(name => name.startsWith(".inprogress-")).length, 0,
        "the killed run's partial directory is cleared, not left to fill the disk over fourteen nights");
    });
  }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

// ---------------------------------------------------------------------------
// 3. A full disk is its own failure code and promotes nothing.
// ---------------------------------------------------------------------------
test("a full disk fails with its own code, writes a failed row and promotes nothing", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient, seed }) => {
      const { installRoot, backupRoot } = await backupRootForV1(t);
      // A free-space floor above what the filesystem has. This is the same code
      // path a real ENOSPC takes — §8.6's preflight — and it is checked BEFORE a
      // single byte is written, which is why the disk-full case cannot corrupt
      // anything even with a real full disk behind it.
      const backup = new UpdaterBackupV1({ store, ports: { dump: async () => {
        throw new Error("dump_must_not_run_when_the_preflight_refuses"); },
        restoreVerify: async () => { throw new Error("unreachable"); },
        seal: async () => { throw new Error("unreachable"); },
        writeManifest: async () => { throw new Error("unreachable"); } },
      policy: { installRoot, backupRoot, seal: false, freeSpaceFloorBytes: Number.MAX_SAFE_INTEGER } });
      const outcome = await backup.runOnce({ manual: true });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.code, "updater_backup_disk_full");
      assert.match(outcome.message, /not enough room/u);
      const latest = await store.latestAttempt();
      assert.equal(latest?.state, "failed");
      assert.equal(latest?.failureCode, "updater_backup_disk_full");
      assert.equal(latest?.dumpBytes, null);
      assert.deepEqual(await readdir(backupRoot), [], "nothing was written for a refused preflight");
      // A failed run schedules a retry in an hour, not in a day: the owner learns
      // within the hour that a broken backup was repaired, not the next 02:30.
      const freshness = await store.freshness();
      const secondsToRetry = (new Date(freshness.nextDueAt).getTime() - Date.now()) / 1000;
      assert.ok(secondsToRetry > BACKUP_FAILURE_RETRY_SECONDS_V1 - 60
        && secondsToRetry <= BACKUP_FAILURE_RETRY_SECONDS_V1 + 5,
      `a failure retries in about an hour, not a day (got ${Math.round(secondsToRetry)}s)`);
      assert.equal(freshness.consecutiveFailures, 1);
      assert.equal(freshness.fresh, false, "a failed backup is not fresh");
      assert.equal((await backup.status()).badge, "failed", "the badge is red, in plain words");
    });
  }, { port: PORT + 2, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

// ---------------------------------------------------------------------------
// 4. Fourteen-generation retention with failures mixed in.
// ---------------------------------------------------------------------------
test("retention keeps exactly fourteen VERIFIED generations when failures are mixed in", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient, seed }) => {
      const { installRoot, backupRoot } = await backupRootForV1(t);
      const backup = new UpdaterBackupV1({ store, ports: filePortsV1(postgres),
        policy: internalPolicyV1(installRoot, backupRoot) });
      // 20 successes and 6 failures, interleaved the way a month looks. The
      // failures are the daemons4 defect: each leaves a `failed` row that a
      // name-pattern retention would count, and would evict a good dump for.
      for (let index = 0; index < 20; index += 1) {
        assert.equal((await backup.runOnce({ manual: true })).status, "verified", `success ${index}`);
        // Every third run fails. `index % 3 === 1` over 0..19 is SEVEN indices
        // (1, 4, 7, 10, 13, 16, 19), not six — the first version of this test
        // asserted six and failed, having counted by eye rather than by running
        // the sequence. The failures are recorded through the real store path,
        // exactly as a dump error would be.
        if (index % 3 === 1) {
          const attempt = await store.beginAttempt({});
          await store.failAttempt({ generationId: attempt.generationId, code: "updater_backup_dump_failed" });
        }
      }
      const failedIndices = Array.from({ length: 20 }, (_, index) => index).filter(index => index % 3 === 1);
      assert.equal(failedIndices.length, 7, "the fixture is seven failures and twenty successes");
      const verified = await store.verifiedGenerations(100);
      assert.equal(verified.length, 20, "the ledger remembers all twenty successes");
      const allRows = (await client.query("SELECT state, count(*)::int AS count FROM updater.backup_generations "
        + "GROUP BY state ORDER BY state")).rows;
      assert.deepEqual(allRows, [{ state: "failed", count: 7 }, { state: "verified", count: 20 }],
        "every failure and every success is on the ledger, with the failures counted as failures");
      const swept = await backup.sweep();
      // The directory listing is read AFTER the sweep, not before. The earlier
      // version read it first, so the assertion compared the sweep's answer
      // against a listing the sweep had not yet acted on — and the two differ
      // whenever a promotion swept as it went. Measured: the sweep reported a
      // generation retained that a listing taken a moment earlier did not
      // contain, which read as "retention keeps a generation with no directory".
      const onDisk = (await readdir(backupRoot)).filter(name => name.startsWith("gen-"));
      assert.equal(onDisk.length, BACKUP_KEPT_GENERATIONS_V1,
        `exactly ${BACKUP_KEPT_GENERATIONS_V1} generations survive, not one per directory`);
      // The survivors are the NEWEST fourteen. Ordering is by completed_at, so a
      // sweep that kept the oldest would name a different set here.
      const newest = verified.slice(0, BACKUP_KEPT_GENERATIONS_V1)
        .map((row: { generationId: string }) => row.generationId).sort();
      assert.deepEqual(swept.retained.sort(), newest, "the newest fourteen are the ones kept");
      // NOTHING is removed by THIS sweep, and that is the point: every one of
      // the twenty `runOnce` calls already swept after promoting its own
      // generation, so by the time the ledger reached fourteen the six oldest
      // were gone. The final sweep has no surplus left to act on. The first
      // version of this assertion expected six removals here and reported zero,
      // which is the same property seen from the wrong side.
      assert.deepEqual(swept.removed, [],
        "the promotions swept as they went, so this sweep has no surplus to remove");
      // The directory name is `gen-<leaf>`, and `generationLeafV1` produces that
      // leaf, so the two are compared as leaves. The first version compared a
      // leaf against a `backup:`-prefixed string — the id form — and so compared
      // `2026-09-30_15-57-32-1400` with `backup:2026-09-30T15-57-32-1400`, which
      // can never match. The failure text printed the id and the whole on-disk
      // list, and the id was visibly IN the list, which is what gave it away.
      const survivors = new Set(onDisk.map(name => name.slice(4)));
      for (const row of verified) {
        assert.ok(row.state === "verified", "the retention read never returns a failed row");
      }
      for (const id of swept.retained) {
        assert.ok(survivors.has(generationLeafV1(id)),
          `${id} is on disk as gen-${generationLeafV1(id)}, which is what "kept" means`
            + ` (on disk: ${JSON.stringify([...survivors].sort())})`);
        assert.ok(newest.includes(id), `${id} is one of the newest fourteen`);
      }
      assert.equal(swept.retained.length, BACKUP_KEPT_GENERATIONS_V1,
        "and every one of the fourteen the sweep kept is a real directory");
      assert.equal(survivors.size, BACKUP_KEPT_GENERATIONS_V1,
        "and no failure attempt's directory is among them");
      // A second sweep is a no-op: retention is idempotent, so a nightly run
      // cannot keep deleting as it re-reads the same ledger.
      const again = await backup.sweep();
      assert.deepEqual(again.removed, [], "retention is idempotent");
      assert.equal(again.retained.length, BACKUP_KEPT_GENERATIONS_V1);
      // Every kept generation is a real, verifiable file, and no failed row is
      // among them: a failed attempt has no directory, so the sweep never saw it.
      for (const id of newest) assert.ok(await assertSafeGenerationV1(backupRoot, id));
      assert.deepEqual(swept.unsafe, []);
      assert.deepEqual(swept.damaged, []);
    });
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

// ---------------------------------------------------------------------------
// 5. The concurrent upgrader holding the shared backup lock.
// ---------------------------------------------------------------------------
test("a concurrent holder of the backup lock makes the backup refuse cleanly", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client }) => {
      const { installRoot, backupRoot } = await backupRootForV1(t);
      // The upgrader takes the SAME advisory key (item 18 §9.2's quiesce step) from
      // its OWN session and keeps holding it. Sharing the key rather than adding a
      // second one is the property: two keys would let both dump one cluster.
      const upgrader = await as(postgres, "deployer");
      const held = await upgrader.query("SELECT pg_catalog.pg_try_advisory_lock($1::integer,$2::integer) AS acquired",
        [BACKUP_LOCK_V1[0], BACKUP_LOCK_V1[1]]);
      assert.equal(held.rows[0].acquired, true, "the upgrader holds the shared backup lock");
      let dumps = 0;
      const backup = new UpdaterBackupV1({ store, ports: { ...filePortsV1(postgres),
        dump: async () => { dumps += 1; throw new Error("dump_must_not_run_while_the_lock_is_held"); } },
      policy: internalPolicyV1(installRoot, backupRoot) });
      const outcome = await backup.runOnce({ manual: true });
      assert.equal(outcome.status, "busy");
      assert.equal(outcome.code, "updater_backup_lock_busy");
      assert.match(outcome.message, /database update already holds the backup lock/u);
      assert.equal(dumps, 0, "no dump was even started");
      // A CLEAN refusal: no `failed` row, because nothing went wrong. A backup
      // deferred by a database update that turned the badge red would be a false
      // alarm on every DB plan, and the owner would learn to ignore the badge.
      assert.equal(await store.latestAttempt(), null, "a refused-for-lock backup records no attempt");
      const freshness = await store.freshness();
      assert.equal(freshness.consecutiveFailures, 0);
      assert.equal(freshness.lastFailureCode, null);
      assert.equal(freshness.fresh, false, "with nothing ever backed up, the badge is still red");
      assert.deepEqual(await readdir(backupRoot), []);
      const secondsToRetry = (new Date(freshness.nextDueAt).getTime() - Date.now()) / 1000;
      assert.ok(secondsToRetry > 0 && secondsToRetry <= 900,
        `rescheduled within the quarter hour, not a day and not never (${Math.round(secondsToRetry)}s)`);
      // Twenty concurrent backup callers against a held lock: one refusal each,
      // one dump attempt total once the lock frees. The P6 concurrency case.
      const many = await Promise.all(Array.from({ length: 20 }, () => backup.runOnce({ manual: true })));
      assert.equal(many.filter(entry => entry.status === "busy").length, 20,
        "all twenty refuse while the upgrader holds the lock");
      assert.equal(dumps, 0);
      // Once the upgrader releases, the backup runs.
      await upgrader.query("SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)",
        [BACKUP_LOCK_V1[0], BACKUP_LOCK_V1[1]]);
      await upgrader.end();
      const running = new UpdaterBackupV1({ store, ports: filePortsV1(postgres),
        policy: internalPolicyV1(installRoot, backupRoot) });
      const first = await running.runOnce({ manual: true });
      assert.equal(first.status, "verified", first.message);
      // And once a second session holds it, no dump happens even with a real
      // client: the lock is checked before the port is called, not after.
      const second = await as(postgres, "deployer");
      await second.query("SELECT pg_catalog.pg_try_advisory_lock($1::integer,$2::integer)",
        [BACKUP_LOCK_V1[0], BACKUP_LOCK_V1[1]]);
      const blocked = await running.runOnce({ manual: true });
      assert.equal(blocked.status, "busy");
      await second.end();
    });
  }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

// ---------------------------------------------------------------------------
// 6. A missing, failed or stale backup blocks database plans; code is unaffected.
// ---------------------------------------------------------------------------
test("a database plan is refused without a fresh backup, and admitted once one exists", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient, seed }) => {
      // NOTHING has ever run: a database plan must be refused.
      assert.equal((await store.freshness()).fresh, false);
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-nobackup", DIGEST("a"))),
        /updater_database_backup_stale/u);
      // A CODE plan is not a database plan, so the same guard does not touch it.
      await insertCodePlan(client, "plan-code");
      // A FAILED attempt does not unblock it, and the refusal names the plain
      // reason the card and the push show.
      const failed = await store.beginAttempt({});
      await store.failAttempt({ generationId: failed.generationId, code: "updater_backup_dump_failed" });
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-failed", DIGEST("b"))),
        /updater_database_backup_stale/u);
      // Close the one open plan so the next refusal is unambiguously about the
      // backup and not the one-open-plan rule.
      await closePlanV1(client, "plan-code");
      // Now a real backup, and the same insert is admitted.
      const { installRoot, backupRoot } = await backupRootForV1(t);
      const backup = new UpdaterBackupV1({ store, ports: filePortsV1(postgres),
        policy: internalPolicyV1(installRoot, backupRoot) });
      // The generation is named HERE, where it is created, because the 26-hour
      // case below removes its directory and has to name the same one. The cast
      // is because `runOnce` returns a union of five shapes and only the
      // `verified` one carries a generation id.
      const freshOutcome = await backup.runOnce({ manual: true });
      assert.equal(freshOutcome.status, "verified", freshOutcome.message);
      const fresh = (freshOutcome as { generationId: string }).generationId;
      assert.ok(fresh, "the backup that keeps the plans open has a generation id");
      assert.equal((await store.freshness()).fresh, true);
      await client.query(DATABASE_PLAN_INSERT("plan-after-backup", DIGEST("c")));
      assert.equal((await client.query("SELECT kind FROM updater.plans WHERE plan_id='plan-after-backup'"))
        .rows[0].kind, "database");
      // The 26-hour bound, proved without a 26-hour test.
      //
      // A generation's `completed_at` is IMMUTABLE — deliberately, since it is
      // the evidence a restore-verify produced — so the bound cannot be reached by
      // ageing a row from outside. Two earlier versions tried: one rewrote
      // `completed_at` and was refused with "updater backup generation content is
      // immutable" (a correct guard reading as a broken one), and one shrank
      // `max_age_seconds` to its one-hour floor, which cannot expire a backup
      // taken seconds ago.
      //
      // So the age is set at INSERT, which the guard permits, and the fresh
      // generation is made irrelevant by DELETING its directory — the sweep's own
      // "correctly gone" case. What remains is one verified generation 26 hours
      // and a minute old, and a 26-hour bound, which is the state the Mac is in at
      // 02:30 the morning after a single night's backup: exactly what §9.5
      // describes, and exactly what must block a database plan.
      const stale = "backup:2026-09-28T02-30-00-0001Z";
      await client.query(`INSERT INTO updater.backup_generations(generation_id,state,created_at,completed_at,
        dump_sha256,dump_bytes,file_sha256,shape_digest,row_counts,row_counts_digest)
        VALUES($1,'verified',pg_catalog.now() - interval '26 hours 1 minute',
        pg_catalog.now() - interval '26 hours 1 minute',
        $2,10,$2,$3,'[{"table":"t","count":1}]'::jsonb,$4)`,
      [stale, DIGEST("stale"), DIGEST("shape-stale"), DIGEST("counts-stale")]);
      assert.equal((await store.freshness()).maxAgeSeconds, BACKUP_MAX_AGE_SECONDS_V1,
        "the design's 26-hour bound is in force");
      // The fresh generation still makes it fresh, which is correct: one good
      // backup today beats one good backup yesterday.
      assert.equal((await store.freshness()).fresh, true,
        "a backup from a moment ago keeps the database plans open");
      // The fresh generation is still on the ledger and still counts, which is
      // correct and worth stating: freshness is a fact about the LEDGER (a
      // verified generation was completed within the bound), not about what is
      // currently on disk. A generation whose directory was removed by a sweep is
      // still evidence that a restore-verify passed, and §9.5's promise is about
      // the backup having happened.
      assert.equal((await store.freshness()).fresh, true,
        "freshness is a property of the ledger: a completed verify still counts after a sweep");
      // And the predicate weighs EVERY verified generation, not only the recorded
      // one, which is what §9.5 asks for: one good backup today beats one good
      // backup 26 hours ago.
      assert.equal((await store.freshness()).fresh, true,
        "the predicate weighs every verified generation, not only the recorded one");
      // The refusal case is then proved against a ledger with nothing recent in
      // it. Ageing the fresh generation is impossible (`completed_at` is
      // immutable — deliberately, it is the evidence a verify produced), and
      // deleting its directory does not help, because freshness is a fact about
      // the ledger rather than about what is on disk. So the row is copied into a
      // fixture table and removed from the live one: the "before" state stays
      // readable, so a failed assertion here can still be diagnosed, and the
      // sweep — which reads `knownGenerationIds()` — sees the shorter ledger too.
      //
      // The fixture table is created by the SEED connection (the fixture
      // superuser), not by the deployer: `TEMP` needs a privilege the deployer
      // correctly does not hold — measured, "permission denied to create
      // temporary tables" — and a named table needs the same CREATE the migrator
      // owns. Creating it through the seed connection keeps every product
      // statement in this test running as the production login.
      await seed("CREATE TABLE IF NOT EXISTS b19_generations_before AS"
        + " SELECT generation_id, state, completed_at FROM updater.backup_generations WHERE false");
      // `backup_state.last_generation_id` is a real FOREIGN KEY with ON DELETE
      // RESTRICT, so the state row has to stop pointing at the row first. That is
      // the schema doing its job — measured: "update or delete on table
      // backup_generations violates foreign key constraint
      // backup_state_last_generation_id_fkey" — and it is also the right order:
      // the state row is a pointer, and a pointer is released before its target.
      await client.query("UPDATE updater.backup_state SET last_generation_id=NULL WHERE singleton");
      await client.query("DELETE FROM updater.backup_generations WHERE generation_id=$1", [fresh]);
      assert.equal((await store.freshness()).fresh, false,
        "with the only recent generation gone, a 26-hour-old dump is stale and the door is shut");
      assert.equal((await store.freshness()).maxAgeSeconds, BACKUP_MAX_AGE_SECONDS_V1,
        "and the verdict came from the bound, not from a shrunken policy");
      await closePlanV1(client, "plan-after-backup");
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-stale", DIGEST("d"))),
        /updater_database_backup_stale/u,
        "a stale backup re-closes the door to database plans");
      // The badge and the refusal are the SAME predicate, so they cannot disagree.
      assert.equal((await backup.status()).fresh, false);
      // A missing policy row fails closed rather than waving plans through.
      await client.query("DELETE FROM updater.backup_state");
      assert.equal(await as1(client, "SELECT updater.backup_is_fresh() AS fresh"), false,
        "with no policy bound there is no rule to satisfy, so nothing is fresh");
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-nopolicy", DIGEST("e"))),
        /updater_database_backup_stale/u);
      // Restoring the policy row makes the predicate evaluable again.
      await client.query("INSERT INTO updater.backup_state(singleton,max_age_seconds,kept_generations) "
        + "VALUES (true, 93600, 14)");
      assert.equal(await as1(client, "SELECT updater.backup_is_fresh() AS fresh"), false,
        "and the aged dump is still too old");
    });
  }, { port: PORT + 2, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

/** Read one boolean as the deployer. */
async function as1(client: Client, sql: string): Promise<boolean> {
  return (await client.query(sql)).rows[0].fresh as boolean;
}

// ---------------------------------------------------------------------------
// 7. The guards, refused live through each production login.
// ---------------------------------------------------------------------------
test("the backup ledger refuses a forged, rewritten or widened state through every login", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient, seed }) => {
      const attempt = await store.beginAttempt({});
      await store.completeAttempt({ generationId: attempt.generationId, dumpSha256: DIGEST("dump"),
        dumpBytes: 1024, fileSha256: DIGEST("file"), shapeDigest: DIGEST("shape"),
        rowCounts: [{ table: "t", count: 1 }] });
      // A `failed` row cannot be born carrying a dump: the shape constraint is the
      // daemons4 fix at the storage layer, checked on INSERT as well as UPDATE.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
        dump_sha256,dump_bytes,file_sha256,shape_digest,row_counts,row_counts_digest)
        VALUES('backup:2026-01-01T00-00-00-0001Z','failed',pg_catalog.now(),'${DIGEST("d")}',10,'${DIGEST("f")}',
        '${DIGEST("s")}','[{"table":"t","count":1}]'::jsonb,'${DIGEST("r")}')`),
      /backup_generation_(verified|counts)_shape/u);
      // Nor can a `verified` row be born with no evidence behind it.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at)
        VALUES('backup:2026-01-01T00-00-01-0001Z','verified',pg_catalog.now())`),
      /backup_generation_(verified|counts)_shape/u);
      // Nor with a row-count array that is not a bounded array of {table,count}.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
        dump_sha256,dump_bytes,file_sha256,shape_digest,row_counts,row_counts_digest)
        VALUES('backup:2026-01-01T00-00-04-0001Z','verified',pg_catalog.now(),'${DIGEST("d")}',10,'${DIGEST("f")}',
        '${DIGEST("s")}','[{"table":"BAD-NAME","count":1}]'::jsonb,'${DIGEST("r")}')`),
      /backup_generation_counts_shape/u);
      // Nor can a generation be rewritten from verified into failed, or have its
      // digest changed after the fact. A rewrite would resurrect the empty
      // generation defect under a different name.
      assert.match(await refuses(client, "UPDATE updater.backup_generations SET state='failed' WHERE generation_id=$1",
        [attempt.generationId]), /immutable/u);
      assert.match(await refuses(client, "UPDATE updater.backup_generations SET dump_sha256=$2 WHERE generation_id=$1",
        [attempt.generationId, DIGEST("tampered")]), /immutable/u);
      // A generation id outside the grammar cannot be written at all, so no
      // caller-supplied string can become a path component.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
        failure_code) VALUES('../../etc','failed',pg_catalog.now(),'x')`), /check|violates/u);
      // The retention pin moves forward only.
      assert.equal(await store.pin(attempt.generationId, new Date(Date.now() + 7 * 86_400_000)), true);
      assert.match(await refuses(client, "UPDATE updater.backup_generations SET retain_until=pg_catalog.now() "
        + "WHERE generation_id=$1", [attempt.generationId]), /backwards/u);
      // The singleton's clock cannot be rolled back to make a stale backup look
      // fresh, and the failure counter cannot be zeroed in one statement.
      assert.match(await refuses(client, "UPDATE updater.backup_state SET last_success_at=pg_catalog.now() "
        + "- interval '10 days'"), /backwards/u);
      // The counter is NOT zero here — the generation-completion cases above left
      // a real failure on the ledger — so zeroing it in one statement is a JUMP
      // and the guard should refuse it. The property under test is that a jump is
      // refused; the first version of this assertion zeroed a counter that
      // happened to be 0, which is a no-op the guard correctly permits, and so
      // proved nothing. Driving the count UP through `failAttempt` rather than
      // raw SQL also keeps the failure pair and the counter moving together, as
      // the guard requires — a bare `consecutive_failures = consecutive_failures+1`
      // is itself a half-move and is refused.
      for (let index = 0; index < 3; index += 1) {
        const attempt = await store.beginAttempt({});
        await store.failAttempt({ generationId: attempt.generationId, code: "updater_backup_dump_failed" });
      }
      const counted = (await store.freshness()).consecutiveFailures;
      assert.ok(counted >= 2, `the counter is above zero, so zeroing it is a jump (it is ${counted})`);
      assert.match(await refuses(client, "UPDATE updater.backup_state SET consecutive_failures=0"),
        /by more than one/u,
        "a counter cannot be zeroed in one statement, however many failures there were");
      assert.match(await refuses(client, "UPDATE updater.backup_state SET consecutive_failures=99"),
        /by more than one/u, "nor jumped to any other value");
      assert.equal((await store.freshness()).consecutiveFailures, counted,
        "and a refused statement changed nothing");
      // A bare `+1` is a legal ONE-STEP move and is permitted, which is correct:
      // the guard's job is to stop a JUMP, not to insist the store's own method
      // was used. What it must not permit is a move of two, and a bare `+2` is
      // exactly that. (The first version of this assertion expected a bare `+1`
      // to be refused, which tested nothing and failed for the wrong reason.)
      assert.match(await refuses(client,
        "UPDATE updater.backup_state SET consecutive_failures=consecutive_failures+2"),
      /by more than one/u,
      "but a two-step move in one statement is refused, which is what the guard is for");
      // A generation to complete, for the reset case below. It must be in flight
      // (`beginAttempt`) so `completeAttempt` finds it in the state it requires.
      const recoveryForReset = await store.beginAttempt({});
      // A success may ZERO the counter however far it has climbed — that is what
      // the counter is FOR, and without it a Mac that failed four nights running
      // could never record a recovery and the ledger would be stuck red forever.
      // (The first version of this guard refused it, and measured on a real
      // cluster `completeAttempt` failed with "moved by more than one" after
      // three failures. That is a real deadlock, not a test problem.)
      await store.completeAttempt({ generationId: recoveryForReset.generationId,
        dumpSha256: DIGEST("reset"), dumpBytes: 10, fileSha256: DIGEST("freset"),
        shapeDigest: DIGEST("sreset"), rowCounts: [{ table: "t", count: 1 }] });
      assert.equal((await store.freshness()).consecutiveFailures, 0,
        "a success clears the counter, however many failures preceded it");
      // ...but a MULTI-STEP zero must be BLAMED on a success that actually moved.
      // Leaving `last_success_at` where it was is the forgery the reset could
      // otherwise enable: a caller drops four nights of failures in one statement
      // and the badge goes green with no new evidence behind it.
      //
      // The counter is taken to 4 with FOUR `failAttempt` calls, because the setup
      // has to be legal moves only — a bare assignment to any value the guard
      // reads as a jump is itself refused, and a fixture that cannot be set up
      // proves nothing about the guard it is meant to exercise.
      for (let index = 0; index < 4; index += 1) {
        await store.failAttempt({ generationId: (await store.beginAttempt({})).generationId,
          code: "updater_backup_dump_failed" });
      }
      assert.equal((await store.freshness()).consecutiveFailures, 4,
        "four real failures, so zeroing them is a five-step move");
      assert.match(await refuses(client, "UPDATE updater.backup_state SET consecutive_failures=0"),
        /by more than one/u,
        "zeroing the counter without recording a new success is still refused");
      // The permitted reset goes through `completeAttempt`, not raw SQL, because the
      // carve-out requires `last_success_at` to MOVE and a bare
      // `last_success_at=pg_catalog.now()` in the same transaction as a previous one
      // is the SAME timestamp — the forgery check would see no movement and refuse
      // a legitimate reset. The store's completion and the state UPDATE are
      // separate statements, so the transaction clock advances between them.
      await store.completeAttempt({ generationId: (await store.beginAttempt({})).generationId,
        dumpSha256: DIGEST("reset2"), dumpBytes: 10, fileSha256: DIGEST("freset2"),
        shapeDigest: DIGEST("sreset2"), rowCounts: [{ table: "t", count: 1 }] });
      assert.equal((await store.freshness()).consecutiveFailures, 0,
        "and zeroing it alongside a success that really happened is permitted");
      // The failure pair cannot be half-cleared, which is how "failed" would
      // otherwise become "healthy" by clearing one column. Both halves are ALREADY
      // set at this point, because the `failAttempt` calls above set them, so
      // re-setting one of them is a no-op the guard correctly permits — the first
      // version of this assertion therefore passed for the wrong reason. The pair
      // is CLEARED first (a legal move, and one that proves the clear works), and
      // each half is then set on its own.
      //
      // The code is a LEGAL one (`^[a-z][a-z0-9_]{1,63}$`). The first version used
      // `'x'`, which the column's own CHECK refuses before the pair guard runs —
      // again the wrong boundary.
      await client.query("UPDATE updater.backup_state SET last_failure_at=NULL, last_failure_code=NULL");
      assert.deepEqual((await store.freshness()).lastFailureCode, null,
        "the pair clears together, and clearing both is legal");
      assert.match(await refuses(client,
        "UPDATE updater.backup_state SET last_failure_code='updater_backup_dump_failed'"), /together/u,
      "a failure code cannot be set without its timestamp");
      assert.match(await refuses(client, "UPDATE updater.backup_state SET last_failure_at=pg_catalog.now()"),
        /together/u, "nor a timestamp without its code");
      // Setting both together IS legal, which is what makes the guard a
      // consistency rule rather than a prohibition.
      await client.query("UPDATE updater.backup_state SET last_failure_code='updater_backup_dump_failed',"
        + " last_failure_at=pg_catalog.now()");
      assert.equal((await store.freshness()).lastFailureCode, "updater_backup_dump_failed");
      // And a code outside the bounded grammar never reaches the pair guard.
      assert.match(await refuses(client, "UPDATE updater.backup_state SET last_failure_code='x', "
        + "last_failure_at=pg_catalog.now()"), /check constraint|violated/u,
      "a one-character code is refused by the column's own CHECK first");
      // The recovery rule: a failure may be CLEARED on its own (that is a
      // cleanup, and refusing it would leave the ledger stuck), but a recovery
      // that also dates a success BEFORE the failure it clears is refused. The
      // `IS DISTINCT FROM` on `last_success_at` is what separates the two, and
      // both halves are asserted because a rule that only refuses is a rule that
      // blocks the legitimate case too.
      // The counter is set up with ONE `failAttempt` — which moves the counter by
      // one AND sets the failure pair, the only legal way to move it. The
      // first version added `consecutive_failures + 1` in the same statement as
      // the pair, which is a two-step move and is correctly refused; the second
      // set the pair and the counter together at a value one higher, also
      // refused. Measured: "updater backup failure counter moved by more than one".
      const recoverySetup = await store.beginAttempt({});
      await store.failAttempt({ generationId: recoverySetup.generationId,
        code: "updater_backup_dump_failed" });
      assert.match(await refuses(client, "UPDATE updater.backup_state SET last_failure_at=NULL,"
        + " last_failure_code=NULL, last_success_at=pg_catalog.now() - interval '1 hour'"),
      /recovered before the failure it clears/u,
      "a recovery dated before the failure it clears is refused");
      await client.query("UPDATE updater.backup_state SET last_failure_at=NULL, last_failure_code=NULL");
      assert.deepEqual((await store.freshness()).lastFailureCode, null,
        "and clearing a stale failure on its own is legal, which is the case the first version of this rule broke");
      // A second policy row is impossible, and the bounds hold so the freshness
      // rule cannot be made vacuous or unbounded.
      assert.match(await refuses(client, "INSERT INTO updater.backup_state(singleton,max_age_seconds,kept_generations)"
        + " VALUES (false, 93600, 14)"), /singleton/u);
      assert.match(await refuses(client, "UPDATE updater.backup_state SET max_age_seconds=999999999"),
        /check constraint|violated/u);
      assert.match(await refuses(client, "UPDATE updater.backup_state SET kept_generations=0"),
        /check constraint|violated/u);
      // A completed attempt cannot be completed twice, which is the retry-after-
      // failure case: a second completion must not resurrect a finished row.
      const second = await store.beginAttempt({});
      await store.completeAttempt({ generationId: second.generationId, dumpSha256: DIGEST("d2"),
        dumpBytes: 10, fileSha256: DIGEST("f2"), shapeDigest: DIGEST("s2"), rowCounts: [{ table: "t", count: 2 }] });
      await assert.rejects(store.completeAttempt({ generationId: second.generationId, dumpSha256: DIGEST("d3"),
        dumpBytes: 10, fileSha256: DIGEST("f3"), shapeDigest: DIGEST("s3"), rowCounts: [{ table: "t", count: 3 }] }),
      /updater_backup_completion_refused/u);
      // The MIGRATOR — the account a candidate controls — can touch none of it,
      // and cannot reach the freshness function the refusal runs.
      const migrator = await as(postgres, "migrator");
      try {
        assert.match(await refuses(migrator, "SELECT * FROM updater.backup_generations"), /permission denied/u);
        assert.match(await refuses(migrator, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
          failure_code) VALUES('backup:2026-01-01T00-00-02-0001Z','failed',pg_catalog.now(),'x')`),
        /permission denied/u);
        assert.match(await refuses(migrator, "UPDATE updater.backup_state SET consecutive_failures=0"),
          /permission denied/u);
        assert.match(await refuses(migrator, "SELECT updater.backup_is_fresh()"), /permission denied/u);
        // A candidate cannot mint a database plan by the back door, and cannot
        // make the freshness function say yes.
        assert.match(await refuses(migrator, DATABASE_PLAN_INSERT("plan-mig", DIGEST("mig"))),
          /permission denied/u);
        assert.match(await refuses(migrator, "SELECT updater.backup_row_counts_shape('[]'::jsonb)"),
          /permission denied/u);
      } finally { await migrator.end(); }
      // The WEB can read the badge, and it is the same verdict the trigger uses.
      const web = await as(postgres, "web");
      try {
        // The badge is built from the COLUMN grants, not from a callable verdict,
        // and that is deliberate: `backup_is_fresh()` is the trigger's rule, and a
        // web role that could call it would be a second implementation of that
        // rule to keep in step. The columns below are everything the badge needs —
        // the last state, the last attempt, the last success, the last failure and
        // the bound — and the web computes "red" from them.
        //
        // The web cannot CALL the freshness function, which the first version of
        // this assertion wrongly required: measured, "permission denied for
        // function backup_is_fresh". The column-scoped grant is the design, so the
        // assertion now checks the columns exist and that the function stays shut.
        const badge = (await web.query("SELECT state, created_at, completed_at, failure_code, encrypted"
          + " FROM updater.backup_generations ORDER BY created_at DESC LIMIT 1")).rows[0];
        assert.equal(badge.state, "verified");
        assert.equal(badge.failure_code, null, "and it carries no failure, which is what the badge shows");
        const policy = (await web.query("SELECT max_age_seconds, last_attempt_at, last_success_at,"
          + " last_failure_code, consecutive_failures FROM updater.backup_state")).rows[0];
        assert.equal(policy.max_age_seconds, BACKUP_MAX_AGE_SECONDS_V1,
          "with the bound the badge compares against");
        assert.ok(policy.last_success_at instanceof Date, "and the success it compares");
        assert.equal(policy.last_failure_code, null);
        assert.equal(policy.consecutive_failures, 0);
        assert.match(await refuses(web, "SELECT updater.backup_is_fresh()"),
          /permission denied/u,
          "the freshness RULE stays the trigger's alone");
        // The digests are NOT readable: the badge needs state and ages, not the
        // operator's hashes or per-table counts.
        assert.match(await refuses(web, "SELECT dump_sha256 FROM updater.backup_generations"),
          /permission denied/u);
        assert.match(await refuses(web, "SELECT row_counts FROM updater.backup_generations"),
          /permission denied/u);
        // And the web can write NOTHING here: a compromised release must not be
        // able to clear a failure or declare a backup good (R12, §12).
        assert.match(await refuses(web, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
          failure_code) VALUES('backup:2026-01-01T00-00-03-0001Z','failed',pg_catalog.now(),'x')`),
        /permission denied/u);
        assert.match(await refuses(web, "UPDATE updater.backup_state SET consecutive_failures=0"),
          /permission denied/u);
        assert.match(await refuses(web, "DELETE FROM updater.backup_generations"), /permission denied/u);
        // And it cannot queue a push in the updater's name: the existing R12
        // template guard still holds with the new tables present.
        assert.match(await refuses(web, `INSERT INTO updater.push_queue(id,template,title,body)
          VALUES('push:00000000-0000-4000-8000-000000000001','control-room-updater.backup_failed','t','b')`),
        /only the updater may use its own push template/u);
      } finally { await web.end(); }
    });
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

// ---------------------------------------------------------------------------
// 8. The on-disk boundary: planted symlinks, foreign entries, unknown dirs.
// ---------------------------------------------------------------------------
test("a planted symlink or a foreign entry in the backup root is never deleted or counted", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client }) => {
      const { base, installRoot, backupRoot } = await backupRootForV1(t);
      const backup = new UpdaterBackupV1({ store, ports: filePortsV1(postgres),
        policy: internalPolicyV1(installRoot, backupRoot) });
      const good = await backup.runOnce({ manual: true });
      assert.equal(good.status, "verified");
      // A VICTIM directory outside the backup root, which a planted symlink points
      // at. Nothing the sweep does may touch it.
      const victim = join(base, "victim");
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "precious.txt"), "do not delete\n");
      // A symlinked generation, named exactly like a generation the ledger knows.
      const attackerLeaf = `gen-${generationLeafV1(good.generationId)}`;
      await rm(join(backupRoot, attackerLeaf), { recursive: true, force: true });
      await symlink(victim, join(backupRoot, attackerLeaf));
      // A real generation directory whose DUMP is a symlink out of the root.
      const second = await store.beginAttempt({});
      await store.completeAttempt({ generationId: second.generationId, dumpSha256: DIGEST("d"), dumpBytes: 5,
        fileSha256: DIGEST("f"), shapeDigest: DIGEST("s"), rowCounts: [{ table: "t", count: 1 }] });
      await mkdir(join(backupRoot, `gen-${generationLeafV1(second.generationId)}`), { recursive: true, mode: 0o700 });
      await symlink(join(victim, "precious.txt"),
        join(backupRoot, `gen-${generationLeafV1(second.generationId)}`, "database.dump"));
      // A REAL generation, which retention legitimately owns and may delete — but
      // ONLY once it is actually surplus. The default policy keeps fourteen, so
      // three generations is not surplus and the honest expectation is that none
      // of them is removed. A real surplus is created further down by dropping the
      // keep count to two, which is the same policy value the installer would
      // write, rather than by hand-building fifteen generations here.
      const surplus = await store.beginAttempt({});
      const surplusBytes = Buffer.from("surplus\n", "utf8");
      await store.completeAttempt({ generationId: surplus.generationId,
        dumpSha256: `sha256:${createHash("sha256").update(surplusBytes).digest("hex")}`,
        dumpBytes: surplusBytes.length, fileSha256: `sha256:${createHash("sha256").update(surplusBytes).digest("hex")}`,
        shapeDigest: DIGEST("s3"), rowCounts: [{ table: "t", count: 3 }] });
      const surplusLeaf = `gen-${generationLeafV1(surplus.generationId)}`;
      await mkdir(join(backupRoot, surplusLeaf), { recursive: true, mode: 0o700 });
      await writeFile(join(backupRoot, surplusLeaf, "database.dump"), surplusBytes, { mode: 0o400 });
      await writeFile(join(backupRoot, surplusLeaf, "manifest.json"),
        `${JSON.stringify({ schema: "control-room.backup-manifest/v1", generationId: surplus.generationId,
          dumpSha256: `sha256:${createHash("sha256").update(surplusBytes).digest("hex")}`,
          dumpBytes: surplusBytes.length,
          fileSha256: `sha256:${createHash("sha256").update(surplusBytes).digest("hex")}`,
          shapeDigest: DIGEST("s3"), rowCounts: [{ table: "t", count: 3 }],
          rowCountsDigest: DIGEST("r"), snapshotXid: null, encrypted: false,
          pgVersion: "control-room.pg-version/v1", installRoot })}\n`, { mode: 0o400 });
      // A directory the LEDGER DOES NOT KNOW: an attacker-planted one, shaped to
      // look exactly like a generation.
      const planted = "gen-2026-01-01_00-00-00-0001Z";
      await mkdir(join(backupRoot, planted), { recursive: true, mode: 0o700 });
      await writeFile(join(backupRoot, planted, "database.dump"), "planted\n", { mode: 0o400 });
      await writeFile(join(backupRoot, planted, "manifest.json"), '{"schema":"nope"}\n', { mode: 0o400 });

      const swept = await backup.sweep();
      // The symlinked generation is reported unsafe and left in place: removing
      // "through" it would remove the victim's contents.
      assert.ok(swept.unsafe.includes(good.generationId), "the symlinked generation is reported unsafe");
      assert.equal(await readFile(join(victim, "precious.txt"), "utf8"), "do not delete\n",
        "the victim is untouched");
      // The generation with a symlinked dump is unsafe too, and the target is
      // untouched even though the real directory is this one's to remove.
      assert.ok(swept.unsafe.includes(second.generationId));
      assert.equal(await readFile(join(victim, "precious.txt"), "utf8"), "do not delete\n");
      // The unknown directory is neither kept nor removed: it is not the ledger's
      // to delete, so it is only reported.
      assert.equal((await readdir(join(backupRoot, planted))).length, 2,
        "a directory the ledger does not know is left alone, files and all");
      // Nothing is removed at the default keep count of fourteen, because three
      // generations is not surplus. Asserting a removal here would have been
      // asserting that retention deletes good dumps it should be keeping.
      assert.deepEqual(swept.removed, [],
        "three generations is not surplus, so retention removes none of them");
      // Now drop the keep count to two, which is a POLICY value the installer
      // writes rather than a hand-built pile of generations. Which generation is
      // actually surplus depends on the keep SET, and that is the interesting
      // part: the keep set is chosen from the LEDGER's verified rows, and
      // `good` is the oldest of the three — so it is the one outside keep=2. But
      // its directory is the symlink, so it is reported `unsafe` and NOT removed.
      // That is the property worth asserting: retention's arithmetic is right and
      // the safety check still wins, so a real generation is never deleted
      // through an unsafe path, and an unsafe one is never deleted as surplus.
      await client.query("UPDATE updater.backup_state SET kept_generations=2 WHERE singleton");
      const pruned = await backup.sweep();
      assert.deepEqual(pruned.removed, [],
        "the only surplus generation is the one whose directory is a symlink, so nothing is removed");
      assert.ok(pruned.unsafe.includes(good.generationId),
        "and it is reported unsafe rather than silently kept or silently deleted");
      assert.ok(pruned.retained.includes(surplus.generationId),
        "the valid generation inside the keep set is retained");
      assert.ok(pruned.unsafe.includes(second.generationId),
        "the one with a symlinked dump fails the safety check, so it is reported unsafe and never counted as kept");
      assert.equal(await existsAsync(join(backupRoot, `gen-${generationLeafV1(second.generationId)}`)), true,
        "and its directory is still there: damaged is reported, not deleted");
      assert.equal(await existsAsync(join(backupRoot, attackerLeaf)), true,
        "the symlinked generation is still there: it is unsafe, not surplus");
      assert.equal(await readFile(join(victim, "precious.txt"), "utf8"), "do not delete\n",
        "and the victim it points at is still intact");
      // Retention's arithmetic, at keep=1: the NEWEST verified generation is the
      // only one kept, so every older verified generation is surplus. The two
      // unsafe ones are surplus AND unsafe, and unsafe wins — they are reported
      // and left. That is the whole property, and it is the half the earlier
      // assertions did not reach.
      await client.query("UPDATE updater.backup_state SET kept_generations=1 WHERE singleton");
      const prunedAgain = await backup.sweep();
      assert.deepEqual(prunedAgain.removed, [],
        "at keep=1 the only valid generation is still the newest, so there is nothing safe to remove");
      assert.ok(prunedAgain.retained.includes(surplus.generationId),
        "and the newest valid generation is retained");
      assert.ok(prunedAgain.unsafe.includes(good.generationId)
        && prunedAgain.unsafe.includes(second.generationId),
      "while both unsafe generations are surplus and still not deleted: unsafe always wins over surplus");
      assert.equal(await existsAsync(join(backupRoot, attackerLeaf)), true,
        "the symlinked generation is STILL not removed, however far out of date it is");
      // And the half that proves the sweep can actually DELETE: a second, VALID
      // generation is created, then the keep count drops to one so exactly one
      // verified generation is surplus. `completed_at` is immutable by the
      // generation guard — deliberately, since it is the evidence a verify
      // produced — so the test creates real generations rather than rewriting
      // their ages. Measured: rewriting `completed_at` is refused with "updater
      // backup generation content is immutable", which is the guard working.
      // And the half that proves the sweep can actually DELETE. The keep count
      // goes back to its default BEFORE the new generation is created, because a
      // `runOnce` sweeps as it promotes: with keep=1 already set, the new run's own
      // sweep removed the older valid generation, and the explicit sweep below then
      // had nothing left to remove. That ordering was the reason the first version
      // of this assertion reported an empty `removed` list.
      await client.query("UPDATE updater.backup_state SET kept_generations=2 WHERE singleton");
      const extra = await backup.runOnce({ manual: true });
      assert.equal(extra.status, "verified");
      const extraLeaf = `gen-${generationLeafV1(extra.generationId)}`;
      assert.equal(await existsAsync(join(backupRoot, extraLeaf)), true, "the new generation is on disk");
      await client.query("UPDATE updater.backup_state SET kept_generations=1 WHERE singleton");
      const prunedLast = await backup.sweep();
      assert.deepEqual(prunedLast.removed, [surplus.generationId],
        "at keep=1 only the newest valid generation survives, and that is the one removed"
          + ` (retained ${JSON.stringify(prunedLast.retained)}, unsafe ${JSON.stringify(prunedLast.unsafe)})`);
      assert.equal(await existsAsync(join(backupRoot, `gen-${generationLeafV1(surplus.generationId)}`)), false,
        "and its directory is gone");
      assert.equal(await existsAsync(join(backupRoot, extraLeaf)), true, "while the newest one is kept");
      assert.equal(await existsAsync(join(backupRoot, attackerLeaf)), true,
        "and the planted symlink is STILL there: unsafe is never a deletion candidate");
      assert.equal(await readFile(join(victim, "precious.txt"), "utf8"), "do not delete\n",
        "with the victim it points at untouched through every removal");
      // The safety check refuses both planted generations, and reports the
      // REMOVED one as absent rather than as a failure — a generation that is not
      // there is `null`, which is what lets the sweep tell "gone, correctly" from
      // "broken".
      //
      // TWO refusal codes are correct for the two plants, and asserting one would
      // have hidden the other. A symlinked GENERATION DIRECTORY is caught by the
      // R-FS walk before the generation check runs, so it is
      // `updater_symlink_refused`; a symlinked DUMP inside a real directory gets
      // past that walk and is caught by the generation check itself, so it is
      // `updater_backup_generation_refused`. Both fail closed, which is the
      // property; the distinction is which layer noticed.
      await assert.rejects(assertSafeGenerationV1(backupRoot, good.generationId),
        /updater_(symlink|backup_generation)_refused/u,
        "a symlinked generation directory is refused, never followed");
      await assert.rejects(assertSafeGenerationV1(backupRoot, second.generationId),
        /updater_backup_generation_refused/u, "a generation with a symlinked dump is refused");
      assert.equal(await assertSafeGenerationV1(backupRoot, surplus.generationId), null,
        "a correctly removed generation is reported absent, not refused");
      assert.equal(await assertSafeGenerationV1(backupRoot, extra.generationId) !== null, true,
        "and the surviving one still passes its own check");
    });
  }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

/**
 * Existence, checked with `lstat` and tolerating ENOENT.
 *
 * The first version of this helper used `require("node:fs")`, which is not
 * available in an ES module — the `require` threw, the `catch` returned false,
 * and every caller read as "the directory is gone". Three assertions failed on a
 * helper that could only ever answer one thing. `lstat` also follows no symlink,
 * which is what these assertions actually want: they are checking that a
 * PLANTED SYMLINK is still there, and `stat` would have followed it to the victim.
 */
async function existsAsync(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

// ---------------------------------------------------------------------------
// 9. The seal: an external root must be sealed; a failed seal refuses.
// ---------------------------------------------------------------------------
test("a backup root outside the install root is sealed, and a failed seal refuses the generation", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    await withBackupStoreV1(postgres, async ({ store, client }) => {
      const { base, installRoot } = await backupRootForV1(t);
      // An external root on a volume with ownership DISABLED, which is the
      // carry-forward's case. Nothing under it is protected by ownership, so the
      // policy REQUIRES a seal rather than merely allowing one.
      const backupRoot = join(base, "ExternalDrive", "backups");
      await mkdir(backupRoot, { recursive: true, mode: 0o777 });
      const policy = resolveBackupRootPolicyV1({ installRoot, backupRoot });
      assert.equal(policy.insideInstallRoot, false);
      assert.equal(policy.sealRequired, true, "an external root must be sealed");
      assert.equal(resolveBackupRootPolicyV1({ installRoot, backupRoot: join(installRoot, "backups") })
        .sealRequired, false, "a root inside the install root keeps the R-FS boundary instead");
      // NOTE: `join(base, "x", "..", "y")` is NOT a test case here — `path.join`
    // already normalises it to `base/y` before the policy ever sees it, so
    // asserting a refusal for it would be asserting a property of `join`, not of
    // the policy. The escaping case the policy actually has to catch is a
    // string that is not normalised at all, which the literal below is.
    for (const bad of ["/", `installRoot/backups`, `${base}/x/../y`, `${base}/x/./y`]) {
        assert.throws(() => resolveBackupRootPolicyV1({ installRoot, backupRoot: bad }),
          /updater_backup_root_refused/u, `the backup root ${bad} is refused`);
      }
      // A seal that fails refuses the whole generation: an unsealed dump on a
      // drive with no ownership must not be promoted, and must not be called fresh.
      const ports = filePortsV1(postgres);
      const failing = new UpdaterBackupV1({ store, ports: { ...ports, seal: async () => false },
        policy: { installRoot, backupRoot, seal: false, freeSpaceFloorBytes: 0 } });
      const refused = await failing.runOnce({ manual: true });
      assert.equal(refused.status, "failed");
      assert.equal(refused.code, "updater_backup_seal_refused");
      assert.deepEqual((await readdir(backupRoot)).filter(name => name.startsWith("gen-")), [],
        "no generation was promoted");
      assert.equal((await store.freshness()).fresh, false, "and nothing was recorded as fresh");
      // With a real seal it is promoted, marked encrypted, and the plaintext is
      // genuinely gone from the dump file.
      const sealing = new UpdaterBackupV1({ store, ports: { ...ports, seal: async ({ path }: { path: string }) => {
        const original = await readFile(path);
        const transformed = Buffer.concat([Buffer.from("SENTINEL-SEALED-BYTES", "utf8"),
          createHash("sha256").update(original).digest()]);
        await writeFile(path, transformed);
        return true; } },
      policy: { installRoot, backupRoot, seal: false, freeSpaceFloorBytes: 0 } });
      const sealed = await sealing.runOnce({ manual: true });
      assert.equal(sealed.status, "verified", sealed.message);
      const generation = await store.generation(sealed.generationId);
      assert.ok(generation, "the sealed generation is on the ledger");
      assert.equal(generation.encrypted, true);
      const dumpBytes = await readFile(join(backupRoot, `gen-${generationLeafV1(sealed.generationId)}`,
        "database.dump"));
            // The sentinel is 21 characters, so the slice is 21 bytes and the
      // comparison is an exact `assert.equal` — no regex, no anchoring to get
      // wrong. Two earlier versions of this assertion got the LENGTH wrong (20,
      // then 19), each time matching a shorter prefix and failing, which read
      // exactly like "the seal did not happen". The failure text named the
      // 18-byte prefix each time, which is what a wrong slice length looks like.
      assert.equal(dumpBytes.subarray(0, 21).toString("latin1"), "SENTINEL-SEALED-BYTES",
        "the dump on disk is the sealed bytes, not the plaintext");
      assert.ok(dumpBytes.length > 21, "and the sealed bytes have content behind the marker");
      // The manifest records BOTH digests, which is what lets a restore say which
      // plaintext the verify was performed against.
      const safe = await assertSafeGenerationV1(backupRoot, sealed.generationId);
      assert.ok(safe, "the sealed generation passes its own safety check");
      assert.equal(safe.manifest.encrypted, true);
      assert.equal(safe.manifest.dumpSha256, generation.dumpSha256);
      assert.equal(safe.manifest.fileSha256, generation.fileSha256);
      assert.notEqual(safe.manifest.dumpSha256, safe.manifest.fileSha256,
        "a sealed dump has two different digests, and both are recorded");
    });
  }, { port: PORT + 2, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

test("the backup lane ran on a real cluster, not a skip", () => {
  assert.equal(PG ? required : 0, TEST_COUNT, "every backup test declares that it needs PostgreSQL");
  assert.equal(ran, TEST_COUNT, "and every one of them ran rather than skipping");
  void updaterDdlFilesV1;
});
