// `pg/postmaster-pid.mjs` — who is at the pid a `postmaster.pid` (or socket
// lock) names, and the two file-format questions that decide it.
//
// WHY THIS IS ITS OWN FILE. The identities below are used by TWO callers that
// cannot see each other:
//
//   `pg/init-database.mjs`          the install-night init phase, and
//   `pg/first-owner-ports.mjs`      the `retireDatabase` port the installer calls
//                                   on the undo path, which is bundled into the
//                                   updater CLI.
//
// `first-owner-ports.mjs` must not import `init-database.mjs`: that module is a
// BUNDLE ENTRY (`policy/bundle.json`), and the bundle's trust rule is that the
// updater carries no release code and no TypeScript. Pulling the init phase in
// would drag `pg-cluster-layout.ts` and the whole phase dependency graph into
// the CLI's `lib/install-steps.mjs` graph. So the two files that decide "is this
// pid ours" live here, with no imports beyond `node:child_process`, and both
// callers import them.
//
// WHAT IS IN HERE, and why each answer is kept separate. After a power cut or a
// restart the pid file SURVIVES and its pid is RECYCLED onto whatever the OS
// starts next — possibly a process of D's own, possibly another cluster's
// postmaster. So "is that pid alive" is not "is that our postmaster": the live
// process at that pid is looked up in the PROCESS TABLE and only something
// provably a program of this install's runtime, on this data directory, is ever
// signalled. Nothing here signals anything. Signalling lives in the caller,
// because only the caller knows the bootout, and only the init phase has one.

import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * `postmaster.pid`, read the way PostgreSQL writes it, and only the fields this
 * decision needs.
 *
 * Line 1 is the pid and line 2 is the DATA DIRECTORY. Both are read BY POSITION,
 * and the position was MEASURED rather than recalled — the first version of this
 * function read the data directory off line 4, which is the PORT:
 *
 *        1  44236                                          <- pid
 *        2  /private/tmp/pidfmt/data                       <- data directory
 *        3  1790811618                                     <- start time
 *        4  59919                                          <- port
 *        5  /private/tmp/pidfmt                            <- socket directory
 *        6  localhost                                      <- listen address
 *        7  295089419 1077542916                           <- shmem key/offset
 *        8  ready
 *
 * A positional read of the WRONG line is not a small error in a sweep: a
 * permissive parser would read the port as a path, and a strict one refuses
 * every orphan it is supposed to recover from.
 *
 * `matchesThisData` is the check that makes the sweep safe, and it is an EXACT
 * comparison rather than a "contains" test: the pid file sits inside the data
 * directory, so a substring test would match every file and approve every kill.
 *
 * A NEGATIVE pid is a STANDALONE backend's. `initdb` runs `postgres --boot` and
 * `postgres --single`, and each writes `-<pid>` on line 1; MEASURED `-59002`
 * during `initdb` on 17.11. PostgreSQL reads its own file the same way (the
 * absolute value is the pid), so `standalone` is kept and the pid is the absolute
 * value. Treating the minus sign as "unreadable" wedged every retry after a
 * power cut inside `initdb`, because the file outlives the process — and it
 * wedges the installer's own clean-up in exactly the same way.
 *
 * An EMPTY or torn file (a crash mid-write) returns `null`, which is NOT a
 * refusal on its own. Both callers have already proved, before asking, that the
 * directory is this phase's own debris, and the process-table sweep that follows
 * finds anything still working on it by argv.
 *
 * The same eight-line format is written to the SOCKET lock file
 * (`.s.PGSQL.<port>.lock`), so this reads that one too.
 */
export function readPostmasterPidFileV1(text, dataDirectory) {
  const lines = String(text ?? "").split("\n");
  const first = (lines[0] ?? "").trim();
  const pid = Math.abs(Number(first));
  const recorded = (lines[1] ?? "").trim();
  if (!/^-?[0-9]{1,10}$/u.test(first) || !Number.isSafeInteger(pid)
    || pid < 1 || pid > 0x7fffffff || recorded === "" || recorded.includes("\0")) {
    return null;
  }
  return Object.freeze({ pid, standalone: first.startsWith("-"), dataDirectory: recorded,
    matchesThisData: recorded === dataDirectory });
}

/**
 * The one non-boolean answer `processExists` can give, and the only string.
 *
 * `kill(pid, 0)` is the zero-signal liveness probe: it performs the permission
 * and existence checks of `kill(2)` and delivers no signal. Its three outcomes
 * are three different answers and are kept as three, because the third must NOT
 * be read as the second. A postmaster owned by another account is still a
 * postmaster holding the data directory, and treating EPERM as death retires a
 * directory out from under a live server.
 *
 * IN-PROCESS, not `/bin/kill -0`: `/bin/kill` exits 1 for BOTH "no such process"
 * and "not permitted", so a non-root rehearsal read a foreign live postmaster as
 * dead. `process.kill` keeps the two errors apart.
 */
export const PROCESS_EXISTS_PERMISSION_DENIED_V1 = "epdenied";

export async function processExistsV1(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === "EPERM") return PROCESS_EXISTS_PERMISSION_DENIED_V1;
    return false;
  }
}

/** A `ps` that failed yields an EMPTY table, which reads as "nothing is there". */
export async function listProcessesV1() {
  const text = await new Promise(resolveRun => {
    const child = spawn("/bin/ps", ["-axww", "-o", "pid=,ppid=,uid=,command="],
      { stdio: ["ignore", "pipe", "ignore"], env: { LC_ALL: "C" } });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", () => resolveRun(""));
    child.once("close", code => resolveRun(code === 0 ? stdout : ""));
  });
  return text.split("\n").map(line => /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s(.*)$/u.exec(line))
    .filter(Boolean).map(([, pid, ppid, uid, command]) => Object.freeze({
      pid: Number(pid), ppid: Number(ppid), uid: Number(uid), command: command.trim() }));
}

/**
 * A program of this install's VENDORED runtime, and only of that runtime.
 *
 * The three accepted shapes are all real, and all MEASURED on install night:
 * the program itself, the child that has been `exec`'d through the Seatbelt
 * profile but has not reached its own exec yet, and `pg_ctl`'s `/bin/sh -c exec
 * "<bin>/postgres" -D "<data>"` wrapper. The last one is a `sh` that is ABOUT to
 * become a runtime program, so it is accepted; a `sh` that is not about to is
 * not, and neither is anything outside the runtime's own bin directories.
 */
export function isRuntimeProgramCommandV1(command, binDirectories) {
  return binDirectories.some(directory => command.startsWith(`${directory}/`)
    || (command.startsWith("/usr/bin/sandbox-exec ") && command.includes(` -- ${directory}/`))
    || (/^(?:\/bin\/)?sh -c (?:exec )?"/u.test(command) && command.includes(`"${directory}/`)));
}

/** The quoted and unquoted forms, because `pg_ctl` and `postgres` write both. */
export function namesDataDirectoryV1(command, data) {
  return command.includes(` -D ${data} `) || command.endsWith(` -D ${data}`) || command.includes(` -D "${data}"`);
}

/** Every runtime program on this data directory as this account, plus descendants. */
export function pgProcessesOnDataDirectoryV1(rows, { data, binDirectories, uid }) {
  const matches = rows.filter(row => row.uid === uid
    && isRuntimeProgramCommandV1(row.command, binDirectories) && namesDataDirectoryV1(row.command, data));
  const selected = new Set(matches.map(row => row.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid) && row.uid === uid) { selected.add(row.pid); grew = true; }
    }
  }
  return Object.freeze([...selected].sort((left, right) => left - right));
}

/**
 * Who is at the pid a `postmaster.pid` (or socket lock) names, read from the
 * process table — never from `kill -0` alone, which cannot tell our postmaster
 * from whatever inherited its pid after a restart.
 *
 *   gone                  no such process
 *   foreign               not a program of this install's runtime (a recycled pid)
 *   ours                  a PG program of this runtime on THIS data directory, as D,
 *                         or a descendant of one
 *   not_database_account  a PG program of this runtime on THIS directory, not D's
 *   other_cluster         a PG program of this runtime whose argv names ANOTHER `-D`
 *   unattributed          a program of this runtime naming no data directory
 *
 * The last two are why a pid is not an identity: `other_cluster` is the pid
 * recycled onto ANOTHER cluster's postmaster (which the pid file in THIS
 * directory therefore does not own), and `unattributed` is an orphaned standalone
 * backend, whose stdin is gone so it exits on its own.
 */
export function identifyRecordedProcessV1(pid, rows, { data, binDirectories, uid }) {
  const row = rows.find(entry => entry.pid === pid);
  if (row === undefined) return Object.freeze({ kind: "gone", uid: -1 });
  const answer = kind => Object.freeze({ kind, uid: row.uid });
  if (pgProcessesOnDataDirectoryV1(rows, { data, binDirectories, uid }).includes(pid)) return answer("ours");
  if (!isRuntimeProgramCommandV1(row.command, binDirectories)) return answer("foreign");
  if (namesDataDirectoryV1(row.command, data)) return answer("not_database_account");
  if (/ -D "?\//u.test(row.command)) return answer("other_cluster");
  return answer("unattributed");
}

/**
 * The directory that decides "is a program of this runtime one of OURS".
 *
 * The install root is trusted input (the phase's own root) and the vendored
 * runtime lives under it, so the bin directories are derived rather than
 * configured: a caller cannot pass a bin directory that reaches outside the
 * root, and there is no second place to keep the answer in step.
 */
export function runtimeBinDirectoriesV1(root) {
  return Object.freeze([join(root, "runtime", "pg-current", "bin"), join(root, "runtime", "pg", "bin")]);
}
