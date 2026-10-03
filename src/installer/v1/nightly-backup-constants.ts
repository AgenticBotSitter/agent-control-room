// The nightly-backup constants that plain `node` scripts must also read.
//
// This module must have NO imports. `scripts/ops/backup-database.mjs` and
// `scripts/ops/verify-database-backup.mjs` are documented to run as bare
// `node script.mjs`, without tsx or a bundler, and they reach these constants
// through `deploy/postgres/backup-database.mjs`. Node's own type stripping
// cannot resolve an extensionless import or a JSON import without an import
// attribute, so any import added here breaks both operator commands
// (rv-bkfix4). `nightly-backup-configuration.ts` re-exports both names.

/**
 * The pg_dump deadline, and why it is this long.
 *
 * 120 s was a guess made before any real database existed, and it is far too
 * short for what this runs on: a Mac mini's local PostgreSQL, a custom-format
 * dump of the whole `control_room` database, on a filesystem the owner also
 * uses. A dump that is merely still working at two minutes is a night with no
 * backup at all, and the nightly job is a launchd `StartCalendarInterval` one,
 * so nothing runs again that day and nothing tells the owner it happened.
 *
 * 45 minutes is a ceiling, not a target. The nightly job's launchd
 * `ExitTimeOut` is derived from this value, so a legitimate long dump is never
 * SIGKILLed by launchd with nothing in the log; a dump that cannot finish in 45
 * minutes on this hardware is a problem the owner must see, and it is reported
 * as `nightly_backup_dump_timeout:<ms>` rather than a generic failure.
 *
 * It lives HERE, and not in `deploy/postgres/backup-database.mjs`, because this
 * is the one module both the dump tool and the launch-daemon bundle can import. Putting it in the tool would make the bundle depend on `deploy/`, and
 * `pg` with it.
 */
export const NIGHTLY_DUMP_TIMEOUT_MS_V1 = 45 * 60 * 1000;

/**
 * The outer backup manifest's schema id, and the ONE place it is defined.
 *
 * Three modules have to agree on this exact string, and two of them run in
 * places the third cannot reach:
 *
 *   - `deploy/postgres/backup-database.mjs` WRITES the manifest, on the
 *     scheduled nightly path (R4B-10);
 *   - `scripts/ops/verify-database-backup.mjs` REFUSES any backup whose
 *     manifest does not carry it, and it re-exports the name from
 *     `scripts/ops/backup-database.mjs`;
 *   - `src/installer/v1/nightly-backup.ts` READS the binding to decide whether a
 *     generation may spend retention (R4B-01).
 *
 * It lives HERE for the same reason `NIGHTLY_DUMP_TIMEOUT_MS_V1` does: this is
 * the one module all three can import that has no dependency at all. The dump
 * tool imports it directly; the nightly runner imports it directly; and the
 * verifier reaches it transitively, through the dump tool it already imports.
 * Putting the constant in the dump tool instead would force the nightly runner —
 * whose dependency-free bundle must not acquire `pg` — to import the module
 * that needs it, which is exactly the import `nightly_backup_dependency_missing`
 * exists to survive.
 */
export const BACKUP_MANIFEST_SCHEMA_V1 = "control-room.verified-database-backup/v1" as const;
