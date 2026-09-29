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
  }),
});

export const databaseRoleNamesV1 = Object.freeze([...databaseRoleManifestV1.groups,
  ...Object.keys(databaseRoleManifestV1.logins)]);

export function databaseRoleAttributesV1(role) {
  if (!databaseRoleNamesV1.includes(role)) throw new Error("upgrade_role_catalog_refused");
  return `${Object.hasOwn(databaseRoleManifestV1.logins, role) ? "LOGIN" : "NOLOGIN"} INHERIT `
    + "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
}
