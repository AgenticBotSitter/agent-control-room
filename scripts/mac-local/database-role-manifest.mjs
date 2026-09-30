/** The one list of PostgreSQL roles the Control Room schema needs. The live
 * upgrade creates, checks and changes membership only for roles named here,
 * and never gives any of them SUPERUSER, CREATEROLE or BYPASSRLS. A role
 * outside this list is never touched. `newLogin` marks a login the upgrade may
 * create, and only from a SCRAM verifier the Mac hands over; every other login
 * must already exist. `legacyGroup` is the one old membership the upgrade may
 * revoke from that login. */
const login = (group, extra = {}) => Object.freeze({ group, newLogin: false, legacyGroup: null, ...extra });

export const databaseRoleManifestV1 = Object.freeze({
  groups: Object.freeze([
    "control_room_schema_owner", "control_room_application", "control_room_reader", "control_room_backup",
    "control_room_schedule_admissions", "control_room_github_broker", "control_room_work_intake",
    "control_room_private_web", "control_room_task_coordinator", "control_room_native_results",
    "control_room_local_result_publisher", "control_room_agent_reviewer", "control_room_native_queue_worker",
    "control_room_fleet_gateway", "control_room_fleet_owner_authority",
  ]),
  logins: Object.freeze({
    control_room_migrator: login("control_room_schema_owner"),
    control_room_app: login("control_room_application"),
    control_room_scheduler: login("control_room_schedule_admissions"),
    control_room_work_intake_agent: login("control_room_work_intake", { newLogin: true }),
    control_room_web: login("control_room_private_web", { mac: true, legacyGroup: "control_room_application" }),
    control_room_coordinator: login("control_room_task_coordinator",
      { mac: true, legacyGroup: "control_room_application" }),
    control_room_results: login("control_room_native_results", { mac: true, legacyGroup: "control_room_application" }),
    control_room_publisher: login("control_room_local_result_publisher", { mac: true, newLogin: true }),
    control_room_agent_reviewer_login: login("control_room_agent_reviewer", { mac: true, newLogin: true }),
    control_room_queue_worker: login("control_room_native_queue_worker",
      { mac: true, legacyGroup: "control_room_application" }),
    control_room_fleet: login("control_room_fleet_gateway", { mac: true, newLogin: true }),
    control_room_fleet_owner: login("control_room_fleet_owner_authority", { mac: true, newLogin: true }),
  }),
});

/** Roles the schema names that the Mac upgrade must recognise but must NEVER
 * create, change or drop.
 *
 * The fleet gateway and its owner-authority role are installed by
 * db/roles/fleet_gateway_roles.sql, which is an OFFLINE OPERATOR SETUP file a
 * Mac-local install never applies. Migration 0141's `redeem_fleet_enrollment`
 * guards itself with `IF EXISTS (SELECT 1 FROM pg_roles WHERE
 * rolname='control_room_fleet_gateway')`, so a database with no gateway is
 * correct and the migration is a no-op for it — the fleet surface is simply
 * absent. Putting them in `groups` would make the upgrade CREATE them on every
 * Mac, which changes the privilege boundary: a role that grants the gateway
 * EXECUTE on enrollment and DELETE on assignment-lease scopes would exist on a
 * cluster whose owner never asked for a fleet.
 *
 * They are listed here so the manifest check still knows the name: a migration
 * naming a role nothing in the manifest knows is a live role the owner cannot
 * reason about at upgrade time. This is the difference between "the upgrade
 * owns this role" and "the upgrade has heard of it", and both are refused
 * failing the check; only the first is created.
 */
export const databaseRoleKnownButNotManagedV1 = Object.freeze([
  "control_room_fleet_gateway", "control_room_fleet_owner_authority",
]);

export const databaseRoleNamesV1 = Object.freeze([...databaseRoleManifestV1.groups,
  ...Object.keys(databaseRoleManifestV1.logins), ...databaseRoleKnownButNotManagedV1]);

export function databaseRoleAttributesV1(role) {
  if (!databaseRoleNamesV1.includes(role)) throw new Error("upgrade_role_catalog_refused");
  return `${Object.hasOwn(databaseRoleManifestV1.logins, role) ? "LOGIN" : "NOLOGIN"} INHERIT `
    + "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
}

/** A role name is a bare or double-quoted identifier. Anything carrying a
 * placeholder (`%I`, `%s`, `$1`) is a position the source builds at run time
 * and cannot be checked here, so it is never reported as a name. */
const roleIdentifier = '(?:"[^"\\n]+"|[A-Za-z_][A-Za-z0-9_$]*)';
const roleList = `(?:${roleIdentifier}\\s*(?:,\\s*${roleIdentifier}\\s*,?)*)`;
// PUBLIC is the implicit grantee of the default privileges and CURRENT_USER
// is the migrating login; neither is a role this manifest can own or refuse.
const rolePseudoNames = new Set(["public", "current_user", "current_role", "session_user"]);
// Every statement form that names a role, not just CREATE ROLE and `TO`:
// membership grants (`IN ROLE`, `FOR ROLE`), object ownership (`OWNER TO`,
// `DROP OWNED BY`), session impersonation (`SET ROLE`), the grantor of record
// (`GRANTED BY`), and the catalog lookup every migration that has to tolerate
// a role that may not exist yet uses (`rolname = '<role>'`). A migration that
// names a role the upgrade will never create or check is a role the owner
// cannot reason about at upgrade time, so each of these counts as naming one.
const roleNameRules = Object.freeze([
  ["create", new RegExp(`\\bCREATE\\s+(?:ROLE|USER|GROUP)\\s+(${roleList})`, "giu")],
  ["alter", new RegExp(`\\bALTER\\s+(?:ROLE|USER|GROUP)\\s+(${roleList})`, "giu")],
  ["drop", new RegExp(`\\bDROP\\s+(?:ROLE|USER|GROUP)\\s+(${roleList})`, "giu")],
  ["member", new RegExp(`\\bIN\\s+(?:ROLE|GROUP)\\s+(${roleList})`, "giu")],
  ["admin", new RegExp(`\\bFOR\\s+(?:ROLE|USER)\\s+(${roleList})`, "giu")],
  ["grant", new RegExp(`\\bGRANT\\b[^;]*?\\bTO\\s+(?:GROUP\\s+)?(${roleList})`, "giu")],
  ["revoke", new RegExp(`\\bREVOKE\\b[^;]*?\\bFROM\\s+(${roleList})`, "giu")],
  ["owner", new RegExp(`\\bOWNER\\s+TO\\s+(${roleList})`, "giu")],
  ["owned", new RegExp(`\\b(?:DROP|REASSIGN)\\s+OWNED\\s+BY\\s+(${roleList})`, "giu")],
  ["session", new RegExp(`\\bSET\\s+(?:(?:LOCAL|SESSION)\\s+)?ROLE\\s+(${roleIdentifier})`, "giu")],
  ["grantor", new RegExp(`\\bGRANTED\\s+BY\\s+(${roleIdentifier})`, "giu")],
  ["catalog", /\brolname\s*(?:=~|=|IN)\s*'([^'\n]+)'/giu],
]);

/** Every distinct role name a SQL source names, mapped to the statement forms
 * that named it. Line and block comments are removed first: a commented-out
 * grant is not a role the database ever sees, and a role name written in prose
 * must not be able to fail the manifest. */
export function databaseRoleNamesInSqlV1(text) {
  const source = String(text).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/--[^\n]*/gu, "");
  const found = new Map();
  for (const [form, pattern] of roleNameRules) {
    for (const match of source.matchAll(pattern)) {
      for (const raw of (match[1] ?? "").split(",")) {
        const name = raw.trim().replace(/^"|"$/gu, "").trim();
        if (!name || name.includes("%") || rolePseudoNames.has(name.toLowerCase())) continue;
        const forms = found.get(name);
        if (forms) forms.add(form); else found.set(name, new Set([form]));
      }
    }
  }
  return found;
}

/** The role names `sources` names that the manifest does not, sorted, so a
 * failing check reports the same bounded list every run. */
export function unknownDatabaseRoleNamesV1(sources) {
  const named = new Set();
  for (const text of sources) for (const name of databaseRoleNamesInSqlV1(text).keys()) named.add(name);
  return [...named].filter(name => !databaseRoleNamesV1.includes(name)).sort();
}
