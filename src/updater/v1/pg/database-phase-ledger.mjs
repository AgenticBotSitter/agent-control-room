// ONE MIGRATION, ONE TRANSACTION, AND THE REAL SCHEMA DIGESTS ON BOTH SIDES OF
// IT. High 1 of the M1 review.
//
// WHAT WAS WRONG, and it was not cosmetic. Every ledger row was written with
// `pre_schema_digest = post_schema_digest = 'sha256:000…0'`, and THREE consumers
// read those rows back:
//
//   - `deploy/postgres/apply-migrations.mjs:177-184` compares the LIVE schema
//     digest with the head row's `post_schema_digest` after every run and refuses
//     with `migration_live_schema_drift`. So the first upgrade through the
//     release's own applier refused a cluster this phase had just built.
//   - `scripts/mac-local/database-upgrade-vps-step.mjs:44-47` refuses
//     `upgrade_schema_drift_refused` before showing any plan.
//   - `src/installer/v1/private-postgres-owner-runner.ts:289-300` requires
//     `pre[n+1] === post[n]` and `post[last]` equal to the live digest, and
//     answered "uncertain" for every verification on this ledger.
//
// So the freshly installed cluster was one that every later tool considered
// drifted. The zeros were not a missing proof; they were a FALSE one.
//
// WHY A `DO` BLOCK AND NOT psql's `\gset`. The obvious mechanism is psql's
// `\gset`, which captures a query's single value into a variable. It does not work
// in this transport, and the reasons are MEASURED against the real 17.11 server
// rather than guessed:
//
//   1. psql does NOT interpolate `:variables` inside a `-f` SCRIPT at all — only
//      in interactive input and in `-c`. MEASURED:
//
//         # prog.sql:  SELECT 11 AS eleven \gset cr_e
//                     SELECT :cr_e::int + 1;
//         $ psql -At -f prog.sql
//         ERROR:  syntax error at or near ":"   LINE 2: SELECT :cr_e::int + 1;
//
//         so a `\gset` in a `-f` program binds a variable no later statement can
//         read. (With `-c` it is worse, not better: `ERROR: syntax error at or
//         near "\"` — the backslash command is not lexed at all.)
//
//   2. `runSessionTransactionV1` appends a `;` to each statement's last line, and
//      `\gset` then swallows it. MEASURED:
//
//         SELECT md5('a') AS d \gset cr_pre;   →  invalid variable name: "cr_pre;d"
//
// So a digest value cannot travel from a query to an INSERT through psql at all in
// this phase's transport. What CAN carry it is SQL, which is what this file uses:
// a PL/pgSQL `DO` block computes both digests into local variables and INSERTs the
// row, entirely server-side, inside the same transaction as the file. MEASURED,
// including that the block's effects roll back with the transaction:
//
//   DO $cr$ DECLARE pre text; post text; BEGIN
//     SELECT 'sha256:pre' INTO pre;
//     CREATE TABLE IF NOT EXISTS probe_created(x int);
//     SELECT 'sha256:post' INTO post;
//     INSERT INTO probe_ledger VALUES (2, pre || '/' || post);
//   END $cr$;
//   → 1|x   /   2|sha256:pre/sha256:post
//
// The block runs as the MIGRATOR, which owns the ledger table through
// `control_room_schema_owner`'s INHERIT membership — no `SET ROLE`, for the
// measured reason `apply-release-schema.mjs` records: a role switch drops the
// ownership the GRANTs need and the server answers
// `permission denied for function commit_agent_review`, naming a function and
// never mentioning the switch.
//
// THE BLOCK IS DELIBERATELY UNTERMINATED, because `runSessionTransactionV1`
// terminates each statement's last line and a `DO` block that ends `END $tag$`
// with no `;` is exactly what it expects. MEASURED: two such blocks concatenated
// with nothing between them answered
//
//   LINE 71: DO $cr_ledger$
//            ^  syntax error at or near "DO"
//
// — psql never saw the first block complete, so the second block's `DO` landed
// INSIDE it. With the terminator the transport adds, the same two migrations
// applied in one `--single-transaction` produced:
//
//   1|sha256:96f59660e|sha256:966e0786d
//   2|sha256:966e0786d|sha256:af9b2b664
//   chain_ok=true
//
// which is the property the owner runner checks, measured on a real 17.11
// server: `post[1] == pre[2]`, both real digests of two different schema states.
//
// M1 FIX ROUND: those digests were the release-schema digest, which no reader of
// the ledger computes. They are now `readSchemaDigest`'s, server-side — see
// `schema-snapshot-digest.mjs` — and the migration runs as the schema owner.

import { runSessionTransactionV1 } from "./sql-session.mjs";
import { schemaSnapshotDigestExpressionV1 } from "./schema-snapshot-digest.mjs";

const refuse = code => { throw new Error(code); };

/**
 * The PL/pgSQL block's dollar-quote tag, declared as a constant so the block and
 * the collision check below cannot disagree about it.
 *
 * The check is not decoration. A migration file carrying `$$cr_ledger$` would end
 * the block early, and the remainder of the file would be executed as a TOP-LEVEL
 * statement — outside the transaction's intent and outside the row that records it.
 * That is a silent corruption rather than a failure, so it is a refusal by name.
 */
export const LEDGER_BLOCK_TAG_V1 = "cr_ledger";

/**
 * The `DO` block that records one migration: `pre`, the FILE, `post`, the ROW.
 *
 * THE ORDER INSIDE THE BLOCK IS THE WHOLE CLAIM:
 *
 *   1. `pre`  — the schema BEFORE the file, measured on this connection inside
 *      this transaction. It is the schema the previous row's `post` described, and
 *      measuring it outside the transaction would record a state the transaction
 *      never saw.
 *   2. the FILE, verbatim.
 *   3. `post` — the schema AFTER the file, on the same connection.
 *   4. the INSERT, last, so a migration that ran without a row — or a row without a
 *      migration — is not a state the ledger can be in. `ON_ERROR_STOP=1` turns a
 *      failed statement into a non-zero exit rather than a warning, so the whole
 *      block rolls back and nothing is recorded.
 *
 * BOTH DIGESTS, IN THAT ORDER, is what makes the chain the owner runner checks
 * exact: `pre[n+1] === post[n]` for every n, and `post[last]` equal to the live
 * digest. A version that wrote `pre === post` would satisfy the link check by
 * accident and tell a later reader nothing about what the migration changed.
 *
 * THE FILE IS INSIDE THE BLOCK, which is what a `DO` block buys and what makes
 * this one transaction rather than three: the block's statements ARE the
 * transaction's statements, so a file that fails rolls back the block's `pre` with
 * it and nothing is recorded.
 *
 * THE FILE IS NOT QUOTED, and splicing it as text is safe for two measured
 * reasons. Its bytes are verified against the ledger row's sha256 BEFORE this
 * function is called (`readReleaseLedgerV1` refuses an altered file before any
 * statement runs), and the block's dollar-quote tag is checked against the file's
 * own text — a file carrying `$$cr_ledger$` would end the block early, so that
 * collision is a refusal rather than a silently truncated program.
 *
 * IT RETURNS NO TRAILING SEMICOLON, on purpose. `runSessionTransactionV1` adds
 * one to the block's last line, and that is what makes two blocks in one
 * `-f -` program parse as two statements. Without it psql never sees the first
 * block complete and the next `DO` is swallowed into it — MEASURED, and the
 * failure names the SECOND block's `DO`, which is why it reads as a problem with
 * the second migration rather than with the first.
 */
export function migrationLedgerBlockV1({ fileText, file, order, sha256, preSql, postSql }) {
  for (const [name, value] of [["fileText", fileText], ["file", file], ["order", order],
    ["sha256", sha256], ["preSql", preSql], ["postSql", postSql]]) {
    if (value === undefined || value === null || value === "") {
      refuse(`release_schema_migration_refused:statement:${name}`);
    }
  }
  if (typeof file !== "string" || !/^db\/migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/u.test(file)
    || !/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(order) || order < 1) {
    refuse("release_schema_migration_refused:statement");
  }
  if (fileText.includes(`$${LEDGER_BLOCK_TAG_V1}$`)) {
    refuse(`release_schema_migration_refused:dollar_quote_collision:${file}`);
  }
  return Object.freeze(`DO $${LEDGER_BLOCK_TAG_V1}$\n`
    + `DECLARE cr_pre_schema_digest text;\nDECLARE cr_post_schema_digest text;\nBEGIN\n`
    + `SELECT ${preSql} INTO cr_pre_schema_digest;\n`
    + `${fileText.trimEnd()}\n`
    + `SELECT ${postSql} INTO cr_post_schema_digest;\n`
    + `INSERT INTO control_room_schema_migrations`
    + `(filename, digest, ledger_order, pre_schema_digest, post_schema_digest)\n`
    + `VALUES ('${file}', 'sha256:${sha256}', ${order},`
    + ` cr_pre_schema_digest, cr_post_schema_digest);\n`
    + `END $${LEDGER_BLOCK_TAG_V1}$`);
}

/**
 * Apply one migration with real digests, as the SCHEMA OWNER.
 *
 * THE DIGEST is `readSchemaDigest`'s (`schema-snapshot-digest.mjs`), the one every
 * reader of these two columns recomputes — High 1 of the M1b review. The phase's
 * other digest (the release-schema digest, compared against the bundle pin) is a
 * different question and is still asked, once, at the end of the phase.
 *
 * `SET LOCAL ROLE <schema owner>` FIRST, inside the same transaction, which is
 * exactly what `apply-migrations.mjs` does around every migration. MEASURED in the
 * M1 fix round: without it the migrator created every object as ITSELF, and
 * `apply-migrations.mjs` — the applier every later upgrade runs — ends with
 * `migration_refused_non_owner_objects` for any `public` relation not owned by
 * `control_room_schema_owner`. The earlier note that `SET ROLE` "drops ownership
 * and breaks the grants" described objects the MIGRATOR owned; with the schema
 * owner owning them, the migrator's INHERIT membership grants on them as owner.
 * `LOCAL` ends with the transaction, so nothing outlives the migration.
 */
export async function applyMigrationWithDigestsV1({ fileText, file, order, sha256, context,
  user = "control_room_migrator", database = "control_room", schemaOwner = "control_room_schema_owner" }) {
  if (typeof schemaOwner !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(schemaOwner)) {
    refuse("release_schema_migration_refused:schema_owner");
  }
  const digestSql = schemaSnapshotDigestExpressionV1();
  await runSessionTransactionV1([`SET LOCAL ROLE ${schemaOwner}`, migrationLedgerBlockV1({ fileText, file, order,
    sha256, preSql: digestSql, postSql: digestSql })], context, { user, database });
  return Object.freeze({ file, order, digest: `sha256:${sha256}` });
}

/** The ledger rows already applied, in order, as the migrator reads them. */
export const APPLIED_LEDGER_SQL_V1 = "SELECT filename, digest, ledger_order, pre_schema_digest, post_schema_digest"
  + " FROM control_room_schema_migrations ORDER BY ledger_order";

/**
 * Which migrations are still PENDING, given what the ledger says was applied.
 * H3 of the M1b review: the phase re-applied migration 0001 on every run, so a
 * retry after any failure past the first migration answered
 * `relation "tenants" already exists` and never converged.
 *
 * The rule is `apply-migrations.mjs`'s own: the applied rows must be EXACTLY a
 * PREFIX of the release ledger — same file, same order, same digest, no gap — and
 * only the suffix after it runs. Anything else (an unknown row, a digest that
 * differs, a hole) is a cluster this release did not build, and is refused by name
 * rather than "resumed".
 */
export function pendingMigrationsV1(files, rows) {
  if (!Array.isArray(files) || !Array.isArray(rows)) refuse("release_schema_ledger_prefix_refused:input");
  if (rows.length > files.length) refuse(`release_schema_ledger_prefix_refused:unknown_rows:${rows.length}`);
  rows.forEach((row, index) => {
    const expected = files[index];
    if (row?.filename !== expected.file || Number(row?.ledger_order) !== expected.order
      || row?.digest !== `sha256:${expected.sha256}`) {
      refuse(`release_schema_ledger_prefix_refused:${String(row?.filename ?? "?").slice(0, 120)}`);
    }
  });
  return Object.freeze(files.slice(rows.length));
}
