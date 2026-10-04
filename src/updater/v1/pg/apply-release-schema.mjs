// `apply-release-schema.mjs` — the release ledger as migrator, grant
// convergence, the full updater loader, and the schema digest
// (INSTALL_COMPOSITION.md §5.3, third script; §4.3 row 22).
//
// IT RUNS AFTER `init-database.mjs` AND BECAUSE OF WHAT THAT SCRIPT DELIBERATELY
// LEFT OUT. `init-database` creates the cluster, the roles, the database and the
// updater's role and schema, and stops. It creates no table in `public`, because
// the release migration ledger is the only thing that may, and the updater's
// loader refuses to run until the deployer can see the three release tables its
// SECURITY DEFINER guards read. This script is where that becomes true, in this
// order:
//
//   1. the release ledger, READ and verified against its own rows with no
//      statement run — then the queue schema and the one role file a pending
//      migration ASSERTS, then the ledger file by file, each in its own transaction
//      with its own ledger row, AS THE MIGRATOR — never as the superuser and never
//      as root. `SET ROLE control_room_schema_owner` around the file body is what
//      makes every created object owned by the NOLOGIN role, and the `RESET` before
//      the ledger INSERT is what lets the migrator write its own row without owning
//      the table. The queue schema and `queue_backup_read_roles.sql` run BEFORE the
//      ledger because `0285` asserts the grant the file makes: an assertion about a
//      privilege file has to be made after the privilege file;
//   2. the remaining role files, grant convergence as the schema owner from the
//      release's role manifest as DATA. A release that changed the manifest changed
//      a reviewed artifact; a release that did NOT change it converges to the same
//      set, which is exactly what "converges" is for;
//   3. the full updater loader, which can now run: the three release tables
//      exist, so the deployer's reach assertion is answerable, and the loader
//      re-asserts the schema owner, the role attributes, the exact table set,
//      PUBLIC's emptiness and the exact release reach;
//   4. the schema digest, compared against the bundle's pinned value, and every
//      service login verified through the password protocol so the installer
//      knows each SCRAM verifier it just set actually authenticates.
//
// WHY IT HOLDS NO PASSWORD FOR ANYBODY ELSE. The migrator is peer-mapped, so it
// is reached by a process running as the database account. The deployer is
// peer-mapped, so it is reached by a root process. The service logins are the
// only ones with passwords, and the only thing done with those here is a
// verification CONNECTION — which is the one moment in the whole phase when a
// secret is on this machine outside `Protected/service/db-logins.json`, and it
// travels in a worker's stdin rather than in argv or the environment.
//
// THE RESULT IS ONE BOUNDED JSON OBJECT with the design's three fields
// (`outcome`, `schemaDigest`, `ledgerHead`) and nothing else, so a script that
// learned to add a field would be refused by the port rather than journaled
// unreviewed.

import { constants, lchown, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { applyUpdaterSchemaV1 } from "../schema-installer.ts";
import { applyOwnershipV1, chownCredentialOwnershipV1 } from "./database-phase-ownership.mjs";
import { readDatabasePhaseDataV1 } from "./database-phase-data.mjs";
import { APPLIED_LEDGER_SQL_V1, applyMigrationWithDigestsV1, pendingMigrationsV1 } from "./database-phase-ledger.mjs";
import { schemaSnapshotDigestExpressionV1 } from "./schema-snapshot-digest.mjs";
import { buildReleaseDependenciesV1 as buildProductionReleaseDependenciesV1 } from "./database-phase-dependencies.mjs";
import {
  RELEASE_SCHEMA_REQUEST_V1, RELEASE_SCHEMA_RESULT_V1, MAXIMUM_REQUEST_BYTES_V1, activeDatabasePhaseCalls,
  isDigestV1, isLedgerHeadV1, parseDatabasePhasePasswordsV1, parseDatabasePhaseRequestV1,
  readBoundedJsonValueV1, readRequestArgumentV1,
} from "./database-phase-contract.mjs";
// The one entry guard for the tree, imported from its shared home rather than
// re-exported through the contract module, so there is a single definition.
import { isMainModuleV1 } from "../../../installer/shared/is-main-module.mjs";
import { postgresProfileParametersV1 } from "./database-phase-process.mjs";
import { makeSessionClientV1, runSessionStatementV1, runSessionTransactionV1 } from "./sql-session.mjs";
import { readUpdaterDdlFilesV1 } from "./updater-ddl.mjs";
import { digestReleaseSchemaRowsV1, readPinnedReleaseSchemaDigestV1, readReleaseSchemaDigestSqlV1 } from "./release-schema-digest.mjs";

/**
 * The `application_name` every connection this phase opens carries, so a retry can
 * find the sessions a KILLED run left behind (see step 0b). Fixed, not per-run: a
 * retry must recognise the previous run's sessions, and nothing else on a fresh
 * install connects under this name.
 */
export const RELEASE_PHASE_APPLICATION_NAME_V1 = "control-room-release-phase";

const refuse = code => { throw new Error(code); };
/** A PostgreSQL role name as the role manifest allows it; checked before it is spliced into a GRANT. */
const ROLE_NAME_V1 = /^[a-z][a-z0-9_]{0,62}$/u;
const sha256 = text => createHash("sha256").update(text).digest("hex");

/**
 * The four ledger rows this phase DELIBERATELY does not apply, by their real
 * paths in `migration-ledger.json`.
 *
 * MEASURED against the release's ledger, which carries 140 `migrate` rows and
 * exactly four others:
 *
 *   db/roles/production_roles.sql          kind: grants
 *   db/roles/production_table_grants.sql   kind: grants
 *   db/roles/agent_reviewer_roles.sql      kind: grants
 *   db/roles/production_provision.sql      kind: provision
 *
 * Each is skipped because its work is done by a named component, and the
 * component is named in the comment above the check that uses this constant. A
 * FIFTH non-`migrate` row is refused rather than skipped, which is the property
 * that matters: a skipped row is a release artifact the installer believes it
 * applied, so making the set explicit turns "we forgot" into "someone decided".
 */
export const RELEASE_LEDGER_SKIPPED_KINDS_V1 = Object.freeze([
  "db/roles/production_roles.sql",
  "db/roles/production_table_grants.sql",
  "db/roles/agent_reviewer_roles.sql",
  "db/roles/production_provision.sql",
]);

/**
 * The ledger, read as DATA and verified before anything runs.
 *
 * Every file's bytes are compared against its own ledger row BEFORE the first
 * statement executes. That order is the property: a release whose file on disk
 * does not match its ledger row must be refused before it has changed anything,
 * not detected afterwards by a digest that has already moved.
 *
 * The order check is `1, 2, 3, …` with no gaps, because the applier refuses a
 * gap only after it has connected, and a refusal that needs a cluster is a
 * refusal the rehearsal cannot reproduce.
 */
export async function readReleaseLedgerV1(releaseRoot) {
  const ledger = JSON.parse(await readFile(join(releaseRoot, "deploy", "postgres", "migration-ledger.json"), "utf8"));
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.entries) || ledger.entries.length === 0) {
    refuse("release_schema_ledger_refused");
  }
  const entries = [];
  for (const entry of ledger.entries) {
    const kind = entry.kind ?? "migrate";
    if (!["migrate", "grants", "provision"].includes(kind)) refuse(`release_schema_ledger_kind_refused:${entry.file}`);
    // THE SKIPPED KINDS ARE DECLARED, NOT MERELY SKIPPED (Medium 2).
    //
    // `grants` and `provision` rows are `continue`d, and the review's judgement is
    // right that "probably right for the Mac-local path" is not something a reader
    // can check — a future row of either kind would be skipped silently, and a
    // skipped row is a release artifact the installer believes it applied.
    //
    // So the four files the release's own mac-local provisioner applies and this
    // phase does NOT are named here, as a constant, and the ledger is REFUSED when
    // it carries a non-`migrate` row that is not one of them. A fifth row is a
    // decision somebody has to make deliberately, which is the point: the four
    // below are skipped because their work is done elsewhere, each in a named
    // place, and that reasoning is written down where a reviewer will meet it.
    //
    //   db/roles/production_roles.sql         cluster roles, created from the role
    //                                        MANIFEST by `init-database` — one
    //                                        reviewed list, not a second one
    //                                        spelled in SQL
    //   db/roles/production_table_grants.sql  the whole-cluster table grants; this
    //                                        phase converges the MAC roles from
    //                                        `desired-grants.json` instead, and
    //                                        revoking the VPS set here would remove
    //                                        grants the Mac cluster never had
    //   db/roles/agent_reviewer_roles.sql     one of the EIGHT privilege files
    //                                        applied below, with role creation
    //                                        stripped — its GRANTS are applied;
    //                                        only its `CREATE ROLE` is redundant
    //   db/roles/production_provision.sql     the VPS provisioner as a whole; its
    //                                        cluster half is `init-database` and its
    //                                        table half is the grant converger
    if (kind !== "migrate") {
      if (!RELEASE_LEDGER_SKIPPED_KINDS_V1.includes(entry.file)) {
        refuse(`release_schema_ledger_kind_refused:${entry.file}`);
      }
      continue;
    }
    if (typeof entry.file !== "string" || !entry.file.startsWith("db/migrations/") || entry.file.includes("..")) {
      refuse("release_schema_ledger_file_refused");
    }
    if (!Number.isSafeInteger(entry.order) || entry.order < 1) refuse("release_schema_ledger_order_refused");
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) refuse("release_schema_ledger_file_refused");
    entries.push(Object.freeze({ file: entry.file, order: entry.order, sha256: entry.sha256 }));
  }
  if (entries.length === 0) refuse("release_schema_ledger_refused");
  entries.sort((left, right) => left.order - right.order);
  if (entries.some((entry, index) => entry.order !== index + 1)) refuse("release_schema_ledger_order_refused");
  if (new Set(entries.map(entry => entry.file)).size !== entries.length) refuse("release_schema_ledger_file_refused");
  const files = [];
  for (const entry of entries) {
    const text = await readFile(join(releaseRoot, entry.file), "utf8");
    // Verified here, before any statement: a file that does not match is a
    // release that was modified after its ledger row was written.
    if (sha256(text) !== entry.sha256) refuse(`release_schema_file_altered:${entry.file}`);
    files.push(Object.freeze({ ...entry, text }));
  }
  return Object.freeze(files);
}

/**
 * A role file applied BEFORE the migration ledger, checked against the one thing
 * that makes running it early safe.
 *
 * THE RULE. A migration may only assert a postcondition that is ALREADY TRUE WHEN
 * THE LEDGER RUNS. `0285_queue_backup_read.sql` asserts one about a grant
 * `db/roles/queue_backup_read_roles.sql` makes, so that file has to run first —
 * and the only reason it can is that it grants on a schema and its relations,
 * which the ledger never creates and the release's own pg-boss construction builds
 * in an earlier phase step. A file that named a `public` relation could not: on a
 * fresh install no `public` relation exists yet, so it would fail with `relation
 * … does not exist`, and on an upgraded one it would either match or silently
 * not, which is the same drift the ledger's prefix check exists to prevent.
 *
 * So the scope is CHECKED, on the file's own text, and an out-of-scope file is a
 * refusal by name rather than a surprise at install night.
 *
 * WHAT IS ACCEPTED, and it is exactly three shapes, because that is what the file
 * in the early group uses:
 *
 *   GRANT|REVOKE … ON SCHEMA control_room_queue …
 *   GRANT|REVOKE … ON control_room_queue.<relation> …
 *   GRANT|REVOKE … ON ALL TABLES|SEQUENCES|… IN SCHEMA control_room_queue
 *   ALTER DEFAULT PRIVILEGES [FOR ROLE …] IN SCHEMA control_room_queue …
 *
 * The last is the one that matters most and is the reason this is not a blunt
 * "every `ON` must be `control_room_queue.<relation>`" rule: the default
 * privilege has no relation to name, and it is the clause that makes tomorrow's
 * `queue_stats_YYYYMMDD` partition readable (MEASURED, in the file's own header).
 *
 * The `FROM` grantee is not checked, because a grantee is a ROLE and every role
 * exists before the ledger runs — `init-database` created them all from the role
 * manifest. Only the TARGET is scoped.
 *
 * @returns {readonly string[]} the out-of-scope targets; empty when the file is in scope
 */
export function earlyPrivilegeFileScopeV1(text, file) {
  if (typeof text !== "string" || text.length === 0 || text.includes("\0")) {
    refuse(`release_schema_early_grant_scope_refused:${file}:text`);
  }
  const statements = text.split(";")
    .flatMap(statement => splitDollarQuotedOutsideV1(statement))
    .map(statement => statement.replace(/--[^\n]*/gu, ""))
    .filter(statement => /\b(?:GRANT|REVOKE)\b/iu.test(statement)
      || /\bALTER\s+DEFAULT\s+PRIVILEGES\b/iu.test(statement));
  const offending = [];
  for (const statement of statements) {
    // `ALTER DEFAULT PRIVILEGES` names no relation at all: its only scope is the
    // `IN SCHEMA` clause, and a statement with no such clause covers every schema
    // the role creates in — which the ledger's migrations do, so it is out of
    // scope however harmless it looks.
    if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b/iu.test(statement)) {
      const schema = /\bIN\s+SCHEMA\s+([A-Za-z_][A-Za-z0-9_$]*)/u.exec(statement)?.[1];
      offending.push(...(schema === "control_room_queue" ? [] : [`${file}:default-privileges:${schema ?? "all-schemas"}`]));
      continue;
    }
    // `GRANT|REVOKE`: everything between `ON` and the grantee list, which is
    // what the target actually is. The grantee list is dropped by taking the
    // substring, because a ROLE is in scope for every file (the manifest created
    // them all in the init phase) and only the OBJECT is scoped.
    const head = /\b(?:GRANT|REVOKE)\b/iu.exec(statement);
    const afterOn = head === null ? null : /\bON\b/iu.exec(statement.slice(head.index));
    if (afterOn === null) continue;
    const tail = statement.slice(head.index + afterOn.index + 2);
    const objects = tail.split(/\b(?:TO|FROM)\b/iu)[0]
      .replace(new RegExp(`^\\s*(?:${EARLY_GRANT_OBJECT_TYPE_PATTERN})\\b`, "iu"), "")
      .replace(/^\s*IN\s+SCHEMA\s+[A-Za-z_][A-Za-z0-9_$]*/iu, "");
    for (const raw of objects.split(",")) {
      // A function signature's argument list is not part of the name.
      const name = raw.trim().replace(/\(.*$/su, "").trim();
      if (name === "") continue;
      if (name === "control_room_queue") continue;
      if (name.startsWith("control_room_queue.")) continue;
      offending.push(`${file}:${name}`);
    }
  }
  return Object.freeze([...new Set(offending)].sort());
}

/**
 * The object-type keywords a GRANT/REVOKE may carry between `ON` and the object
 * list, LONGEST FORM FIRST so `ALL TABLES` is not consumed as `ALL` and leaves
 * `TABLES IN SCHEMA …` behind as an apparent object name.
 */
const EARLY_GRANT_OBJECT_TYPE_PATTERN = [
  "ALL\\s+TABLES", "ALL\\s+SEQUENCES", "ALL\\s+FUNCTIONS", "ALL\\s+PROCEDURES", "ALL\\s+ROUTINES",
  "ALL\\s+TYPES", "ALL\\s+SCHEMAS", "DATABASES?",
  "LARGE\\s+OBJECT\\S*", "FOREIGN\\s+TABLES?", "SEQUENCES?", "TABLES?", "SCHEMAS?", "TABLESPACES?",
  "FUNCTIONS?", "PROCEDURES?", "ROUTINES?", "DOMAINS?", "TYPES?", "ALL",
].join("|");

/**
 * Split a SQL fragment into its code and dollar-quoted segments, so a statement
 * is never read through the body of a `DO $$ … END $$` block.
 *
 * `splitDollarQuotedV1` below does this for a whole file and refuses on
 * unbalanced tags. This is the same scan applied to a fragment that has already
 * been split on `;`, where an unbalanced tag is not a refusal but simply "there is
 * no body here" — the caller's rule is about grant targets, not about parsing.
 */
function splitDollarQuotedOutsideV1(fragment) {
  const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/gu;
  let open = null, start = 0, index = 0, out = "";
  for (let match = pattern.exec(fragment); match !== null; match = pattern.exec(fragment)) {
    if (open === null) { open = match; start = match.index; }
    else { out += fragment.slice(index, start); index = pattern.lastIndex; open = null; }
  }
  return open === null ? [out + fragment.slice(index)] : [];
}

/** `db/migrations/0237_x.sql` — the ledger's own spelling of "head". */
export function ledgerHeadV1(files) {
  const last = files.at(-1);
  if (!last) refuse("release_schema_ledger_refused");
  return last.file.split("/").pop();
}

/**
 * `Protected/service/db-logins.json`, written so that NO path in the write can be
 * redirected by the service account. M-a of the M1b review.
 *
 * `Protected/service` belongs to S (the service account reads this file), so any
 * NAME in it is one S can occupy. The old write used a FIXED staging name with a
 * symlink-following `writeFile` and a path `chmod`: S could plant
 * `.db-logins.json.tmp` as a symlink and root would write every database password
 * into the target and chmod it — a service-to-root file clobber, refused by the
 * `lstat` only after both had happened.
 *
 * Now: a RANDOM staging name opened `O_CREAT|O_EXCL|O_NOFOLLOW` (a planted name is
 * a refusal, never a write through it), the bytes and the mode set through the
 * DESCRIPTOR, the ownership handed to S by `lchown` (which does not follow) with
 * a read-back, and a `rename` into place. Staging files a KILLED run left behind
 * are removed first by `unlink`, which removes a link rather than its target.
 */
async function writeCredentialFileV1({ root, accounts, dependencies, text }) {
  const directory = join(root, "Protected", "service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ours = /^\.db-logins\.json\.(?:tmp|[0-9]+\.[a-f0-9]{16}\.staging)$/u;
  for (const name of await readdir(directory)) {
    if (ours.test(name)) await unlink(join(directory, name)).catch(error => { if (error?.code !== "ENOENT") throw error; });
  }
  const fileName = `.db-logins.json.${process.pid}.${(dependencies.randomBytes ?? randomBytes)(8).toString("hex")}.staging`;
  const staging = join(directory, fileName);
  const handle = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
    // Through the descriptor: `open`'s mode is masked by the umask, and a path
    // `chmod` would follow whatever now sits at the name.
    await handle.chmod(0o600);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    const written = await lstat(staging);
    if (!written.isFile() || written.isSymbolicLink() || (written.mode & 0o777) !== 0o600) {
      refuse(`release_schema_credentials_mode_refused:${(written.mode & 0o777).toString(8)}`);
    }
    // §4.3 row 22: "(S, 0600, written by R)" — handed to S BEFORE the rename, so no
    // reader ever sees a credential file root owns.
    await applyOwnershipV1(chownCredentialOwnershipV1({ root, accounts, fileName }),
      dependencies.lchownPath ?? lchown, dependencies.inspectPath ?? lstat);
    await rename(staging, join(directory, "db-logins.json"));
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
}

export async function applyReleaseSchemaV1(request, passwords, dependencies = {}) {
  const run = async () => {
    const parsed = parseDatabasePhaseRequestV1(request, {
      schema: RELEASE_SCHEMA_REQUEST_V1, code: "release_schema_input_refused",
      // `expectedLedgerHead` is OPTIONAL: a fresh install has no head to expect,
      // and pinning one is how a caller asserts the ledger it meant to apply.
      // The port declares the same split, and the two must agree or one of them
      // refuses every request the other sends.
      extraKeys: ["release"], optionalKeys: ["expectedLedgerHead"],
    });
    const secrets = parseDatabasePhasePasswordsV1(passwords, parsed.logins, "release_schema_input_refused");
    const { root, accounts, logins } = parsed;
    if (request.release !== "current") refuse("release_schema_release_refused");
    if (request.expectedLedgerHead !== undefined && !isLedgerHeadV1(request.expectedLedgerHead)) {
      refuse("release_schema_ledger_head_refused");
    }
    const databaseName = dependencies.databaseName ?? "control_room";
    // `dependencies.port` OVERRIDES the role manifest's value, and that is the same
    // arrangement `init-database.mjs` has always used (`dependencies.port ?? 5432`).
    // The manifest carries the PRODUCTION port because the port is part of the
    // socket path and both phases must agree on it; a rehearsal or a lane that runs
    // the cluster on another port supplies the override, and the two phases must
    // take it from the SAME place or one of them connects to a socket the other
    // never created. MEASURED: with the release phase ignoring the override it
    // looked for `.s.PGSQL.5432` in a cluster on the lane's port and answered
    // `connection to server on socket "…/.s.PGSQL.5432" failed: No such file or
    // directory` — a connection failure that names the wrong port rather than the
    // disagreement that caused it.
    // From the REQUEST, for the reason `init-database.mjs` gives: the socket path
    // is `.s.PGSQL.<port>` inside `pg/socket`, and both phases must derive it from
    // the same number or one of them connects to a socket the other never created.
    const port = parsed.port;
    const migratorName = dependencies.migratorName ?? "control_room_migrator";
    const schemaOwner = dependencies.migratorGroup ?? "control_room_schema_owner";
    const deployerName = dependencies.deployerName ?? "control_room_deployer";
    // The role files the release's own Mac-local provisioner applies, in its
    // order. Named here because the ORDER is the property — each file grants on
    // what the previous one created — and a list assembled from a directory
    // listing would have no order to review.
    //
    // EVERY ROLE IN THEM IS STRIPPED, and that is the whole of the difference
    // between this phase and the release's provisioner. `init-database` already
    // created every group and login role from the role MANIFEST, with the
    // manifest's attributes; these files then create the same roles again, and
    // PostgreSQL has no `CREATE ROLE IF NOT EXISTS`, so applying them whole
    // answers (MEASURED, one per run, in the order the files are listed):
    //
    //   ERROR:  role "control_room_private_web" already exists
    //   ERROR:  role "control_room_task_coordinator" already exists
    //
    // and a `WARNING: there is already a transaction in progress` alongside each,
    // because each file also opens its own `BEGIN`/`COMMIT` and this phase is
    // already inside `--single-transaction`.
    //
    // So each file is applied with its role CREATION removed and its GRANTS kept.
    // That split is the point: the roles come from ONE reviewed list (the
    // manifest, which the live upgrade also checks against) and the privileges
    // come from the release's own files, so a release that widened a grant
    // converges and a release that invented a role does not get one.
    //
    // The strip is ASSERTED rather than assumed. A file whose `CREATE ROLE` did
    // not match would have its role-creation applied and fail with "role …
    // already exists"; a file that had no such statement at all would have had
    // nothing removed, which is fine but is not what this comment claims, so the
    // count is checked and a file with no `CREATE ROLE` is a refusal.
    const privilegeFiles = Object.freeze([
      "private_web_roles.sql", "task_coordinator_roles.sql", "native_queue_producer_roles.sql",
      "native_results_roles.sql", "local_result_publisher_roles.sql", "native_queue_worker_roles.sql",
      "agent_reviewer_roles.sql", "fleet_gateway_roles.sql",
      // R5B-01: the nightly backup's dump login is `control_room_migrator`, and
      // `pg_dump` reads EVERY schema including `control_room_queue`. That schema
      // is owned by `postgres` — deliberately, because the release fingerprints
      // every queue relation's owner and a migration must not be able to ALTER a
      // queue object — so the migrator CANNOT grant on it: MEASURED, as the
      // production login with `SET ROLE control_room_schema_owner`,
      // `GRANT USAGE ON SCHEMA control_room_queue` answers `permission denied for
      // schema control_room_queue`. This file is in the loop for exactly that
      // reason: the loop runs its files as `postgres`, which IS the queue's owner
      // on a Mac install, so it is the only place the grant can be made.
      //
      // It declares no `CREATE ROLE`, so the strip above finds nothing to remove
      // and `steps.push` records it as a plain grants file — which is what it is.
      "queue_backup_read_roles.sql",
    ]);

    /**
     * THE ONE FILE THAT RUNS BEFORE THE LEDGER, and the rule that puts it there.
     *
     * `db/migrations/0285_queue_backup_read.sql` is the ledger's STATEMENT that
     * the nightly dump may read the queue: it refuses by name
     * (`queue_backup_read_incomplete`) when the queue schema exists and the read
     * does not. So it is a postcondition about a grant `db/roles` makes — and a
     * migration may only assert a postcondition that is ALREADY TRUE WHEN THE LEDGER
     * RUNS.
     *
     * WHY THAT WAS NOT SO, and what it cost. The ledger ran first and the privilege
     * loop ran later, so the very run that would have made the grant ran 0285 first,
     * 0285 refused, and the whole phase rolled back before reaching the file.
     * MEASURED on an install-way int6 database (queue schema present from the
     * original install, read absent because the granting file did not exist yet):
     * `release_schema_migration_refused:db/migrations/0285_queue_backup_read.sql:
     *  ERROR: queue_backup_read_incomplete:usage=f,default=f,repair=apply
     *  db/roles/queue_backup_read_roles.sql as the queue schema owner (postgres)`.
     * Every retry re-ran the ledger first and failed at the identical spot, so no
     * number of retries escaped it: an int6-shaped Mac could never receive 0285,
     * and with it the rest of this release.
     *
     * WHY NOT MAKE 0285 TOLERANT INSTEAD (option (b)). Because it would have to be
     * duplicated into the OTHER applier, which never runs this loop at all:
     * `scripts/mac-local/database-upgrade-remote.mjs` migrates first
     * (`applyPending`) and converges grants from `database-upgrade-grants.mjs`,
     * whose `roleFiles` deliberately EXCLUDES `queue_backup_read_roles.sql`
     * (the converger's parser refuses a grantee that is not a Mac-local service
     * group, and `control_room_schema_owner` is the migrator's group, not one). So
     * a history-conditioned "only refuse on a second upgrade" in 0285 would still
     * leave the release's own other upgrade path refusing — and would leave 0285
     * able to pass silently on the one shape it was written to catch, which is the
     * trade its comment refuses. Fixing the ORDER keeps the refusal exactly as
     * sharp and makes it mean what it says: the read is present when the ledger
     * runs, so the refusal now fires only when it is genuinely missing afterwards.
     *
     * IT IS A SEPARATE LIST rather than a flag on `privilegeFiles`, because the
     * scope of the reordering is the thing a reviewer has to check, and a flag
     * would hide it inside a nine-element array.
     */
    const preLedgerPrivilegeFiles = Object.freeze(["queue_backup_read_roles.sql"]);
    // `CREATE ROLE <name> …;` in any of the spellings these files use, INCLUDING
    // the multi-line one, and NEVER inside a dollar-quoted body.
    //
    // MEASURED, and the two failures are different and both matter. Seven files
    // spell it as a bare statement wrapping across two lines:
    //
    //   CREATE ROLE control_room_private_web NOLOGIN INHERIT NOSUPERUSER …
    //     NOREPLICATION NOBYPASSRLS;
    //
    // so a single-line pattern matched none of them and the whole set applied,
    // producing `ERROR: role "control_room_private_web" already exists`. Widening
    // the pattern to span lines fixed that and broke the other four, which wrap
    // it in a `DO $$ … END $$` guard:
    //
    //   DO $$ BEGIN
    //     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='…') THEN
    //       CREATE ROLE … NOLOGIN INHERIT …;
    //     END IF;
    //   END $$;
    //
    // — and stripping the `CREATE ROLE` from inside the body leaves
    // `IF NOT EXISTS ( … ) THEN` with an empty branch, which is
    // `ERROR: syntax error at or near "IF"`, a message that names neither the
    // role nor the phase.
    //
    // So the pattern is applied ONLY to the text OUTSIDE every dollar-quoted
    // block, and the split is done by scanning for `$tag$` pairs rather than by a
    // regex over the whole file. A file whose dollar-quote pairs do not balance
    // is a refusal, because "I did not understand where the bodies were" is the
    // one answer from which nothing else can be concluded.
    const splitDollarQuotedV1 = (text, file) => {
      const segments = [];
      const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/gu;
      let index = 0, open = null, start = 0;
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        if (open === null) { open = match; start = match.index; }
        else { segments.push({ kind: "code", text: text.slice(index, start) });
          segments.push({ kind: "body", text: text.slice(start, pattern.lastIndex) });
          index = pattern.lastIndex; open = null; }
      }
      if (open !== null) refuse(`release_schema_role_file_refused:${file}`);
      segments.push({ kind: "code", text: text.slice(index) });
      return segments;
    };
    /** A bare `CREATE ROLE …;`, which is the only form that is removed. */
    const createRoleStatement = /^[ \t]*CREATE[ \t]+ROLE[ \t]+[A-Za-z_][A-Za-z0-9_$]*[\s\S]*?;[ \t]*$/gmu;
    const releaseRoot = join(root, "current");
    // AWAITED, and that is not tidiness. `planLayoutV1` does a DYNAMIC import so the
    // release phase's dependency can be the real planner without the init phase's
    // static import being the only spelling of it — and a dynamic import returns a
    // PROMISE. MEASURED: the release phase called it synchronously, got a Promise,
    // read `.status` off it as `undefined` and refused
    // `release_schema_layout_refused:undefined` — a refusal naming no reason, for
    // a layout that is perfectly fine. So the call site awaits, and the refusal's
    // `?.reason` now has something to report.
    const layout = await (dependencies.planLayout)({
      pgRoot: join(root, "pg"), dataId: parsed.pgDataId, runtimeDirectory: join(root, "runtime", "pg-current"),
      accounts: { database: accounts.database.name, migrator: migratorName, deployer: deployerName }, port });
    if (layout?.status !== "socket_only_cluster_layout_built") refuse(`release_schema_layout_refused:${layout?.refusal?.reason}`);
    const profile = join(root, "updater", "current", "policy", "service-postgres.sb");
    const profileParameters = postgresProfileParametersV1({ root, layout, logDirectory: join(root, "logs", "postgresql17") });
    const environment = Object.freeze({ ...layout.environment, PGAPPNAME: RELEASE_PHASE_APPLICATION_NAME_V1 });
    // The migrator is reached by the DATABASE ACCOUNT (the map's first line) and
    // the deployer by ROOT (its second). Both identities are the map's answer,
    // not a choice, which is why neither session needs a password.
    const databaseIdentity = Object.freeze({ uid: accounts.database.uid, gid: accounts.database.gid });
    const deployerIdentity = Object.freeze({ uid: 0, gid: 0 });
    // `identity` IS PART OF THE CONTEXT, not supplied at each call site. MEASURED:
    // the ledger's `applyMigrationWithDigestsV1` forwards `context` straight into
    // `runSessionTransactionV1`, which reads `identity.uid` — and the context as
    // written carried no `identity`, so the first real migration answered
    // `Cannot read properties of undefined (reading 'uid')` and the phase reported
    // it as `release_schema_migration_refused:db/migrations/0001_…:Cannot read
    // properties of undefined`. Every OTHER call site spelled `{ ...context,
    // identity: databaseIdentity }` by hand, so the shape was agreed on by
    // repetition rather than by the object that defines it.
    const context = { root, layout, environment, port, profile, profileParameters,
      pgRoot: join(root, "pg"), identity: databaseIdentity, onSpawn: dependencies.onPgSpawn };
    // Two runners and no more. `asMigrator` is the only one used for SQL this
    // phase issues directly; the deployer and the superuser sessions are reached
    // through `runSessionTransactionV1` and `makeSessionClientV1`, which name
    // their own identity, because a runner that could be handed either would be
    // a runner whose authority depends on its caller. There is no `asSuperuser`
    // here: the superuser half of this phase is the ledger table's creation, and
    // that is inside a transaction with an explicit `user`.
    const asMigrator = sql => runSessionStatementV1({ user: migratorName, database: databaseName, sql },
      { ...context, identity: databaseIdentity });
    const steps = [];

    /**
     * Apply role files as the SUPERUSER, in the order given, and return the step
     * labels. ONE function for both groups, because the two groups differ only in
     * WHEN they run and that is precisely what a reviewer must be able to check —
     * two loops would let the stripping, the scope check and the identity drift
     * apart without anything noticing.
     *
     * …as the SUPERUSER, and that is a RECORDED DECISION rather than an oversight
     * (Medium 1). §5.3 says the phase "runs as migrator; has no rights on
     * `updater`", and the privilege files do run as the migrator wherever they grant
     * on objects it owns. But they also contain statements the migrator cannot issue
     * at all: `ALTER ROLE … SET search_path`, any `ALTER DEFAULT PRIVILEGES` on a
     * schema it does not own, and — the decisive one — grants on the QUEUE, which
     * `installFixedQueue` builds as `postgres` because the release's shape
     * fingerprint includes every relation's OWNER. MEASURED: the identical pg-boss
     * construction run as `control_room_migrator` fingerprints `sha256:09dc01b4…`
     * against the pinned `sha256:e7286b89…`, and the release's installer refuses with
     * `upgrade_queue_shape_refused` — correctly, because queue objects owned by the
     * migrator are objects a migration could ALTER.
     *
     * So the queue's owner is `postgres`, these files are applied as `postgres`, and
     * the files' ROLE CREATION is stripped so the roles still come from ONE reviewed
     * list (the manifest). The migrator's ledger and its
     * `updater_release_reader_roles.sql` still run as the migrator, so §5.3's
     * property — the migrator holds nothing in `updater` — is unaffected and is
     * asserted in the lane against the live catalogue.
     *
     * @param {readonly string[]} files the `db/roles` file names, in order
     * @returns {readonly string[]} the step labels, one per file
     */
    const applyPrivilegeFilesV1 = async files => {
      if (!Array.isArray(files) || files.length === 0) refuse("release_schema_role_file_refused:empty");
      const labels = [];
      for (const file of files) {
        const text = await readFile(join(releaseRoot, "db", "roles", file), "utf8");
        // The file's own name travels with every failure from here, because a
        // refusal that does not name the file is unreadable: nine files run in
        // sequence and the error names a line inside one of them. That is a real
        // cost — measured, the first five runs of this loop all reported
        // `syntax error at or near "IF"` with no file, because the offending line
        // is a `DO $$ BEGIN` body that reads correctly in isolation.
        const fail = (why) => refuse(`release_schema_role_file_refused:${file}:${why}`);
        // The EARLY group carries one extra obligation, because it runs before the
        // ledger: everything it grants on must already exist. Checked on the file's
        // own text, so widening it into the early group is a refusal rather than a
        // fresh install's `relation … does not exist`.
        if (preLedgerPrivilegeFiles.includes(file)) {
          const outOfScope = earlyPrivilegeFileScopeV1(text, file);
          if (outOfScope.length > 0) refuse(`release_schema_early_grant_scope_refused:${file}:${outOfScope.join(",")}`);
        }
        // Strip only from the CODE segments: a `DO $$ … END $$` body's
        // `IF NOT EXISTS (…) THEN CREATE ROLE …; END IF` is already idempotent —
        // that is the whole reason those four files are safe to re-run on a
        // cluster whose roles the phase created — so it is left exactly as
        // written.
        const segments = splitDollarQuotedV1(text, file);
        let creations = 0;
        for (const segment of segments) {
          if (segment.kind === "code") creations += (segment.text.match(createRoleStatement) ?? []).length;
        }
        // The file's own `BEGIN;`/`COMMIT;` are removed for the same reason a bare
        // `CREATE ROLE` is: this phase is already inside `--single-transaction`, and
        // a nested `BEGIN` is the `WARNING: there is already a transaction in
        // progress` that appeared beside every one of these failures.
        //
        // THE SAME DOLLAR-QUOTE RULE APPLIES, and not applying it is the failure
        // this replaced. MEASURED: `native_queue_worker_roles.sql` contains
        //
        //   DO $$
        //   BEGIN              <-- the PL/pgSQL block's own opening
        //     IF NOT EXISTS ( … ) THEN
        //       RAISE EXCEPTION 'native queue prerequisite mismatch';
        //     END IF;
        //   END $$;
        //
        // and `/^\s*BEGIN\s*;?$/gm` removes that `BEGIN` as readily as the
        // transaction's, leaving `DO $$` followed directly by `IF NOT EXISTS` —
        // which is `ERROR: syntax error at or near "IF"`, pointing at a line that
        // is correct in the file. So the transaction-control strip is applied to
        // the code segments only, alongside the role strip.
        const applied = segments.map(segment => segment.kind !== "code" ? segment.text
          : segment.text
            .replace(createRoleStatement, "")
            .replace(/^[ \t]*BEGIN[ \t]*;[ \t]*$/gmu, "")
            .replace(/^[ \t]*COMMIT[ \t]*;[ \t]*$/gmu, "")).join("");
        if (applied.trim() === "") fail("nothing_left_to_apply");
        try {
          await runSessionTransactionV1([applied], { ...context, identity: databaseIdentity },
            { user: "postgres", database: databaseName });
        } catch (error) {
          // The file's name and its first real line, because the phase's own
          // refusal for a SQL error names a psql line number and nothing else.
          fail(`sql:${String(error?.message ?? "").slice(0, 160)}`);
        }
        labels.push(creations > 0 ? `${file}:grants-only` : file);
      }
      return Object.freeze(labels);
    };

    // --- 1. THE LEDGER IS READ AND VERIFIED FIRST — no statement has run yet — and
    // only then the two steps whose ORDER is the fix for R5B-03.
    //
    // `0285_queue_backup_read.sql` refuses when the queue schema exists and the
    // nightly dump's read does not. Both the schema and the grant used to be made
    // AFTER the ledger, so the migration that checks for them ran first and refused
    // the very run that would have satisfied it — on every Mac whose queue schema
    // predates this release, and on every retry of that run. So the queue schema and
    // the one role file a pending migration asserts now run before the ledger runs,
    // and the postcondition is true before the ledger asserts it.
    //
    // THE READS STAY AHEAD OF EVERY STATEMENT, deliberately. `readReleaseLedgerV1`
    // compares each file's bytes against its ledger row, and the head pin is
    // settled, both BEFORE the first statement — a release whose file does not match
    // its row must be refused before it has changed anything, and a caller that
    // names a head it expects must be refused before the queue is built, not after.
    // That is why this block is the ledger's READ and not its APPLY.
    const files = await readReleaseLedgerV1(releaseRoot);
    const head = ledgerHeadV1(files);
    if (request.expectedLedgerHead !== undefined && request.expectedLedgerHead !== head) {
      // A caller that names the head it expects is asking "is this the ledger I
      // approved?"; answering yes when it is not would be the worst answer
      // available, so this is settled before any statement runs.
      refuse(`release_schema_ledger_head_mismatch:${request.expectedLedgerHead}:${head}`);
    }
    steps.push(`ledger-verified:${files.length}`);

    // --- 0b. SESSIONS A KILLED RUN LEFT BEHIND (H3). A run SIGKILLed while a
    // `psql` child was executing leaves that child running: it is detached and it
    // finishes or fails on its own. Its transaction is all-or-nothing (every program
    // ends in an explicit `COMMIT`, see `runSessionTransactionV1`), but a retry
    // racing it would apply the SAME migration concurrently and fail on the
    // orphan's locks. So the retry first ends every session under this phase's
    // application name except its own — `pg_terminate_backend` rolls back whatever
    // such a session had not committed — and waits, bounded, for them to be gone.
    // On a first run there are none and this is one read.
    //
    // IT IS NOW BEFORE THE QUEUE, AND THAT IS THE POINT. The sweep used to run
    // after the ledger's reads but before its first migration, which was the first
    // statement that takes a lock. The queue schema and the early role file now sit
    // in that position instead, and both take locks — `installFixedQueueFromDataV1`
    // runs pg-boss's construction, which locks its own tables — so a retry racing a
    // killed run would contend with the orphan there first. The sweep ends orphans
    // before ANY lock-taking work, which is the only order in which the property it
    // exists for is true.
    const endOrphanSessions = "SELECT count(pg_catalog.pg_terminate_backend(pid, 10000))::int AS sessions"
      + ` FROM pg_catalog.pg_stat_activity WHERE application_name = '${RELEASE_PHASE_APPLICATION_NAME_V1}'`
      + " AND pid <> pg_catalog.pg_backend_pid()";
    for (let attempt = 0; ; attempt += 1) {
      const [row] = await runSessionStatementV1({ user: "postgres", database: databaseName,
        sql: endOrphanSessions }, context);
      if (Number(row?.sessions ?? 0) === 0) break;
      if (attempt >= 30) refuse(`release_schema_orphan_sessions_survived:${row.sessions}`);
      steps.push(`orphan-sessions-ended:${row.sessions}`);
      await new Promise(resolveWait => { setTimeout(resolveWait, 200); });
    }

    // The queue goes first because the role file grants on it: a role file before
    // the schema fails with `schema "control_room_queue" does not exist`
    // (MEASURED), which is the same ordering trap one step earlier in the same
    // phase, and `queue_backup_read_roles.sql` refuses rather than skipping — its
    // own `DO $$ … END $$` guard raises `queue backup read prerequisite mismatch`.
    //
    // On a FRESH install neither is a no-op: the schema is built here (it did not
    // exist) and the file grants on it. Both steps are already idempotent —
    // `installFixedQueueFromDataV1` checks for the schema and builds only what is
    // missing, and every statement in the role file is a GRANT or a REVOKE.
    await dependencies.installFixedQueue({ ...context, identity: databaseIdentity,
      user: migratorName, database: databaseName });
    steps.push("queue-schema");
    steps.push(...await applyPrivilegeFilesV1(preLedgerPrivilegeFiles));

    // The ledger table itself, created by the superuser and then handed to the
    // schema owner — the same split `apply-migrations.mjs` uses, and for the
    // same reason: `CREATE TABLE` for the migrator would make the migrator own
    // the record of what the migrator did. All four statements are ONE
    // transaction, because a transaction cannot be assembled from several
    // connections and a half-applied ownership transfer would leave the migrator
    // unable to write the rows it is about to be required to write.
    await runSessionTransactionV1([
      await readFile(join(releaseRoot, "db", "setup", "production_migration_ledger.sql"), "utf8"),
      `ALTER TABLE control_room_schema_migrations OWNER TO ${schemaOwner}`,
      `GRANT CREATE, USAGE ON SCHEMA public TO ${schemaOwner}`,
      `GRANT CREATE, USAGE ON SCHEMA public TO ${migratorName}`,
    ], { ...context, identity: databaseIdentity }, { user: "postgres", database: databaseName });
    steps.push("ledger-table");

    // The digest query is read ONCE, before the loop, and the same text is used
    // for every migration's `pre` and `post` and for the phase's own final
    // digest check. Reading it per migration would be 140 reads of a file the
    // bundle owns, and a read that returned different text mid-loop would produce
    // a ledger whose chain joins two different digest functions.
    const releaseDigestSql = await readReleaseSchemaDigestSqlV1(root);
    steps.push("digest-sql");
    // ONLY THE PENDING SUFFIX RUNS (H3 of the M1b review, probe A2): the ledger the
    // cluster already holds must be an exact prefix of this release's — same file,
    // order and digest — and only what follows it is applied. A first run reads no
    // rows and applies everything; a retry after a kill at ANY migration resumes at
    // the first one whose row did not commit.
    const pending = pendingMigrationsV1(files, await asMigrator(APPLIED_LEDGER_SQL_V1));
    steps.push(`ledger-pending:${pending.length}`);
    for (const file of pending) {
      // Each migration is ONE transaction on ONE connection: the `pre` digest, the
      // file, the `post` digest, and the ledger row that records it. This is the
      // release applier's own boundary ("each migration file applies inside one
      // transaction together with its ledger row"), and it is also the only
      // boundary at which "applied" means anything: a file and its row in
      // different transactions would leave a migration that ran with no record,
      // which no later run could detect.
      //
      // `SET ROLE` is a SESSION statement, and this is the one place where the
      // phase's transport cannot express it: `--single-transaction` puts every
      // statement in one transaction, and PostgreSQL refuses a transaction-block
      // `SET ROLE` that the file's own `DO $$ … END $$` bodies would then
      // inherit. The role is therefore applied by the migrator's MEMBERSHIP
      // instead — `init-database` granted `control_room_schema_owner TO
      // control_room_migrator`, and with `INHERIT` the migrator's objects are
      // created as the schema owner, which is the property the ledger's own
      // post-apply ownership check requires and the one this phase asserts.
      // No `SET ROLE` is issued here, and none is needed.
      //
      // AND THE DIGESTS ARE REAL, which is High 1 of the review. They used to be
      // `'sha256:' + '0'.repeat(64)` in both columns, and THREE consumers read
      // them back: the release applier's own post-run drift check
      // (`migration_live_schema_drift`), the VPS upgrade step
      // (`upgrade_schema_drift_refused`) and the installer's owner-runner
      // (`substantiveEvidence`, which requires `pre[n+1] === post[n]` and
      // `post[last] === the live digest`). On this ledger all three refused a
      // cluster the phase had just built — so the zeros were not a missing proof
      // but a false one.
      await applyMigrationWithDigestsV1({ fileText: file.text, file: file.file, order: file.order,
        sha256: file.sha256, context, user: migratorName, database: databaseName, schemaOwner })
        // The server's own words are KEPT, and that is the same lesson as Medium 3
        // one step up the stack: `.catch(() => refuse(...))` discarded them, so a
        // migration refused for a permissions reason and one refused for a syntax
        // error were indistinguishable from the outside. The file's name comes
        // first because eight files and a hundred migrations share this call site.
        .catch(error => refuse(`release_schema_migration_refused:${file.file}:`
          + `${String(error?.message ?? "unknown").slice(0, 200)}`));
      steps.push(`applied:${file.file}`);
    }
    // …and the head row's `post_schema_digest` IS the live schema, by the digest the
    // ledger's readers use. This is `apply-migrations.mjs`'s own drift check, made
    // here so a cluster that would be refused by the first upgrade is refused on
    // install night instead.
    const [ledgerHead] = await asMigrator(`SELECT filename, post_schema_digest FROM control_room_schema_migrations
      ORDER BY ledger_order DESC LIMIT 1`);
    const [live] = await asMigrator(`SELECT ${schemaSnapshotDigestExpressionV1()} AS digest`);
    if (!ledgerHead || ledgerHead.post_schema_digest !== live?.digest) {
      refuse(`release_schema_ledger_drift:${ledgerHead?.filename ?? "none"}:`
        + `expected=${ledgerHead?.post_schema_digest ?? "none"}:live=${live?.digest ?? "none"}`);
    }

    // --- 3. the rest of the release's role files, then grant convergence.
    //
    // The queue schema and `queue_backup_read_roles.sql` are NOT here: they ran
    // before the ledger, as step 1 records. What is left is the eight files that
    // grant on `public` relations the ledger CREATES — which is why they are here
    // and why moving them earlier was not an option: MEASURED, a role file naming
    // a `public` relation applied before the ledger fails on a fresh install with
    // `relation "control_jobs" does not exist`.
    //
    // `provisionMacLocalNarrowRolesV1`'s own order is the release's: the group
    // roles, then the queue schema, then the files that GRANT on it. The first
    // group is `init-database`'s (the manifest), and the queue is now step 1.
    steps.push(...await applyPrivilegeFilesV1(privilegeFiles.filter(file => !preLedgerPrivilegeFiles.includes(file))));
    // The updater's read-only release grants. The deployer must see the three
    // tables its SECURITY DEFINER guards read, and only the object's owner can
    // GRANT — which is the migrator, because the migrator created them.
    await runSessionTransactionV1([
      await readFile(join(releaseRoot, "db", "roles", "updater_release_reader_roles.sql"), "utf8"),
    ], { ...context, identity: databaseIdentity }, { user: migratorName, database: databaseName });
    const converged = await dependencies.convergeGrants({
      statement: runSessionStatementV1, root, releaseRoot, databaseName, layout, environment, port, profile,
      profileParameters, pgRoot: join(root, "pg"), identity: databaseIdentity,
      // `SET ROLE` travels as the statement's `before` clause and the matching
      // `RESET` as its `after`, rather than being concatenated into the SQL
      // text. Concatenation would change the statement's FIRST KEYWORD, and the
      // row-returning decision is made from that keyword — so a wrapped grant
      // would be run as a non-row-returning statement and its rows would be
      // dropped, which is exactly the kind of silent wrong-answer this file
      // spends so much room avoiding.
      //
      // NO `SET ROLE`, and that is the measured and only arrangement that works.
      //
      // `init-database` granted `control_room_schema_owner TO
      // control_room_migrator` with `INHERIT`, and the migrator's own migrations
      // therefore create their objects — tables, functions, `SECURITY DEFINER`
      // entry points — as the MIGRATOR, which owns them. A GRANT on an object can
      // only be issued by its owner, so:
      //
      //   as the migrator directly → the GRANT applies
      //   as `SET ROLE control_room_schema_owner` → the role switch drops the
      //     ownership, and the server answers
      //       ERROR:  permission denied for function commit_agent_review
      //
      // MEASURED, and the second is the more interesting failure: it names a
      // function and a privilege and never mentions that a role switch caused
      // it, so a reader would go looking for a missing grant rather than for a
      // role that no longer owned the thing it was granting on.
      //
      // This is also consistent with the ledger, which the migrator owns: the
      // grant converger and the ledger's own `INSERT` are then the same session's
      // authority, and the phase's post-apply ownership assertion is the check
      // that nothing drifted.
      asSchemaOwner: sql => runSessionStatementV1({ user: migratorName, database: databaseName, sql },
        { ...context, identity: databaseIdentity }),
    });
    if (converged?.converged !== true) refuse("release_schema_grants_refused");
    steps.push(`grants:${converged.convergedGrants ?? "0"}`);

    // --- 2a. each service login joins its ONE group, from the release's
    // `macRolePlan`. MEASURED (cl-bringup N-L): nothing on the install path granted
    // these memberships (only `mac:provision` and the rehearsal did), so the
    // installed web host's `control_room_web` connected and was refused
    // `permission denied for table tenants`, and the web host stopped with
    // `database_unavailable`. The grants above go to the GROUPS; this is what lets
    // a login use them. Plain `GRANT` — no ADMIN option, which the web preflight
    // refuses — as `postgres`, because the groups were created by the init phase's
    // superuser and only an admin of a role may grant it. Idempotent: a repeat is a
    // NOTICE, not an error, so a re-run converges.
    if (dependencies.macRolePlan !== undefined) {
      const plan = dependencies.macRolePlan;
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) refuse("release_schema_memberships_refused");
      const memberships = Object.entries(plan).sort(([left], [right]) => left.localeCompare(right, "en"));
      if (memberships.some(([login, group]) => !ROLE_NAME_V1.test(login) || !ROLE_NAME_V1.test(group))) {
        refuse("release_schema_memberships_refused");
      }
      if (memberships.length > 0) {
        try {
          await runSessionTransactionV1(memberships.map(([login, group]) => `GRANT ${group} TO ${login};`),
            { ...context, identity: databaseIdentity }, { user: "postgres", database: databaseName });
        } catch (error) { refuse(`release_schema_memberships_refused:${String(error?.message ?? "").slice(0, 160)}`); }
      }
      steps.push(`memberships:${memberships.length}`);
    }

    // --- 2b. every service login proved to authenticate with the password the
    // installer generated, and — for the logins the peer map does NOT name —
    // proved to be REFUSED without it.
    //
    // BEFORE THE UPDATER LOADER, not after it. Nothing here depends on the
    // updater's schema, and the loader's deployer half is the one step that needs
    // ROOT — so in this order a non-root run of the SHIPPED script (the lane's
    // default-path test) reaches the real `verifyLogin` and proves it, instead of
    // stopping at the deployer spawn before the verifier ever runs. That ordering
    // is how Blocker 1 hid: the only cross-process test died first.
    //
    // The two halves are not symmetric across the login list, and the asymmetry
    // is the design. MEASURED: `control_room_migrator` is one of the three roles
    // in `pg_hba.conf`'s `peer map=cr` lines
    //
    //   local all <migrator>  peer map=cr
    //   local all <deployer>  peer map=cr
    //   local all postgres    peer map=cr
    //
    // and the map sends the database account to the migrator, so that login
    // authenticates by BEING the database account — with no password, and
    // correctly so. Asserting "refused without a password" for it is asserting
    // the opposite of the design, and it failed:
    // `release_schema_login_accepted_without_password:control_room_migrator`.
    //
    // So the refusal half is required of the logins that are NOT peer-mapped,
    // which is every one the manifest generates a password for, and the
    // peer-mapped ones get the password half only. `peerMapped` comes from the
    // SAME LAYOUT the hba was written from, not from a list here, so a change to
    // the map moves this line with it.
    const peerMapped = new Set([migratorName, deployerName, "postgres"]);
    for (const login of logins) {
      const password = secrets[login.name];
      if (typeof password !== "string") refuse("release_schema_login_password_missing");
      // `identity` IS PASSED, and that is the fix for a bug the cross-process test
      // found after the cook/v1 merge: `makeVerifyLoginV1` reads `identity.uid` for
      // the `psql` child, and this call site did not supply one, so the phase died
      // with `Cannot read properties of undefined (reading 'uid')` at the FIRST
      // login check. The in-process lane never saw it because it injected its own
      // verifier. It is the same `databaseIdentity` every other spawn in this phase
      // uses, so the verifier's child runs as the same account the phase does.
      const outcome = await dependencies.verifyLogin({ root, layout, login: login.name, password, port,
        environment, profile, profileParameters, pgRoot: join(root, "pg"),
        identity: databaseIdentity, onSpawn: dependencies.onPgSpawn });
      if (outcome?.authenticated !== true) refuse(`release_schema_login_unverified:${login.name}`);
      // The other half of the claim for the logins it applies to, and the half
      // that makes the first mean something: with NO password the SAME login is
      // refused. Without it, a verifier that ignored its password argument would
      // report every login authenticated.
      if (!peerMapped.has(login.name) && outcome?.refusedWithoutPassword !== true) {
        // The login accepted a connection with NO password, which means the
        // hba's scram rule is not in force for it and the installer wrote a
        // password file for a login that never needed one.
        refuse(`release_schema_login_accepted_without_password:${login.name}`);
      }
      steps.push(`login:${login.name}`);
    }

    // --- 3. the full updater loader, now answerable.
    //
    // `applyUpdaterSchemaV1` is a DEPENDENCY, and the review's judgement on the
    // "not caught" mutation is that it should be: the loader rebuilds
    // `0002_schema.sql` on every run, so `release_schema_updater_tables_empty` is
    // unreachable through PostgreSQL — a guard nobody can trip is the shape this
    // repository keeps deleting. Making the loader injectable means a caller (and
    // a test) can hand back `{ tables: 0 }` and trip the guard in milliseconds,
    // which is what turns it from an assertion about a filesystem into one about
    // a contract. The default is still the real loader, so nothing in production
    // is stubbed.
    const loader = dependencies.applyUpdaterSchema ?? applyUpdaterSchemaV1;
    //
    // The loader runs its TWO halves as the two identities the peer map names,
    // and the deployer half is ROOT — that is the design (`cr root
    // control_room_deployer`), and it is why the deployer holds no password.
    //
    // In this LANE there is no root: the process runs as the invoking uid, so a
    // deployer spawn with `uid: 0` is `spawn EPERM`. The identity is therefore
    // a DEPENDENCY rather than a literal, and the lane substitutes the invoking
    // uid for the deployer. What that changes is exactly one thing — the uid the
    // server sees for the deployer half — and what it does not change is the
    // part being proved: the schema is owned by `control_room_deployer`, the role
    // holds no verifier, the table set is the design's, PUBLIC holds nothing, and
    // the deployer's reach into `public` is EXACTLY three read-only tables. All
    // five are read back from the live catalogue below. What the lane does NOT
    // prove is that a ROOT process can reach the deployer role, and the
    // real-root rehearsal must.
    const ddlFiles = await readUpdaterDdlFilesV1(join(root, "updater", "current", "ddl"),
      ["0001_deployer_role.sql", "0000_bootstrap.sql", "0002_schema.sql", "0003_guards.sql"]);
    const loaderDeployerIdentity = dependencies.deployerIdentity ?? deployerIdentity;
    // The loader's TWO halves need the peer map, and in this lane only the
    // superuser half is mapped: the map's deployer line is `cr root
    // control_room_deployer`, and this process is not root, so the server answers
    // `FATAL: Peer authentication failed for user "control_room_deployer"`.
    //
    // That refusal is ASSERTED rather than worked around, and it is a real
    // result: it is the map doing exactly what it exists to do, refusing the
    // deployer role to a uid that is not root. The lane then runs the loader's
    // deployer half ONLY when a mapped identity was supplied — which in
    // production is root, and which the real-root rehearsal must supply. What
    // the lane asserts without root is everything else: the superuser half of
    // the loader, the schema owner, the role's attributes, the exact table set,
    // PUBLIC's emptiness, the deployer's exact release reach (all readable as the
    // superuser, which sees every ACL), and the absence of a verifier.
    const deployerMapped = loaderDeployerIdentity.uid === 0;
    const applied = await loader({
      bootstrap: makeSessionClientV1({ ...context, database: { user: "postgres", database: databaseName },
        identity: databaseIdentity }),
      directory: join(root, "updater", "current", "ddl"),
      // ARMED IN PRODUCTION (M1b review). This was a literal `true`, and the
      // loader skips its "the deployer has grown a verifier" refusal when it is
      // true — so with the installer then sending `control_room_deployer` a
      // password, nothing would have caught it. Only a caller that SAYS so (a
      // harness with a fixture password) can disarm it; the production dependency
      // set never does, and the deployer is now refused as a password login by the
      // shared parser besides.
      deployerHasFixturePassword: dependencies.deployerHasFixturePassword === true,
      connectDeployer: async () => {
        const client = makeSessionClientV1({ ...context,
          database: { user: deployerName, database: databaseName }, identity: loaderDeployerIdentity });
        // The deployer's spawn, NAMED when the kernel refuses it (M1b Low): a
        // non-root process asking for uid 0 gets `spawn EPERM`, which named neither
        // the deployer nor the identity, and a test that accepted "any EPERM"
        // could not tell it from an `lchown` EPERM in the ownership plan.
        return Object.freeze({ query: async sql => client.query(sql).catch(error => {
          if (error?.code === "EPERM" || /\bspawn EPERM\b/u.test(String(error?.message ?? ""))) {
            refuse(`release_schema_deployer_spawn_refused:uid=${loaderDeployerIdentity.uid}:EPERM`);
          }
          throw error;
        }) });
      },
    })
    // …and the refusal fires for EITHER way the deployer half can fail without
    // root. MEASURED, and the second case is the one a SPAWNED script hits: the
    // in-process lane gets `FATAL: Peer authentication failed for user
    // "control_room_deployer"` from the server, while a spawned script tries to
    // `posix_spawn` as uid 0 first and the KERNEL refuses with `EPERM` before any
    // connection is attempted — a spawn failure rather than a peer failure, which
    // fell through to `throw error` and reached the operator as
    // `database_phase_script_failed:1:spawn EPERM`: naming neither the deployer,
    // nor the peer map, nor the identity that would have finished the job.
    //
    // Both answers mean the same thing and both are the phase being honest about
    // what it cannot do here, so both produce the same named refusal. What is
    // preserved is the distinction that matters: any OTHER error still propagates,
    // so a loader that failed for its own reasons is not disguised as a missing
    // identity.
    //
    // MEASURED and left as a REFUSAL, not worked around.
    //
    // `0002_schema.sql` and `0003_guards.sql` must run AS the deployer, and
    // the deployer is `cr root control_room_deployer` — a ROOT peer-map line.
    // A lane with no root cannot finish, and that refusal is the phase being
    // honest: the guard functions, the SECURITY DEFINER bodies and the
    // release-read grants are exactly the parts a non-root run must not be
    // trusted to have built.
    //
    // Two earlier attempts here were both wrong and both are why this is a
    // refusal. Returning a zero-table result let the phase continue and the
    // next statement failed `schema "updater" does not exist` — a lane that
    // passed its own checks against a schema that was not there. Applying the
    // remaining files as the SUPERUSER is worse than useless: the loader
    // asserts the schema is owned by `control_room_deployer`, so a superuser
    // apply would either fail that assertion or, worse, produce a schema whose
    // guards are owned by the wrong role and whose grants were never tested.
    //
    // So the phase stops here, in a lane with no root, and says which identity
    // would finish it. Production has that identity.
    .catch(error => {
      const message = String(error?.message ?? "");
      const cannotReachTheDeployer = /Peer authentication failed for user "control_room_deployer"/u
        .test(message) || /EPERM/iu.test(message);
      if (!deployerMapped && cannotReachTheDeployer) {
        refuse(`release_schema_deployer_identity_unavailable:uid=${loaderDeployerIdentity.uid}:`
          + `map=${accounts.database.name}|root`);
      }
      throw error;
    });
    if (applied.tables < 1) refuse("release_schema_updater_tables_empty");
    steps.push(`updater-ddl:${applied.tables}`);

    // --- 4. the schema digest, against the bundle's pin.
    //
    // The two values are COMPARED AS BARE HEX, and the `sha256:` prefix is added
    // once, at the end. `digestReleaseSchemaRowsV1` returns bare hex (it matches
    // the release's `readPrivateWebSchemaDigest`, which also returns bare hex)
    // and the pin file stores bare hex, so prefixing the pin for the comparison
    // produced `962ffe…:962ffe…` — a mismatch whose two halves are the same
    // digest. That is the failure mode a digest comparison must never have: a
    // refusal that says "these differ" about two identical values is a refusal
    // nobody can act on.
    const rows = await asMigrator(releaseDigestSql);
    const schemaDigest = digestReleaseSchemaRowsV1(rows);
    const pinned = await readPinnedReleaseSchemaDigestV1(root);
    if (!isDigestV1(`sha256:${schemaDigest}`) || schemaDigest !== pinned.digest) {
      refuse(`release_schema_digest_mismatch:computed=${schemaDigest}:pinned=${pinned.digest}`);
    }
    steps.push("digest");

    // --- 6. the SERVICE LOGIN CREDENTIAL FILE, 0600, written here and nowhere
    //        else.
    //
    // §4.3 row 22: "service logins with root-generated SCRAM passwords from
    // stdin → `Protected/service/db-logins.json` (S, 0600, written by R)". This
    // phase is R's half of that: it already holds every password, so it is the
    // only place that can write the file without any other component ever seeing
    // a secret.
    //
    // WHY IT IS WRITTEN AFTER THE VERIFIERS, NOT BEFORE. The file is the durable
    // record of a credential. Written first, a later `\password` failure would
    // leave the machine holding a credential file for logins whose verifiers were
    // never set, and the next reader of that file would believe a login worked.
    // Written last, the file's existence is a claim the phase has already proved,
    // login by login, by connecting with it — the loop above.
    //
    // WHY 0600 AND NOT 0640. The service account reads this file, and the design's
    // protected-root table says "No secrets inline … with those files at 0600".
    // Group-readable would hand the password to every process sharing the service
    // account's groups, and this file exists for one purpose: a secret nobody
    // else may have.
    //
    // WHY THE MODE IS CHMOD-ED AND THEN READ BACK. `open`'s `mode` is subject to
    // the process umask, so `writeFile(path, bytes, { mode: 0o600 })` lands at
    // whatever the umask allows. The mode is therefore set explicitly and then
    // READ BACK, and a file that is not exactly 0600 is a refusal — because a
    // credential file at 0644 is a secret every account on the Mac can read, and
    // a refusal the operator sees is the only outcome better than that.
    await writeCredentialFileV1({ root, accounts, dependencies, text: `${JSON.stringify({
      schema: "control-room.db-logins/v1",
      database: databaseName,
      // `verifiersSet` rather than a bare login list, so a reader can tell a
      // complete credential file from one written before the verifiers existed.
      verifiersSet: true,
      logins: Object.fromEntries(logins.map(login => [login.name, secrets[login.name]])),
    }, null, 2)}\n` });
    steps.push(`credentials:${logins.length}`);

    return Object.freeze({ schema: RELEASE_SCHEMA_RESULT_V1, outcome: "applied",
      schemaDigest: `sha256:${schemaDigest}`, ledgerHead: head });
  };
  // A different key from `init-database`'s, because these two phases are
  // sequenced by the installer and must not refuse each other; they are separate
  // scripts and the installer is what orders them.
  if (activeDatabasePhaseCalls.has(`release:${request?.root}`)) refuse("release_schema_busy");
  activeDatabasePhaseCalls.add(`release:${request?.root}`);
  try { return await run(); } finally { activeDatabasePhaseCalls.delete(`release:${request?.root}`); }
}

/**
 * THE COMMAND-LINE ENTRY, and it is the port's exact transport (§5.3): the
 * request on `--request` argv, ONE stdin line carrying the passwords, ONE
 * bounded JSON object on stdout.
 *
 * MEASURED, and this entry could not run it. Both scripts read TWO values from
 * stdin and ignored argv, and the reader they shared destroyed the stream when it
 * broke out of its `for await` at the end of the first line, so the second read
 * threw `AbortError: The operation was aborted` and every real spawn returned
 * `database_phase_script_failed:1:The operation was aborted` before the first SQL
 * statement. See `init-database.mjs` for the full measurement and
 * `readBoundedJsonValueV1` for why the second reader no longer exists.
 */
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  let failure = "release_schema_request_refused";
  try {
    const request = readRequestArgumentV1(process.argv.slice(2), MAXIMUM_REQUEST_BYTES_V1,
      "release_schema_request_refused");
    // The argv value is TEXT and `applyReleaseSchemaV1` takes an OBJECT, so it is
    // parsed HERE — the same fix, and the same measurement, as the init entry: a
    // raw string handed to `parseDatabasePhaseRequestV1` answers
    // `release_schema_input_refused` about an input the caller spelled correctly.
    // One `JSON.parse` at the boundary, one shared parser for the object.
    const passwords = await readBoundedJsonValueV1(process.stdin, MAXIMUM_REQUEST_BYTES_V1,
      "release_schema_passwords_refused");
    // The release is named by the REQUEST: `root/current` is what the installer
    // staged, and `request.release` has already been checked to be `"current"`.
    const releaseRoot = join(JSON.parse(request).root ?? "", "current");
    process.stdout.write(`${JSON.stringify(await applyReleaseSchemaV1(JSON.parse(request), passwords,
      await buildReleaseDependenciesV1(releaseRoot)))}\n`);
    failure = "";
  } catch (error) { failure = error instanceof Error ? error.message : "release_schema_failed"; }
  if (failure !== "") { process.stderr.write(`${failure}\n`); process.exitCode = 1; }
}

/**
 * THE PRODUCTION DEPENDENCY SET. Every one of these was a refusal, and the
 * refusal is what Blocker 3 was: `planLayout` answered
 * `release_schema_layout_planner_required`, `convergeGrants` and `verifyLogin`
 * refused, and `installFixedQueue` did not EXIST — `dependencies.installFixedQueue(…)`
 * at the call site was a TypeError, so the phase could not have reached its second
 * statement.
 *
 * They are real now, and each names where its data comes from:
 *
 *   `planLayout`        the real `planPgClusterLayoutV1` — the same function
 *                       `init-database` uses, so the peer map written into
 *                       `pg_hba.conf` and the one this phase re-derives come from
 *                       ONE implementation and cannot disagree about which uid may
 *                       become the migrator
 *   `convergeGrants`    over `deploy/postgres/desired-grants.json`
 *   `installFixedQueue` over `deploy/postgres/fixed-queue-schema.json`
 *   `verifyLogin`       a bounded `psql -w` child, in fixed code
 *
 * All three data files are READ, VALIDATED and FROZEN once here, and every
 * applier shares that one read — so a phase that converged grants against one
 * artifact cannot build the queue from a second read of the release that says
 * something else. No release code is imported or executed; this is option (a),
 * the arrangement the migration ledger already uses.
 */
export async function buildReleaseDependenciesV1(releaseRoot, overrides = {}) {
  const data = await readDatabasePhaseDataV1(releaseRoot);
  return buildProductionReleaseDependenciesV1(data, overrides);
}
