// Scoped role/authority evidence for the restore identity (R5B-03).
//
// WHY THIS EXISTS. The restore identity used to compare every `control_room_%`
// role ON THE WHOLE CLUSTER against the roles the backup recorded. That makes
// the documented rollback — restore the backup taken before an update — fail on
// a cluster where the update added a login, which is exactly what an update
// does. MEASURED on PostgreSQL 17 as the production logins (round 5, R5B-03):
// restoring a good backup into a fresh database on a cluster that had one extra
// login failed `restore_identity_mismatch:rolesDigest` while every restored row
// matched the backup exactly, and the half-restored target was then refused as
// non-empty. The refusal was about a role the backup never claimed, and it was
// raised after the target had already been filled.
//
// THE RULE THIS FILE ENCODES, and why it is narrower than "ignore extra roles":
// the recorded role set is not a sample, it is EVERY `control_room_%` role the
// source cluster held when the backup was taken — that is the whole of
// `ROLES_SNAPSHOT_SQL`. So the identity is computed over exactly the recorded
// set, which is the thing a backup can honestly be said to reproduce, and an
// extra role is reported rather than folded into that comparison.
//
// A role outside the recorded set is harmless on its own and dangerous when it
// is WIRED IN: a `control_room_%` role added after the backup that is a member
// of — or holds — one of the backup's own roles exercises that role's authority
// inside the restored database, and no digest of the recorded roles can see it.
// That case refuses the restore BEFORE the target is written, and names the
// role. A pair of added roles that only wire into each other holds no recorded
// authority and is left alone, which is what makes the documented rollback work
// on a release pair that both added `control_room_work_intake` and
// `control_room_work_intake_agent`.
//
// Both halves are measured rather than argued. Scoping a real restore's
// observed roles and memberships to the recorded 29 roles and 13 memberships
// reproduces the recorded digests EXACTLY with an unrelated role present on the
// cluster, and a membership wiring an added role into `control_room_migrator`
// IS visible in `pg_auth_members` on a target that still holds no tables, so the
// pre-write refusal can run at all.
//
// This never reaches the cluster catalogue for anything the recorded set does
// not already name, and it grants nothing. It reads.
import { connectTarget } from "./evidence.mjs";

// Every role this package manages, by the snapshot query's own prefix. A
// membership partner that does NOT match is outside the product's role model
// entirely (a cluster superuser, say) — those were already visible to the
// backup, so they are not "added since" and must not be treated as such.
const CONTROL_ROOM_ROLE = /^control_room_/u;

/**
 * Whether a role name is one this package manages at all.
 *
 * @param {unknown} name
 */
export function isControlRoomRoleNameV1(name) {
  return typeof name === "string" && CONTROL_ROOM_ROLE.test(name);
}

/**
 * Restrict a role or membership snapshot to the roles a backup recorded.
 *
 * Order is preserved rather than re-sorted: `digestOf` hashes the JSON of the
 * array as collected, and both the backup snapshot and this projection must
 * produce the same sequence for the digest to be comparable at all.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {ReadonlySet<string>} recordedRoleNames
 */
export function scopeRolesToRecordedV1(rows, recordedRoleNames) {
  if (!Array.isArray(rows)) throw new Error("restore_scoped_roles_shape");
  assertRecordedRoleNamesV1(recordedRoleNames);
  return rows.filter(row => typeof row?.rolname === "string" && recordedRoleNames.has(row.rolname))
    .map(row => ({ ...row }));
}

/**
 * Restrict a membership snapshot to what the backup could have recorded.
 *
 * `MEMBERSHIPS_SNAPSHOT_SQL` keeps a row when EITHER end is a `control_room_%`
 * role, so the backup's own list legitimately contains pairs whose partner is
 * outside the product's roles. The projection therefore DROPS exactly the rows
 * whose ends are managed roles the backup did not record — and, applied to the
 * backup's own list, drops nothing at all, which is the property that makes the
 * digest comparable.
 *
 * One unrecorded managed end is precisely the wiring this file exists to catch.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {ReadonlySet<string>} recordedRoleNames
 */
export function scopeMembershipsToRecordedV1(rows, recordedRoleNames) {
  if (!Array.isArray(rows)) throw new Error("restore_scoped_memberships_shape");
  assertRecordedRoleNamesV1(recordedRoleNames);
  return rows.filter(row => knownAtBackupV1(row?.member, recordedRoleNames)
    && knownAtBackupV1(row?.role, recordedRoleNames))
    .map(row => ({ ...row }));
}

/** A role was "known at backup time" if the backup recorded it, or if it is not
 * a role this package manages — the latter was already visible to the backup. */
function knownAtBackupV1(name, recordedRoleNames) {
  return typeof name === "string" && (recordedRoleNames.has(name) || !isControlRoomRoleNameV1(name));
}

function assertRecordedRoleNamesV1(recordedRoleNames) {
  if (!(recordedRoleNames instanceof Set) || recordedRoleNames.size < 1)
    throw new Error("restore_scoped_recorded_set");
}

/**
 * The recorded role names, read from a backup's own metadata. A backup that
 * recorded none cannot be scoped against, and is refused rather than compared
 * against an empty set, which every real cluster would fail.
 *
 * @param {unknown} metadata
 * @returns {ReadonlySet<string>}
 */
export function recordedRoleNamesFromMetadataV1(metadata) {
  const roles = metadata?.evidence?.roles;
  if (!Array.isArray(roles) || roles.length < 1) throw new Error("restore_refused_no_recorded_roles");
  const names = new Set();
  for (const role of roles) {
    if (typeof role?.rolname !== "string" || !/^[a-z0-9_]+$/u.test(role.rolname))
      throw new Error("restore_refused_recorded_role_name");
    names.add(role.rolname);
  }
  return names;
}

/**
 * Read the target's cluster-wide role and membership state, projected against
 * the roles a backup recorded.
 *
 * `pg_auth_members` and `pg_roles` are cluster-wide, so this runs against the
 * restored database's own connection and sees every wiring on the cluster,
 * including one made after the backup was taken. A role the backup recorded and
 * the cluster does not have is refused by name, EXCEPT the ones this restore is
 * about to create for itself.
 *
 * That exception is not a convenience. MEASURED on PostgreSQL 17: refusing
 * `control_room_backup` here fails `restore_refused_missing_recorded_role` on a
 * CORRECTLY provisioned target, because the operator provisions the logins and
 * the tool creates its own group roles one step later. So the caller passes the
 * exact list it will create, rather than this module guessing which ones those
 * are - two lists kept in agreement by hand is how the first version of this
 * check broke the documented path.
 *
 * Runs BEFORE anything is written to the target, so a refusal here leaves it
 * untouched.
 *
 * @param {{ host?: string, port?: number, database?: string, user?: string, password?: string }} target
 * @param {ReadonlySet<string>} recordedRoleNames
 * @param {ReadonlySet<string>} selfCreatedRoleNames roles this restore will CREATE itself
 * @returns {Promise<{ extraRoles: string[], wiredMemberships: { member: string, role: string, adminOption: boolean }[] }>}
 */
export async function readUnrecordedRoleAuthorityV1(target, recordedRoleNames, selfCreatedRoleNames = new Set()) {
  assertRecordedRoleNamesV1(recordedRoleNames);
  const client = connectTarget(target);
  await client.connect();
  try {
    const roles = (await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'control\\_room\\_%' ORDER BY rolname`)).rows
      .map(row => row.rolname);
    // A role the restore is about to create itself is not missing; anything else
    // that the backup recorded and the cluster lacks is a real provisioning
    // gap, and the scoped digest would otherwise fail later naming a digest
    // rather than the role the operator has to provision.
    const missing = [...recordedRoleNames].filter(name => !roles.includes(name) && !selfCreatedRoleNames.has(name));
    if (missing.length > 0) throw new Error(`restore_refused_missing_recorded_role:${missing[0]}`);
    const memberships = (await client.query(
      `SELECT member.rolname AS member, role.rolname AS role, am.admin_option FROM pg_auth_members am
       JOIN pg_roles member ON member.oid = am.member JOIN pg_roles role ON role.oid = am.roleid
       WHERE member.rolname LIKE 'control@_room@_%' ESCAPE '@' OR role.rolname LIKE 'control@_room@_%' ESCAPE '@'
       ORDER BY 1, 2`)).rows;
    const wiredMemberships = memberships.filter(row => !knownAtBackupV1(row.member, recordedRoleNames)
      || !knownAtBackupV1(row.role, recordedRoleNames))
      .map(row => ({ member: row.member, role: row.role, adminOption: row.admin_option === true }));
    return { extraRoles: roles.filter(name => !recordedRoleNames.has(name)), wiredMemberships };
  } finally {
    await client.end();
  }
}