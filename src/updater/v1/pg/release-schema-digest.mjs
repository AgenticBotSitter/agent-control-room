// The updater's own record of the release schema's shape, and how it is
// digested.
//
// WHY THIS FILE EXISTS RATHER THAN AN IMPORT. The digest the install journal
// records has to be computed by UPDATER code, because the updater must be able
// to answer "has the release schema moved?" without importing release code — the
// trust-domain rule that keeps `pg` and TypeScript out of the updater bundle.
// Importing `readPrivateWebSchemaDigest` from `src/web/v1/` would break that
// rule, and a weaker answer was not available: the design's health check (§5.8)
// compares this digest on every install and on every start.
//
// SO THE SQL LIVES IN ITS OWN FILE, `release-schema-digest.sql`, beside this
// one, and is COPIED VERBATIM from `readPrivateWebSchemaDigest`. A query copied
// into a JavaScript template literal would be a second place to edit it and no
// place a reviewer could diff; as a file it is greppable, and the duplication is
// made safe BY A TEST rather than by hope:
// `tests/install-database-phase-real-postgres.test.mjs` extracts the release
// module's own query from its source, strips comments from both, and asserts
// they are the same text — so a migration that changes the release schema and a
// somebody editing only one of the two copies both fail that test. It is the
// same "equivalence test until the TypeScript version is deleted" shape the
// design uses for the launch-daemon plist bytes, and it is the only honest way
// to have both a self-contained updater and a digest that means the same thing
// to both halves of the system.
//
// The query excludes the migration-ledger table BY OWNER
// (`control_room_schema_owner`), not by name alone. A ledger that counted its own
// rows would digest the data rather than the schema, and a look-alike table with
// a different owner would then be missed.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalConstraintManifestRowsV1 } from "./canonical-constraint-definition.mjs";

const refuse = code => { throw new Error(code); };

/** The digest query, as a file inside the bundle. */
export const RELEASE_SCHEMA_DIGEST_SQL_RELATIVE_PATH_V1 = "pg/release-schema-digest.sql";

/** Read the digest query from the install root's bundle. */
export async function readReleaseSchemaDigestSqlV1(root) {
  const path = join(root, "updater", "current", RELEASE_SCHEMA_DIGEST_SQL_RELATIVE_PATH_V1);
  const text = await readFile(path, "utf8");
  if (text.length === 0 || text.length > 1024 * 1024 || text.includes("\0")) refuse("release_schema_digest_sql_refused");
  return text;
}

/**
 * The digest of the rows this file's query returned.
 *
 * The hash is over `JSON.stringify(rows)` and nothing else, matching the release
 * exactly. A different serialisation — sorted keys, a canonical-JSON pass — would
 * produce a different value for the same schema, and the two halves would then
 * disagree for a reason no test would attribute correctly.
 *
 * The rows are canonicalised FIRST, by the same function the release applies, and
 * that is load-bearing rather than cosmetic: `pg_dump`/`pg_restore` re-parse
 * every CHECK constraint, and a constraint written with `BETWEEN` comes back with
 * the n-ary tree instead of the nested one, so `pg_get_constraintdef` renders it
 * with different parentheses. Without this the updater's health check would
 * report the release schema as having MOVED on a database that was restored from
 * a backup of itself, and the install would be refused. See
 * `canonical-constraint-definition.mjs`.
 */
export function digestReleaseSchemaRowsV1(rows) {
  if (!Array.isArray(rows)) refuse("release_schema_digest_rows_refused");
  return createHash("sha256").update(JSON.stringify(canonicalConstraintManifestRowsV1(rows))).digest("hex");
}

/**
 * The pinned digest, read from the bundle's own policy file.
 *
 * It is a FILE rather than a constant in this module so the value the install
 * compares against is a reviewed artifact in `policy/`, beside the accounts and
 * the bundle policy, and so a rehearsal can point at its own. The read is
 * checked: a missing, malformed or non-digest value is a refusal, because
 * "compare against nothing" would silently pass.
 */
export async function readPinnedReleaseSchemaDigestV1(root) {
  const path = join(root, "updater", "current", "policy", "release-schema-digest.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value?.schema !== "control-room.release-schema-digest/v1" || !/^[a-f0-9]{64}$/u.test(value.digest ?? "")) {
    refuse("release_schema_digest_pin_refused");
  }
  return Object.freeze({ digest: value.digest, path });
}
