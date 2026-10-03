// The install-night database phase's DATA INPUTS, read from the release and
// validated before anything runs.
//
// §5.3 says the phase "converges grants from the release's role manifest as
// DATA" and the trust rule says the updater bundle carries no release code. Those
// two together decide this file's shape: the release ships three JSON artifacts
// under `current/deploy/postgres/` (generated at build time by
// `scripts/mac-local/database-phase-data.mjs` from the release's own
// `database-role-manifest.mjs`, `database-upgrade-grants.mjs` and pg-boss), and
// this file READS AND VALIDATES them. No release module is imported and none is
// executed.
//
// This is the same arrangement the migration LEDGER already uses —
// `deploy/postgres/migration-ledger.json` is read and its rows verified before the
// first statement — applied to three more artifacts. That is why it is not a new
// trust boundary: the release already has to be trusted to ship a ledger, and a
// release that changed a role or a grant changed a reviewed file in the same diff.
//
// WHY THE VALIDATION IS THIS THOROUGH. Every field these files carry is either
// CONCATENATED INTO SQL (role names, attributes), BOUND INTO A GRANT (object
// names, privileges), or COMPARED AGAINST a live catalogue (the grant tuples). So
// the validators here are the boundary at which a malformed artifact becomes a
// refusal rather than a statement, and each check names what it protects:
//
//   - a role name is a bare identifier, because it goes into `CREATE ROLE <name>`
//     with no quoting and a name carrying a semicolon would be a second statement;
//   - an attribute clause is one of TWO literal strings, because
//     `buildInitStatementsV1` accepts exactly those two and anything else is
//     refused there anyway — checking here means the refusal happens before any
//     child process is spawned;
//   - a grant tuple is six fields with an enum in two of them, because
//     `grantSql` builds `GRANT <right> ON <kind> <object> TO <role>` from it;
//   - the queue DDL is bounded, has no NUL, and names the namespace the phase
//     grants on, because it is the ONE input that is SQL the phase did not write.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDigestV1 } from "./database-phase-contract.mjs";

const refuse = code => { throw new Error(code); };

/** The three inputs' paths, relative to the RELEASE root (`<root>/current`). */
export const DATABASE_PHASE_DATA_PATHS_V1 = Object.freeze({
  roleManifest: "deploy/postgres/role-manifest.json",
  desiredGrants: "deploy/postgres/desired-grants.json",
  fixedQueue: "deploy/postgres/fixed-queue-schema.json",
});

/** The role-name grammar, which is `buildInitStatementsV1`'s own. */
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;

/** The two attribute clauses the phase accepts, verbatim. */
const ATTRIBUTE_CLAUSES = new Set([
  "LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
  "NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
]);

/** The exact key sets, so an artifact that grew or lost a field is a refusal. */
const ROLE_MANIFEST_KEYS = Object.freeze(["database", "deployerLogin", "macRolePlan", "migratorGroup",
  "migratorLogin", "port", "roles", "schema"]);
const DESIRED_GRANTS_KEYS = Object.freeze(["desired", "principals", "schema"]);
const FIXED_QUEUE_KEYS = Object.freeze(["construction", "createQueue", "namespace", "queue", "schema"]);

const isPlainRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value, keys, code) => {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) refuse(code);
};

async function readDataFileV1(releaseRoot, relative, code) {
  const text = await readFile(join(releaseRoot, relative), "utf8")
    .catch(error => error?.code === "ENOENT" ? Promise.reject(new Error(code)) : Promise.reject(error));
  // Bounded and NUL-free, before the JSON parse, so a malformed artifact cannot
  // become an unbounded buffer or a parse that consumes a NUL as part of a name.
  if (typeof text !== "string" || text.length === 0 || text.length > 16 * 1024 * 1024
    || text.includes("\0")) {
    refuse(code);
  }
  let value;
  try { value = JSON.parse(text); } catch { refuse(code); }
  return value;
}

/**
 * `role-manifest.json`, in the shape `buildInitDependenciesV1` consumes.
 *
 * Every role is checked against the phase's OWN two clauses rather than against a
 * check written here, so the artifact and the consumer cannot disagree about what
 * a role is. A phase that accepted a third attribute string would be accepting a
 * role the design never approved.
 */
export async function readRoleManifestV1(releaseRoot) {
  const value = await readDataFileV1(releaseRoot, DATABASE_PHASE_DATA_PATHS_V1.roleManifest,
    "database_phase_role_manifest_refused");
  keysAre(value, ROLE_MANIFEST_KEYS, "database_phase_role_manifest_refused");
  if (value.schema !== "control-room.database-role-manifest/v1"
    || !Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > 128) {
    refuse("database_phase_role_manifest_refused");
  }
  for (const key of ["migratorLogin", "migratorGroup", "deployerLogin", "database"]) {
    if (typeof value[key] !== "string" || !ROLE_NAME.test(value[key])) {
      refuse(`database_phase_role_manifest_refused:${key}`);
    }
  }
  // The port is part of the SOCKET PATH, not of a network config: the cluster is
  // socket-only and the postmaster publishes `.s.PGSQL.<port>` inside `pg/socket`,
  // so an artifact carrying 0, a negative number or 70000 would produce a socket
  // path neither phase could compute the same way. Bounded to the TCP range
  // because that is the range PostgreSQL itself accepts.
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
    refuse("database_phase_role_manifest_refused:port");
  }
  if (!isPlainRecord(value.macRolePlan)) refuse("database_phase_role_manifest_refused:macRolePlan");
  const roles = value.roles.map(entry => {
    if (!isPlainRecord(entry) || Object.keys(entry).sort().join(",") !== "attributes,name") {
      refuse("database_phase_role_manifest_refused");
    }
    if (typeof entry.name !== "string" || !ROLE_NAME.test(entry.name)
      || !ATTRIBUTE_CLAUSES.has(entry.attributes)) {
      refuse(`database_phase_role_manifest_refused:${entry.name}`);
    }
    return Object.freeze({ name: entry.name, attributes: entry.attributes });
  });
  if (new Set(roles.map(entry => entry.name)).size !== roles.length) {
    refuse("database_phase_role_manifest_refused:duplicate");
  }
  const macRolePlan = {};
  for (const [login, group] of Object.entries(value.macRolePlan)) {
    if (!ROLE_NAME.test(login) || !ROLE_NAME.test(group)) refuse("database_phase_role_manifest_refused:macRolePlan");
    macRolePlan[login] = group;
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    migratorLogin: value.migratorLogin,
    migratorGroup: value.migratorGroup,
    deployerLogin: value.deployerLogin,
    database: value.database,
    port: value.port,
    macRolePlan: Object.freeze(macRolePlan),
  });
}

/**
 * `desired-grants.json`, as the phase's converger consumes it.
 *
 * The tuples are kept as the release's OWN `role|kind|object|column|privilege|
 * grantable` strings rather than being split here into objects, because the
 * release's `macGrantRowsToSetV1` builds live rows into the same strings and the
 * diff is a set difference of strings. Parsing them into objects would be a
 * second spelling of the release's grant model.
 *
 * Each tuple is checked for its SHAPE — six fields, a known kind, a known
 * privilege — because `grantSql` concatenates the fourth and fifth into a
 * statement and a tuple with an empty role would produce `GRANT SELECT ON … TO `
 * with no grantee, which the server refuses with a message naming nothing about
 * the artifact.
 */
export async function readDesiredGrantsV1(releaseRoot) {
  const value = await readDataFileV1(releaseRoot, DATABASE_PHASE_DATA_PATHS_V1.desiredGrants,
    "database_phase_desired_grants_refused");
  keysAre(value, DESIRED_GRANTS_KEYS, "database_phase_desired_grants_refused");
  if (value.schema !== "control-room.database-desired-grants/v1"
    || !Array.isArray(value.principals) || value.principals.length === 0 || value.principals.length > 128
    || !Array.isArray(value.desired) || value.desired.length === 0 || value.desired.length > 20_000) {
    refuse("database_phase_desired_grants_refused");
  }
  const kinds = new Set(["table", "sequence", "schema", "function", "database"]);
  const privileges = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES",
    "TRIGGER", "USAGE", "EXECUTE"]);
  for (const principal of value.principals) {
    if (typeof principal !== "string" || !ROLE_NAME.test(principal)) {
      refuse(`database_phase_desired_grants_refused:principal`);
    }
  }
  const desired = value.desired.map(tuple => {
    if (typeof tuple !== "string") refuse("database_phase_desired_grants_refused:tuple");
    const parts = tuple.split("|");
    if (parts.length !== 6 || !ROLE_NAME.test(parts[0]) || !kinds.has(parts[1])
      || parts[2] === "" || parts[2].includes(";") || parts[2].includes("\n")
      || parts[5] !== "plain" && parts[5] !== "grantable"
      || parts[4] !== "" && !privileges.has(parts[4])) {
      refuse(`database_phase_desired_grants_refused:${tuple.slice(0, 80)}`);
    }
    return tuple;
  });
  if (new Set(desired).size !== desired.length) refuse("database_phase_desired_grants_refused:duplicate");
  return Object.freeze({ desired: Object.freeze(desired), principals: Object.freeze([...value.principals]) });
}

/**
 * `fixed-queue-schema.json` — the queue DDL, which is the ONE input that is SQL
 * this phase did not write.
 *
 * It is checked for a bound, a NUL and a namespace, and NOT for its contents:
 * re-deriving what pg-boss's construction "should" contain would be a second
 * implementation of pg-boss, and the release's own
 * `expectedShapeDigest` fingerprint is the check that actually binds the built
 * schema to a known shape. The phase's job here is to make sure the program it is
 * about to send is the program the release shipped, and the fingerprint downstream
 * makes sure the schema that produces is the schema the release expects.
 *
 * The namespace is checked because the role files grant ON it: a queue built in
 * `public` would leave `native_queue_worker_roles.sql` refusing with
 * `relation "control_room_queue.queue" does not exist`, which names the SQL and
 * not the artifact.
 */
export async function readFixedQueueSchemaV1(releaseRoot) {
  const value = await readDataFileV1(releaseRoot, DATABASE_PHASE_DATA_PATHS_V1.fixedQueue,
    "database_phase_queue_ddl_refused");
  keysAre(value, FIXED_QUEUE_KEYS, "database_phase_queue_ddl_refused");
  if (value.schema !== "control-room.database-fixed-queue-schema/v1"
    || typeof value.namespace !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value.namespace)) {
    refuse("database_phase_queue_ddl_refused:namespace");
  }
  if (!isPlainRecord(value.queue) || Object.keys(value.queue).sort().join(",") !== "name,options"
    || typeof value.queue.name !== "string" || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value.queue.name)
    || !isPlainRecord(value.queue.options)) {
    refuse("database_phase_queue_ddl_refused:queue");
  }
  if (!Array.isArray(value.construction) || value.construction.length === 0
    || value.construction.length > 64
    || value.construction.some(program => typeof program !== "string" || program.length === 0
      || program.length > 4 * 1024 * 1024 || program.includes("\0"))) {
    refuse("database_phase_queue_ddl_refused:construction");
  }
  if (typeof value.createQueue !== "string" || value.createQueue.length === 0
    || value.createQueue.length > 1024 * 1024 || value.createQueue.includes("\0")
    || !value.createQueue.includes(`'${value.queue.name}'`)) {
    refuse("database_phase_queue_ddl_refused:create_queue");
  }
  return Object.freeze({
    namespace: value.namespace,
    queue: Object.freeze({ name: value.queue.name, options: Object.freeze({ ...value.queue.options }) }),
    construction: Object.freeze([...value.construction]),
    createQueue: value.createQueue,
  });
}

/** Every input, read once, so a caller cannot mix a half-read release. */
export async function readDatabasePhaseDataV1(releaseRoot) {
  const [roles, grants, queue] = await Promise.all([
    readRoleManifestV1(releaseRoot), readDesiredGrantsV1(releaseRoot), readFixedQueueSchemaV1(releaseRoot),
  ]);
  return Object.freeze({ roles, grants, queue });
}

void isDigestV1;