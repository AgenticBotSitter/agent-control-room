#!/usr/bin/env node
// Generate the install-night database phase's DATA inputs from the release's own
// source of truth, and write them into the release tree as reviewed artifacts.
//
// WHY THESE FILES EXIST AT ALL. The updater bundle carries no release code and
// executes none — that is the trust-domain rule that keeps `pg-boss`,
// `database-upgrade-grants.mjs` and the release's TypeScript out of the
// trusted component. But the phase still has to CONVERGE GRANTS and BUILD THE
// QUEUE SCHEMA from the release's role manifest (§5.3), and until this generator
// existed the only code that could do either lived in the test file. Blocker 3 of
// the M1 review: `buildInitDependenciesV1()` was called with no manifest, so
// `roles` was `[]` and `buildInitStatementsV1` refused `pg_phase_role_set_empty`
// on every real run, and `buildReleaseDependenciesV1()` had no `installFixedQueue`
// at all — `dependencies.installFixedQueue(...)` was a TypeError.
//
// THE DECISION, recorded because it was the reviewer's open question and the
// lead's to make: option (a). The release ships the three inputs as DATA under
// `current/deploy/postgres/`, the phase READS them, and no release code is
// imported or executed. The ledger already works this way —
// `deploy/postgres/migration-ledger.json` is read the same way — so this is not
// a new trust boundary, it is the existing one applied to three more artifacts.
//
// WHY DATA AND NOT A SPAWNED RELEASE SCRIPT (option b). A spawned release script
// would have to be trusted to decide what the fixed phase does, and the phase
// would have to trust its bounded JSON result; a data file is reviewed as text in
// the same diff as the manifest it came from, and a wrong value in it is refused
// by a schema check rather than acted on by imported code.
//
// WHAT IS GENERATED, AND FROM WHAT:
//   deploy/postgres/role-manifest.json          <- scripts/mac-local/database-role-manifest.mjs
//   deploy/postgres/desired-grants.json         <- scripts/mac-local/database-upgrade-grants.mjs
//   deploy/postgres/fixed-queue-schema.json     <- pg-boss getConstructionPlans + create_queue
//
// The queue DDL is captured from `pg-boss` itself rather than transcribed, which
// is the only way the phase builds the schema the release builds: the release's
// own `installFixedQueueSchemaV1` fingerprints the construction with a digest
// (`expectedShapeDigest`), and a transcribed copy would drift from pg-boss on the
// next version bump while the fingerprint kept asserting the old shape.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";


import { databaseRoleAttributesV1, databaseRoleManifestV1 } from "./database-role-manifest.mjs";
import { macRolePlan, desiredMacGrantsV1, readDesiredMacGrantsV1 } from "./database-upgrade-grants.mjs";
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

const refuse = code => { throw Object.assign(new Error(code), { code }); };

export const ROLE_MANIFEST_PATH_V1 = "deploy/postgres/role-manifest.json";
export const DESIRED_GRANTS_PATH_V1 = "deploy/postgres/desired-grants.json";
export const FIXED_QUEUE_PATH_V1 = "deploy/postgres/fixed-queue-schema.json";

/**
 * The role manifest, in the shape `buildInitStatementsV1` consumes.
 *
 * `buildInitStatementsV1` takes `{ name, attributes }` and CHECKS the attribute
 * clause against two literal strings, so the attribute is carried here as the
 * exact clause rather than as flags this generator would expand — the phase's own
 * check is the second gate, and a generator that expanded flags could produce a
 * clause the phase refuses.
 *
 * Every role the manifest names is included: the groups AND the logins. A group
 * missing here is a `CREATE ROLE` that never runs and a grant that fails later
 * with "role … does not exist", and the release's own
 * `unknownDatabaseRoleNamesV1` check is what keeps the set and the SQL in step.
 */
export function roleManifestDataV1({ database = "control_room", port = 5432 } = {}) {
  const groups = databaseRoleManifestV1.groups.map(name => ({ name, attributes: databaseRoleAttributesV1(name) }));
  const logins = Object.entries(databaseRoleManifestV1.logins).map(([name]) => ({
    name, attributes: databaseRoleAttributesV1(name),
  }));
  return Object.freeze({
    schema: "control-room.database-role-manifest/v1",
    // Both names, because `buildInitStatementsV1` needs `migratorLogin` and
    // `migratorGroup` as separate spellings and a phase that guessed them would
    // be guessing which group a migration's objects end up owned by.
    migratorLogin: "control_room_migrator",
    migratorGroup: "control_room_schema_owner",
    deployerLogin: "control_room_deployer",
    // The database name and the port, here rather than as literals in the two
    // scripts. The cluster is socket-only and never listens on TCP, so the port
    // is not a network fact but part of the SOCKET PATH: the postmaster publishes
    // `.s.PGSQL.<port>` inside `pg/socket`, and both phases must compute the same
    // number or the release phase connects to a socket the init phase never
    // created. Carried as data so there is one place it can differ rather than two.
    database,
    port,
    macRolePlan,
    roles: Object.freeze([...groups, ...logins]),
  });
}

/**
 * The desired grant set, as the phase's own converger consumes it.
 *
 * The set is the release's `desiredMacGrantsV1` output verbatim — a sorted array
 * of the same `role|kind|object|column|privilege|grantable` tuples the release's
 * `macGrantRowsToSetV1` builds from a live catalogue. Keeping the TUPLE SHAPE is
 * the point: a data file in a shape the phase re-encoded would be a second
 * spelling of the release's grant model, and the two would drift.
 *
 * `principals` is carried because the phase's catalogue query binds `$1` to the
 * mac roles and groups. It is the release's own `macRolePlan` keys and values,
 * and it is carried so the phase does not have to reconstruct it from the grants
 * (a reconstruction could include a role that holds no grant, and the catalogue
 * query's `= ANY($1)` would then read rows the diff does not account for).
 */
export async function desiredGrantsDataV1() {
  const desired = await readDesiredMacGrantsV1();
  const principals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];
  return Object.freeze({
    schema: "control-room.database-desired-grants/v1",
    principals,
    // Sorted so the file is byte-stable across runs: a generated artifact whose
    // bytes move when nothing changed would make every release diff noisy and
    // would make "did the grant set change" unanswerable by eye.
    desired: Object.freeze([...desired].sort()),
  });
}

/**
 * The queue DDL, captured from pg-boss.
 *
 * `construction` is `getConstructionPlans(schema)` — the exact program pg-boss
 * commits to build the schema — and `createQueue` is the one statement
 * `createQueue(name, options)` sends. Both are MEASURED by running pg-boss
 * against a recording `db.executeSql`, so the phase issues the release's own SQL
 * rather than a transcription of it:
 *
 *   SQL>>> "\n    BEGIN;\n    SET LOCAL lock_timeout = 30000;\n …
 *           SELECT control_room_queue.create_queue('native-task-delivery',
 *           '{"retryLimit":0,"policy":"standard"}'::jsonb);\n    COMMIT;\n  "
 *
 * The recording is done by CONSTRUCTING the SQL, not by running it: the queue is
 * captured through a fake `executeSql` that records and returns empty rows, so
 * this generator needs no database and cannot depend on one being up.
 */
export async function fixedQueueSchemaDataV1(loadPgBoss) {
  const pgBoss = await loadPgBoss();
  const construction = pgBoss.getConstructionPlans("control_room_queue");
  const programs = Array.isArray(construction) ? construction : [construction];
  if (!Array.isArray(programs) || programs.length === 0
    || programs.some(program => typeof program !== "string" || program.length === 0)) {
    refuse("database_phase_queue_ddl_refused");
  }
  // The queue this installation runs. Named here rather than derived, because the
  // name is a product decision and `native-task-delivery` is it; a phase that
  // guessed a name would build a queue nothing reads.
  const queue = Object.freeze({ name: "native-task-delivery", options: Object.freeze({ retryLimit: 0 }) });
  const recorded = [];
  const client = { executeSql: async (sql) => { recorded.push(sql); return { rows: [], rowCount: 0 }; } };
  const boss = new pgBoss.PgBoss(Object.freeze({ db: client, schema: "control_room_queue",
    backend: "postgres", migrate: false, createSchema: false, supervise: false, schedule: false,
    useListenNotify: false }));
  try { await boss.createQueue(queue.name, queue.options); } catch (error) {
    refuse(`database_phase_queue_ddl_refused:${error.message.slice(0, 120)}`);
  } finally { await boss.stop({ graceful: false }).catch(() => undefined); }
  // Exactly ONE create_queue program, and it must name this queue. Anything else
  // means pg-boss changed shape and the phase would issue SQL nobody reviewed.
  const createQueue = recorded.find(sql => sql.includes("create_queue("));
  if (recorded.length !== 1 || typeof createQueue !== "string"
    || !createQueue.includes(`'${queue.name}'`)) {
    refuse("database_phase_queue_ddl_refused:unexpected_program_count");
  }
  return Object.freeze({
    schema: "control-room.database-fixed-queue-schema/v1",
    namespace: "control_room_queue",
    queue,
    construction: Object.freeze(programs),
    createQueue,
  });
}

/**
 * Write all three files, and return their digests.
 *
 * Written with `JSON.stringify(…, null, 2)` and a trailing newline so they are
 * diffable and so a file ending mid-line cannot be produced. The digest is of the
 * exact bytes written, and the caller records it in the release manifest, which
 * is what makes "the phase's inputs changed" a fact a reviewer can check rather
 * than a diff they have to notice.
 */
export async function writeDatabasePhaseDataV1(releaseRoot, { loadPgBoss } = {}) {
  const files = [
    [ROLE_MANIFEST_PATH_V1, roleManifestDataV1()],
    [DESIRED_GRANTS_PATH_V1, await desiredGrantsDataV1()],
    [FIXED_QUEUE_PATH_V1, await fixedQueueSchemaDataV1(loadPgBoss ?? defaultLoadPgBoss)],
  ];
  const written = [];
  for (const [relative, value] of files) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const path = join(releaseRoot, relative);
    await mkdir(join(releaseRoot, "deploy", "postgres"), { recursive: true, mode: 0o755 });
    await writeFile(path, bytes, { mode: 0o644 });
    written.push(Object.freeze({ path: relative, bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex") }));
  }
  return Object.freeze({ schema: "control-room.database-phase-data/v1", files: Object.freeze(written) });
}

const defaultLoadPgBoss = async () => import("pg-boss");

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  const releaseRoot = process.argv[2];
  if (!releaseRoot) { process.stderr.write("database_phase_data_root_required\n"); process.exitCode = 1; }
  else {
    writeDatabasePhaseDataV1(releaseRoot).then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }).catch(error => { process.stderr.write(`${error.code ?? "database_phase_data_failed"}\n`); process.exitCode = 1; });
  }
}

void desiredMacGrantsV1;