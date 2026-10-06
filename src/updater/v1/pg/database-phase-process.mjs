// How the two install-night database scripts reach PostgreSQL: the pinned
// environment, the Seatbelt profile, the privilege drop, and the two-phase
// `postgres` session.
//
// This file is the half of §5.3 that is about the PROCESS, and it is shared
// rather than duplicated for the same reason the contract is shared: the
// installer's guarantee is "the database account ran this, under this profile,
// with this environment", and that guarantee is only as good as the single
// place the profile and environment are written.
//
// THE PRIVILEGE DROP IS THE POINT. Root spawns this script; the script must
// never run SQL as root. It drops to the database account itself, with
// `sandbox-exec` in between, so the Seatbelt profile is entered AFTER the
// privilege drop (`posix_spawn` applies uid/gid before the sandboxed program
// starts). A root-run `psql` would give the release's SQL the superuser it must
// never have, and no amount of later GRANT/REVOKE takes that back.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const refuse = code => { throw new Error(code); };

/**
 * The `initdb` / `pg_ctl` / `psql` binary set, resolved from the VENDORED
 * runtime and never from PATH.
 *
 * `initdb` is the binary that decides where `share` and `pkglibdir` are: it
 * resolves both relative to its own image, which is why the vendored runtime
 * must ship them next to `bin/`. A Homebrew `initdb` against a vendored data
 * directory would produce a cluster whose extension and timezone lookups
 * resolve into a different tree — the exact class of bug the runtime vendor
 * exists to prevent.
 */
export const PG_FAMILY_BINARIES_V1 = Object.freeze([
  "initdb", "pg_ctl", "pg_controldata", "psql", "pg_isready", "createdb", "psql",
]);

/** The account-independent environment every PG-family process gets, plus the pins. */
export function pgFamilyEnvironmentV1(layoutEnvironment) {
  if (!layoutEnvironment || typeof layoutEnvironment !== "object") refuse("pg_phase_layout_required");
  // The layout's own environment IS the whole environment: no PATH (so nothing
  // can be found outside the runtime by name), no HOME, no locale owner
  // control, and the OpenSSL/Kerberos pins. LC_ALL is load-bearing rather than
  // cosmetic: a postmaster started without a valid locale refuses to start at
  // all, with "postmaster became multithreaded during startup".
  return { ...layoutEnvironment };
}

/**
 * Run one PG-family program as the given identity, inside the profile.
 *
 * `sandbox-exec` is spawned with `uid`/`gid` already set, which is the order the
 * design wants: the profile describes what the *account* can do, and applying
 * it to a root process would describe a different thing.
 *
 * A UID OF 0 IS ALLOWED, and only for the DEPLOYER identity, and this is not a
 * hole in the guard. The peer map has three lines and the second is
 * `cr root control_room_deployer`: the deployer's entire authority is "a root
 * process connected on the local socket", it holds no password, and the updater
 * loader refuses the role outright if a verifier ever appears. So a spawn as uid
 * 0 running the DEPLOYER's statements is the designed path, and refusing it here
 * would make the updater's own DDL unrunnable. What is refused is uid 0 for
 * anything else: the superuser half of the phase runs as the DATABASE ACCOUNT,
 * never as root, and a caller that asked for root to run `CREATE ROLE` or the
 * release ledger is asking for the thing the design forbids.
 *
 * `role` is therefore REQUIRED, and it is what the uid is checked against. A
 * caller that cannot name the role cannot get a root spawn at all.
 *
 * Every profile parameter the file names is passed. That is not tidiness: a
 * profile that references an undefined `(param ...)` fails to COMPILE, and
 * sandbox-exec reports that as
 *
 *   invalid data type of path filter; expected pattern, got boolean
 *
 * with exit 65 and no filename. A caller that passes a subset does not get a
 * looser sandbox; it gets a database that never starts, with a message that
 * names neither the profile nor the parameter. MEASURED on macOS 26.6.2.
 */
export function spawnPgFamily(options) {
  const { executable, args, environment, uid, gid, profile, profileParameters, stdio = ["ignore", "pipe", "pipe"] } = options;
  if (typeof executable !== "string" || !executable.startsWith("/")) refuse("pg_phase_executable_invalid");
  if (!Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) {
    refuse("pg_phase_arguments_invalid");
  }
  const deployer = options.role === "deployer";
  if (deployer !== (uid === 0 && gid === 0)) {
    // Either a root spawn that is not the deployer, or a non-root spawn that
    // claims to be. Both are refused by name, because "it was root" is the fact
    // an operator needs and "uid 0" is not an explanation.
    if (uid === 0 || gid === 0) refuse("pg_phase_root_identity_refused");
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
      refuse("pg_phase_identity_refused");
    }
  }
  if (typeof profile !== "string" || !profile.startsWith("/")) refuse("pg_phase_profile_required");
  if (!Array.isArray(profileParameters) || profileParameters.length === 0) refuse("pg_phase_profile_parameters_required");
  if (options.onSpawn !== undefined && typeof options.onSpawn !== "function") refuse("pg_phase_spawn_hook_invalid");
  // Test-only observation point, absent in production: the kill-at-every-statement
  // lane uses it to SIGKILL the phase just BEFORE this child starts (a kill between
  // statements) or a moment after (a kill mid-statement). It is told what is about
  // to run — program, argv and the SQL program, which no longer carries any
  // password — so it can name a kill point, and it cannot change the child.
  options.onSpawn?.(Object.freeze({ executable, args: Object.freeze([...args]),
    stdin: typeof options.stdin === "string" ? options.stdin : "" }));
  return new Promise((resolve, reject) => {
    // `detached: true` is `setsid()` in the child: a NEW SESSION with NO
    // CONTROLLING TERMINAL, so no PG-family program can ever open `/dev/tty`.
    //
    // MEASURED by the M1b review (probe G): the installer runs under `sudo` in
    // Terminal, the children inherited that terminal, and psql's `\password`
    // opened `/dev/tty` and printed `Enter new password for user …` on the
    // owner's screen and waited forever. Pressing Enter set an empty password and
    // fed the real one to the server as SQL, which logged it in `out.log`. The
    // phase no longer sends a password to psql at all (see `scramVerifierV1`),
    // and this is the second, independent half: whatever a PG tool tries to
    // prompt for, there is no terminal for it to prompt on. A prompt then fails
    // instead of blocking, and `-w` on every connection makes the failure a code.
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profile,
      ...profileParameters.flatMap(([name, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string" || value.includes("\0")) {
          refuse("pg_phase_profile_parameter_invalid");
        }
        return ["-D", `${name}=${value}`];
      }), "--", executable, ...args],
    { uid, gid, env: environment, shell: false, stdio, detached: true });
    let stdout = "", stderr = "", bytes = 0, settled = false;
    const MAXIMUM = 8 * 1024 * 1024;
    const finish = (action, value) => { if (settled) return; settled = true; clearTimeout(timer); action(value); };
    const append = (current, chunk) => {
      bytes += chunk.length;
      // A diagnostic stream is bounded for the same reason a request is: this is
      // a root-run process reading output from a sandboxed program.
      if (bytes > MAXIMUM) { child.kill("SIGKILL"); finish(reject, new Error("pg_phase_output_limit")); return current; }
      return current + chunk.toString("utf8");
    };
    child.stdout?.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(reject, error));
    child.once("close", (code, signal) => finish(resolve, { code, signal, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // A timeout is a refusal, never a partial success: a postmaster that was
      // still starting when we gave up may have a data directory half written,
      // and the caller's next step would be to start it again.
      finish(reject, new Error("pg_phase_timeout"));
    }, options.timeoutMs ?? 300_000);
    // `stdin` is a PROGRAM, written once and closed. It is how SQL reaches
    // `psql` without appearing in argv (and therefore in `ps` output). Writing it after the
    // handlers are attached means a program larger than the pipe buffer cannot
    // deadlock: `end` is asynchronous and the reader is already consuming.
    if (options.stdin !== undefined) {
      if (typeof options.stdin !== "string" || options.stdin.length > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(reject, new Error("pg_phase_stdin_refused"));
      } else { child.stdin.end(options.stdin); }
    }
  });
}

/**
 * The profile parameters for the postgres role, derived from the layout.
 *
 * `RUNTIME_ROOT`, `RELEASE_ROOT` and `UPDATER_ROOT` are not used by the write
 * rules but ARE named by the profile's exec rule, so they are passed here
 * rather than left to the caller to remember. The socket and data roots come
 * from the layout, which is the single place that decides them.
 *
 * `RUNTIME_ROOT` IS THE REALPATH OF THE RUNTIME TREE, and that is MEASURED, not
 * stylistic. `sandbox-exec` resolves a `(subpath ...)` pattern against the path
 * as written, BEFORE following symlinks, so a `(subpath "<root>/runtime")`
 * that reaches a vendored tree through a symlink denies the very binary it was
 * written to allow. The failure is silent about the cause:
 *
 *   sandbox-exec: execvp() of '<root>/runtime/pg-current/bin/initdb' failed:
 *   Operation not permitted
 *
 * — the same message a genuinely forbidden binary produces, so a reader has no
 * way to tell a mis-scoped rule from a correct refusal. In production
 * `runtime/pg-current -> runtime/pg-17.11` resolves INSIDE `runtime/`, so the
 * two spellings coincide and the bug is invisible there; it appears the moment
 * the runtime lives anywhere else, which is exactly the rehearsal's arrangement.
 * Resolving here means the rule names what the kernel will open.
 */
export function postgresProfileParametersV1({ root, layout, logDirectory, realpath = realpathSync }) {
  const runtime = safeRealpath(realpath, join(root, "runtime"));
  return Object.entries({
    RUNTIME_ROOT: runtime,
    RELEASE_ROOT: join(root, "releases"),
    UPDATER_ROOT: join(root, "updater"),
    DATA_ROOT: join(root, "pg"),
    SOCKET_ROOT: layout.socketDirectory,
    // `service-postgres.sb` names `(param "WORKING_DIRECTORY")`, and an unset
    // param is a boolean to sandbox-exec, so every phase spawn was refused
    // `invalid data type of path filter; expected pattern, got boolean` (rv-9b
    // B2). The phase spawns with `cwd: <root>/pg`, so that is the value.
    WORKING_DIRECTORY: join(root, "pg"),
    OUT_LOG: join(logDirectory, "out.log"),
    ERR_LOG: join(logDirectory, "err.log"),
  }).sort(([left], [right]) => left.localeCompare(right, "en"));
}

/**
 * The real path of an existing directory, or a refusal.
 *
 * A directory that does not exist is NOT tolerated: the profile parameters are
 * built before the runtime is vendored in a rehearsal whose root is assembled in
 * a different order, and a path that will not resolve yet would silently fall
 * back to the symlink spelling and produce the denial above. Failing here names
 * the missing directory instead.
 */
function safeRealpath(realpath, path) {
  try { return realpath(path); } catch { throw new Error("pg_phase_runtime_root_unresolved"); }
}

/**
 * A statement that is EXPECTED to be refused, reported as a value.
 *
 * A guard that can only be exercised through an exception is a guard nobody
 * writes a test for, so every "this login must not be able to" assertion in
 * this phase goes through here and asserts on the SQLSTATE the SERVER returned.
 * The refusal is a return value, never a thrown error, because a refusal is the
 * expected outcome of the call and a `null` — the statement succeeded — is the
 * finding worth failing a test over.
 */
export async function sessionRefusalV1(runSql) {
  try { await runSql(); } catch (error) {
    return Object.freeze({ refused: true,
      sqlstate: /^pg_phase_sql_refused:([0-9A-Z]{5}|unknown)$/u.exec(error?.message ?? "")?.[1] ?? "unclassified",
      message: String(error?.message ?? "").slice(0, 200) });
  }
  return Object.freeze({ refused: false, sqlstate: "", message: "" });
}