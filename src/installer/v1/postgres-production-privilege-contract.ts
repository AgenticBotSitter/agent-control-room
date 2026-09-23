/**
 * Evidence-side representation of the fixed privileges installed by
 * production_provision.sql and production_table_grants.sql. This parses only
 * the simple control_room_* aclitems those reviewed scripts create; quoted
 * names, grant options, unknown grantees, and extra privileges refuse.
 */
export const POSTGRES_PRODUCTION_MEMBERSHIPS_V1 = Object.freeze([
  Object.freeze({ member: "control_room_app", role: "control_room_application", admin_option: false as const }),
  Object.freeze({ member: "control_room_migrator", role: "control_room_schema_owner", admin_option: false as const }),
  Object.freeze({ member: "control_room_scheduler", role: "control_room_schedule_admissions", admin_option: false as const }),
]);

const owner = "control_room_schema_owner";
const immutableApplicationTables = new Set([
  "audit_events", "projection_changes", "command_receipts", "control_transition_events",
  "control_policy_decisions", "control_approval_consumptions", "control_audit_anchors", "node_protocol_replay",
]);
const applicationDeleteTables = new Set([
  "projects", "work_items", "executions", "blockers", "attention_items", "machine_nodes", "worker_runtimes",
  "agent_identities",
]);
const schedulerReadTables = new Set([
  "workspaces", "projects", "control_schedule_occurrences", "control_schedules", "control_requests",
  "control_workflows", "control_jobs",
]);
const brokerTables = new Set(["control_github_webhook_replays", "control_github_worker_wake_hints"]);

function parseAcl(value: string): ReadonlyMap<string, string> | undefined {
  if (!value.startsWith("{") || !value.endsWith("}")) return undefined;
  const body = value.slice(1, -1);
  if (body.length === 0) return new Map();
  const result = new Map<string, string>();
  for (const item of body.split(",")) {
    const match = /^([a-z0-9_]+)=([arwdDxtmU]*)\/([a-z0-9_]+)$/u.exec(item);
    if (!match) return undefined;
    const [, grantee, privileges, grantor] = match;
    if (grantor !== owner || result.has(grantee)
      || [...privileges].some((privilege, index, all) => all.indexOf(privilege) !== index)) return undefined;
    result.set(grantee, privileges);
  }
  return result;
}

function expectedTablePrivileges(table: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>([[owner, "arwdDxtm"]]);
  if (table === "control_room_schema_migrations") return result;
  if (brokerTables.has(table)) {
    result.set("control_room_github_broker", "ard");
    return result;
  }
  const application = immutableApplicationTables.has(table) ? "ar"
    : applicationDeleteTables.has(table) ? "arwd" : "arw";
  result.set("control_room_application", application);
  result.set("control_room_reader", "r");
  result.set("control_room_backup", "r");
  if (table === "control_scheduled_task_admissions") result.set("control_room_schedule_admissions", "ar");
  else if (schedulerReadTables.has(table)) result.set("control_room_schedule_admissions", "r");
  return result;
}

function expectedSequencePrivileges(sequence: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>([[owner, "rwU"]]);
  if (sequence === "control_github_worker_wake_hints_hint_id_seq") {
    result.set("control_room_github_broker", "U");
  }
  return result;
}

/** Validates one pg_class ACL snapshot against the reviewed production grants. */
export function matchesPostgresProductionAclV1(object: string, acl: string): boolean {
  if (!object.startsWith("public.")) return false;
  const name = object.slice("public.".length);
  if (!/^[a-z0-9_]+$/u.test(name)) return false;
  const observed = parseAcl(acl);
  if (!observed) return false;
  const ownerPrivileges = observed.get(owner);
  const expected = ownerPrivileges === "arwdDxtm" ? expectedTablePrivileges(name)
    : ownerPrivileges === "rwU" ? expectedSequencePrivileges(name) : undefined;
  if (!expected || observed.size !== expected.size) return false;
  return [...expected].every(([role, privileges]) => observed.get(role) === privileges);
}
