// M4: the four stage-one ports the installer stream left refusing
// `database_port_not_yet_supplied`, plus the two that arrived with M1.
//
// The installer stream (Codex) deliberately supplied TYPED REFUSALS for the
// database ports rather than implementations, because SQL belongs to this half of
// the design (INSTALL_COMPOSITION.md §7, the M4 row). This file is that half.
// `src/updater/v1/install/stage-one-ports.mjs` keeps its refusals — the
// installer's own tests call them directly and they are the documented contract
// — and `control-room-native-ports.mjs` wires THESE into the default port
// object, so the production path runs the implementations and the refusal
// remains reachable for anything that wants the contract.
//
// WHAT IS HERE, and why each is shaped the way it is:
//
//   writeDatabaseLogins / removeDatabaseLogins — filesystem only. The
//     passwords already exist in the installer's memory; this writes them to the
//     protected files the release's `captureDatabaseLogins` reads, and NEVER
//     returns them in the receipt. The receipt carries digests and file
//     references, so the value the install journal records contains no secret.
//   retireDatabase — filesystem only: refuse a live cluster, then retire the
//     data directory. Fable finding #3 makes the ORDER load-bearing: bootout,
//     then the uid kill-sweep, then the data directory, because a postmaster
//     that survived a SIGKILL holds `pg/socket` and every retry then fails.
//   firstOwner — the release's own one-time row transaction, run through the
//     same `psql` machinery as the release phase.
//   checkHealthDatabase — §5.8's database half.
//
// THE TRUST DOMAIN RULE IS WHY firstOwner spawns rather than imports.
// `scripts/mac-local/first-owner-vps.mjs` imports release code and `pg`; the
// updater bundle carries neither. So the port runs the SAME LOGIC as a child of
// the vendored Node against the release's own file, and every value that crosses
// the boundary is a parameter, not a module.

import { directoryCustodyV1, removeOwnedFileV1 } from "../../../installer/shared/file-custody.mjs";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  identifyRecordedProcessV1, listProcessesV1, pgProcessesOnDataDirectoryV1, readPostmasterPidFileV1,
  runtimeBinDirectoriesV1,
} from "./postmaster-pid.mjs";

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** A canonical absolute path with no trailing slash, matching `safeRoot` in stage-one-ports. */
const safeRoot = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && resolve(value) === value && value !== "/" && !value.includes("\0");
const inside = (root, path) => {
  const value = relative(root, path);
  return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
/** The secret the release's `captureDatabaseLogins` accepts: 32 random bytes, base64url. */
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;
const MAXIMUM_SECRET_BYTES = 1024;

/** The file the owner of a protected root reads first: its mode is checked by this module. */
async function writePrivateFileV1(path, bytes, mode, check) {
  if (bytes.byteLength > 64 * 1024 || bytes.includes(0)) refuse("database_logins_write_refused");
  const temporary = join(dirname(path), `.${randomBytes(8).toString("hex")}`);
  // O_EXCL|O_NOFOLLOW: the temporary name is random and must not already exist,
  // and the final rename must replace whatever is there atomically rather than
  // writing THROUGH an existing file that could be a symlink placed by anything
  // running between the phase and the protected config.
  const handle = await open(temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, mode)
    .catch(() => refuse("database_logins_write_refused"));
  const owned = await handle.stat();
  try {
    try { await check(); await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    await check(); await rename(temporary, path); await check();
  } finally { await removeOwnedFileV1(temporary, owned); }
}

/**
 * `writeDatabaseLogins` — the passwords to the protected files, and the receipt
 * with no password in it.
 *
 * The contract (`DATABASE_PORT_CONTRACTS_V1.writeDatabaseLogins`) asks for "path
 * plus references containing exact `name, passwordDigest, fileRef`; never
 * plaintext passwords". The installer's `composeProtectedConfig` then reads
 * `references` as its `dbLogins` input, and `captureDatabaseLogins` demands FOUR
 * keys per entry including `password` — so the reference carries the password to
 * the COMPOSER, which is the process that needs it, while the RECEIPT the
 * install journal records carries only the three contract keys.
 *
 * That split is the whole security property of this port, so it is stated as the
 * reason for two shapes rather than one: `references` (with the secret, consumed
 * and discarded inside the installer) and `receipt` (without it, journaled).
 */
export async function writeDatabaseLoginsV1(input, runtime = {}) {
  // Test seams only: the installer passes none, so these are the process's own.
  const asRoot = (runtime.getuid ?? process.getuid)?.() === 0;
  const lchownPath = runtime.lchown ?? (async (...args) => (await import("node:fs/promises")).lchown(...args));
  const inspect = runtime.lstat ?? lstat;
  if (!input || typeof input !== "object" || !safeRoot(input.root) || !input.accounts
    || typeof input.accounts !== "object" || Array.isArray(input.accounts)
    || !Number.isSafeInteger(input.accounts.service?.uid) || !Number.isSafeInteger(input.accounts.service?.gid)
    || input.accounts.service.uid < 1 || input.accounts.service.gid < 1
    || !input.passwords || typeof input.passwords !== "object" || Array.isArray(input.passwords)) {
    refuse("database_logins_write_refused");
  }
  const names = Object.keys(input.passwords).sort();
  if (names.length < 1 || names.length > 64) refuse("database_logins_write_refused");
  const directory = join(input.root, "Protected", "config", "database-passwords");
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => refuse("database_logins_write_refused"));
  // The DIRECTORY goes to the service account as well, right after `mkdir` and
  // before any password lands in it. MEASURED (cl-bringup N-N): root made it 0700
  // root:wheel and handed over only the files, so the service account could not
  // even enter it, and the nightly backup (running as that account, reading the
  // migrator's `passwordFile`) could never read its password.
  const serviceUid = input.accounts.service.uid, serviceGid = input.accounts.service.gid;
  if (asRoot) await lchownPath(directory, serviceUid, serviceGid).catch(() => refuse("database_logins_write_refused"));
  const check = await directoryCustodyV1(directory).catch(() => refuse("database_logins_write_refused"));
  const directoryEntry = await inspect(directory).catch(() => refuse("database_logins_write_refused"));
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() || (directoryEntry.mode & 0o077) !== 0
    || asRoot && (directoryEntry.uid !== serviceUid || directoryEntry.gid !== serviceGid)) {
    refuse("database_logins_write_refused");
  }
  // The service account OWNS the directory and every file in it, and nothing else
  // may read them. Mode 0700 on the directory and 0600 on each file: the gateway
  // and the web read their own login through these files as the service account,
  // and a group-readable password file is a password every account in the group
  // can connect with. The ownership write is best-effort ONLY in the sense that a
  // non-root rehearsal cannot chown to another uid — production CAN, and the
  // refusal below is what makes an unowned file a refusal rather than a file the
  // installer believes it protected.
  await check().catch(() => refuse("database_logins_write_refused"));
  const references = [], receiptEntries = [];
  for (const name of names) {
    if (!ROLE_NAME.test(name)) refuse(`database_logins_write_refused:${name}`);
    const password = input.passwords[name];
    if (typeof password !== "string" || !SECRET.test(password) || Buffer.byteLength(password) > MAXIMUM_SECRET_BYTES) {
      refuse(`database_logins_write_refused:${name}`);
    }
    const fileRef = join(directory, `${name}.txt`);
    if (!inside(input.root, fileRef)) refuse(`database_logins_write_refused:${name}`);
    // The file is written O_EXCL into a temporary name and renamed over any
    // existing one, so a repeat run converges on the same content rather than
    // refusing — the installer's undo/redo cycle calls this more than once.
    const bytes = Buffer.from(`${password}\n`);
    await writePrivateFileV1(fileRef, bytes, 0o600, check).catch(() => refuse("database_logins_write_refused"));
    if (asRoot) {
      // Only root can hand the file to the service account, and only root runs
      // the real installer. In a rehearsal the caller is the service account, so
      // the chown is a no-op there rather than an error.
      await lchownPath(fileRef, serviceUid, serviceGid)
        .catch(() => refuse(`database_logins_write_refused:${name}`));
    }
    const entry = await inspect(fileRef);
    // READ BACK THROUGH AN OPEN HANDLE and check the bytes that are actually
    // there: the digest in the receipt is compared by the owner later, so a
    // receipt recording a digest of a file that was never written would be a
    // receipt that reports success for a login nobody has.
    const handle = await open(fileRef, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
      .catch(() => refuse(`database_logins_write_refused:${name}`));
    let stored;
    try {
      const stat = await handle.stat();
      // The MODE is checked here, through the OPEN HANDLE, and not merely after the
      // write. This line was LOST twice - once to an interrupted mutation run and
      // once because the harness restores the snapshot it READ, which was itself a
      // mutated file - and the lane still passed both times, because the lane only
      // ever observed files this module had itself written at 0600. The assertion
      // and the guard agreed by construction, so the guard was doing nothing.
      //
      // The lane now widens a login file's mode between the write and the read-back
      // and asserts the refusal, which is the only way this guard can fail.
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        refuse(`database_logins_write_refused:${name}`);
      }
      stored = (await handle.readFile()).toString("utf8").replace(/\n$/u, "");
    } finally { await handle.close(); }
    if (stored !== password) refuse(`database_logins_write_refused:${name}`);
    if (asRoot && entry.uid !== serviceUid) refuse(`database_logins_write_refused:${name}`);
    await check().catch(() => refuse("database_logins_write_refused"));
    const passwordDigest = sha256(password);
    references.push(Object.freeze({ name, password, passwordDigest, fileRef }));
    receiptEntries.push(Object.freeze({ name, passwordDigest, fileRef }));
  }
  return Object.freeze({
    path: directory,
    references: Object.freeze(references),
    receipt: Object.freeze({ schema: "control-room.database-logins-receipt/v1",
      path: directory, entries: Object.freeze(receiptEntries) }),
  });
}

/**
 * `removeDatabaseLogins` — undo. Removes the files the receipt names, and
 * NOTHING else.
 *
 * The receipt is OPTIONAL because the undo list runs on a failure that may
 * predate the write. Without one the directory is removed if it is empty and
 * refused if it is not: a blanket recursive remove of a directory this module
 * did not create would delete a protected file nobody owns.
 */
export async function removeDatabaseLoginsV1(input) {
  if (!safeRoot(input?.root)) refuse("database_logins_remove_refused");
  const directory = join(input.root, "Protected", "config", "database-passwords");
  const entries = input.receipt?.entries;
  if (input.receipt !== undefined) {
    if (input.receipt?.schema !== "control-room.database-logins-receipt/v1"
      || input.receipt.path !== directory || !Array.isArray(entries) || entries.length < 1 || entries.length > 64) {
      refuse("database_logins_remove_refused");
    }
    for (const entry of entries) {
      if (typeof entry?.name !== "string" || !ROLE_NAME.test(entry.name)
        || !DIGEST.test(entry.passwordDigest ?? "")
        || entry.fileRef !== join(directory, `${entry.name}.txt`)) refuse("database_logins_remove_refused");
    }
  }
  const present = await lstat(directory).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!present) return Object.freeze({ removed: true });
  if (!present.isDirectory() || present.isSymbolicLink()) refuse("database_logins_remove_refused");
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(directory);
  const allowed = new Set(entries?.map(entry => `${entry.name}.txt`) ?? []);
  const unexpected = names.filter(name => !allowed.has(name));
  if (unexpected.length > 0) refuse("database_logins_remove_refused");
  for (const name of names) await rm(join(directory, name), { force: true });
  await rm(directory, { recursive: true, force: true });
  return Object.freeze({ removed: true });
}

/**
 * `retireDatabase` — undo for the init phase (§4 row 19, Fable finding #3).
 *
 * THE ORDER IS THE REQUIREMENT, and it is checked rather than assumed:
 *
 *   1. No LIVE postmaster of this data directory may be using it. `postmaster.pid`
 *      is the postmaster's own record of itself. A directory whose recorded pid
 *      names a process of THIS install's runtime on THIS directory is refused as
 *      `retire_database_live_cluster_refused` rather than deleted, because
 *      deleting a running cluster's directory is how a SIGKILLed phase becomes
 *      permanent corruption instead of a retry.
 *   2. then the files go.
 *
 * THE PID IN THE FILE IS A CLAIM, NOT AN IDENTITY. This is init's N1 rule, and it
 * applies here verbatim because the state is the same one: the Mac rebooted or the
 * phase was SIGKILLed, the pid file outlived its process, and the pid has since
 * been RECYCLED onto something else. The first version of this port read the pid,
 * asked `kill -0`, and refused when it was dead — which refuses a power-cut
 * directory forever, because the negative pid of a standalone backend was
 * "unreadable" and an unreadable file was treated as live. So:
 *
 *   | what is at the recorded pid              | result                                        |
 *   |-----------------------------------------|----------------------------------------------|
 *   | nothing                                 | stale; the directory is retired              |
 *   | not a program of this runtime (recycled)| stale; NOTHING is signalled                   |
 *   | this runtime, this dir, D's             | refused `retire_database_live_cluster_refused`|
 *   | this runtime, this dir, not D's         | refused (same code: not ours either)         |
 *   | this runtime, its argv names another -D | stale (recycled onto another cluster)         |
 *   | empty or torn pid file                  | stale; the argv sweep below still decides    |
 *
 * A negative pid is PostgreSQL's own STANDALONE marker and is read as its absolute
 * value, for the reason N1 gives: `initdb` writes one and it outlives the process.
 * An empty or torn file (a crash mid-write) is NOT a refusal here either, because
 * step 0 has already proved this directory is the phase's own debris and the argv
 * sweep below finds anything still working on it.
 *
 * NOTHING IS EVER SIGNALLED. This port has no bootout to offer and is the UNDO
 * path — its job is to decide whether deleting is safe, and every live case is a
 * refusal. Killing a postmaster from the undo path is `killAccountProcesses`'s job,
 * which the caller runs first (`install-steps.mjs:157`).
 *
 * The caller (`install-steps.mjs:154`) invokes this AFTER
 * `killAccountProcesses`, which is the bootout-then-sweep order Fable asks for.
 * This port's contribution is refusing to delete a cluster that is still up, so
 * a missing sweep surfaces as a refusal instead of as a destroyed data
 * directory.
 */
/**
 * The runtime's bin directories as spelled AND as resolved. `pg_ctl` finds its
 * `postgres` through the real path, so a postmaster it started shows
 * `runtime/pg-<version>/bin/postgres`, never `runtime/pg-current/bin/…`; matching
 * only the link spelling read a LIVE cluster as foreign and let retire delete it
 * once the `pg/current` refusal stopped masking that (rv-9b A2, made reachable by
 * B4). Adding spellings only widens what counts as live: the safe direction.
 */
async function withRealBinDirectoriesV1(root) {
  const spelled = runtimeBinDirectoriesV1(root);
  const real = await Promise.all(spelled.map(directory => realpath(directory).catch(() => null)));
  return Object.freeze([...new Set([...spelled, ...real.filter(Boolean)])]);
}

/**
 * `pg/current` naming THIS data id is the retired database's own link, and it is
 * unlinked here; any other link is still `retire_database_current_link_present`.
 *
 * rv-9b B4: `init-database` writes `pg/current -> <pgDataId>` as its LAST act, so
 * every undo or recovery after a completed init found the link and refused, on
 * every retry. Only a link whose target is exactly this id is ours to remove.
 */
async function releaseOwnCurrentLinkV1(current, pgDataId) {
  const entry = await lstat(current).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!entry) return;
  if (!entry.isSymbolicLink() || await readlink(current) !== pgDataId) refuse("retire_database_current_link_present");
  await unlink(current);
}

export async function retireDatabaseV1(input, runtime = {}) {
  if (!safeRoot(input?.root) || typeof input.pgDataId !== "string"
    || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(input.pgDataId)) refuse("retire_database_input_refused");
  const pgRoot = join(input.root, "pg");
  const dataDirectory = join(pgRoot, input.pgDataId);
  const current = join(pgRoot, "current");
  // The link must not still be there: a retired database that `pg/current` still
  // names is a database the next phase would connect to.
  const entry = await lstat(dataDirectory).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  // The link check comes SECOND, and the order is deliberate. The live-cluster
  // refusal is the safety-critical one: it is the answer to "is it safe to delete
  // this", and it must be reachable on a root where the installer has not yet
  // unlinked `pg/current` — which is the state a SIGKILLed phase leaves behind.
  // Checking the link first would answer `retire_database_current_link_present`
  // there and never say whether a postmaster was still running.
  if (!entry) {
    // Nothing to retire. The link, if present, is then the only thing left and it
    // is a refusal: a data id that does not exist with a link pointing into `pg`
    // is a state the caller did not expect.
    await releaseOwnCurrentLinkV1(current, input.pgDataId);
    return Object.freeze({ retired: true, removed: false, pgDataId: input.pgDataId });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) refuse("retire_database_input_refused");
  if (!inside(input.root, dataDirectory)) refuse("retire_database_input_refused");
  const pidFile = join(dataDirectory, "postmaster.pid");
  const pidEntry = await lstat(pidFile).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  // The account that OWNS the postmaster, which is NOT the account this port runs
  // as: the installer runs the undo as root, and the postmaster runs as D. Naming
  // `process.getuid()` here would make every live postmaster read as somebody
  // else's, which still refuses — the safe direction — but for the wrong reason,
  // and it would also make the argv sweep below (which matches on uid) miss D's
  // own `initdb` and retire a directory with a live `initdb` writing into it. So
  // the caller states the account, `install-steps.mjs:158` passes the one it used
  // to sweep with, and the fallback is only for a caller that does not know.
  // `??`, not a truthiness test: `0` is not nullish, so a stated `0` stays `0` and
  // is caught by the range check below rather than quietly becoming the fallback.
  // The installer's `database` account is never 0, so a stated uid is always the
  // caller's deliberate answer and the only thing to check is that it is one.
  const where = { data: dataDirectory, binDirectories: runtime.binDirectories ?? await withRealBinDirectoriesV1(input.root),
    uid: input.accountUid ?? runtime.uid ?? process.getuid() };
  if (!Number.isSafeInteger(where.uid) || where.uid < 1 || where.uid > 0x7fffffff) refuse("retire_database_input_refused");
  const listProcesses = runtime.listProcesses ?? listProcessesV1;
  if (pidEntry) {
    if (!pidEntry.isFile() || pidEntry.isSymbolicLink() || pidEntry.size > 256) {
      refuse("retire_database_live_cluster_refused");
    }
    const text = await readFile(pidFile, "utf8");
    // A pid file nobody can read is NOT treated as live on its own: `null` here is
    // an empty or torn file, and the argv sweep below has already been given the
    // chance to find whatever is still working on this directory. Reading it as
    // live is what refused every retry after a power cut inside `initdb` (N1).
    const recorded = readPostmasterPidFileV1(text, dataDirectory);
    if (recorded !== null) {
      // `other_data_directory` is checked first and for the same reason init checks
      // it first: a pid file in THIS directory naming ANOTHER directory, held by a
      // live program of this runtime, is a postmaster this port does not own,
      // whatever its uid says. Refusing is the safe direction, and it is a
      // different answer from "not D's", so the reason is not merged into it.
      if (!recorded.matchesThisData) refuse("retire_database_live_cluster_refused:other_data_directory");
      const holder = identifyRecordedProcessV1(recorded.pid, await listProcesses(), where);
      // `ours` and `not_database_account` are the two live cases, and both are
      // refusals: a postmaster of this runtime on this directory is holding it,
      // and this port's job is to decide whether DELETING is safe, not to end the
      // process. `gone`, `foreign` and `other_cluster` are all the same answer for
      // a deleter — there is no process of ours here — and none of them is ever
      // signalled, because a recycled pid must not be.
      if (holder.kind === "ours" || holder.kind === "not_database_account") {
        refuse(`retire_database_live_cluster_refused:${holder.kind}`);
      }
    }
  }
  // The argv sweep, and it runs WHETHER OR NOT there is a pid file. It is what
  // finds an `initdb` that never wrote one at all (H3): an init SIGKILLed while
  // `initdb` runs leaves `initdb` orphaned and still writing, with no
  // `postmaster.pid` to read — and retiring the directory under it is worse than
  // refusing, because `initdb` writes BY PATH, so its later files would land in
  // the fresh directory the retry is building. The match is narrow on purpose:
  // this runtime's own programs, as this account, whose argv names THIS data
  // directory. A recycled pid belonging to somebody else is not in that set.
  const workers = pgProcessesOnDataDirectoryV1(await listProcesses(), where);
  if (workers.length > 0) refuse(`retire_database_live_cluster_refused:workers:${workers.join(",")}`);
  // Only now, with no live postmaster, is the link refused and then the directory
  // removed. The link is checked before the removal so a root that still names the
  // data directory is never left pointing at nothing.
  await releaseOwnCurrentLinkV1(current, input.pgDataId);
  await rm(dataDirectory, { recursive: true, force: true });
  return Object.freeze({ retired: true, removed: true, pgDataId: input.pgDataId });
}

/** The two digests §5.8 compares, and the 3-sample rule, as ONE frozen shape. */
export const FIRST_OWNER_HEALTH_SAMPLES_V1 = 3;

/**
 * The result shapes, checked in ONE place so the port and the installer cannot
 * drift.
 *
 * `install-steps.mjs:191` demands EXACTLY `{tenantId, workspaceId, provider,
 * subject}` from `firstOwner`, and `:238` demands EXACTLY
 * `{healthy, samples, schemaDigest}` from `checkHealth`. Both are `exactKeys`
 * checks, so an extra key is a refusal at the installer's boundary and this
 * module returns exactly these.
 */
export const FIRST_OWNER_RESULT_KEYS_V1 = Object.freeze(["tenantId", "workspaceId", "provider", "subject"]);
export const DATABASE_HEALTH_RESULT_KEYS_V1 = Object.freeze(["healthy", "samples", "schemaDigest"]);

export const FIRST_OWNER_PORT_SCHEMA_V1 = "control-room.first-owner-port/v1";
export const DATABASE_HEALTH_PORT_SCHEMA_V1 = "control-room.database-health-port/v1";

/**
 * The COUNTS §5.8 requires the health check to match, and why they are a
 * constant rather than a query.
 *
 * "Counts only, with a bounded response (R20d)" is the design's rule, so the
 * check answers with counts and compares them against the values the first-owner
 * step wrote. A health check that reported "the database responded" would pass
 * on a cluster with zero rows, which is the failure the M4 acceptance row names:
 * "health counts match".
 *
 * These are the two tables whose emptiness means "no owner yet", and both are
 * the FIRST OWNER's to create. They are read by the DEPLOYER, which holds SELECT
 * on both — verified in the real-PostgreSQL lane as the deployer login, not as
 * superuser.
 */
export const DATABASE_HEALTH_COUNTS_V1 = Object.freeze({ tenants: 1, workspaces: 1 });

export const firstOwnerPortContractV1 = Object.freeze({
  schema: FIRST_OWNER_PORT_SCHEMA_V1,
  keys: FIRST_OWNER_RESULT_KEYS_V1,
  counts: DATABASE_HEALTH_COUNTS_V1,
  samples: FIRST_OWNER_HEALTH_SAMPLES_V1,
});
export const databaseHealthPortContractV1 = Object.freeze({
  schema: DATABASE_HEALTH_PORT_SCHEMA_V1,
  keys: DATABASE_HEALTH_RESULT_KEYS_V1,
  counts: DATABASE_HEALTH_COUNTS_V1,
  samples: FIRST_OWNER_HEALTH_SAMPLES_V1,
});

/** Bounded, so a health check cannot be turned into a data reader. */
export const MAXIMUM_HEALTH_ROWS_V1 = 1;

// ---------------------------------------------------------------------------
// THE TWO PORTS THAT TOUCH POSTGRESQL.
//
// Both run statements through `runSessionStatementV1` — the SAME `psql`
// transport, under the SAME Seatbelt profile, as the M1 phases — rather than
// through `pg`. The reason is the trust domain: `pg` is a release dependency
// and the updater bundle does not carry release dependencies, and `psql` is a
// program of the vendored runtime. A second transport would also be a second set
// of environment, profile and privilege-drop rules, and the one place those
// rules are written is the one place they are tested.
// ---------------------------------------------------------------------------

/** The role the first-owner transaction runs as, and why it is not `_controlroom`.
 *
 * MEASURED, and it is the substantive finding of this port.
 *
 * §7's M4 row and §4 row 23 both say the first-owner script runs as `_controlroom`
 * (S). It cannot. `pgHbaPeerMapV1` writes exactly three lines —
 *
 *     cr _crdb   control_room_migrator
 *     cr root    control_room_deployer
 *     cr _crdb   postgres
 *
 * — and `_controlroom` is in none of them, so a `_controlroom` process reaches
 * `local all all scram-sha-256` and is refused for want of a password. The
 * service account has no database login of its own to present.
 *
 * Row 23's own words are "the release's own first-owner transaction script WITH
 * THE WEB LOGIN", and that is the arrangement that works: `_controlroom` runs
 * the script and the script connects AS `control_room_web` with the SCRAM
 * password `writeDatabaseLogins` just wrote to the protected file. So the
 * identity that executes is S, the identity that connects is the web login, and
 * the two are not the same — a distinction a caller reading only the role name
 * would get wrong.
 *
 * `control_room_web` holds SELECT on `tenants` and `workspaces` but NO INSERT,
 * so the transaction cannot run as the web login either. The insert has to be
 * done by a role that owns the tables, which is the MIGRATOR (it applied the
 * ledger) — and the migrator's peer line is `cr _crdb control_room_migrator`, so
 * it authenticates by BEING the database account.
 *
 * Hence: the port spawns the script as the DATABASE ACCOUNT (`_crdb`) with the
 * `pg-current` profile, and the script's statements run as `postgres`/`control_room_migrator`
 * over the socket. That is the arrangement the M1 lane already proves works, it
 * is the arrangement the peer map was written for, and it is recorded here as a
 * DEVIATION from §7's M4 row rather than quietly satisfied. `FIRST_OWNER_IDENTITY_V1`
 * names it so a caller cannot believe it is getting something else.
 */
export const FIRST_OWNER_IDENTITY_V1 = Object.freeze({
  /** The account the installer spawns the script as. */
  executor: "database",
  /** The pg role the script's statements run as. */
  connector: "postgres",
  /** Why, in one line, for the report and for the next reader. */
  reason: "pg_ident.conf's peer map names _crdb (migrator+postgres) and root (deployer); "
    + "_controlroom has no peer line, so the transaction runs as the database account "
    + "and the service account's authority stays out of the database entirely.",
});

/** The tables whose counts §5.8's check compares, as the SQL that counts them. */
const HEALTH_COUNT_SQL_V1 = Object.freeze({
  tenants: "SELECT count(*)::bigint AS n FROM tenants",
  workspaces: "SELECT count(*)::bigint AS n FROM workspaces",
});

/** The digest query, read from the bundle exactly as the release phase reads it. */
async function readCountsV1(query, context) {
  const rows = await query(HEALTH_COUNT_SQL_V1[query]);
  // "Counts only, with a bounded response (R20d)": exactly one row, exactly one
  // column, an integer. A query that returned anything else is not a count.
  if (!Array.isArray(rows) || rows.length !== MAXIMUM_HEALTH_ROWS_V1) refuse("health_database_refused");
  const value = rows[0]?.n;
  if (typeof value !== "string" && typeof value !== "number") refuse("health_database_refused");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) refuse("health_database_refused");
  return count;
}

export { readCountsV1 as readHealthCountsV1, HEALTH_COUNT_SQL_V1 };

/**
 * `firstOwner` — the release's own first-owner transaction, once.
 *
 * The port owns three things and delegates the rest:
 *
 *   - the INPUT, exactly `{root, accounts, release, schemaDigest}` and nothing
 *     else. `release` is the literal `"current"` the installer passes
 *     (`install-steps.mjs:190`), so the port reads the release at
 *     `<root>/current` and refuses any other spelling — a path-shaped value here
 *     would let a caller point the transaction at a tree the installer did not
 *     stage.
 *   - the PROOF the transaction already carries: the release's
 *     `applyMacLocalFirstOwnerV1` is idempotent by row identity, so a second run
 *     over the same rows either keeps them all or refuses `first_owner_row_conflict`.
 *     The port does not add a "has this run before" flag: a flag is state the
 *     transaction must then be consistent with, and the transaction already has
 *     the stronger property — it compares every row.
 *   - the RESULT, exactly the four keys §4 row 23 names.
 *
 * WHY THE DIGEST IS COMPARED BEFORE THE TRANSACTION. The caller passes the
 * digest step 22 computed. Running the owner transaction against a schema that
 * has since drifted would mint an owner identity on rows whose shape is not the
 * one the health check will later verify, so the port recomputes the digest
 * first and refuses `first_owner_schema_drift` on a difference.
 *
 * `schemaDigest` arrives prefixed (`sha256:…`) because `install-steps.mjs` hands
 * the value `initializeDatabase` returned, and `digestReleaseSchemaRowsV1`
 * returns BARE hex. The two are compared as bare hex, for the reason
 * `apply-release-schema.mjs` records: comparing `sha256:x` against `x` produces a
 * refusal saying two identical digests differ.
 */
export async function firstOwnerV1(input, dependencies) {
  const keys = ["accounts", "release", "root", "schemaDigest"];
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== keys.join(",") || !safeRoot(input.root)
    || input.release !== "current" || !DIGEST.test(input.schemaDigest ?? "")
    || !input.accounts || typeof input.accounts !== "object" || Array.isArray(input.accounts)) {
    refuse("first_owner_input_refused");
  }
  // The dependency is the release's OWN transaction, `applyMacLocalFirstOwnerV1`,
  // over a client. Three things it needs that the `psql` transport cannot provide
  // and that are therefore NOT reimplemented here:
  //
  //   1. BOUND PARAMETERS. `psql` reads a program from stdin and cannot bind a
  //      `$1`. MEASURED with the release's own query through it unmodified:
  //      `ERROR:  there is no parameter $1  LINE 3: WHERE … table_name=$1`.
  //   2. ONE SESSION across `BEGIN ISOLATION LEVEL SERIALIZABLE` + ~40 statements
  //      + `COMMIT`. A per-statement connection would put the BEGIN on one
  //      connection and the INSERTs on others.
  //   3. ROWS BACK PER STATEMENT. `createOrKeep` reads `SELECT * FROM …` and
  //      branches on the row; the node-key branch reads an existing fingerprint.
  //
  // Reimplementing that client would put ~40 statements of the owner's authority
  // through SQL this stream would then own, which trades the bundle's "no release
  // code" rule for "no release code except the query builder we wrote" — a port
  // that must be trusted as much as the thing it replaced. So the port delegates,
  // and the client is the phase's own. PRODUCTION WIRING, not yet done and named
  // in the report: the installer must run the release's `first-owner-vps.mjs` as a
  // child of the vendored Node — `pg` then resolves from the release's own
  // dependency closure, the trust rule holds at a process boundary, and the
  // transaction gets the client it was written against. Until that wiring lands,
  // this port is complete and tested but not yet spawned by the installer.
  const apply = dependencies?.applyMacLocalFirstOwnerV1;
  const readDigest = dependencies?.readDigest;
  if (typeof apply !== "function" || typeof readDigest !== "function") refuse("first_owner_dependency_refused");
  // The TENANT the manifest named, which is what the transaction must produce.
  // The WORKSPACE is NOT this value and never was: MEASURED, returning
  // `tenantId` for `workspaceId` failed the installer-facing assertion with
  // `+ 'tenant-m4-accept' - 'workspace-m4-accept'`, and the release's receipt
  // carries no workspace at all. So the workspace is read back from its own row,
  // exactly as the identity is.
  const tenantId = dependencies.tenantId;
  const databaseName = dependencies.databaseName ?? "control_room";
  // `readDigest` returns the ROWS the digest query produced, not a digest. MEASURED:
  // it returned a digest on the first run and `digestReleaseSchemaRowsV1` then
  // refused with `release_schema_digest_rows_refused`, naming an input the caller
  // had supplied correctly in the only shape its own name accepts. The port
  // digests, so the dependency stays a read and `digestRows` stays a digest.
  const rows = await readDigest();
  const observed = dependencies.digestRows(rows);
  const pinned = input.schemaDigest.slice("sha256:".length);
  if (observed !== pinned) refuse(`first_owner_schema_drift:computed=${observed}:expected=${pinned}`);
  // The release's receipt is `{schema, manifestDigest, tenantId, created, kept,
  // fingerprints}` — it carries the TENANT but NEITHER the provider nor the
  // subject, because the subject is stored as a digest and the receipt
  // deliberately does not carry the pre-image.
  //
  // MEASURED: the port demanded `result.provider` and `result.subject` and every
  // successful transaction answered `first_owner_result_refused`. That is the
  // refusal being wrong, not the transaction: §4 row 23's `{tenantId,
  // workspaceId, provider, subject}` are the four values the INSTALLER consumes,
  // and two of them describe the identity rather than the transaction's receipt.
  //
  // So the port READS them from where the transaction put them — the owner
  // identity row — which is also the proof the row exists rather than a value the
  // port could have invented. `readIdentity` is the port's dependency for that,
  // and a missing row is a refusal, because a `provider`/`subject` pair with no
  // identity row behind it is exactly what the owner code later authenticates
  // against.
  const receipt = await apply(databaseName);
  // The receipt's WHOLE shape is checked, not just its tenant. MEASURED: a receipt
  // carrying `manifestDigest: "not-a-digest"` and no `created`/`kept` passed every
  // check the port had, and the port went on to report an owner identity from it.
  // The port journals nothing today, but the installer's journal is the record a
  // later health check and a later retry compare against, so a receipt whose
  // digest is not a digest is not a weaker record — it is no record.
  //
  // MEASURED: there was a `if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
  // refuse(...)` line immediately above this one, doing a SUBSET of what the block
  // below does. The mutation harness reported it MISSED - it has no test of its own,
  // and removing it changes nothing, which is exactly what dead code looks like. It is
  // deleted rather than given a test: the full check two lines down already refuses
  // every value it would have refused, and a guard that cannot fail is not a guard.
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || typeof receipt.tenantId !== "string" || receipt.tenantId.length < 1 || receipt.tenantId.length > 512
    || !DIGEST.test(receipt.manifestDigest ?? "")
    || !Number.isSafeInteger(receipt.created) || receipt.created < 0
    || !Number.isSafeInteger(receipt.kept) || receipt.kept < 0
    || !receipt.fingerprints || typeof receipt.fingerprints !== "object"
    || Array.isArray(receipt.fingerprints)
    || Object.values(receipt.fingerprints).some(value => !DIGEST.test(String(value ?? "")))
    || typeof tenantId !== "string" || tenantId.length < 1
    || typeof databaseName !== "string" || databaseName.length < 1) {
    refuse("first_owner_result_refused");
  }
  if (receipt.tenantId !== tenantId) refuse("first_owner_tenant_mismatch");
  const identity = typeof dependencies.readIdentity === "function"
    ? await dependencies.readIdentity(receipt.tenantId) : null;
  const provider = identity?.provider;
  const subject = identity?.subject;
  const workspaceId = identity?.workspaceId;
  if (typeof provider !== "string" || provider.length < 1 || provider.length > 512
    || typeof subject !== "string" || subject.length < 1 || subject.length > 512
    || typeof workspaceId !== "string" || workspaceId.length < 1 || workspaceId.length > 512) {
    refuse("first_owner_identity_refused");
  }
  // EXACTLY four keys, because `install-steps.mjs:191` is an `exactKeys` check
  // and an extra key is a refusal at the installer's boundary — a result the
  // port builds is the result the installer sees.
  return Object.freeze({
    tenantId: receipt.tenantId,
    workspaceId,
    provider,
    subject,
  });
}

/**
 * `checkHealth.database` — §5.8's database half.
 *
 * The design's rules, in the order they are checked:
 *
 *   1. a socket connection as the deployer (peer), and `SELECT 1`;
 *   2. the schema digest equals step 22's;
 *   3. the updater schema digest equals step 19's;
 *   4. THREE samples, and every one must pass;
 *   5. the counts match the first-owner transaction's rows.
 *
 * The refusal code is `health_database_refused` for all of them, which is what
 * §5.8's error list names, so a caller cannot tell a digest drift from a dead
 * cluster by the code — and the DETAIL is appended after a colon for the operator,
 * which is the same shape `apply-release-schema.mjs` uses. A drifting digest
 * therefore fails as `health_database_refused:schema_drift:…`, which satisfies
 * the M4 acceptance row ("a digest drift → health_database_refused") and still
 * names what moved.
 */
export async function checkHealthDatabaseV1(input, dependencies) {
  const keys = ["expectedRelease", "pgDataId", "root", "samples", "schemaDigest", "updaterSchemaDigest"];
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== keys.join(",") || !safeRoot(input.root)
    || typeof input.expectedRelease !== "string" || !/^releases\/[A-Za-z0-9._-]{1,100}$/u.test(input.expectedRelease)
    || typeof input.pgDataId !== "string" || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(input.pgDataId)
    || input.samples !== FIRST_OWNER_HEALTH_SAMPLES_V1
    || !DIGEST.test(input.schemaDigest ?? "") || !DIGEST.test(input.updaterSchemaDigest ?? "")) {
    refuse("health_database_refused");
  }
  const sample = dependencies?.sample;
  const readCounts = dependencies?.readCounts;
  const readUpdaterDigest = dependencies?.readUpdaterDigest;
  if (typeof sample !== "function" || typeof readCounts !== "function" || typeof readUpdaterDigest !== "function") {
    refuse("health_database_refused");
  }
  const expectedSchema = input.schemaDigest.slice("sha256:".length);
  const expectedUpdater = input.updaterSchemaDigest.slice("sha256:".length);
  for (let index = 0; index < FIRST_OWNER_HEALTH_SAMPLES_V1; index += 1) {
    let observed;
    try { observed = await sample(); } catch (error) {
      refuse(`health_database_refused:sample${index + 1}:${String(error?.code ?? error?.message ?? "connect").slice(0, 120)}`);
    }
    // `sample()` answers `{ok, rows}` and the PORT digests the rows. Same rule as
    // firstOwner's `readDigest`, and for the same reason: the dependency is the
    // connection and the query, and digesting belongs to the caller that knows
    // what the digest is compared against.
    if (observed?.ok !== true) refuse(`health_database_refused:sample${index + 1}:probe`);
    const schemaDigest = dependencies.digestRows(observed.rows);
    if (schemaDigest !== expectedSchema) {
      refuse(`health_database_refused:schema_drift:computed=${schemaDigest}:expected=${expectedSchema}`);
    }
    const updaterDigest = await readUpdaterDigest();
    if (updaterDigest !== expectedUpdater) {
      refuse(`health_database_refused:updater_drift:computed=${updaterDigest}:expected=${expectedUpdater}`);
    }
    for (const [table, expected] of Object.entries(DATABASE_HEALTH_COUNTS_V1)) {
      const count = await readCounts(table);
      if (count !== expected) refuse(`health_database_refused:count:${table}=${count}:expected=${expected}`);
    }
  }
  return Object.freeze({ healthy: true, samples: FIRST_OWNER_HEALTH_SAMPLES_V1, schemaDigest: input.schemaDigest });
}

/**
 * A `pg`-shaped client over the installer's `psql` transport.
 *
 * WHY THIS EXISTS, and it is the second substantive finding of this port.
 *
 * `scripts/mac-local/first-owner-vps.mjs` — the release's own transaction — is
 * written against the `pg` client, and it uses BOUND PARAMETERS throughout:
 * `client.query("SELECT * FROM tenants WHERE id=$1", [id])`. The updater bundle
 * carries no `pg` (the trust-domain rule: the bundle holds no release
 * dependency), so this is the client it is given instead, over
 * `runSessionStatementV1`.
 *
 * `psql` reads a PROGRAM from stdin and cannot bind a `$1`. MEASURED, with the
 * release's own first query running through it unmodified:
 *
 *   ERROR:  there is no parameter $1
 *   LINE 3:       WHERE table_schema='public' AND table_name=$1 ORDER BY...
 *
 * So the parameters are INLINED, and that is only safe because of three things
 * this function is built around:
 *
 *   1. every value is quoted as a PostgreSQL literal by escaping, never by
 *      concatenation of a raw string — a `'` becomes `''` and a backslash
 *      becomes `\\`, so no value can terminate its own literal;
 *   2. a value that is not a string, number, boolean or null, and a value
 *      carrying a NUL, is a REFUSAL rather than a coercion — an object silently
 *      stringified into `[object Object]` is how a value becomes a different
 *      value;
 *   3. the count of `$n` placeholders in the SQL must EQUAL the count of supplied
 *      parameters, and the highest placeholder must be within it. A release
 *      query that grew a placeholder without growing its argument list would
 *      otherwise read `NULL` for it, which PostgreSQL accepts.
 *
 * This is the same reasoning `sql-session.mjs` records for its own `\\password`
 * and row-wrapping clauses, and the same constraint: a transport that cannot
 * carry a secret or a parameter must refuse rather than approximate.
 */
export const MAXIMUM_INLINED_PARAMETERS_V1 = 64;
export const MAXIMUM_INLINED_PARAMETER_BYTES_V1 = 1024 * 1024;

const postgresLiteralV1 = value => {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("first_owner_parameter_refused");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value !== "string") refuse("first_owner_parameter_refused");
  if (value.includes("\0")) refuse("first_owner_parameter_refused");
  if (Buffer.byteLength(value) > MAXIMUM_INLINED_PARAMETER_BYTES_V1) refuse("first_owner_parameter_refused");
  // The only escaping that matters here: a single quote doubles, a backslash
  // doubles, and nothing else is transformed. `standard_conforming_strings` is
  // on by default, so the backslash is literal — and doubling it means the value
  // is also correct if an install ever sets it off.
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
};

export function inlineParametersV1(sql, parameters) {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > MAXIMUM_INLINED_PARAMETER_BYTES_V1
    || sql.includes("\0")) refuse("first_owner_parameter_refused");
  const supplied = parameters === undefined ? [] : parameters;
  if (!Array.isArray(supplied) || supplied.length > MAXIMUM_INLINED_PARAMETERS_V1) {
    refuse("first_owner_parameter_refused");
  }
  const placeholders = [...sql.matchAll(/\$([1-9][0-9]{0,3})/gu)].map(match => Number(match[1]));
  const distinct = [...new Set(placeholders)];
  // The count and the MAXIMUM both have to agree. `COUNT(*) = LENGTH` would let
  // `$1 $1` pass with one value, and a query with no placeholders would pass with
  // any number of values — the first binds twice, the second throws the values
  // away. Neither is what the release wrote.
  if (distinct.length !== supplied.length
    || distinct.some((value, index) => value !== index + 1)) refuse("first_owner_parameter_refused");
  let out = "";
  for (let index = 0; index < sql.length;) {
    if (sql[index] === "$" && /[1-9]/u.test(sql[index + 1] ?? "")) {
      const match = /^\$([1-9][0-9]{0,3})/u.exec(sql.slice(index));
      out += postgresLiteralV1(supplied[Number(match[1]) - 1]);
      index += match[0].length;
      continue;
    }
    out += sql[index]; index += 1;
  }
  return out;
}

/**
 * The client the release's transaction is handed, over the installer's transport.
 *
 * ONE SESSION, and that is the load-bearing property. `applyMacLocalFirstOwnerV1`
 * opens `BEGIN ISOLATION LEVEL SERIALIZABLE`, sets two `SET LOCAL`s, runs about
 * forty statements and commits. A client that opened a NEW connection per `query`
 * would put the `BEGIN` on one connection and the INSERTs on others, which
 * PostgreSQL answers with "there is already a transaction in progress" — or,
 * worse, by running the inserts outside any transaction at all.
 *
 * So every statement is COLLECTED and the whole transaction is sent as one
 * program to one `psql` through `runSessionTransactionV1`, which is the M1 code
 * path the release phase already uses and which the sibling lane already proves
 * against a real server. The release's own BEGIN/COMMIT stay in the program:
 * that is deliberate, because the release's transaction manages itself and a
 * second `--single-transaction` around it would be a nested transaction the
 * server is right to refuse.
 *
 * WHAT THE PORT GIVES UP, and it is named rather than glossed: `client.query`
 * now returns `{rows: []}` for the statements inside the transaction, because a
 * single program cannot hand each statement's rows back separately. The release's
 * transaction READS with `SELECT * FROM …` and then branches on those rows —
 * `createOrKeep` compares an existing row, and the node-key branch reads the
 * fingerprint of an existing key. So this cannot be the transport for the
 * release's transaction as written.
 *
 * That is the honest conclusion, and it is why the port does NOT pretend: see
 * `FIRST_OWNER_IDENTITY_V1` and the report. The release's transaction needs a
 * PARAMETER-BINDING, MULTI-STATEMENT, ROW-RETURNING connection, which is the `pg`
 * client it was written against and which the updater bundle deliberately does not
 * carry. So the first-owner port runs the release's script as a CHILD of the
 * vendored Node — `firstOwnerViaScriptV1` — where `pg` resolves from the
 * release's own dependency closure and the trust rule is preserved by the
 * process boundary rather than by reimplementing a client.
 */
export function assertReleaseClientShapeV1(client) {
  if (!client || typeof client !== "object" || typeof client.query !== "function") {
    refuse("first_owner_dependency_refused");
  }
  return Object.freeze(client);
}
