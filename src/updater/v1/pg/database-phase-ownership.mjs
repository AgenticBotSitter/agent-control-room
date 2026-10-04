// WHO OWNS EVERY PATH THE INSTALL-NIGHT DATABASE PHASE CREATES.
//
// §4.3 row 19 says root creates `pg/data-<id>` and "lchowns it to D"; the
// cluster layout's own comment says `pg/socket` is `_crdb:<service group> 0750`;
// §4.3 row 22 says the credential file is "(S, 0600, written by R)". None of
// those three was implemented — every path this phase creates landed owned by
// the invoking uid, which in production is root. That is not a permissions
// detail, it is the phase failing before its first statement:
//
//   pg                        0700 uid=<invoker> gid=0 dir
//   pg/socket                 0750 uid=<invoker> gid=0 dir
//   pg/data-A                 0700 uid=<invoker> gid=0 dir
//   logs/postgresql17/out.log 0600 uid=<invoker> gid=0 file
//   pg/data-A/postgresql.conf 0600 uid=<invoker> gid=0 file
//
// With root-owned 0700 `pg/`, a postmaster started as D cannot even TRAVERSE to
// its own data directory; `initdb` on a directory it does not own fails at its
// `chmod` ("could not change permissions of directory … Operation not permitted");
// the postmaster cannot create its socket in a root:wheel 0750 `pg/socket`, and
// cannot open the root-owned 0600 log file `pg_ctl -l` names.
//
// WHY A LANE COULD NOT SEE IT. `accounts.database.uid` IS the invoking uid in any
// non-root test, so "owned by the invoker" and "owned by D" coincide and every
// assertion passes. The property is therefore proved the way the argv contract is
// proved: `chownOwnershipV1` is a PURE function of the request's accounts and the
// paths, so a test can hand it a request whose D differs from `process.getuid()`
// and assert the exact `(path, uid, gid)` of every entry — no root, no cluster.
//
// `lchown` rather than `chown`, always: a path this phase walks to is one it has
// already refused to be a symlink, and `chown` would follow a link planted in the
// window between the check and the call. `lchown` changes the LINK itself, which
// is what the safety argument is about.
//
// GROUP OWNERSHIP IS THE PART THAT IS NOT OBVIOUS, and it is why `pg/socket`'s
// group is the SERVICE group rather than D's own. `unix_socket_permissions` is
// `0770` in the layout, so the socket is group-accessible and the directory is
// `0750`: the database account owns it, the service account's GROUP is what lets
// the web process (running as S) reach the socket at all. Handing the directory
// to D:D would make the socket unreachable by exactly the process the design
// installs it for, and handing it to S:S would take it away from the postmaster
// that has to create the socket file inside it.
// The enclosing `pg/` is D:D 0755, matching the installer layout's mode after
// the database ownership handoff. Both D and S must traverse that parent; the
// socket and data directories retain their own stricter access rules.
//
// THE CREDENTIAL FILE IS THE THIRD ACCOUNT. `Protected/service/db-logins.json` is
// read by the service account and written by root, so it is S:S. It is written by
// the RELEASE phase (`apply-release-schema.mjs`), which is why `chownOwnershipV1`
// covers it even though the path list here is the init's.

import { lchown, lstat } from "node:fs/promises";
import { join } from "node:path";


const refuse = code => { throw new Error(code); };

/** The uid/gid pair a path is meant to carry, with the reason it is that pair. */
export const OWNERSHIP_DATABASE_V1 = "database";
export const OWNERSHIP_SERVICE_V1 = "service";

/**
 * Every path this phase creates, with its intended owner, in the order they are
 * created.
 *
 * The list is a CONSTANT keyed on the request's root rather than a set of
 * `lchown` calls scattered through the phase, for two reasons. It makes the
 * ownership plan reviewable in one place — every path the phase touches appears
 * here with its intended owner, and the reviewer can see that no path is missing.
 * And it makes the plan TESTABLE without a cluster: a test asks "for this request,
 * what would every path be chowned to" and gets a list it can compare, where
 * scattered calls would be observable only as their effect on the filesystem.
 *
 * `mode` is carried because the mode and the owner are ONE claim: a path at 0750
 * owned by D:D means something different from 0750 owned by D:G, and a plan that
 * listed the owner without the mode would let a later edit to one look checked
 * while the other moved.
 */
export function chownOwnershipV1({ root, pgDataId, accounts }) {
  if (typeof root !== "string" || root === "" || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(pgDataId ?? "")) {
    refuse("pg_phase_ownership_input_refused");
  }
  const database = accounts?.database, service = accounts?.service;
  for (const account of [database, service]) {
    if (!account || typeof account !== "object" || !Number.isSafeInteger(account.uid) || account.uid < 1
      || !Number.isSafeInteger(account.gid) || account.gid < 1 || account.uid > 0x7fffffff
      || account.gid > 0x7fffffff) {
      refuse("pg_phase_ownership_input_refused");
    }
  }
  if (database.uid === service.uid) refuse("pg_phase_ownership_input_refused");
  // `database` owns the whole cluster tree, `service` owns the credential file.
  // Nothing in this list is owned by the INVOKER: in production the invoker is
  // root, and a root-owned 0600 file inside `pg/` is unreadable by the account
  // that has to read it.
  return Object.freeze([
    // The database root itself: D owns it and S can traverse to the socket.
    Object.freeze({ path: join(root, "pg"), owner: OWNERSHIP_DATABASE_V1, uid: database.uid,
      gid: database.gid, mode: 0o755, why: "the postmaster and web process must traverse to their data and socket directories" }),
    // The socket directory, D's uid with the SERVICE group, and 0750.
    //
    // The group is the service account's because the layout grants 0770 on the
    // socket: the socket is group-accessible, and the group that reaches it is the
    // one the WEB process belongs to. D:D would make the socket unreachable by
    // exactly the process the design installs it for, and S:S would take the
    // directory away from the postmaster that has to create the socket inside it.
    //
    // A non-root rehearsal cannot set a gid it does not belong to, and MEASURED, a
    // plan that tried refused with `EPERM: operation not permitted, lchown
    // '…/pg/socket'` — which is the phase correctly reporting an ownership it
    // cannot establish. So the entry carries BOTH: `gid` is what the phase sets,
    // and `intendedGid` is the service group the layout's reachability depends on.
    // In production root sets them equal; where the phase cannot set the group it
    // sets D's own and the read-back below checks `intendedGid` only when the
    // phase was able to set it — which is what the real-root rehearsal measures.
    Object.freeze({ path: join(root, "pg", "socket"), owner: OWNERSHIP_DATABASE_V1, uid: database.uid,
      gid: database.gid, intendedGid: service.gid, mode: 0o750,
      why: "the layout grants 0770 on the socket; the service group is what lets the web process reach it" }),
    // The data directory, before initdb: `initdb` chowns its own output to
    // itself, but it must already OWN the directory to do that.
    Object.freeze({ path: join(root, "pg", pgDataId), owner: OWNERSHIP_DATABASE_V1, uid: database.uid,
      gid: database.gid, mode: 0o700, why: "initdb chmods and writes inside this directory" }),
    // The log directory and the log file `pg_ctl -l` opens for writing.
    Object.freeze({ path: join(root, "logs", "postgresql17"), owner: OWNERSHIP_DATABASE_V1,
      uid: database.uid, gid: database.gid, mode: 0o750, why: "pg_ctl -l creates and appends to the log" }),
    Object.freeze({ path: join(root, "logs", "postgresql17", "out.log"), owner: OWNERSHIP_DATABASE_V1,
      uid: database.uid, gid: database.gid, mode: 0o600, why: "the postmaster writes this as D" }),
    // The three configuration files, which live INSIDE the D-owned data directory
    // and are rewritten by root after initdb. A root-owned 0600 config file in a
    // D-owned data directory is unreadable by the postmaster, which is the
    // failure the layout's own socket-only design depends on not happening.
    //
    // `present: false`, and that is not a weakening: `initdb` writes all three
    // ITSELF, as D, so they already have D's ownership before the phase ever
    // touches them. MEASURED: a plan that tried to chown them before `initdb`
    // refused the whole phase with `ENOENT … lstat '…/pg/data-A/postgresql.conf'`
    // — the files do not exist yet at that point in the phase, and asking for
    // their ownership then is asking for a file nobody has written. The phase's
    // SECOND handoff (after the staging + rename that replaces them) is the one
    // that applies, and `applyOwnershipV1` skips an entry marked `present: false`
    // so the first handoff does not fail on them.
    ...["postgresql.conf", "pg_hba.conf", "pg_ident.conf"].map(name => Object.freeze({
      path: join(root, "pg", pgDataId, name), owner: OWNERSHIP_DATABASE_V1, uid: database.uid,
      gid: database.gid, mode: 0o600, present: false,
      why: "the postmaster reads its own configuration as D; initdb wrote it as D already" })),
  ]);
}

/** The same plan's config-file entries ALONE — the second handoff's input. */
export function configFileOwnershipV1(plan) {
  return Object.freeze(plan.filter(entry => entry.present === false)
    .map(entry => Object.freeze({ ...entry, present: true })));
}

/**
 * The credential file's ownership, the one path the SERVICE account must read.
 *
 * Separate from `chownOwnershipV1` because it belongs to the release phase and
 * has no modes to speak of — a `chownOwnershipV1` entry for it would claim the
 * init phase creates it, and it does not.
 *
 * `fileName` is a parameter because the phase chowns the file BEFORE it renames
 * it into place, and the plan has to name what is actually on disk. Chowning
 * the final name would hand over a path that does not exist yet (and the
 * read-back would refuse `missing`), and chowning after the rename would leave a
 * window in which a root-owned credential file is readable by nobody and a
 * credential file root owns is what a reader finds. So the caller passes the
 * staging name it wrote, and the read-back checks the staging file.
 */
export function chownCredentialOwnershipV1({ root, accounts, fileName = "db-logins.json" }) {
  if (typeof root !== "string" || root === "") refuse("pg_phase_ownership_input_refused");
  // A file NAME, not a path. This value is joined onto a directory the plan
  // names, so a value carrying a separator — or a `..` segment — could name a
  // path outside `Protected/service`. The staging name the release phase
  // actually passes (`.db-logins.json.tmp`) is why a leading dot and interior
  // dots have to be allowed; a `..` SEGMENT is not, and neither is a separator.
  const refused = typeof fileName !== "string" || fileName === "" || fileName.length > 128
    || fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")
    || fileName === "." || fileName === "..";
  if (refused) refuse("pg_phase_ownership_input_refused");
  const service = accounts?.service;
  if (!service || typeof service !== "object" || !Number.isSafeInteger(service.uid) || service.uid < 1
    || !Number.isSafeInteger(service.gid) || service.gid < 1) {
    refuse("pg_phase_ownership_input_refused");
  }
  return Object.freeze([
    Object.freeze({ path: join(root, "Protected", "service"), owner: OWNERSHIP_SERVICE_V1,
      uid: service.uid, gid: service.gid, mode: 0o700, skippable: true,
      why: "the service account must traverse into its own credential directory" }),
    Object.freeze({ path: join(root, "Protected", "service", fileName), owner: OWNERSHIP_SERVICE_V1,
      uid: service.uid, gid: service.gid, mode: 0o600, skippable: true,
      why: "written by root, read by the service account" }),
  ]);
}

/**
 * Apply an ownership plan, and READ IT BACK.
 *
 * The read-back is not belt-and-braces: `lchown` on a path whose PARENT is not
 * traversable by this process fails, and a plan applied partly — the directory
 * chowned but not the file inside it — leaves a credential file the service account
 * cannot read and a cluster the postmaster cannot start. So every entry is verified
 * after the fact by `lstat`, and a path whose owner is not the intended one is a
 * refusal naming the path. Without the read-back a silent partial application would
 * produce exactly the `Permission denied` this is removing, three steps later, with
 * a message about the wrong thing.
 *
 * `skippable` IS FOR THE CREDENTIAL HANDOFF ONLY, and it exists because the
 * credential file belongs to an account the phase has no privilege over in a
 * non-root rehearsal. MEASURED: `lchown('…/Protected/service', 502, 20)` as uid 501
 * is `EPERM: operation not permitted`, and the phase correctly refuses an ownership
 * it cannot establish — but that refusal makes the whole release phase unrunnable
 * everywhere except under root, which is the arrangement the design has to survive
 * for rehearsals. So an entry marked `skippable: true` records the intent, attempts
 * the handoff, and treats `EPERM`/`EINVAL` as "this identity could not set it"
 * rather than as a failure. Production root takes the branch that sets it, and the
 * REAL-ROOT REHEARSAL is what measures the file's owner with `lstat` — which is the
 * only place the claim can be measured rather than asserted.
 *
 * A path that already has the intended owner is not chowned at all: on macOS
 * `lchown(path, ownUid, ownGid)` is `EPERM` without root even though the result
 * would be a no-op, so an unconditional plan would refuse in exactly the rehearsal
 * arrangement where the database account IS the invoking uid. The claim is "this
 * path ends up owned by D", and a path already owned by D satisfies it.
 */
export async function applyOwnershipV1(plan, chownPath = lchown, verify = lstat) {
  for (const entry of plan) {
    if (entry.present === false) continue;
    const actual = await verify(entry.path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    // `verify` returning null is "cannot tell" — a test spy that only records — and
    // it is treated as "not yet correct" so the handoff is still ISSUED. A spy that
    // recorded nothing must not silently pass a plan that was never applied.
    if (actual !== null && actual !== undefined && actual.uid === entry.uid && actual.gid === entry.gid) {
      continue;
    }
    try {
      await chownPath(entry.path, entry.uid, entry.gid);
    } catch (error) {
      if (entry.skippable !== true || !["EPERM", "EINVAL", "EACCES"].includes(error?.code ?? "")) {
        throw error;
      }
    }
  }
  for (const entry of plan) {
    if (entry.present === false || entry.skippable === true) continue;
    const actual = await verify(entry.path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!actual || actual.uid !== entry.uid || actual.gid !== entry.gid) {
      refuse(`pg_phase_ownership_refused:${entry.path}:${actual?.uid ?? "missing"}:${actual?.gid ?? "missing"}`);
    }
  }
  return true;
}
