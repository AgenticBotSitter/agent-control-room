// THE OWNERSHIP THE PRODUCT ACTUALLY WRITES, as one stand-in for the guard's
// `stat`.
//
// WHY THIS EXISTS, and why it is not a convenience constant. The rescue guard
// validates custody before it stops a service, so a stand-in that answers
// whatever makes the guard's own expectation true can never fail the test that
// uses it. That is exactly what happened: the stand-in answered uid 0 for every
// path that was not `*data-p*`, which asserted that `pg/` is ROOT-owned, while
// `chownOwnershipV1` (`database-phase-ownership.mjs:92-95`) hands `pg/` to the
// DATABASE ACCOUNT so the postmaster can traverse into its own tree. The guard
// then required the convenience constant, the fixture asserted it, and every
// rescue on a real installation refused. One argument, inverted, and a
// production-only 100% refusal.
//
// The rule this module enforces for every caller: a guard that validates a
// custody property must be exercised against the ownership the PRODUCING code
// writes, read out of that code rather than remembered.
//
//   path                                   uid    mode   written by
//   $ROOT                                  0      0755   installer.mjs createLayout ["", 0o755, rootOwner]
//   $ROOT/releases                         0      0750   installer.mjs createLayout ["releases", 0o750, {uid:0}]
//   $ROOT/releases/<id>                    0      0550   attended-source.mjs stageTree (rootUid, dirs 0550)
//   $ROOT/releases/<id>/… (file)           0      0440   stageTree modeForFile (0o500 -> 0o550, else 0o440)
//   $ROOT/pg                               D      0700   database-phase-ownership.mjs chownOwnershipV1
//   $ROOT/pg/socket                        D      0750   chownOwnershipV1, and installer.mjs createLayout
//   $ROOT/pg/data-<id>                     D      0700   chownOwnershipV1
//   $ROOT/pg/data-<id>/{base,global,pg_wal} D     0700   MEASURED, initdb on the pinned 17.11 runtime
//   $ROOT/pg/data-<id>/pg_wal/archive_status D    0700   MEASURED, initdb, present in every cluster
//   $ROOT/pg/data-<id>/<config file>       D      0600   chownOwnershipV1, and MEASURED on 17.11
//
// `D` is the database account, and the guard resolves it from the root-held
// PostgreSQL plist rather than trusting this constant, so the stand-in's `D` is
// the same uid the guard's `id -u` answers with.
//
// GROUP OWNERSHIP IS DELIBERATELY NOT MODELLED. The guard reads `%u` and the
// mode and never the gid, and the group's whole point is in the code: `pg/` and
// the data tree are D:D, `pg/socket` is D:<service group> so the web process
// can reach a socket the layout grants 0770, and `releases/` is 0:<service group>.
// Modelling a gid the guard never reads would be asserting a claim nothing
// checks.

/** uid 0. Root-owned by construction in production; the invoker is root. */
export const GUARD_ROOT_UID_V1 = "0";

/** The uid the guard's `id -u` stand-in answers for the database account. */
export const GUARD_DATABASE_UID_V1 = "123";

/** The account name the fixture's root-held PostgreSQL plist carries. */
export const GUARD_DATABASE_ACCOUNT_V1 = "test-database";

/**
 * The shell body of a `stat` stand-in that answers the ownership above.
 *
 * `mtime` is the `%u`-less form the caller needs, because each fixture keeps its
 * heartbeat clock somewhere different (an env default, a file the test rewrites,
 * a constant). `overrides` are damage cases: each one is matched BEFORE the model
 * so a test can make exactly one path wrong without restating the whole shape,
 * which is what a hand-written per-test `stat` always ends up doing.
 *
 * @param {{ mtime?: string, overrides?: ReadonlyArray<{ match: string, uid: string, mode: string }> }} input
 */
export function guardStatStandInV1({ mtime = 'echo "${GUARD_MTIME:-0}"', overrides = [] } = {}) {
  const uid = GUARD_DATABASE_UID_V1;
  return [
    `case "$2" in`,
    `  %m) ${mtime} ;;`,
    `  *) case "$3" in`,
    ...overrides.map(({ match, uid: overUid, mode }) => `    ${match}) echo "${overUid} ${mode}" ;;`),
    // `releases/**`: the directory the installer creates at 0750, and every
    // entry `stageTree` writes inside it at rootUid with the service group. A
    // file is 0440 unless the release marked it executable, which stageTree
    // renders 0550; the guard forbids only group/world writes, so both are
    // accepted and both are what the product writes.
    `    */releases|*/releases/*) case "\${3##*/}" in`,
    `      *.json|*.js|*.mjs) echo "${GUARD_ROOT_UID_V1} 440" ;;`,
    `      *) echo "${GUARD_ROOT_UID_V1} 550" ;;`,
    `    esac ;;`,
    // Everything under `pg/`, INCLUDING `pg/` itself. This is the arm the old
    // stand-in got wrong: `pg/` does not match `*data-p*`, so it fell through to
    // the root-owned answer and the guard's root expectation was confirmed by
    // its own fixture.
    `    */pg|*/pg/*) case "\${3##*/}" in`,
    `      socket) echo "${uid} 750" ;;`,
    `      PG_VERSION|pg_control|pg_hba.conf|pg_ident.conf|postgresql.conf) echo "${uid} 600" ;;`,
    `      *) echo "${uid} 700" ;;`,
    `    esac ;;`,
    `    *) echo "${GUARD_ROOT_UID_V1} 550" ;;`,
    `  esac ;;`,
    `esac`,
  ].join("\n");
}