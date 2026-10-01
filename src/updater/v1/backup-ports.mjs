import { spawn as nodeSpawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lchown, lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { updaterRefuseV1 } from "./contracts.mjs";
import { buildTrustedEnvironment } from "./trusted-runtime.mjs";
import { assertEvidenceReaderV1, pinEvidenceSessionV1, readDumpEvidence, readOwnership, readRowCounts,
  readShapeDigest } from "./backup-evidence.mjs";
import { PostgresBackupStoreV1, generationLeafV1 } from "./backup-store.mjs";
import { UpdaterBackupV1 } from "./backup-runner.mjs";

/**
 * Item 19a's PRODUCTION ports: the real `pg_dump`, the real scratch cluster and
 * the real `pg_restore`, as product code (review backup19b H3.2: they used to
 * exist only inside the test lane, so nothing in the product could run a
 * backup and the rules below were unimplemented).
 *
 * THE RULES THIS FILE IMPLEMENTS, each one the design's:
 *
 *  * R17c, streamed, not staged. `pg_dump` writes to its STDOUT; this process
 *    (root, in production) holds the only descriptor on the dump file, opened
 *    O_CREAT|O_EXCL|O_NOFOLLOW at 0600 inside the root-owned `.inprogress-`
 *    directory, and hashes every byte as it writes it. The child never has a
 *    path under `backups/`.
 *  * The child runs as `_crdb` (`runAs`), not as root, with an environment
 *    built from nothing (`buildTrustedEnvironment`: no PATH, no HOME, no PG*),
 *    in its own process group so a timeout kills the whole of it.
 *  * ONE SNAPSHOT for the dump and its evidence. The reader session opens a
 *    REPEATABLE READ READ ONLY transaction, exports its snapshot, reads the
 *    shape digest and the row counts inside it, and `pg_dump --snapshot=<id>`
 *    dumps that same snapshot. The first version read the counts afterwards on
 *    a separate connection with a hard-coded snapshot id, so on a live install
 *    any write between the two would have failed the backup every night.
 *  * LEAST PRIVILEGE (review backup19b C1). Both the evidence read and
 *    `pg_dump` run as `control_room_backup_reader` (see ddl/0001): read-all and
 *    BYPASSRLS, and nothing that can grant or become anything. The scratch
 *    cluster is restored by a NON-superuser role, so a release's own functions
 *    — CHECK helpers, index expressions, materialised views, all of which run
 *    during a restore — run with no authority in a throwaway cluster, never as
 *    a superuser that could `COPY ... TO PROGRAM`.
 *  * The dump is WHOLE: no `--no-privileges` on the dump (a restore for real
 *    needs the grants). Only the scratch RESTORE skips owners and privileges,
 *    because the scratch cluster has none of the production roles; the verify
 *    compares shape and rows, which do not depend on either.
 *  * R17a, the scratch cluster. Under the backup lock, any `scratch-*` left by
 *    a killed run is stopped and removed first (a SIGKILLed parent cannot stop
 *    its own cluster, and this Mac has 32 SysV segments). Then `initdb` in
 *    `<scratchRoot>/scratch-<leaf>` with its socket inside the data directory
 *    and no TCP listener, the dump streamed into `pg_restore` over STDIN, the
 *    evidence read back, and the cluster stopped and deleted in a `finally`.
 *  * Every child is BOUNDED by a timeout, and every wait on the source is
 *    bounded by `--lock-wait-timeout` and the reader's lock/statement timeouts,
 *    so a release holding a lock cannot hang the backup forever.
 */

export const BACKUP_READER_ROLE_V1 = "control_room_backup_reader";
const SCRATCH_ADMIN_V1 = "crverify_admin";
const SCRATCH_RESTORE_V1 = "crverify_restore";
const SCRATCH_READER_V1 = "crverify_reader";
const SCRATCH_DATABASE_V1 = "restored";
const SCRATCH_PREFIX_V1 = "scratch-";
const SNAPSHOT_ID_V1 = /^[0-9A-Fa-f]{1,16}(-[0-9A-Fa-f]{1,16}){1,2}$/u;
const STDERR_MAX_V1 = 4096;

const DEFAULT_TIMEOUTS_V1 = Object.freeze({ dumpMs: 3_600_000, restoreMs: 3_600_000, clusterMs: 180_000 });
const EVIDENCE_CLOSE_TIMEOUT_MS_V1 = 5_000;

/**
 * Run one child, bounded. `stdin` is a readable stream piped to the child;
 * `stdoutTo` is a writable the child's stdout is piped into. Resolves on exit
 * code 0; anything else — a non-zero exit, a signal, a timeout, a spawn error,
 * a broken pipe — is a refusal carrying `code` and a bounded slice of stderr.
 */
async function runChildV1({ spawnChild, file, args, runAs, timeoutMs, stdin = null, stdoutTo = null, code,
  signal = null }) {
  if (signal?.aborted) throw updaterRefuseV1("updater_backup_cancelled");
  const child = spawnChild(file, args, {
    env: buildTrustedEnvironment(), shell: false, detached: true,
    stdio: [stdin ? "pipe" : "ignore", stdoutTo ? "pipe" : "ignore", "pipe"],
    ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
  });
  let stderr = "", timedOut = false, cancelled = false;
  child.stderr?.on("data", chunk => { if (stderr.length < STDERR_MAX_V1) stderr += String(chunk); });
  // The process GROUP, so a pg_ctl or initdb that forked is killed whole. It is
  // this child's own group (detached), never a pattern.
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
  const cancel = () => { cancelled = true; killGroup(); };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
  const exited = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
  exited.catch(() => {}); // Observed below; this only stops an early pipe failure leaving it unhandled.
  try {
    const flows = [];
    if (stdin) flows.push(pipeline(stdin, child.stdin).catch(error => {
      // The child closing its stdin early is reported by its exit status, not here.
      if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    }));
    if (stdoutTo) flows.push(pipeline(child.stdout, stdoutTo));
    const [{ exitCode, signal }] = await Promise.all([exited, ...flows]);
    if (cancelled || timedOut || exitCode !== 0) {
      const refusal = updaterRefuseV1(cancelled ? "updater_backup_cancelled" : timedOut ? `${code}_timeout` : code);
      refusal.message = `${refusal.code}: exit ${exitCode ?? signal} ${stderr.replace(/\s+/gu, " ").trim()}`.slice(0, 400);
      throw refusal;
    }
  } catch (error) {
    killGroup();
    if (typeof error?.code === "string" && error.code.startsWith("updater_")) throw error;
    const refusal = updaterRefuseV1(code);
    refusal.message = `${code}: ${error?.message ?? error}`.slice(0, 400);
    throw refusal;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

/** A writable that hashes and counts every byte on its way to a descriptor. */
function hashingFileSinkV1(handle) {
  const hash = createHash("sha256");
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk); bytes += chunk.length;
      handle.write(chunk).then(() => callback(), callback);
    },
  });
  return { sink, result: () => ({ bytes, sha256: `sha256:${hash.digest("hex")}` }) };
}

const confQuoteV1 = value => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/**
 * Open an evidence-reading `pg` client and, alongside it, a bounded way to
 * reach that exact backend from the SERVER side on cancellation (see
 * `withAbortableEvidenceClientV1`). A role can always terminate its OWN other
 * session regardless of its privileges — PostgreSQL's signal check is
 * `has_privs_of_role(caller, target)`, which is trivially true when the two
 * sessions share a login — so the second connection reuses the exact same
 * `target`, never a more privileged one.
 */
async function openEvidenceReaderV1(connect, target) {
  const reader = await connect(target);
  reader.on?.("error", () => {});
  const pid = Number((await reader.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0]?.pid);
  const terminateBackend = !Number.isSafeInteger(pid) ? async () => {} : async () => {
    const admin = await connect(target);
    admin.on?.("error", () => {});
    try {
      // The `timeout` argument (PostgreSQL 17) makes this wait for the
      // backend to actually be gone, not merely for the signal to be sent, so
      // cancellation cannot return before the server itself agrees the
      // reader session is closed.
      await admin.query("SELECT pg_catalog.pg_terminate_backend($1, $2)", [pid, EVIDENCE_CLOSE_TIMEOUT_MS_V1]);
    } finally { await admin.end().catch(() => {}); }
  };
  return { reader, terminateBackend };
}

/**
 * Own a PostgreSQL evidence client for the duration of one operation.
 * Stop must not merely reject the active query: its backend is a scarce
 * production-reader session too. One shared close promise owns `end()` and an
 * explicit socket destroy, and the operation cannot return until that close
 * has either completed or reached its bounded hard-close fallback.
 *
 * `terminateBackend` is the SERVER-side half of that close. Destroying this
 * process's own socket does nothing for a backend asleep in the lock
 * manager: PostgreSQL only notices a gone client when the backend next tries
 * to send or receive, and a blocked lock wait does neither until the lock is
 * granted. `terminateBackend` is a caller-supplied, best-effort, bounded
 * callback that reaches the backend from the SERVER side instead (a second
 * session asking `pg_terminate_backend`), and cancellation awaits it the same
 * way it awaits `client.end()`.
 */
export async function withAbortableEvidenceClientV1(client, signal, operation, beforeEnd = async () => {},
  closeTimeoutMs = EVIDENCE_CLOSE_TIMEOUT_MS_V1, terminateBackend = async () => {}) {
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1)
    throw updaterRefuseV1("updater_backup_ports_refused");
  let cancelled = false;
  let closePromise;
  const destroy = () => { try { client.connection?.stream?.destroy?.(); } catch {} };
  const close = force => {
    if (force) destroy();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let timer;
      const timedOut = new Promise(resolvePromise => {
        timer = setTimeout(() => { destroy(); resolvePromise(); }, closeTimeoutMs);
      });
      try {
        const ending = Promise.resolve().then(() => client.end()).catch(() => { destroy(); });
        const terminating = force ? Promise.resolve().then(terminateBackend).catch(() => {}) : Promise.resolve();
        await Promise.race([Promise.all([ending, terminating]), timedOut]);
      } finally { clearTimeout(timer); }
    })();
    return closePromise;
  };
  const cancel = () => {
    cancelled = true;
    // Hard-close now so the active SQL rejects; the finally below awaits this
    // same promise, so returning cancellation also proves cleanup was awaited,
    // including the server-side termination `close(true)` now also starts.
    void close(true);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (cancelled) throw updaterRefuseV1("updater_backup_cancelled");
    return await operation(client);
  } catch (error) {
    if (cancelled || signal?.aborted) throw updaterRefuseV1("updater_backup_cancelled");
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!cancelled && !signal?.aborted) {
      let cleanupTimer;
      const cleanupTimedOut = new Promise(resolvePromise => {
        cleanupTimer = setTimeout(resolvePromise, closeTimeoutMs, false);
      });
      const cleaned = await Promise.race([
        Promise.resolve().then(() => beforeEnd(client)).then(() => true, () => true), cleanupTimedOut,
      ]);
      clearTimeout(cleanupTimer);
      if (!cleaned) destroy();
    }
    await close(cancelled || signal?.aborted);
  }
}

/**
 * The production ports for `UpdaterBackupV1`.
 *
 * @param {object} options
 * @param {string} options.pgBin       the runtime's PostgreSQL `bin` directory (absolute)
 * @param {{host: string, port?: number, database: string}} options.source  the live cluster's socket and database
 * @param {(target: {host: string, port?: number, user: string, database: string}) => Promise<any>} options.connect
 *        opens a `pg` client; the source reader and the scratch logins go through it
 * @param {string} options.scratchRoot where `scratch-<leaf>` clusters are created (absolute)
 * @param {{uid: number, gid: number} | null} [options.runAs] the account children run as (`_crdb`)
 * @param {Function} [options.spawnChild] `child_process.spawn`-shaped; production leaves the default
 * @param {number} [options.scratchPort] names the scratch cluster's socket file only — it has no TCP listener
 */
export function postgresBackupPortsV1({ pgBin, source, connect, scratchRoot, runAs = null,
  spawnChild = nodeSpawn, timeouts = DEFAULT_TIMEOUTS_V1, seal = null, scratchPort = 5432 }) {
  for (const path of [pgBin, scratchRoot]) {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
      throw updaterRefuseV1("updater_backup_ports_refused");
  }
  if (!source || typeof source.host !== "string" || !isAbsolute(source.host)
      || typeof source.database !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/u.test(source.database)
      || (source.port !== undefined && !Number.isSafeInteger(source.port)) || typeof connect !== "function"
      || !Number.isSafeInteger(scratchPort) || scratchPort < 1024 || scratchPort > 65535)
    throw updaterRefuseV1("updater_backup_ports_refused");
  const bin = name => join(pgBin, name);
  const child = (file, args, extra) => runChildV1({ spawnChild, file, args, runAs, ...extra });
  const portArgs = source.port === undefined ? [] : ["--port", String(source.port)];

  /** Stop and remove every scratch cluster a killed run left behind. Called
   * only under the backup lock, so none of them is in use. */
  const removeScratchV1 = async (path, signal = null) => {
    if (runAs) await child("/bin/rm", ["-rf", path], { timeoutMs: timeouts.clusterMs,
      code: "updater_backup_scratch_remove_failed", signal });
    else await rm(path, { recursive: true, force: true, maxRetries: 2 });
  };

  async function reapStaleScratchV1(signal = null) {
    let directory;
    try { directory = await opendir(scratchRoot); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for await (const item of directory) {
      if (!item.name.startsWith(SCRATCH_PREFIX_V1)) continue;
      const path = join(scratchRoot, item.name);
      const entry = await lstat(path).catch(() => null);
      if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
      if (await lstat(join(path, "postmaster.pid")).catch(() => null)) {
        await child(bin("pg_ctl"), ["-D", path, "-m", "immediate", "-w", "-t", "30", "stop"],
          { timeoutMs: timeouts.clusterMs, code: "updater_backup_scratch_stop_failed", signal }).catch(() => {});
      }
      await removeScratchV1(path, signal);
    }
  }

  return Object.freeze({
    sealBound: typeof seal === "function",
    async dump({ path, signal }) {
      const { reader, terminateBackend } = await openEvidenceReaderV1(connect, { host: source.host,
        port: source.port, user: BACKUP_READER_ROLE_V1, database: source.database });
      return withAbortableEvidenceClientV1(reader, signal, async reader => {
        await pinEvidenceSessionV1(reader);
        await assertEvidenceReaderV1(reader);
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const snapshot = String((await reader.query("SELECT pg_catalog.pg_export_snapshot() AS snapshot"))
          .rows[0]?.snapshot ?? "");
        if (!SNAPSHOT_ID_V1.test(snapshot)) throw updaterRefuseV1("updater_backup_snapshot_refused");
        // The evidence, INSIDE the exported snapshot, before the dump starts.
        const evidence = { shapeDigest: await readShapeDigest(reader), rowCounts: await readRowCounts(reader),
          ownership: await readOwnership(reader), snapshotXid: snapshot };
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0), 0o600);
        let written;
        try {
          const { sink, result } = hashingFileSinkV1(handle);
          await child(bin("pg_dump"), ["--format=custom", `--snapshot=${snapshot}`, "--lock-wait-timeout=60000",
            "--no-password", "--host", source.host, ...portArgs, "--username", BACKUP_READER_ROLE_V1,
            "--dbname", source.database], { timeoutMs: timeouts.dumpMs, stdoutTo: sink,
            code: "updater_backup_dump_failed", signal });
          await handle.sync();
          written = result();
        } finally { await handle.close(); }
        return { bytes: written.bytes, sha256: written.sha256, evidence };
      }, async reader => reader.query("ROLLBACK"), EVIDENCE_CLOSE_TIMEOUT_MS_V1, terminateBackend);
    },

    async restoreVerify({ generationId, dumpPath, signal }) {
      await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
      await reapStaleScratchV1(signal);
      const dataDir = join(scratchRoot, `${SCRATCH_PREFIX_V1}${generationLeafV1(generationId)}`);
      await mkdir(dataDir, { recursive: false, mode: 0o700 });
      if (runAs) await lchown(dataDir, runAs.uid, runAs.gid);
      let started = false;
      try {
        await child(bin("initdb"), ["-D", dataDir, "-U", SCRATCH_ADMIN_V1, "-A", "trust", "--no-sync",
          "-E", "UTF8", "--no-locale"], { timeoutMs: timeouts.clusterMs, code: "updater_backup_scratch_failed", signal });
        // A throwaway cluster: socket inside its own 0700 data directory, no TCP
        // listener, and no durability (it exists to prove the dump restores).
        const settings = `\nunix_socket_directories = ${confQuoteV1(dataDir)}\nlisten_addresses = ''\n`
          + `port = ${scratchPort}\n`
          + "fsync = off\nfull_page_writes = off\nsynchronous_commit = off\n"
          + "max_connections = 20\nshared_buffers = 32MB\n";
        if (runAs) await child("/usr/bin/tee", ["-a", join(dataDir, "postgresql.conf")], {
          timeoutMs: timeouts.clusterMs, code: "updater_backup_scratch_config_failed",
          stdin: Readable.from([settings]), signal });
        else {
          const conf = await open(join(dataDir, "postgresql.conf"), constants.O_WRONLY | constants.O_APPEND
            | (constants.O_NOFOLLOW ?? 0));
          try { await conf.write(settings); } finally { await conf.close(); }
        }
        started = true;
        await child(bin("pg_ctl"), ["-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "-t", "60", "start"],
          { timeoutMs: timeouts.clusterMs, code: "updater_backup_scratch_failed", signal });
        // The scratch superuser runs FIXED statements only, before any dump byte
        // is in the cluster. The restore and the read run as the two
        // non-superusers it creates.
        const admin = await connect({ host: dataDir, port: scratchPort, user: SCRATCH_ADMIN_V1, database: "postgres" });
        admin.on?.("error", () => {});
        try {
          // BYPASSRLS on the restoring role too, so a release table with FORCE
          // ROW LEVEL SECURITY neither runs its policy (release code) during the
          // load nor makes the restore fail: the data goes back as dumped.
          await admin.query(`CREATE ROLE ${SCRATCH_RESTORE_V1} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION BYPASSRLS`);
          await admin.query(`CREATE ROLE ${SCRATCH_READER_V1} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION BYPASSRLS`);
          await admin.query(`GRANT pg_read_all_data TO ${SCRATCH_READER_V1}`);
          await admin.query(`CREATE DATABASE ${SCRATCH_DATABASE_V1} OWNER ${SCRATCH_RESTORE_V1}`);
        } finally { await admin.end().catch(() => {}); }
        // The dump is streamed to pg_restore's STDIN from this process's own
        // descriptor, so the child never needs a path to the root-held file.
        const dump = await open(dumpPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          await child(bin("pg_restore"), ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction",
            "--no-password", "--host", dataDir, "--port", String(scratchPort), "--username", SCRATCH_RESTORE_V1,
            "--dbname", SCRATCH_DATABASE_V1],
          { timeoutMs: timeouts.restoreMs, stdin: dump.createReadStream({ autoClose: false }),
            code: "updater_backup_verify_failed", signal });
        } finally { await dump.close(); }
        const { reader, terminateBackend } = await openEvidenceReaderV1(connect, { host: dataDir, port: scratchPort,
          user: SCRATCH_READER_V1, database: SCRATCH_DATABASE_V1 });
        return await withAbortableEvidenceClientV1(reader, signal, async reader => {
          const { shapeDigest, rowCounts } = await readDumpEvidence(reader);
          return { shapeDigest, rowCounts };
        }, async () => {}, EVIDENCE_CLOSE_TIMEOUT_MS_V1, terminateBackend);
      } finally {
        if (started) await child(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
          { timeoutMs: timeouts.clusterMs, code: "updater_backup_scratch_stop_failed" }).catch(() => {});
        await removeScratchV1(dataDir);
      }
    },

    // Sealing needs a key custody design that does not exist yet. Unbound is a
    // REFUSAL, so a policy that requires a seal (a root outside the install
    // root) fails loudly instead of writing a plaintext dump to a drive with
    // ownership disabled. The in-root production default does not seal.
    async seal(input) {
      if (typeof seal === "function") return seal(input);
      throw updaterRefuseV1("updater_backup_seal_unbound");
    },

    async writeManifest({ path, manifest }) {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o400);
      try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
    },
  });
}

/** The uid/gid of a local service account, read with the system's own `id`. */
export async function serviceAccountV1(name, { execFileAsync = promisify(execFile) } = {}) {
  if (!/^_?[a-z][a-z0-9_]{0,31}$/u.test(name)) throw updaterRefuseV1("updater_backup_account_refused");
  const env = buildTrustedEnvironment();
  const [uid, gid] = await Promise.all(["-u", "-g"].map(async flag =>
    Number(String((await execFileAsync("/usr/bin/id", [flag, name], { env, timeout: 10_000 })).stdout).trim())));
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1)
    throw updaterRefuseV1("updater_backup_account_refused");
  return Object.freeze({ uid, gid });
}

/**
 * THE DEFAULT PATH: the nightly backup exactly as `startUpdaterV1` composes it
 * in production, with the real store, the real ports and the in-root policy.
 *
 * `connect` opens a peer-authenticated `pg` client on the install's socket; the
 * deployer's second session (the backup lock) and the reader both go through it.
 * As root, children drop to `_crdb`; a non-root caller (the test lane) runs them
 * as itself.
 */
/** @param {{root: string, client: any, connect: Function,
 * source: {host: string, port?: number, database: string}, pgBin?: string | null,
 * runAs?: {uid: number, gid: number} | null, spawnChild?: Function, timeouts?: any,
 * ownerUid?: number | null, scratchPort?: number}} options */
export async function createNightlyBackupV1(options) {
  const { root, client, connect, source, pgBin = null, runAs,
    spawnChild, timeouts, ownerUid = null, scratchPort = 5432 } = options;
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root)
    throw updaterRefuseV1("updater_backup_ports_refused");
  const store = new PostgresBackupStoreV1(client, {
    connectLock: () => connect({ host: source.host, port: source.port, user: "control_room_deployer",
      database: source.database }) });
  await store.initialize();
  const account = runAs !== undefined ? runAs
    : (typeof process.geteuid === "function" && process.geteuid() === 0 ? await serviceAccountV1("_crdb") : null);
  const ports = postgresBackupPortsV1({ pgBin: pgBin ?? join(root, "runtime/pg-current/bin"), source, connect,
    scratchRoot: join(root, "pg"), runAs: account, spawnChild, timeouts, scratchPort });
  return new UpdaterBackupV1({ store, ports, policy: Object.freeze({ installRoot: root,
    backupRoot: join(root, "backups"), seal: false, freeSpaceFloorBytes: 256 * 1024 * 1024,
    ...(ownerUid === null ? {} : { ownerUid }) }) });
}
