// `init-database.mjs` — the install-night database init (INSTALL_COMPOSITION.md
// §5.3, first script; §4.3 row 19).
//
// WHAT IT OWNS, IN ORDER:
//   1. `pg/data-<id>`, `pg/socket` and the log directory;
//   2. `initdb` from the VENDORED runtime, under the launch daemon's Seatbelt
//      profile, as the database account, with the pinned environment;
//   3. `postgresql.conf`, `pg_hba.conf` and `pg_ident.conf` from the layout,
//      replacing whatever `initdb` wrote;
//   4. a TEMPORARY socket-only postmaster, started and stopped as the database
//      account, under which the group and login roles, the database, the
//      updater's role and schema, and the service logins' SCRAM verifiers are
//      created;
//   5. the `pg/current` link, and the clean-shutdown proof from `pg_controldata`.
//
// WHY IT APPLIES ONLY TWO OF THE FOUR UPDATER DDL FILES. `applyUpdaterSchemaV1`
// asserts that the deployer's reach into the release schema is EXACTLY three
// read-only tables, and refuses with `updater_schema_refused:release_reach_missing`
// when the deployer has reached NONE of them. Those three tables are created by
// the RELEASE migration ledger, which is the next phase's job (§4.3 row 22), so
// running the full loader here would refuse a perfectly good fresh install for a
// reason that has nothing to do with the cluster. This script therefore applies
// the two files that are the installer's half by the loader's own split — 0001
// creates the role, 0000 creates the schema, the two the loader runs through its
// bootstrap client precisely because they need cluster-level authority the
// deployer must not hold — and `apply-release-schema.mjs` runs the full loader
// immediately after the ledger. The loader's assertions DO therefore run on
// install night; they run where the evidence they need exists.
//
// WHAT IT REFUSES, AND WHY EACH REFUSAL IS THE SAFE DIRECTION:
//   - `pg/current` naming another data directory, or not a link.
//   - `pg/current` naming THIS data directory: `convergeCompletedInitV1` first.
//     A cluster carrying THIS phase's own completion record for THIS layout is
//     CONVERGED — the phase re-proves it with `pg_controldata` and answers
//     `initialized` with the digest recomputed from this bundle, touching no
//     process, no directory and no row (X1 of rv-9c: the old unconditional
//     `database_init_already_initialized` refused a run that had been killed after
//     the link was written, which is the state a retry has to finish). A cluster
//     with NO such record — a `move-live-db` target holding the owner's data, or a
//     record for a different layout — is refused `already_initialized:<reason>`.
//     Nothing is ever adopted on a link's word alone.
//   - (without `pg/current`, the data directory is this phase's own DEBRIS:
//     its processes are stopped and it is retired aside, never deleted.)
//   - a socket directory that is a symlink.
//   - any profile parameter left out. `sandbox-exec` fails to COMPILE an
//     undefined `(param ...)` and says only "invalid data type of path filter",
//     so every parameter the profile names is passed here rather than left to
//     the caller to remember.
//
// ONE BOUNDED JSON OBJECT ON STDOUT. Diagnostics go to stderr. A password
// arrives on this script's stdin and NEVER reaches a PG-family program: the
// script computes each login's SCRAM verifier itself and sends only that, so a
// password appears in no argv element, no environment variable, no psql input,
// no server log line and nothing this script writes.

import { spawn } from "node:child_process";
import { constants, lchown, lstat, mkdir, open, readFile, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { planPgClusterLayoutV1 } from "../../../pg-runtime/v1/pg-cluster-layout.ts";
import { applyOwnershipV1, chownOwnershipV1, configFileOwnershipV1 } from "./database-phase-ownership.mjs";
import { buildInitDependenciesV1FromReleaseV1 } from "./database-phase-dependencies.mjs";
import {
  DATABASE_INIT_REQUEST_V1, DATABASE_INIT_RESULT_V1, MAXIMUM_REQUEST_BYTES_V1, activeDatabasePhaseCalls,
  isDigestV1, parseDatabasePhasePasswordsV1, parseDatabasePhaseRequestV1, readBoundedJsonValueV1,
  readRequestArgumentV1,
} from "./database-phase-contract.mjs";
// The one entry guard for the tree, imported from its shared home rather than
// re-exported through the contract module, so there is a single definition.
import { isMainModuleV1 } from "../../../installer/shared/is-main-module.mjs";
import { postgresProfileParametersV1, spawnPgFamily } from "./database-phase-process.mjs";
import { runSessionStatementV1 } from "./sql-session.mjs";
import { scramVerifierV1, setVerifierStatementV1 } from "./scram-verifier.mjs";
import { computeUpdaterDdlFileDigestV1, readUpdaterDdlFilesV1 } from "./updater-ddl.mjs";
import {
  PROCESS_EXISTS_PERMISSION_DENIED_V1, identifyRecordedProcessV1, isRuntimeProgramCommandV1, listProcessesV1,
  namesDataDirectoryV1, pgProcessesOnDataDirectoryV1, processExistsV1, readPostmasterPidFileV1,
} from "./postmaster-pid.mjs";

// The pid-identity half of this phase now lives in `pg/postmaster-pid.mjs`, and
// is RE-EXPORTED here rather than moved silently: the M1 lane test and the
// review's probes import these names from this module, and `retireDatabaseV1`
// (bundled into the updater CLI) must be able to reach the same decisions
// without importing this whole phase. See that file's header for why the two
// callers cannot share a module otherwise.
export {
  PROCESS_EXISTS_PERMISSION_DENIED_V1, identifyRecordedProcessV1, isRuntimeProgramCommandV1, listProcessesV1,
  namesDataDirectoryV1, pgProcessesOnDataDirectoryV1, processExistsV1 as processExists,
  readPostmasterPidFileV1, runtimeBinDirectoriesV1,
} from "./postmaster-pid.mjs";

const refuse = code => { throw new Error(code); };

/** The files a fresh `initdb` leaves, used to tell a real cluster from a plant. */
export const PG_VERSION_FILE_V1 = "PG_VERSION";

/**
 * The `initdb` artifact FLOOR, and why it is a floor plus a plant check rather
 * than an exact match.
 *
 * MEASURED against the vendored 17.11 runtime: these are the entries `initdb`
 * writes at the top level of a data directory. The check is
 *   - all of these present  → "this is a cluster", and
 *   - nothing else present → "this is nothing but a cluster".
 * An exact two-way match would be stronger and would also refuse a correct
 * cluster the moment PostgreSQL adds a file, so the floor is what a version bump
 * needs and the plant check is what a tampered directory needs. Both halves are
 * asserted, because either alone is a claim this script could not support.
 */
export const INITDB_ARTIFACT_FLOOR_V1 = Object.freeze([
  PG_VERSION_FILE_V1, "base", "global", "pg_hba.conf", "pg_ident.conf", "pg_wal", "postgresql.conf",
]);

export function classifyDataDirectoryV1(entries) {
  if (entries.length === 0) return Object.freeze({ state: "empty", entries });
  const present = new Set(entries);
  if (!present.has(PG_VERSION_FILE_V1))
    return Object.freeze({ state: "planted", entries, reason: `unexpected_entries:${entries.slice(0, 8).join(",")}` });
  const missing = INITDB_ARTIFACT_FLOOR_V1.filter(name => !present.has(name));
  // A PG_VERSION with nothing else is the "someone began copying a data
  // directory" case, and it is a refusal rather than something to complete.
  if (missing.length > 0)
    return Object.freeze({ state: "planted", entries, reason: `incomplete_cluster_missing:${missing.join(",")}` });
  return Object.freeze({ state: "cluster", entries });
}

export function assertClusterShutDownV1(controlDataText) {
  const state = /Database cluster state:[ \t]*(.+)/u.exec(controlDataText ?? "")?.[1]?.trim() ?? "";
  if (state === "") refuse("pg_phase_control_data_refused");
  if (state !== "shut down") refuse(`database_init_cluster_not_clean:${state}`);
  return true;
}

/**
 * THE PHASE'S OWN COMPLETION RECORD, written INSIDE the data directory it
 * names (X1 of rv-9c).
 *
 * WHY IT EXISTS. `pg/current` is the phase's completion marker, and it is written
 * LAST — by `rename`, so no reader ever sees it half-made. But "last" is not
 * "atomic with the rest of the phase": a SIGKILL cannot be excluded from the
 * window between the link and the result line, and MEASURED in the M1 lane, a run
 * killed there left a data directory holding a COMPLETE cluster with `pg/current`
 * naming it. A same-id retry then answered `database_init_already_initialized` —
 * TRUE, and useless, because the installer's step needs a RESULT and a refusal is
 * not one, so the only way to finish was a fresh data id and a second cluster.
 *
 * WHY A RECEIPT INSTEAD OF "JUST RE-RUN THE PHASE". `pg/current` naming this id
 * is ALSO the state after `move-live-db`, where the owner's restored data lives in
 * `pg/<id>`. Re-running initdb, the layout or the DDL over that would destroy the
 * owner's data, so "converge a same-id retry" must never mean "adopt whatever is
 * there". The two states have to be DISTINGUISHED, and the distinction is exactly
 * what the link lacks: a value the phase computed from its OWN bundle, wrote into
 * the cluster it built, and can recompute on the next run.
 *
 *   - `updaterSchemaDigest` — the digest of the two DDL files this phase applied
 *     (`computeUpdaterDdlFileDigestV1`). It is compared against the bundle's own
 *     files, not merely carried forward, so a cluster carrying a stale digest from
 *     an older bundle still converges by re-running; and a cluster carrying NO
 *     record — a move target — never does.
 *   - `layoutDigest` — a digest of the three configuration files this phase wrote
 *     plus the data id, so a record from a different layout is not this one's.
 *
 * It is written with `O_EXCL` + `rename` for the same reason the configuration
 * files are (see `writeOwnedFileV1`): the data directory belongs to D, so a plain
 * `writeFile` would follow a link D planted, and a fixed name would let D occupy
 * the name and have a ROOT write land inside it.
 */
export const INIT_COMPLETION_RECORD_V1 = "control-room-init-complete-v1";

/** The record's own digest: the layout this phase wrote, and the data id. */
function initLayoutDigestV1(layout, pgDataId) {
  return createHash("sha256").update([INIT_COMPLETION_RECORD_V1, pgDataId,
    layout.postgresqlConf, layout.pgHbaConf, layout.pgIdentConf].join("\0")).digest("hex");
}

/**
 * The role and database statements, in the only order that works.
 *
 * 1. every role, group and login alike, with `IF NOT EXISTS` so a re-run on a
 *    partially-built cluster converges instead of failing on a role that
 *    exists. The ATTRIBUTES come from the role manifest
 *    (`databaseRoleAttributesV1`), not from a list written here, because the
 *    manifest is what the live upgrade checks against and a second spelling
 *    would be a second answer to "what attributes does the web login have";
 * 2. the migrator's membership in the schema owner, which is what makes every
 *    object a migration creates owned by the NOLOGIN role;
 * 3. the database, then its ownership transferred to the schema owner. Created
 *    here rather than in the ledger because the schema owner does not exist yet
 *    when `CREATE DATABASE` runs on a clean cluster — which is exactly why
 *    `apply-migrations.mjs` transfers ownership with an `ALTER` too.
 */
export function buildInitStatementsV1({ databaseName, roles, migratorLogin, migratorGroup }) {
  if (typeof databaseName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(databaseName)) refuse("pg_phase_database_name_invalid");
  if (typeof migratorLogin !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(migratorLogin)) refuse("pg_phase_migrator_refused");
  if (typeof migratorGroup !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(migratorGroup)) refuse("pg_phase_migrator_refused");
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 128) refuse("pg_phase_role_set_empty");
  const names = roles.map(entry => entry.name);
  if (new Set(names).size !== names.length) refuse("pg_phase_role_set_duplicate");
  // The name and the attribute clause are both checked here, because they are
  // concatenated into a `CREATE ROLE` this file is about to run. A name carrying
  // a quote or a semicolon here would be SQL injection from the request, and an
  // attribute clause carrying `SUPERUSER` would be a role the manifest never
  // approved. Neither is possible if both are matched against these patterns.
  for (const entry of roles) {
    if (typeof entry.name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(entry.name)) refuse("pg_phase_role_name_refused");
    if (entry.attributes !== "LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
      && entry.attributes !== "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS") {
      refuse(`pg_phase_role_attributes_refused:${entry.name}`);
    }
  }
  // `CREATE DATABASE` CANNOT RUN INSIDE A `DO` BLOCK, and that is a PostgreSQL
  // rule rather than a style preference. MEASURED against the vendored 17.11
  // server, from the first real run of this phase:
  //
  //   ERROR:  CREATE DATABASE cannot be executed from a function
  //   CONTEXT:  SQL statement "CREATE DATABASE control_room"
  //   PL/pgSQL function inline_code_block line 1 at EXECUTE
  //
  // `EXECUTE format(...)` inside `DO` is exactly the trick every OTHER statement
  // here uses, because `CREATE DATABASE` was assumed to need it for the same
  // idempotence the roles need. It does not. The idempotence is kept instead by
  // asking the server first: `createDatabase` is a check whose ROW decides
  // whether `create` is sent at all, and the caller — this phase, which is the
  // only writer and is not concurrent with itself — makes the choice. Two
  // statements instead of one, and one of them is a `SELECT`.
  return Object.freeze({
    roles: Object.freeze(roles.map(entry => "DO $cr$ BEGIN IF NOT EXISTS "
      + `(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${entry.name}') THEN CREATE ROLE `
      + `${entry.name} ${entry.attributes}; END IF; END $cr$;`)),
    grantMigrator: `GRANT ${migratorGroup} TO ${migratorLogin};`,
    createDatabase: Object.freeze({
      check: "SELECT 1 AS create_database_needed WHERE NOT EXISTS"
        + ` (SELECT 1 FROM pg_catalog.pg_database WHERE datname = '${databaseName}')`,
      create: `CREATE DATABASE ${databaseName}`,
    }),
    setOwner: `ALTER DATABASE ${databaseName} OWNER TO ${migratorGroup};`,
  });
}

/** Every path the phase touches, derived from the request's root and nothing else. */
export function installDatabasePathsV1(root, pgDataId, socketDir) {
  return Object.freeze({
    pgRoot: join(root, "pg"),
    data: join(root, "pg", pgDataId),
    socket: join(root, socketDir),
    runtime: join(root, "runtime", "pg-current"),
    updater: join(root, "updater", "current"),
    logs: join(root, "logs", "postgresql17"),
    logFile: join(root, "logs", "postgresql17", "out.log"),
  });
}

async function realDirectory(path, mode) {
  const entry = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (entry === null) { await mkdir(path, { recursive: true, mode }); return; }
  if (!entry.isDirectory() || entry.isSymbolicLink()) refuse("pg_phase_directory_refused");
}

async function directoryNames(path) {
  return Object.freeze((await readdir(path)).sort());
}

/**
 * Write a file root owns INSIDE a directory the database account owns, without
 * `writeFile` ever following a link.
 *
 * Low 1 of the review, and it is a root-write-redirect rather than a tidiness
 * concern: after the ownership fix, `pg/data-<id>/` belongs to D, so between
 * `initdb` returning and this write, a process running as D could plant a
 * symlink at `postgresql.conf` and make a ROOT write land wherever it pointed.
 * `writeFile` follows symlinks; `rename` does not — the rename moves THIS
 * descriptor's inode over the name, replacing whatever is there.
 *
 * The staging name is `.control-room-<name>.<random>` rather than a fixed
 * `.tmp`, for the same reason the credential file's staging name carries the
 * pid: a fixed name in a directory D owns is a name D can occupy, and the
 * `O_EXCL` open below turns that occupancy into a refusal instead of a write
 * into somebody else's file.
 */
async function writeOwnedFileV1(path, text, mode, randomBytes) {
  const staging = `${path}.control-room.${process.pid}.${randomBytes(8).toString("hex")}.staging`;
  const handle = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(text); await handle.chmod(mode); } finally { await handle.close(); }
  await rename(staging, path);
  return path;
}

/**
 * The L2 plant check, by `lstat` rather than by name.
 *
 * The review measured a data directory pre-populated with SYMLINKS named as the
 * seven floor entries, and the name-only classifier called it a `cluster` and
 * refused `database_init_already_initialized` — safe, but misnamed: the caller
 * is told "this is already initialised" when what is actually there is a plant.
 *
 * A floor entry that is not a regular file (for the three config files) or not a
 * directory (for the rest) makes the whole directory a `plant`, and the reason
 * names the entry: that is the difference between an operator being told which
 * file to look at and being told to look at the data directory.
 *
 * So the classifier takes the NAMES it used to take plus the directory entries
 * it did not, and it is the directory entries that decide.
 */
export async function classifyDataDirectoryEntriesV1(path) {
  const names = await directoryNames(path);
  const classified = classifyDataDirectoryV1(names);
  if (classified.state === "empty") return classified;
  if (classified.state === "planted") return classified;
  const byName = new Map(await Promise.all(names.map(async name => [name, await lstat(join(path, name))])));
  const wrongKind = INITDB_ARTIFACT_FLOOR_V1.filter(name => {
    const entry = byName.get(name);
    // `base`, `global` and `pg_wal` are directories; `pg_hba.conf`,
    // `pg_ident.conf`, `postgresql.conf` and `PG_VERSION` are regular files.
    const wanted = name === "pg_hba.conf" || name === "pg_ident.conf"
      || name === "postgresql.conf" || name === PG_VERSION_FILE_V1;
    return entry.isSymbolicLink() || (wanted ? !entry.isFile() : !entry.isDirectory());
  });
  if (wrongKind.length > 0) {
    return Object.freeze({ state: "planted", entries: names,
      reason: `not_a_cluster_entry:${wrongKind.join(",")}` });
  }
  return classified;
}

/**
 * Is this pid alive, and is it the account the phase spawned as?
 *
 * `kill(pid, 0)` is the zero-signal liveness probe: it performs the permission and
 * existence checks of `kill(2)` and delivers no signal. Its three outcomes are
 * three different answers and are kept as three — "exists", "does not exist",
 * and "exists but I may not signal it" — because for this sweep the third is the
 * one that must NOT be read as the second. A postmaster owned by another account
 * is still a postmaster holding the data directory, and treating EPERM as death
 * would retire a directory out from under a live server.
 *
 * MEASURED, and this is the bug the first version of this pair had: `exists`
 * returned the STRING `"true"` and the comparison here was `alive !== true`, so
 * every live pid read as dead and the sweep retired the directory of a running
 * postmaster without ever signalling it. One representation — booleans for the
 * two liveness answers and the string for the permission one — is now declared
 * once, here, and `processExists` is written to match.
 */
export async function inspectProcessIdentityV1(pid, databaseIdentity, exists = processExistsV1,
  owner = processOwner) {
  const alive = await exists(pid);
  if (alive === PROCESS_EXISTS_PERMISSION_DENIED_V1) {
    return Object.freeze({ alive: true, uid: -1, gid: -1, ownedByDatabase: false });
  }
  if (alive !== true) return Object.freeze({ alive: false, uid: -1, gid: -1, ownedByDatabase: false });
  const found = await owner(pid);
  return Object.freeze({ alive: true, uid: found.uid, gid: found.gid,
    ownedByDatabase: found.uid === databaseIdentity.uid && found.gid === databaseIdentity.gid });
}

/**
 * The uid and gid of a live pid, through `ps`.
 *
 * A plain `ps` and NOT `spawnPgFamily`: the sandbox profile is the launch
 * daemon's, and it exempts the VENDORED RUNTIME — a `/bin/ps` is not on that
 * list, so running it through the profile would be denied by the seatbelt
 * itself ("Operation not permitted") and the sweep would read EPERM as "the
 * process is not there". The sweep runs as root, in the install root, before any
 * sandbox matters, and `ps -o uid=,gid=` leaks nothing but two numbers.
 *
 * A `ps` that fails returns `-1`s rather than throwing: the caller compares them
 * against the database account's ids, and `-1` is not any real uid, so a failure
 * becomes "not this account" and therefore a REFUSAL — the safe direction.
 */
async function processOwner(pid) {
  const result = await new Promise(resolveRun => {
    const child = spawn("/bin/ps", ["-o", "uid=,gid=", "-p", String(pid)],
      { stdio: ["ignore", "pipe", "ignore"], env: { LC_ALL: "C" } });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", () => resolveRun(""));
    child.once("close", code => resolveRun(code === 0 ? stdout : ""));
  });
  const [uid, gid] = result.trim().split(/\s+/u);
  return { uid: Number(uid ?? -1), gid: Number(gid ?? -1) };
}

/**
 * Sweep an ORPHANED POSTMASTER and converge the retry. High 2 of the review.
 *
 * The case this exists for is MEASURED, and nothing in the phase could detect it
 * before: this script is SIGKILLed while its temporary postmaster is executing a
 * statement. The `finally` that stops the postmaster on every other exit never
 * runs — SIGKILL gives a process no chance to run anything — and the postmaster
 * survives as a DETACHED child holding the socket and the data directory. Then:
 *
 *   retry same id                     → database_init_already_initialized
 *   retry after retiring the data dir → database_init_postmaster_refused:Examine the log output.
 *   postmaster still alive after refused retry = true
 *
 * So the refusal named nothing and the retry did not converge, and the reviewer's
 * judgement is the one taken here: the sweep is what makes retry converge, so it
 * belongs in this phase as well as in C6. The sequence is the design's — bootout,
 * then kill-sweep uid D, then retire the data directory:
 *
 *   1. `pg_ctl stop -m fast`, because a postmaster stopped cleanly does not need
 *      killing and leaves no `postmaster.pid` for anything to sweep.
 *   2. `kill -9` on the pid, as a signal to a process already known to be D's and
 *      already known to belong to THIS data directory. Both conditions are
 *      checked, and either failing is a refusal rather than a kill.
 *   3. retire the data directory by RENAMING it aside — never `rm -rf`. A
 *      half-built cluster holds a live postmaster's files, and an interrupted
 *      `rm -rf` of a cluster whose postmaster is still writing would leave a
 *      directory that `initdb` refuses and an operator has to reason about. A
 *      rename is atomic and the contents are still there for forensics.
 *
 * The refusal, when the pid is alive and is NOT this phase's to touch, is
 * `database_init_orphan_postmaster:<pid>` with the reason appended — so the
 * operator learns WHICH process is holding the cluster rather than being told
 * "Examine the log output." by a tool that looked in the log.
 *
 * THE PID IN THE FILE IS A CLAIM, NOT AN IDENTITY (N1 of the M1c review). After a
 * power cut or a restart the file survives and its pid is RECYCLED onto whatever
 * the OS starts next — possibly a process of D's own. So "is that pid alive and
 * D's" is not "is that our postmaster": the live process at that pid is looked up
 * in the PROCESS TABLE (`identifyRecordedProcessV1`) and is signalled only if it
 * is provably a PG program of this runtime on THIS data directory. Anything else
 * at that pid is left alone and the file is a stale record:
 *
 *   gone / not a program of this runtime    → stale, retired, nothing signalled
 *   this runtime, on this dir, D's           → stopped, killed, retired
 *   this runtime, on this dir, not D's       → refused  (not_database_account)
 *   this runtime, pid file names another dir → refused  (other_data_directory)
 *   this runtime, argv names another dir     → stale (the pid was recycled onto
 *                                              another cluster), nothing signalled
 *   this runtime, no data dir on its argv    → an orphaned standalone backend;
 *                                              waited for (its stdin is gone, so it
 *                                              exits), refused only if it will not
 *
 * An EMPTY or unparseable file (a crash mid-write) is no longer a refusal either:
 * step 0 has already proved this directory is the phase's own debris, and the
 * process-table sweep that follows finds anything still working on it by argv.
 */
export async function sweepOrphanPostmasterV1({ data, pgRoot, port, socketDirectory,
  databaseIdentity, dependencies = {}, bootout, exists = processExistsV1,
  listProcesses = listProcessesV1, binDirectories = [], waitAttempts = 200, kill = kill9 }) {
  const pidPath = join(data, "postmaster.pid");
  const text = await readFile(pidPath, "utf8").catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  const where = { data, binDirectories, uid: databaseIdentity.uid };
  if (text === null) {
    // A stale lock file in the SOCKET directory, with no postmaster at all. It
    // is the other half of the measured state — MEASURED, both files were present:
    // lock file = ['.s.PGSQL.59608', '.s.PGSQL.59608.lock'] — and it is what
    // `pg_ctl` refuses on, with "Examine the log output." So it is named and
    // removed here, and only when no postmaster is alive to hold it.
    const lock = await sweepSocketLockV1({ socketDirectory, port, ...where, listProcesses });
    return Object.freeze({ retired: lock === "removed" ? "stale-socket-lock" : null, pid: 0 });
  }
  const recorded = readPostmasterPidFileV1(text, data);
  if (recorded === null) return Object.freeze({ retired: null, pid: 0, pidFile: "unreadable" });
  const identify = async () => identifyRecordedProcessV1(recorded.pid, await listProcesses(), where);
  let identity = await identify();
  if (identity.kind === "unattributed" && recorded.matchesThisData && identity.uid === databaseIdentity.uid) {
    // A program of this runtime, D's, that names no data directory: what an
    // `initdb` killed without its bootstrap backend leaves. Nothing proves which
    // directory it is on, so it is NOT signalled — it is waited for, bounded. Its
    // stdin was `initdb`'s pipe, so it reads EOF and exits on its own.
    for (let attempt = 0; attempt < waitAttempts && identity.kind === "unattributed"; attempt += 1) {
      await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
      identity = await identify();
    }
  }
  if (identity.kind === "gone" || identity.kind === "foreign") {
    // A `postmaster.pid` whose process has died — or whose pid now belongs to
    // something that is not a program of this runtime at all (a recycled pid).
    // Either way there is no process of ours to stop, so nothing is signalled and
    // the stale record is retired with the directory.
    return retireDataDirectoryV1(data, pgRoot, identity.kind === "gone" ? "stale-pid-file" : "stale-pid-recycled");
  }
  // `postmaster.pid`'s own data-directory line decides whose postmaster this is.
  // This is checked BEFORE any signal: a pid file in THIS directory naming
  // ANOTHER directory, held by a live program of this runtime, is a pid this
  // phase does not own, whatever its uid says.
  if (!recorded.matchesThisData) {
    refuse(`database_init_orphan_postmaster:${recorded.pid}:other_data_directory`);
  }
  // Our own record, but the pid now runs ANOTHER cluster's program (its argv names
  // a different `-D`): recycled after a restart. Not signalled; the record is stale.
  if (identity.kind === "other_cluster") return retireDataDirectoryV1(data, pgRoot, "stale-pid-recycled");
  if (identity.kind === "not_database_account") {
    // Alive, on this data directory, but not the account this phase spawned as.
    // That is either a pre-existing cluster owned by somebody else or an
    // `os.getuid()` that is not what the request claimed, and killing it would be
    // this phase reaching outside its own root.
    refuse(`database_init_orphan_postmaster:${recorded.pid}:not_database_account`);
  }
  if (identity.kind !== "ours") refuse(`database_init_orphan_postmaster:${recorded.pid}:${identity.kind}`);
  // A standalone backend has no `pg_ctl stop` (pg_ctl refuses a negative pid
  // file by design), so only a postmaster is asked to stop cleanly.
  if (!recorded.standalone) await bootout().catch(() => false);
  // Re-identified after the bootout: a postmaster that took the signal cleanly is
  // gone, and the kill below would then be aimed at a pid the OS may already
  // have RECYCLED onto an unrelated process. That is the reason the kill is not
  // unconditional, and why the re-check is the process table and not `kill -0`.
  if ((await identify()).kind === "ours") {
    await kill(recorded.pid);
    // …and after the kill, a short bounded wait for the pid to disappear, so the
    // `initdb` below cannot race a postmaster that is still closing its files.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await exists(recorded.pid)) === false) break;
      await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
    }
  }
  return retireDataDirectoryV1(data, pgRoot, `swept:${recorded.pid}`);
}

/**
 * The SOCKET lock file, `.s.PGSQL.<port>.lock`, removed only when nothing of ours
 * holds it. It carries the same pid and data-directory lines as `postmaster.pid`,
 * and PostgreSQL refuses to start while its pid is alive — so a lock left by a
 * postmaster that died in a power cut, whose pid was then recycled, would refuse
 * every retry exactly the way N1's pid file did. Kept while its pid is ANY live
 * program of this runtime: ours is killed by the sweep first (and this runs again
 * after it), and anybody else's lock is not this phase's to remove.
 */
export async function sweepSocketLockV1({ socketDirectory, port, data, binDirectories, uid,
  listProcesses = listProcessesV1 }) {
  const lock = join(socketDirectory, `.s.PGSQL.${port}.lock`);
  const text = await readFile(lock, "utf8").catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (text === null) return "absent";
  const recorded = readPostmasterPidFileV1(text, data);
  if (recorded !== null) {
    const holder = identifyRecordedProcessV1(recorded.pid, await listProcesses(), { data, binDirectories, uid });
    if (holder.kind !== "gone" && holder.kind !== "foreign") return "kept";
  }
  await unlink(lock).catch(error => { if (error?.code !== "ENOENT") throw error; });
  return "removed";
}

export const retireDataDirectoryV1 = async (data, pgRoot, reason) => {
  // Renamed aside, never removed. `mv` is atomic and leaves every file in place
  // for forensics, and an operator who needs the half-built cluster has it.
  const retired = join(pgRoot, `.retired-${reason.replace(/[^A-Za-z0-9._-]/gu, "-")}-${randomBytes(6).toString("hex")}`);
  await rename(data, retired);
  // NO empty directory is left behind. The phase creates the data directory
  // itself AFTER the sweep and BEFORE the ownership handoff, so it is D's; a
  // directory recreated here by root would be the one `initdb` (running as D)
  // cannot `chmod` — invisible in a lane whose D is the invoker.
  return Object.freeze({ retired: reason, pid: 0, path: retired });
};

/** SIGKILL the given pids and wait, bounded, for every one of them to be gone. */
export async function killAndWaitV1(pids, exists = processExistsV1) {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = [];
    for (const pid of pids) if ((await exists(pid)) !== false) alive.push(pid);
    if (alive.length === 0) return;
    await new Promise(resolveWait => { setTimeout(resolveWait, 100); });
  }
  refuse(`database_init_debris_process_survived:${pids.join(",")}`);
}

/**
 * The line of a failed PG tool's output that names the CAUSE (N3 of the M1c
 * review). `initdb` cleans up after a failure and says so LAST, so the last line
 * is always `initdb: removing contents of data directory "…"`; MEASURED, the cause
 * (`FATAL:  could not create shared memory segment: No space left on device`) was
 * lines earlier. The first `FATAL:`/`PANIC:`/`ERROR:`/`error:` line is the cause;
 * without one, the last line is all there is.
 */
export function pgFailureLineV1(text) {
  const lines = String(text ?? "").split("\n").map(line => line.trim()).filter(line => line !== "");
  const cause = lines.find(line => /(?:^|\s)(?:FATAL|PANIC|ERROR):|(?:^|:\s)error:/u.test(line));
  return (cause ?? lines.at(-1) ?? "").replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ").slice(0, 200);
}

function kill9(pid) {
  return new Promise(resolveRun => {
    const child = spawn("/bin/kill", ["-9", String(pid)], { stdio: "ignore" });
    child.once("error", () => resolveRun(false));
    child.once("close", code => resolveRun(code === 0));
  });
}

/**
 * A SAME-ID RE-RUN AGAINST A COMPLETED CLUSTER, and the two answers it can give.
 *
 * The step-0 refusal this replaces said only `database_init_already_initialized`,
 * which is TRUE and is not actionable: the installer's `init-database` step
 * journals a RESULT (`install-steps.mjs:183`), and a refusal is not one, so the
 * install could only proceed by minting a new data id and building a second
 * cluster. MEASURED (rv-9c X1, the M1 lane): a run killed in the window between
 * `pg/current` and the result line leaves exactly that state.
 *
 * THE TWO STATES `pg/current → this id` CAN MEAN, and why they must not be
 * treated alike:
 *
 *   | the data directory                          | answer                                      |
 *   |---------------------------------------------|---------------------------------------------|
 *   | carries THIS phase's record for THIS layout  | `initialized`, re-proved from the cluster    |
 *   | is a live or moved-in cluster, no record     | `database_init_already_initialized:<reason>` |
 *
 * The second is what `move-live-db` leaves: the owner's restored data, in a data
 * directory this phase never built. Re-running `initdb`, the layout or the DDL
 * over it would destroy it, so it is refused — with a reason appended, because
 * "somebody else's completed cluster" and "this phase's completed cluster" call
 * for different operator actions, and the whole defect X1 names is that the old
 * code made them indistinguishable.
 *
 * NOTHING IS TOUCHED ON EITHER PATH. No process is signalled, no directory is
 * renamed, no SQL is sent, no configuration is rewritten. The re-prove is
 * `pg_controldata` alone, which reads the control file and exits; H4's rule — a
 * re-run must never adopt, stop or overwrite a completed cluster — holds for the
 * RUNNING case too, and the lane asserts a running cluster's rows survive a
 * refused re-run.
 *
 * WHY THE RECEIPT'S DIGEST IS COMPARED AGAINST THE BUNDLE AND NOT CARRIED
 * FORWARD. A record from an OLDER bundle would be a claim about DDL this run did
 * not apply. Re-deriving the digest from `updater/current/ddl` on every re-run
 * means such a cluster is recognised as needing the full phase again (and, since
 * `pg/current` is present, refused for the operator to retire) rather than
 * reported `initialized` against DDL nobody applied. The digest a re-run REPORTS
 * is always the one it computed from its own bundle.
 */
async function convergeCompletedInitV1({ paths, layout, pgDataId, binary, steps, spawn }) {
  const layoutDigest = initLayoutDigestV1(layout, pgDataId);
  const recordPath = join(paths.data, INIT_COMPLETION_RECORD_V1);
  // `lstat` before `readFile`: the data directory belongs to D, so the record is
  // an entry D controls and `readFile` would follow a link planted at the name.
  // A link there is not a record — it is a refusal, and `lstat` is what says so.
  const recordEntry = await lstat(recordPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  // The file's SIZE and KIND are checked before it is read, and the `&&` is
  // load-bearing rather than a typo waiting to happen: written as an `||` the
  // condition is true whenever there is NO record — `false || true` — so the guard
  // fired on every ordinary completion and refused it as
  // `foreign:completion_record_refused`, and the convergence could never run at
  // all. MEASURED: the X1 lane run stalled at 73 of ~80 driver runs, each one
  // refusing at the same point for the same reason.
  if (recordEntry !== null && (!recordEntry.isFile() || recordEntry.isSymbolicLink()
    || recordEntry.size > 64 * 1024)) {
    refuse("database_init_already_initialized:foreign:completion_record_refused");
  }
  const text = recordEntry === null ? null : await readFile(recordPath, "utf8");
  // ONE decision, read once: the classifier answers "is this my own record, for
  // this layout, asserting a clean cluster", and the answer is either the
  // convergence below or a refusal that names what it found. Collapsing the
  // several states into one code is what made the original defect hard to act on,
  // so each is named.
  const classified = classifyCompletionRecordV1(text, recordEntry, layoutDigest);
  if (!classified.ok) refuse(`database_init_already_initialized:${classified.reason}`);
  // THE RE-PROVE, and it is the cluster's own tool: `pg_controldata` reads the
  // control file the last clean shutdown wrote and says whether the cluster is
  // shut down. This is the same proof step 5 takes on a fresh init, read by the
  // same program as the same account, so "adopted" and "initialised" answer the
  // same question the same way — a record alone would be a claim from a file
  // this phase wrote minutes ago, and a crash since then would still read as one.
  const control = await spawn({ executable: binary("pg_controldata"), args: ["-D", paths.data] });
  if (control.code !== 0) refuse("database_init_controldata_refused");
  // A dirty cluster is `cluster_not_clean`, NOT the old `already_initialized`:
  // it says the cluster needs recovery rather than that it is somebody else's,
  // and those are different states with different fixes.
  assertClusterShutDownV1(control.stdout);
  steps.push("adopted", "shut-down");
  return Object.freeze({ schema: DATABASE_INIT_RESULT_V1, outcome: "initialized", pgDataId,
    updaterSchemaDigest: computeUpdaterDdlFileDigestV1(await readUpdaterDdlFilesV1(
      join(paths.updater, "ddl"), ["0001_deployer_role.sql", "0000_bootstrap.sql"])),
    clusterShutDownClean: true });
}

/**
 * CLASSIFY the completion record, once, and both callers read this answer.
 *
 * The refusal and the convergence are two answers to one question, and the
 * question — "is this a record THIS phase wrote for THIS layout, asserting a
 * cluster that is clean?" — is decided HERE and nowhere else. It was decided
 * twice, in the reader and in the reason-picker, and that
 * duplication was measured to be a defect in its own right: a mutation run
 * deleted the clean-shutdown check from the reader and EVERY test still passed,
 * because the reason-picker carried an identical second copy that refused the
 * same record with a different code. A guard that exists twice is one guard and
 * one shadow, and which of the two a mutation removes is luck.
 *
 *   outcome  "ok"          the record is this phase's, for this layout, and clean
 *   reason   anything else the caller must refuse with, naming which it found
 *
 * The two refusal groups are kept distinct because they are different facts about
 * the file, and both call for the refusal: `foreign` covers a shape or a schema
 * this phase does not own (another bundle's record, a planted one, a record for a
 * different layout or data id); `unreadable` covers bytes that are not a record at
 * all. A move target has NO record, which is the third answer and is `ok: false`
 * with `reason: no_completion_record`.
 */
export function classifyCompletionRecordV1(text, recordEntry, layoutDigest) {
  if (recordEntry === null) return Object.freeze({ ok: false, reason: "no_completion_record" });
  if (typeof text !== "string" || !/^\s*\{/u.test(text)) {
    return Object.freeze({ ok: false, reason: "completion_record_unreadable" });
  }
  let value;
  try { value = JSON.parse(text); } catch { return Object.freeze({ ok: false, reason: "completion_record_unreadable" }); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.schema !== INIT_COMPLETION_RECORD_V1) {
    return Object.freeze({ ok: false, reason: "completion_record_foreign" });
  }
  // The clean-shutdown flag is REQUIRED to be `true`, not merely present: it is
  // this phase's own claim about `pg_controldata`, and a claim of "dirty" is not a
  // claim that a cluster is safe to adopt.
  if (value.clusterShutDownClean !== true) {
    return Object.freeze({ ok: false, reason: "completion_record_not_clean" });
  }
  if (value.layoutDigest !== layoutDigest) {
    return Object.freeze({ ok: false, reason: "completion_record_other_layout" });
  }
  // The digest a re-run REPORTS is never the record's: it is recomputed from this
  // bundle's own DDL files, so a converged retry answers with what it would have
  // applied rather than with what it read.
  return Object.freeze({ ok: true, reason: "", value });
}

/**
 * The phase entry point: `(request, passwords, dependencies)`.
 *
 * The order matches the port's process contract rather than convenience. The
 * request is what travels on argv; the passwords are what travels on stdin; the
 * dependencies are what only a test or a rehearsal supplies. Keeping passwords
 * second means a caller that forgets them passes `undefined` and is refused by
 * `parseDatabasePhasePasswordsV1` with a named code, rather than silently
 * initialising a cluster with no service logins.
 */
export async function initializeDatabaseV1(request, passwords, dependencies = {}) {
  const run = async () => {
    const parsed = parseDatabasePhaseRequestV1(request, {
      schema: DATABASE_INIT_REQUEST_V1, code: "database_init_input_refused", extraKeys: [],
    });
    const secrets = parseDatabasePhasePasswordsV1(passwords, parsed.logins, "database_init_input_refused");
    const { root, pgDataId, accounts, logins } = parsed;
    // The release's own deployer name, refused as a password login here as well
    // as by the shared parser's fixed list: a manifest that renamed the deployer
    // must not reopen the hole the parser closes for the default name.
    for (const login of logins) {
      if (login.name === dependencies.deployerName) {
        refuse(`database_init_input_refused:passwordless_login:${login.name}`);
      }
    }
    const paths = installDatabasePathsV1(root, pgDataId, parsed.socketDir);
    const databaseName = dependencies.databaseName ?? "control_room";
    // The port comes from the REQUEST, not from a dependency or a constant. The
    // request is what the port on the other side of the process boundary built, and
    // the socket path both phases use is derived from it -- so a phase that took it
    // from anywhere else would look for a socket nobody published. The dependency
    // key remains for the in-process callers, which is where the lane's port
    // override arrives.
    const port = parsed.port;
    const layout = (dependencies.planLayout ?? planPgClusterLayoutV1)({
      pgRoot: paths.pgRoot, dataId: pgDataId, runtimeDirectory: paths.runtime,
      // The peer map's system-username column is the OS account that runs the
      // postmaster; its database-username column is the role each such process
      // may become. Both names come from the request, never from a literal.
      accounts: { database: accounts.database.name, migrator: dependencies.migratorName, deployer: dependencies.deployerName },
      port,
    });
    if (layout.status !== "socket_only_cluster_layout_built")
      refuse(`database_init_layout_refused:${layout.refusal?.reason}`);
    const profile = join(paths.updater, "policy", "service-postgres.sb");
    const profileParameters = postgresProfileParametersV1({ root, layout, logDirectory: paths.logs });
    // The layout's environment IS the whole environment: no PATH (so a binary can
    // only be reached by the absolute vendored path), no HOME, no owner-chosen
    // locale, and the OpenSSL/Kerberos pins. LC_ALL is load-bearing rather than
    // cosmetic — a postmaster with no valid locale refuses to start at all.
    const environment = Object.freeze({ ...layout.environment });
    const databaseIdentity = Object.freeze({ uid: accounts.database.uid, gid: accounts.database.gid });
    const binary = name => join(paths.runtime, "bin", name);
    const steps = [];
    // Every PG-family program this phase starts runs as the DATABASE ACCOUNT —
    // never as root. `initdb`, `pg_ctl` and `pg_controldata` are all the postmaster
    // account's programs, and the role is named on every spawn so
    // `spawnPgFamily`'s root check has something to check against. A phase that
    // started a postmaster as root would be refused by PostgreSQL itself
    // ("initdb: error: cannot be run as root"), so this is both the design and
    // the only thing that works.
    const spawn = options => spawnPgFamily({ environment, ...databaseIdentity, role: "database",
      profile, profileParameters, cwd: paths.pgRoot, onSpawn: dependencies.onPgSpawn, ...options });
    // Every statement runs AS THE DATABASE ACCOUNT. That is the only identity
    // the peer map sends to `postgres` or to the migrator, and it is why this
    // script can create roles at all without holding a superuser password: it
    // does not hold a password at all, it IS the account the map trusts.
    const sql = (statement) => runSessionStatementV1(statement, { root, layout, identity: databaseIdentity,
      environment, port, profile, profileParameters, pgRoot: paths.pgRoot, onSpawn: dependencies.onPgSpawn });

    // --- 0. THE ONE RULE THAT DECIDES WHETHER THIS IS A RE-RUN (H3 + H4 of the
    //        M1b review): the init is COMPLETE when, and only when, `pg/current`
    //        names this `pgDataId`. `pg/current` is the LAST thing this phase
    //        writes, so it is never present for a half-built cluster.
    //
    // It is decided FIRST, before any directory is made, any ownership changed or
    // any process signalled. MEASURED (probe D): the old order swept before it
    // classified, so re-running init against a cluster the SERVICE was running —
    // the state after `install-database-service`, and after `move-live-db` the
    // state that holds the owner's moved data — killed that postmaster, renamed
    // the live data directory to `pg/.retired-swept-…` and built an empty cluster
    // in its place, and answered `initialized`.
    //
    //   pg/current → this id      → this phase's OWN completed cluster: CONVERGE
    //                               (see below) or refuse `already_initialized`
    //   pg/current → another id   → refuse; another cluster is in use
    //   pg/current is not a link  → refuse
    //   pg/current absent         → everything under pg/<pgDataId> is this
    //                               phase's own debris (the id is per install
    //                               transaction), swept and retired in step 1.
    //
    // `pg/current` ALONE IS NOT ENOUGH TO CONVERGE ON, and that is the half X1 of
    // rv-9c is about. The link says "some run reached its final step"; it does not
    // say WHICH run, and it cannot say, because the link is the last write and the
    // result line after it is the one thing a SIGKILL can still take. MEASURED in
    // the M1 lane: a run killed in exactly that window left a data directory
    // holding a COMPLETE cluster with `pg/current` naming it, and the same-id retry
    // refused `database_init_already_initialized` — true, and useless, because the
    // installer's `init-database` step needs a RESULT and a refusal is not one. The
    // install then could only finish with a NEW data id, discarding a cluster that
    // was already correct.
    //
    // The fix is not "re-run the phase on the link's word", because the link's word
    // is also what a `move-live-db` target looks like: a data directory this phase
    // never built, holding the owner's restored data, which a re-run would destroy.
    // So the two are separated by the phase's OWN completion record (see
    // `classifyCompletionRecordV1`): a same-id retry CONVERGES only on a record
    // that matches this bundle's DDL digest and this layout, and otherwise REFUSES
    // with a code that says which of the two it found.
    const currentLink = join(paths.pgRoot, "current");
    const linked = await lstat(currentLink).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (linked !== null) {
      if (!linked.isSymbolicLink()) refuse("database_init_current_link_refused");
      if (await readlink(currentLink) !== pgDataId) refuse("database_init_current_link_target_refused");
      // A same-id re-run, and this is where it CONVERGES or refuses precisely.
      // Everything below the link check is read-only: a postmaster is never
      // stopped, a directory is never retired, and no SQL is sent, until the
      // record has been read and the cluster has answered `pg_controldata` for
      // itself. H4's rule — a re-run must never adopt, stop or overwrite a
      // completed cluster — is kept in full: adoption here means reporting what the
      // cluster already is, and the re-prove is the two refusals' own subject.
      return await convergeCompletedInitV1({ paths, layout, pgDataId, binary, steps, spawn });
    }

    // --- 1. directories, the DEBRIS of an interrupted attempt, the OWNERSHIP
    //        HANDOFF.
    //
    // THE ORDER IS THE PROPERTY. Every directory is created and chowned BEFORE
    // any PG-family program runs, because the first thing `initdb` does with a
    // data directory is `chmod` it, and it can only do that if it already owns
    // it. A phase that created `pg/` 0700 root-owned and then spawned `initdb`
    // as D would fail with "could not change permissions of directory …
    // Operation not permitted", and the phase that spawned a postmaster as D
    // into a root:wheel 0750 socket directory would fail with "could not create
    // any Unix-domain sockets" — neither message naming the ownership.
    await realDirectory(paths.pgRoot, 0o700);
    await realDirectory(paths.socket, 0o750);
    await realDirectory(paths.logs, 0o750);
    const existing = await lstat(paths.data).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) {
      refuse("database_init_data_directory_refused");
    }
    const binDirectories = [join(paths.runtime, "bin")];
    try { binDirectories.push(join(realpathSync(paths.runtime), "bin")); } catch { /* no runtime yet */ }
    const listProcesses = dependencies.listProcesses ?? listProcessesV1;
    if (existing !== null) {
      // THE DEBRIS SWEEP, which runs only because step 0 proved this is not a
      // completed init. Three things, in the order that cannot race:
      //
      //   a. a POSTMASTER on this directory, through its own `postmaster.pid` —
      //      stopped cleanly if it will stop, killed if not, and REFUSED (never
      //      signalled) if the pid file names another directory or the process is
      //      not D's. MEASURED: a SIGKILLed init leaves its postmaster running and
      //      holding the socket, and every retry then failed inside `pg_ctl`.
      //   b. any other PG-family process of D working on this directory — an
      //      orphaned `initdb` and its bootstrap backend, a `pg_ctl` still waiting,
      //      a postmaster that had not yet written its pid file — found in the
      //      process table (see `pgProcessesOnDataDirectoryV1`) and killed.
      //   c. the directory itself, RENAMED aside when it holds anything at all —
      //      never deleted, so a mistaken retirement is recoverable by hand.
      const swept = await sweepOrphanPostmasterV1({
        data: paths.data, pgRoot: paths.pgRoot, port, socketDirectory: paths.socket,
        databaseIdentity, dependencies, listProcesses, binDirectories,
        exists: dependencies.processExists,
        bootout: async () => (await spawn({ executable: binary("pg_ctl"),
          args: ["-D", paths.data, "-m", "fast", "-w", "-t", "20", "stop"] })).code === 0,
      });
      if (swept.retired) steps.push(`orphan-swept:${swept.retired}`);
      const stragglers = pgProcessesOnDataDirectoryV1(await listProcesses(),
        { data: paths.data, binDirectories, uid: databaseIdentity.uid });
      if (stragglers.length > 0) {
        await killAndWaitV1(stragglers, dependencies.processExists ?? processExistsV1);
        steps.push(`debris-killed:${stragglers.length}`);
      }
      const remaining = await lstat(paths.data).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (remaining !== null && (await readdir(paths.data)).length > 0) {
        const retired = await retireDataDirectoryV1(paths.data, paths.pgRoot, "debris");
        steps.push(`debris-retired:${retired.path.split("/").pop()}`);
      }
    }
    // The socket lock, whether or not a data directory was left: nothing of ours is
    // alive on this directory now, and a lock whose pid died in a power cut and was
    // then recycled would make the temporary postmaster below refuse to start.
    if (await sweepSocketLockV1({ socketDirectory: paths.socket, port, data: paths.data, binDirectories,
      uid: databaseIdentity.uid, listProcesses }) === "removed") steps.push("socket-lock-removed");
    // Created here, AFTER the sweep and BEFORE the ownership handoff, so the
    // directory `initdb` receives is always one the handoff gave to D.
    if (await lstat(paths.data).catch(() => null) === null) await mkdir(paths.data, { recursive: true, mode: 0o700 });
    // …and it is empty, which after the sweep is the only state it can be in. A
    // non-empty directory here is something that appeared DURING the sweep, and
    // that is a refusal, not something to initialise over.
    const classified = await classifyDataDirectoryEntriesV1(paths.data);
    if (classified.state !== "empty") refuse(`database_init_planted_file_refused:${classified.reason ?? classified.state}`);
    // The log file exists before the ownership handoff, because `pg_ctl -l`
    // appends to it rather than creating it: a `pg_ctl` run as D asked to open a
    // root-owned 0600 file for writing fails with "Permission denied", and the
    // phase's own refusal would name the log path rather than the ownership.
    await writeOwnedFileV1(paths.logFile, "", 0o600, dependencies.randomBytes ?? randomBytes);
    // Everything this phase creates, handed to the account that will use it.
    // `chownPath` is a parameter so a test can assert the plan without root —
    // see `database-phase-ownership.mjs`, which explains why a non-root lane
    // could not see this class of bug by any other means.
    const ownership = chownOwnershipV1({ root, pgDataId, accounts });
    await applyOwnershipV1(ownership, dependencies.chownPath ?? lchown, dependencies.inspectPath ?? lstat);
    steps.push("ownership");

    // --- 2. initdb. `--auth-local=peer` and `--auth-host=reject` decide what the
    // window between initdb and the hba write in step 3 could have allowed:
    // `reject` means there is no TCP authentication method at all, so nothing
    // that reached the cluster in that window could have logged in.
    const initdb = await spawn({ executable: binary("initdb"),
      args: ["-D", paths.data, "-U", "postgres", "-E", "UTF8",
        "--auth-local=peer", "--auth-host=reject", "--no-instructions"],
      timeoutMs: dependencies.initdbTimeoutMs ?? 300_000 });
    if (initdb.code !== 0) refuse(`database_init_initdb_refused:${pgFailureLineV1(initdb.stderr || initdb.stdout)}`);
    steps.push("initdb");

    // --- 3. the layout's configuration, replacing what initdb wrote
    //
    // Written by STAGING + RENAME rather than `writeFile`, because this is a
    // ROOT write into a directory the database account owns, and `writeFile`
    // follows symlinks. The window between `initdb` returning and this write is
    // real, and a D-uid process that planted a link at `postgresql.conf` would
    // redirect a root write to a file of its choosing. See `writeOwnedFileV1`.
    const random = dependencies.randomBytes ?? randomBytes;
    await writeOwnedFileV1(join(paths.data, "postgresql.conf"), layout.postgresqlConf, 0o600, random);
    await writeOwnedFileV1(join(paths.data, "pg_hba.conf"), layout.pgHbaConf, 0o600, random);
    await writeOwnedFileV1(join(paths.data, "pg_ident.conf"), layout.pgIdentConf, 0o600, random);
    // Handed to D AGAIN, and that is not redundant. The three files were just
    // replaced by a root process with `O_EXCL` + `rename`, so they are now owned by
    // the INVOKER — the first handoff happened before `initdb` wrote them and was
    // marked `present: false` for exactly that reason. `configFileOwnershipV1` is
    // the same plan's three entries with the flag cleared, which is the handoff that
    // applies.
    await applyOwnershipV1(configFileOwnershipV1(ownership),
      dependencies.chownPath ?? lchown, dependencies.inspectPath ?? lstat);
    // The runtime's own empty OpenSSL config, which R9b names and the layout pins.
    // A missing pinned file is an OpenSSL failure INSIDE the server, so it is
    // checked before the postmaster starts rather than read out of a log later.
    if (await lstat(join(paths.runtime, "etc", "openssl.cnf")).catch(() => null) === null)
      refuse("database_init_runtime_openssl_missing");

    // --- 4. the temporary postmaster, and everything that needs it, with a stop
    //        on EVERY exit including a refusal or a throw. A postmaster left
    //        running on a half-built data directory is the one state the
    //        installer's undo list cannot reason about.
    //
    //    `-o "-p <port>"` is REQUIRED, not a convenience. MEASURED: the layout's
    //    `port` is used only to compute the socket-path budget, and it is not
    //    written into `postgresql.conf` — a postmaster started without an
    //    explicit `-p` publishes `.s.PGSQL.5432` whatever the layout computed, and
    //    every statement then fails with "connection to server on socket
    //    .../.s.PGSQL.<port> failed: No such file or directory". The symptom
    //    names a missing socket and never mentions the port, so it reads as a
    //    crashed postmaster rather than a port that was never applied.
    const started = await spawn({ executable: binary("pg_ctl"),
      args: ["-D", paths.data, "-l", paths.logFile, "-o", `-p ${port}`, "-w", "-t", "60", "start"] });
    if (started.code !== 0)
      refuse(`database_init_postmaster_refused:${(started.stderr || "").trim().split("\n").pop()?.slice(0, 200)}`);
    steps.push("postmaster");
    let updaterSchemaDigest = "";
    // `failure` is declared OUTSIDE the try so the `finally` can augment an error
    // that is already in flight rather than replace it, and it is rethrown AFTER
    // the finally so the shutdown attempt still happens. See the `finally` below.
    let failure = null;
    try {
      const plan = buildInitStatementsV1({
        databaseName, roles: dependencies.roles ?? [],
        migratorLogin: dependencies.migratorName, migratorGroup: dependencies.migratorGroup,
      });
      for (const statement of plan.roles) {
        await sql({ user: "postgres", database: "postgres", sql: statement });
      }
      await sql({ user: "postgres", database: "postgres", sql: plan.grantMigrator });
      // The database is created only when the check said it was missing, and the
      // check is a row rather than a boolean the caller assumed: a check that
      // returned no row because the query was wrong and a check that returned no
      // row because the database exists are indistinguishable, which is why the
      // create is a separate statement the caller only sends when the row is
      // there.
      const needed = await sql({ user: "postgres", database: "postgres", sql: plan.createDatabase.check });
      if (needed.length > 0) {
        await sql({ user: "postgres", database: "postgres", sql: plan.createDatabase.create });
        steps.push("database-created");
      } else { steps.push("database-present"); }
      await sql({ user: "postgres", database: "postgres", sql: plan.setOwner });
      steps.push("roles");

      // The updater's own DDL, the two installer files only, in the loader's own
      // order. The recorded digest is of the FILE SET rather than of the
      // catalogue: at this moment the schema holds no tables, so a catalogue
      // digest would be a digest of emptiness that a later health check could
      // not distinguish from a schema that had lost every table.
      const ddlFiles = await readUpdaterDdlFilesV1(join(paths.updater, "ddl"),
        ["0001_deployer_role.sql", "0000_bootstrap.sql"]);
      for (const file of ddlFiles) await sql({ user: "postgres", database: databaseName, sql: file.text });
      updaterSchemaDigest = computeUpdaterDdlFileDigestV1(ddlFiles);
      if (!isDigestV1(updaterSchemaDigest)) refuse("database_init_updater_digest_invalid");
      steps.push("updater-ddl");

      // `dependencies.onPostmasterReady` is a hook, and it exists for ONE reason:
      // the SIGKILL test needs a window in which the postmaster is running and the
      // script is still alive. Everything about the run stays real, so killing the
      // script here produces a genuine orphan rather than a staged one.
      if (dependencies.onPostmasterReady) await dependencies.onPostmasterReady({ steps });
      // The service logins' SCRAM VERIFIERS, computed in this process and sent as
      // `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` (Blocker 2 of the M1b review).
      //
      // This replaced psql's `\password`, which read its value from the TERMINAL
      // whenever there was one: on install night (sudo, in Terminal) it printed
      // `Enter new password for user …` on the owner's screen and hung, and an
      // Enter there set an empty password and sent the real one to the server as
      // SQL, which logged it. Now psql never sees a password: the statement carries
      // the verifier, which is what the server stores anyway, so there is nothing
      // to prompt for and nothing secret to log. The password never leaves this
      // process except to the release phase's own verification connection.
      for (const login of logins) {
        const password = secrets[login.name];
        if (typeof password !== "string") refuse("database_init_login_password_missing");
        await sql({ user: "postgres", database: databaseName,
          sql: setVerifierStatementV1(login.name, scramVerifierV1(password)) });
        steps.push(`login:${login.name}`);
      }
    } catch (error) {
      failure = error;
    } finally {
      const stopped = await spawn({ executable: binary("pg_ctl"),
        args: ["-D", paths.data, "-m", "fast", "-w", "-t", "60", "stop"] }).catch(() => null);
      // THE ORIGINAL ERROR IS NOT SWALLOWED (Medium 3). This `finally` runs on a
      // refusal or a throw as well as on success, and it used to overwrite the
      // failing phase's code with `database_init_shutdown_refused` — so an
      // operator debugging a migration that failed saw the shutdown code, named
      // a symptom three steps after the cause, and had no way to learn what the
      // cause was. The stop is still asserted — a postmaster left running on a
      // half-built data directory is the state the undo list cannot reason about
      // — but it is reported as a CAUSE on the error that already happened.
      if (stopped === null || stopped.code !== 0) {
        const detail = stopped === null ? "spawn_failed"
          : (stopped.stderr || "unknown").trim().split("\n").pop()?.slice(0, 160) ?? "unknown";
        if (failure === null) {
          failure = new Error(`database_init_shutdown_refused:${detail}`);
        } else {
          failure = new Error(`${failure.message} (and database_init_shutdown_refused:${detail})`,
            { cause: failure });
        }
      }
    }
    // Rethrown AFTER the shutdown attempt, so the stop is still guaranteed and
    // the operator sees the phase's OWN code first.
    if (failure !== null) throw failure;

    // --- 5. the clean-shutdown proof, read from pg_controldata and NOT from the
    //        exit code. Those are two different claims, and the install journal
    //        records the one the tool that owns the data directory answered.
    const control = await spawn({ executable: binary("pg_controldata"), args: ["-D", paths.data] });
    if (control.code !== 0) refuse("database_init_controldata_refused");
    assertClusterShutDownV1(control.stdout);
    steps.push("shut-down");

    // --- 6. the plant check again, AFTER the init and BEFORE the link. A cluster
    //        containing an entry `initdb` could not have written is refused here
    //        rather than discovered on install night by a postmaster that will not
    //        start. By `lstat`, for the reason `classifyDataDirectoryEntriesV1` gives.
    const after = await classifyDataDirectoryEntriesV1(paths.data);
    if (after.state !== "cluster") refuse(`database_init_planted_file_refused:${after.reason}`);

    // --- 6b. THE COMPLETION RECEIPT, BEFORE the link, and that order is the point.
    //
    //        The record is what makes a same-id retry CONVERGE, and it can only
    //        be written while every value in it is true: the DDL digest is known,
    //        the cluster has answered `pg_controldata` clean, and the plant check
    //        below has passed. Written after those, a record is never a claim
    //        about work that did not happen — and `pg/current`, which is what makes
    //        step 0 look here at all, is written after this. So the two can never
    //        disagree in the direction that matters: a link always has a record
    //        behind it, and a record without a link is invisible (the data
    //        directory is debris, retired and rebuilt).
    //
    //        `0600` and owned by the INVOKER (root in production), for the reason
    //        every file this phase writes inside a D-owned directory is: the write
    //        is a root write into D's tree, so it is staged + renamed and never
    //        follows a link. `chownOwnershipV1` does not cover it — it is written
    //        after the handoffs — so the mode is set at creation, exactly as the
    //        three configuration files are.
    const completionRecord = `${JSON.stringify({ schema: INIT_COMPLETION_RECORD_V1,
      layoutDigest: initLayoutDigestV1(layout, pgDataId), updaterSchemaDigest, clusterShutDownClean: true })}\n`;
    await writeOwnedFileV1(join(paths.data, INIT_COMPLETION_RECORD_V1), completionRecord, 0o600,
      dependencies.randomBytes ?? randomBytes);
    steps.push("completion-record");

    // --- 7. `pg/current`, LAST, by rename so no reader ever sees it half-made.
    //        It is the completion marker step 0 reads: written after every proof,
    //        so a kill at any earlier point leaves no link and the retry sweeps;
    //        a kill after it leaves a complete cluster WITH ITS RECEIPT, which is
    //        exactly the state `convergeCompletedInitV1` finishes rather than
    //        refuses. A link that appeared while this phase ran is refused, never
    //        replaced.
    if (await lstat(currentLink).catch(() => null) !== null) refuse("database_init_current_link_target_refused");
    const staging = join(paths.pgRoot, `.current.${pgDataId}.${(dependencies.randomBytes ?? randomBytes)(6).toString("hex")}.tmp`);
    await symlink(pgDataId, staging);
    await rename(staging, currentLink);
    steps.push("current");

    return Object.freeze({ schema: DATABASE_INIT_RESULT_V1, outcome: "initialized", pgDataId,
      updaterSchemaDigest, clusterShutDownClean: true });
  };
  // One active call per install root: a second init for the same root would race
  // on the same data directory, and the loser would find a half-built cluster and
  // refuse with a message about a planted file.
  if (activeDatabasePhaseCalls.has(request?.root)) refuse("database_init_busy");
  activeDatabasePhaseCalls.add(request?.root);
  try { return await run(); } finally { activeDatabasePhaseCalls.delete(request?.root); }
}

/**
 * THE COMMAND-LINE ENTRY, and it is the port's exact transport (§5.3).
 *
 * `--request <json>` on argv, ONE line on stdin carrying the passwords, and ONE
 * bounded JSON object on stdout. `initializeDatabaseV1` sends precisely that:
 *
 *   spawnWithStdin(executable, [target, "--request", request], input.passwords, …)
 *
 * MEASURED, and this entry could not run it. Both scripts read TWO values from
 * stdin and ignored argv, and the reader they shared (`readBoundedJsonLineV1`)
 * destroyed the stream when it broke out of its `for await` at the end of the
 * first line — so the second read threw `AbortError: The operation was aborted`
 * before reading a byte, and every real spawn returned
 * `database_phase_script_failed:1:The operation was aborted`. Nothing had ever
 * executed either script across the process boundary: the port's own test
 * injects a fake transport, and the real-PostgreSQL lane calls the exported
 * function in-process.
 *
 * `process.argv.slice(2)` and NOT the whole argv, because Node always carries
 * the interpreter and the script path in front and the port sends nothing else.
 * The slice is exactly two elements or the entry refuses, which is the check
 * that makes "the request came from argv" a property rather than a hope.
 */
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  let failure = "database_init_request_refused";
  try {
    const request = readRequestArgumentV1(process.argv.slice(2), MAXIMUM_REQUEST_BYTES_V1,
      "database_init_request_refused");
    // The argv value is TEXT, and `initializeDatabaseV1` takes an OBJECT — so the
    // text is parsed here rather than inside. MEASURED: the entry passed the raw
    // string straight through, `parseDatabasePhaseRequestV1` was handed a string
    // where it expected a record, and every spawn answered
    // `database_init_input_refused` naming an input the caller had spelled
    // correctly. Parsing here keeps one parser — the same `JSON.parse` the port
    // does not do and the same `parseDatabasePhaseRequestV1` the port ran against
    // the identical object — so there is still exactly one place that decides what
    // a request is.
    const passwords = await readBoundedJsonValueV1(process.stdin, MAXIMUM_REQUEST_BYTES_V1,
      "database_init_passwords_refused");
    // The release is named by the REQUEST, not searched for: `root/current` is
    // what the installer staged and what the port's `assertPath` already
    // resolved. Reading the data from anywhere else would let a phase act on a
    // release the installer did not stage.
    const releaseRoot = join(JSON.parse(request).root ?? "", "current");
    process.stdout.write(`${JSON.stringify(await initializeDatabaseV1(JSON.parse(request), passwords,
      await buildInitDependenciesV1(releaseRoot)))}\n`);
    failure = "";
  } catch (error) { failure = error instanceof Error ? error.message : "database_init_failed"; }
  if (failure !== "") { process.stderr.write(`${failure}\n`); process.exitCode = 1; }
}

/**
 * THE PRODUCTION DEPENDENCY SET, and what changed.
 *
 * Before this was a function of a `manifest` argument the entry never passed, so
 * every real run got `roles: []` and `buildInitStatementsV1` refused
 * `pg_phase_role_set_empty` before its first SQL statement (Blocker 3). The role
 * list, the migrator's login and group, the deployer's login, the database name
 * and the port now come from `role-manifest.json` under the RELEASE the request
 * names, read once per process — the phase is one process per install, so a cache
 * would be a second source of truth whose staleness nothing could observe.
 *
 * `planLayout` is the real `planPgClusterLayoutV1`, which this file already
 * imported for its own layout: the release phase's refusal was an omission, not a
 * trust decision, and the bundle already crosses that one file in.
 *
 * `releaseRoot` is `join(request.root, "current")`, so the release the phase acts
 * on is the one the installer staged and the one the request named — not a
 * directory found by search.
 */
export async function buildInitDependenciesV1(releaseRoot, overrides = {}) {
  const manifest = await buildInitDependenciesV1FromReleaseV1(releaseRoot);
  return Object.freeze({ ...manifest, planLayout: (input) => planPgClusterLayoutV1(input), ...overrides });
}

/** The fixture-shaped builder, kept for the lane and for nothing in production. */
export function buildInitDependenciesV1FromManifest(manifest = {}, overrides = {}) {
  return Object.freeze({
    databaseName: manifest.database ?? "control_room",
    migratorName: manifest.migratorLogin ?? "control_room_migrator",
    migratorGroup: manifest.migratorGroup ?? "control_room_schema_owner",
    deployerName: manifest.deployerLogin ?? "control_room_deployer",
    port: manifest.port ?? 5432,
    roles: manifest.roles ?? [],
    ...overrides,
  });
}
