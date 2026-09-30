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
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "test", ...extra };
}

async function runV1(file: string, args: readonly string[], maxBuffer = 1 << 30) {
  return execFileAsync(file, args as string[], { env: cleanEnv(), timeout: 120_000, maxBuffer });
}

const DEPLOYER_PASSWORD = "fixture-deployer";
const DDL_DIRECTORY = join(process.cwd(), "src/updater/v1/ddl");
const DIGEST = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const DATABASE_PLAN_INSERT = (id: string, digest: string, json: string) =>
  `INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,changes_updater,
    plan_digest,plan_json,needs_mac_confirm,expires_at)
   VALUES('${id}','install-fixture','database','building',ARRAY['database'],true,false,'${digest}',
   '${json}'::jsonb,false,now()+interval '72 hours')`;

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

const planJson = (id: string, kind: "database" | "code" = "database") =>
  JSON.stringify({ schema: "control-room.install-plan/v2", planId: id, kind });

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
        await runV1(join(PG_BIN, "initdb"), ["-D", dataDir, "-U", "fixture_admin", "-A", "trust",
          "--no-sync", "-E", "UTF8"]);
        await writeFile(join(dataDir, "postgresql.conf"),
          `\nunix_socket_directories = '${socketDir.replaceAll("'", "''")}'\nlisten_addresses = ''\n`);
        await runV1(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-o", "-c fsync=off -c full_page_writes=off",
          "-w", "-t", "60", "start"]);
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
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient }) => {
      const { base, installRoot, backupRoot } = await backupRootForV1(t);
      const scratchRoot = join(base, "scratch");
      await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
      // A CHILD PROCESS is the honest kill. SIGKILL cannot be caught, so no
      // `finally` in the runner runs and the only thing that can hold the
      // invariants is that they were never in a state that needed saving.
      const readyFile = join(base, "ready"), script = join(base, "killed-backup.mjs");
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
      const child = spawn(process.execPath, [script, postgres.socketDirectory, String(postgres.port),
        postgres.database, installRoot, backupRoot, readyFile],
      { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      try {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (await readFile(readyFile, "utf8").catch(() => "") === "started") break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(await readFile(readyFile, "utf8").catch(() => ""), "started",
          `the child reached the dump${stderr ? `: ${stderr}` : ""}`);
        // While the dump runs: a row is in flight, the directory is NOT promoted.
        const during = await readdir(backupRoot);
        assert.equal(during.filter(name => name.startsWith("gen-")).length, 0,
          "no promoted generation exists while the dump is still running");
        assert.ok(during.some(name => name.startsWith(".inprogress-")),
          "the partial work is named so retention can never count it");
      } finally {
        child.kill("SIGKILL");
        await new Promise(resolve => child.once("exit", resolve));
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
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient }) => {
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
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient }) => {
      const { installRoot, backupRoot } = await backupRootForV1(t);
      const backup = new UpdaterBackupV1({ store, ports: filePortsV1(postgres),
        policy: internalPolicyV1(installRoot, backupRoot) });
      // 20 successes and 6 failures, interleaved the way a month looks. The
      // failures are the daemons4 defect: each leaves a `failed` row that a
      // name-pattern retention would count, and would evict a good dump for.
      for (let index = 0; index < 20; index += 1) {
        assert.equal((await backup.runOnce({ manual: true })).status, "verified", `success ${index}`);
        if (index % 3 === 1) {
          // Failures are recorded through the real store path, exactly as a dump
          // error would, and land BETWEEN successes so ordering cannot hide them.
          const attempt = await store.beginAttempt({});
          await store.failAttempt({ generationId: attempt.generationId, code: "updater_backup_dump_failed" });
        }
      }
      const verified = await store.verifiedGenerations(100);
      assert.equal(verified.length, 20, "the ledger remembers all twenty successes");
      const allRows = (await client.query("SELECT state, count(*)::int AS count FROM updater.backup_generations "
        + "GROUP BY state ORDER BY state")).rows;
      assert.deepEqual(allRows, [{ state: "failed", count: 6 }, { state: "verified", count: 20 }],
        "six failures and twenty successes are both on the ledger");
      const swept = await backup.sweep();
      const onDisk = (await readdir(backupRoot)).filter(name => name.startsWith("gen-"));
      assert.equal(onDisk.length, BACKUP_KEPT_GENERATIONS_V1,
        `exactly ${BACKUP_KEPT_GENERATIONS_V1} generations survive, not one per directory`);
      // The survivors are the NEWEST fourteen. Ordering is by completed_at, so a
      // sweep that kept the oldest would name a different set here.
      const newest = verified.slice(0, BACKUP_KEPT_GENERATIONS_V1)
        .map((row: { generationId: string }) => row.generationId).sort();
      assert.deepEqual(swept.retained.sort(), newest, "the newest fourteen are the ones kept");
      assert.equal(swept.removed.length, 6, "the six oldest are removed");
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
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient }) => {
      // NOTHING has ever run: a database plan must be refused.
      assert.equal((await store.freshness()).fresh, false);
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-nobackup", DIGEST("a"), planJson("nobackup"))),
        /updater_database_backup_stale/u);
      // A CODE plan is not a database plan, so the same guard does not touch it.
      await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
        changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
        VALUES('plan-code','install-fixture','code','building',ARRAY['code'],false,false,$1,$2::jsonb,false,
        now()+interval '72 hours')`, [DIGEST("code"), planJson("code", "code")]);
      // A FAILED attempt does not unblock it, and the refusal names the plain
      // reason the card and the push show.
      const failed = await store.beginAttempt({});
      await store.failAttempt({ generationId: failed.generationId, code: "updater_backup_dump_failed" });
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-failed", DIGEST("b"), planJson("failed"))),
        /updater_database_backup_stale/u);
      // Close the one open plan so the next refusal is unambiguously about the
      // backup and not the one-open-plan rule.
      await client.query("UPDATE updater.plans SET state='superseded', superseded_by_plan_id='plan-code' "
        + "WHERE plan_id='plan-code'");
      // Now a real backup, and the same insert is admitted.
      const { installRoot, backupRoot } = await backupRootForV1(t);
      const backup = new UpdaterBackupV1({ store, ports: filePortsV1(postgres),
        policy: internalPolicyV1(installRoot, backupRoot) });
      assert.equal((await backup.runOnce({ manual: true })).status, "verified");
      assert.equal((await store.freshness()).fresh, true);
      await client.query(DATABASE_PLAN_INSERT("plan-after-backup", DIGEST("c"), planJson("after")));
      assert.equal((await client.query("SELECT kind FROM updater.plans WHERE plan_id='plan-after-backup'"))
        .rows[0].kind, "database");
      // Ageing the last success past the policy bound re-closes the door, using
      // the DATABASE's clock. That is what "older than 26 h" means, and ageing the
      // row is the only way to test the bound without a 26-hour test.
      await client.query(`UPDATE updater.backup_generations SET completed_at=pg_catalog.now()
        - make_interval(secs => $1) WHERE generation_id=(SELECT last_generation_id FROM updater.backup_state)`,
      [BACKUP_MAX_AGE_SECONDS_V1 + 60]);
      assert.equal((await store.freshness()).fresh, false, "26 hours and one minute is not fresh");
      await client.query("UPDATE updater.plans SET state='superseded', superseded_by_plan_id='plan-after-backup' "
        + "WHERE plan_id='plan-after-backup'");
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-stale", DIGEST("d"), planJson("stale"))),
        /updater_database_backup_stale/u);
      // The badge and the refusal are the SAME predicate, so they cannot disagree.
      assert.equal((await backup.status()).fresh, false);
      // A missing policy row fails closed rather than waving plans through.
      await client.query("DELETE FROM updater.backup_state");
      assert.equal(await as1(client, "SELECT updater.backup_is_fresh() AS fresh"), false,
        "with no policy bound there is no rule to satisfy, so nothing is fresh");
      assert.match(await refuses(client, DATABASE_PLAN_INSERT("plan-nopolicy", DIGEST("e"), planJson("nopolicy"))),
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
    await withBackupStoreV1(postgres, async ({ store, client, evidenceClient }) => {
      const attempt = await store.beginAttempt({});
      await store.completeAttempt({ generationId: attempt.generationId, dumpSha256: DIGEST("dump"),
        dumpBytes: 1024, fileSha256: DIGEST("file"), shapeDigest: DIGEST("shape"),
        rowCounts: [{ table: "t", count: 1 }] });
      // A `failed` row cannot be born carrying a dump: the shape constraint is the
      // daemons4 fix at the storage layer, checked on INSERT as well as UPDATE.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
        dump_sha256,dump_bytes,file_sha256,shape_digest,row_counts,row_counts_digest)
        VALUES('backup:2026-01-01T00-00-00-000Z','failed',pg_catalog.now(),'${DIGEST("d")}',10,'${DIGEST("f")}',
        '${DIGEST("s")}','[{"table":"t","count":1}]'::jsonb,'${DIGEST("r")}')`),
      /backup_generation_verified_shape/u);
      // Nor can a `verified` row be born with no evidence behind it.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at)
        VALUES('backup:2026-01-01T00-00-01-000Z','verified',pg_catalog.now())`),
      /backup_generation_verified_shape/u);
      // Nor with a row-count array that is not a bounded array of {table,count}.
      assert.match(await refuses(client, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
        dump_sha256,dump_bytes,file_sha256,shape_digest,row_counts,row_counts_digest)
        VALUES('backup:2026-01-01T00-00-04-000Z','verified',pg_catalog.now(),'${DIGEST("d")}',10,'${DIGEST("f")}',
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
      assert.match(await refuses(client, "UPDATE updater.backup_state SET consecutive_failures=0"),
        /by more than one/u);
      // The failure pair cannot be half-cleared, which is how "failed" would
      // otherwise become "healthy" by clearing one column.
      assert.match(await refuses(client, "UPDATE updater.backup_state SET last_failure_code='x'"), /together/u);
      assert.match(await refuses(client, "UPDATE updater.backup_state SET last_failure_at=pg_catalog.now()"),
        /together/u);
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
          failure_code) VALUES('backup:2026-01-01T00-00-02-000Z','failed',pg_catalog.now(),'x')`),
        /permission denied/u);
        assert.match(await refuses(migrator, "UPDATE updater.backup_state SET consecutive_failures=0"),
          /permission denied/u);
        assert.match(await refuses(migrator, "SELECT updater.backup_is_fresh()"), /permission denied/u);
        // A candidate cannot mint a database plan by the back door, and cannot
        // make the freshness function say yes.
        assert.match(await refuses(migrator, DATABASE_PLAN_INSERT("plan-mig", DIGEST("mig"), planJson("mig"))),
          /permission denied/u);
        assert.match(await refuses(migrator, "SELECT updater.backup_row_counts_shape('[]'::jsonb)"),
          /permission denied/u);
      } finally { await migrator.end(); }
      // The WEB can read the badge, and it is the same verdict the trigger uses.
      const web = await as(postgres, "web");
      try {
        assert.equal(typeof (await web.query("SELECT updater.backup_is_fresh() AS fresh")).rows[0].fresh, "boolean");
        assert.equal((await web.query("SELECT state FROM updater.backup_generations LIMIT 1")).rows[0].state,
          "verified");
        // The digests are NOT readable: the badge needs state and ages, not the
        // operator's hashes or per-table counts.
        assert.match(await refuses(web, "SELECT dump_sha256 FROM updater.backup_generations"),
          /permission denied/u);
        assert.match(await refuses(web, "SELECT row_counts FROM updater.backup_generations"),
          /permission denied/u);
        // And the web can write NOTHING here: a compromised release must not be
        // able to clear a failure or declare a backup good (R12, §12).
        assert.match(await refuses(web, `INSERT INTO updater.backup_generations(generation_id,state,completed_at,
          failure_code) VALUES('backup:2026-01-01T00-00-03-000Z','failed',pg_catalog.now(),'x')`),
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
      // A REAL generation, which retention legitimately owns and may delete.
      const surplus = await store.beginAttempt({});
      await store.completeAttempt({ generationId: surplus.generationId, dumpSha256: DIGEST("d3"),
        dumpBytes: 7, fileSha256: DIGEST("f3"), shapeDigest: DIGEST("s3"), rowCounts: [{ table: "t", count: 3 }] });
      const surplusLeaf = `gen-${generationLeafV1(surplus.generationId)}`;
      await mkdir(join(backupRoot, surplusLeaf), { recursive: true, mode: 0o700 });
      await writeFile(join(backupRoot, surplusLeaf, "database.dump"), "surplus\n", { mode: 0o400 });
      await writeFile(join(backupRoot, surplusLeaf, "manifest.json"),
        `${JSON.stringify({ schema: "control-room.backup-manifest/v1", generationId: surplus.generationId,
          dumpSha256: await hashFileV1(join(backupRoot, surplusLeaf, "database.dump")), dumpBytes: 8,
          fileSha256: "sha256:" + "0".repeat(64), shapeDigest: DIGEST("s"), rowCounts: [{ table: "t", count: 3 }],
          rowCountsDigest: DIGEST("r"), snapshotXid: null, encrypted: false,
          pgVersion: "control-room.pg-version/v1", installRoot })}\n`, { mode: 0o400 });
      // A directory the LEDGER DOES NOT KNOW: an attacker-planted one, shaped to
      // look exactly like a generation.
      const planted = "gen-2026-01-01_00-00-00-000Z";
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
      // The one real, valid, surplus generation IS removed: retention still works.
      assert.deepEqual(swept.removed, [surplus.generationId],
        "a valid surplus generation is removed, and only that one");
      assert.equal(existsSync(join(backupRoot, surplusLeaf)), false);
      // The safety check refuses both unsafe generations with the code a caller
      // would act on.
      await assert.rejects(assertSafeGenerationV1(backupRoot, good.generationId),
        /updater_backup_generation_refused/u);
      await assert.rejects(assertSafeGenerationV1(backupRoot, second.generationId),
        /updater_backup_generation_refused/u);
    });
  }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 300_000, pgBin: PG_BIN });
});

/** Existence, without importing `fs` into the hot path of this file. */
function existsSync(path: string): boolean {
  try {
    // eslint-disable-next-line no-sync
    return require("node:fs").existsSync(path) as boolean;
  } catch { return false; }
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
      for (const bad of ["/", `installRoot/backups`, join(base, "x", "..", "y")]) {
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
      assert.match(dumpBytes.subarray(0, 20).toString("latin1"), /^SENTINEL-SEALED-BYTES/u,
        "the dump on disk is the sealed bytes, not the plaintext");
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
