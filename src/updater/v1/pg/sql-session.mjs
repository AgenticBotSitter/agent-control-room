// The SQL boundary for the install-night database phase.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: root never runs release SQL, and
// the migrator is reachable only from a process already running as the database
// account. That is not a convention, it is what the peer map says:
//
//   cr  <database account>  control_room_migrator
//   cr  root                control_room_deployer
//   cr  <database account>  postgres
//
// libpq reports the identity of the PROCESS, not of anything the caller asks
// for. A `psql` spawned by root with `-U control_room_migrator` does not become
// the migrator: the map resolves `root`, and the only role root may become is
// the deployer. So a root-side session can never be the superuser and never the
// migrator — R10's property, arrived at structurally rather than by remembering
// not to.
//
// THE PRIVILEGE DROP IS NOT ONE-WAY, and this surprises people. The map names
// three identities, and two of the phase's sessions use them:
//
//   - `0001` (CREATE ROLE) and `0000` (CREATE SCHEMA) need cluster- and
//     database-level authority, so they run as the DATABASE ACCOUNT, which the
//     map sends to `postgres`;
//   - `0002` and `0003` (the updater's tables and guards) run as the DEPLOYER,
//     which the map sends to ROOT. Root is correct there precisely because the
//     deployer's whole authority is "a root process connected on the local
//     socket" (see 0001_deployer_role.sql) and it holds no password at all.
//
// So the superuser half runs BELOW the database account and the deployer half
// runs AT root. Neither role has a credential anywhere in this design.
//
// WHY `psql` AND NOT `pg`. `psql` is a program from the vendored runtime, so it
// needs nothing from the bundle's exactly-pinned dependency set, and the SQL the
// server sees is the SQL this file wrote. Rows come back as JSON from a
// `json_agg` wrapper rather than through a driver's type mapping, which matters
// because the updater loader asserts on BOOLEAN columns (`rolcanlogin`,
// `rolsuper`) and a text round-trip must not turn them into the strings
// `"true"`/`"false"` — that would make every assertion in the loader compare
// against a string and pass or fail for the wrong reason.

import { join } from "node:path";
import { spawnPgFamily } from "./database-phase-process.mjs";

const refuse = code => { throw new Error(code); };

/**
 * The identities a statement may name, and the databases it may touch.
 *
 * The deployer is in the user list because the peer map gives it to root and the
 * updater's own DDL runs as it; it is NOT in the database-account's reach, and
 * `spawnPgFamily` checks the pairing, so listing it here is a statement about
 * what may be ASKED FOR, not about what any uid may become. The server still
 * decides: a statement asking for the migrator from a root spawn is refused by
 * the hba, not by this list.
 */
export const SESSION_USERS_V1 = Object.freeze(["postgres", "control_room_migrator", "control_room_deployer"]);
export const SESSION_DATABASES_V1 = Object.freeze(["postgres", "control_room"]);

/** Every key a statement may carry, and the ones it must. */
const SESSION_STATEMENT_KEYS_V1 = Object.freeze(["after", "before", "database", "sql", "user"]);
const SESSION_STATEMENT_REQUIRED_V1 = Object.freeze(["database", "sql", "user"]);

/**
 * One statement, checked. Nothing is defaulted and nothing is inferred.
 *
 * The key set is "a subset of the five allowed, containing the three required"
 * rather than an enumeration of the four legal combinations. The enumeration
 * was the first version and it was wrong the moment a statement needed both
 * `before` and `after` — which is exactly the shape the one `\\password`
 * statement has, since its value goes in `before` and the `RESET` in `after`. A
 * refused key set there would have read as a permissions problem rather than as
 * a parser that had not been taught a legal shape.
 *
 * An EXTRA key is still refused, and that is the half that matters: a statement
 * carrying a field nothing reads is a statement whose meaning a reviewer cannot
 * see, and the refusal is what keeps the set closed.
 */
export function parseSessionStatementV1(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("pg_phase_statement_refused");
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !SESSION_STATEMENT_KEYS_V1.includes(key))
    || SESSION_STATEMENT_REQUIRED_V1.some(key => !keys.includes(key))) {
    refuse("pg_phase_statement_refused");
  }
  if (!SESSION_USERS_V1.includes(value.user)) refuse("pg_phase_user_refused");
  if (!SESSION_DATABASES_V1.includes(value.database)) refuse("pg_phase_database_refused");
  if (typeof value.sql !== "string" || value.sql.length === 0 || value.sql.length > 4 * 1024 * 1024
    || value.sql.includes("\0")) refuse("pg_phase_sql_refused");
  for (const key of ["before", "after"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 65_536
      || value[key].includes("\0"))) refuse(`pg_phase_${key}_refused`);
  }
  return Object.freeze({ user: value.user, database: value.database, sql: value.sql,
    before: value.before, after: value.after });
}

/**
 * Whether a statement can return rows, decided by its FIRST KEYWORD.
 *
 * It is decided from the text rather than trusted, because the `json_agg`
 * wrapper only works on a statement that produces a result set, and a `DO $$ …`
 * block — which is how every role and database is created here — does not. The
 * keyword list is the fixed set of DDL/DML forms this phase issues; anything
 * else is executed as a plain statement, so an unrecognised keyword is safe
 * rather than refused. A `WITH` is treated as a row-returning form, which is
 * correct: a data-modifying CTE still returns the outer query's rows.
 *
 * `SHOW` IS THE EXCEPTION AND IT IS NOT WRAPPED, and that is MEASURED rather than
 * designed. `SHOW ssl` returns one column named after the GUC, and the wrapper
 * turns it into a subquery:
 *
 *   SELECT coalesce(json_agg(to_jsonb(t)), …) FROM ( SHOW ssl ) AS t
 *   ERROR:  syntax error at or near ")"  LINE 3: ) AS t
 *
 * because `SHOW` is a utility statement and cannot be a sub-select. A test that
 * reads `SHOW ssl` therefore goes through a plain statement and parses the one
 * line, which is what `pgPhaseShowV1` does. Getting this wrong is not a small
 * thing: the same wrapper applied to a `SHOW` makes the answer EMPTY rather than
 * wrong, so an assertion comparing it to "off" would fail while an assertion
 * checking only "not empty" would pass.
 */
export function statementReturnsRowsV1(sql) {
  const keyword = /^\s*(?:--[^\n]*\n|\s)*([A-Za-z]+)/u.exec(sql)?.[1]?.toUpperCase() ?? "";
  if (["SHOW", "EXPLAIN"].includes(keyword)) return false;
  return ["SELECT", "WITH", "VALUES", "TABLE"].includes(keyword);
}

/**
 * The `json_agg` wrapper, and why it is safe to wrap a query verbatim.
 *
 * The wrapper ENDS WITH A SEMICOLON, and that is not tidiness. It is a
 * row-returning statement, so it is never the last thing in a program: a caller
 * that appends `after: "RESET ROLE;"` — which is how the grant converger issues
 * its grants as the schema owner — produced
 *
 *   … ) AS tRESET ROLE;
 *
 * because the wrapper had no terminator of its own, and the server answered
 *
 *   ERROR:  syntax error at or near "RESET"   LINE 40: RESET ROLE;
 *
 * naming a statement the caller never wrote and pointing at a line that looks
 * fine in isolation. A wrapper that is not terminated is a wrapper that eats
 * whatever comes next.
 *
 * `to_jsonb(t)` keeps the column NAMES, which the loader's assertions read
 * (`rows[0].rolcanlogin`), and `jsonb` keeps the JSON TYPES, which is what
 * stops a boolean arriving as a string — a text round-trip would make every
 * assertion in the updater loader compare against a string and pass or fail for
 * the wrong reason. The inner alias `t` cannot collide with a table name in the
 * statement because it is a range variable of the wrapper, not of the subquery.
 */
export function rowReturningProgramV1(sql) {
  return `SELECT coalesce(json_agg(to_jsonb(t)), '[]'::json)::text FROM (\n${sql}\n) AS t;`;
}

/**
 * Whether `-q` belongs on the command line.
 *
 * MEASURED: `psql -q` suppresses "all output except the result of … SELECT-like
 * commands" — and a `SHOW` is neither, so `-q` makes `SHOW ssl` print NOTHING.
 * The caller would then see an empty answer for a question it asked, which is
 * the silent-wrong-answer shape this file avoids everywhere else. So `-q` is
 * applied only to a statement whose own output is noise: a DDL/DML statement,
 * whose `CREATE TABLE` acknowledgements would otherwise be mixed into the rows
 * this module parses.
 */
export function statementIsQuietV1(sql) {
  return !statementReturnsRowsV1(sql)
    && !/^\s*(?:SHOW|EXPLAIN)\b/iu.test(sql);
}

/** The `psql` argument vector for one statement. */
export function psqlStatementArgumentsV1(statement, { socketDirectory, port, returnsRows, quiet = true }) {
  return Object.freeze([
    "-h", socketDirectory, "-p", String(port), "-U", statement.user, "-d", statement.database,
    // `-w` so a connection needing a password FAILS instead of blocking on the
    // terminal: the hba's last rule is `local all all scram-sha-256`, so a login
    // the map does not cover hits it, and with `-w` that refusal is prompt-free
    // and assertable. Without `-w`, "is this login refused?" waits out the
    // timeout, which is what the first runs of the sibling lane did.
    "-w", "-v", "ON_ERROR_STOP=1", "-At",
    // `-f -` reads the program from stdin, so the SQL is a pipe and not an argv
    // element: on a 4 MB statement that is also the difference between working
    // and E2BIG. A secret-bearing `before`/`after` travels in the same pipe.
    "-f", "-",
    // A DDL statement's own output would otherwise be mixed into the rows the
    // caller parses, so the second stream is discarded and the first is quiet.
    ...(quiet && !returnsRows ? ["-q"] : []),
  ]);
}

/**
 * One statement, one connection, as the given identity.
 *
 * `identity` is `{ uid, gid }`, and it is the caller's decision which identity to
 * use — the DATABASE ACCOUNT for the superuser half, ROOT for the deployer
 * half. What the caller does NOT get to decide is whether that identity is
 * actually mapped: the server decides, from the uid, and a mismatch is a
 * server-side refusal surfaced as `pg_phase_sql_refused:42501`. The refusal
 * therefore comes from the authority rather than from a check in a parent that a
 * caller could have got wrong, which is the direction a guard should come from.
 */
/**
 * A statement with a terminator, unless it is a META-COMMAND.
 *
 * A psql backslash command is not SQL: `\password role` reads its value from the
 * two following lines and a semicolon between them is a third, empty line, which
 * the server answers with "NOTICE: empty string is not a valid password,
 * clearing password" (MEASURED). So a statement whose first non-blank character
 * is `\` is returned unchanged, and every other statement gets its `;`.
 */
export function terminateStatementV1(sql) {
  if (/^\s*\\/u.test(sql)) return sql;
  return sql.trimEnd().endsWith(";") ? sql.trimEnd() : `${sql.trimEnd()};`;
}

export async function runSessionStatementV1(statement, {
  root, layout, identity, environment, port, profile, profileParameters, pgRoot, onSpawn,
}) {
  const parsed = parseSessionStatementV1(statement);
  const socketDirectory = layout.socketDirectory;
  const returnsRows = statementReturnsRowsV1(parsed.sql);
  // The `after` clause is APPENDED VERBATIM, with no separator of its own, and
  // that is the whole reason the `\\password` statement works. MEASURED against
  // the vendored 17.11 server: `\password <role>` reads its value from the two
  // lines that FOLLOW it on the same stream, and only while they are the last
  // two. A separator added here — a newline, or any trailing newline after the
  // second value — makes psql read a third, empty line and answer
  // "NOTICE: empty string is not a valid password, clearing password"; without
  // the value lines at all it compares two empty strings and answers
  // "Passwords didn't match." Both look like a permissions problem and neither
  // is one, which is why the contract is written down rather than remembered.
  //
  // `before` is separated by a newline because it is SQL that must end its
  // line, and `after` is preceded by one because the statement's own last line
  // may not be followed by anything directly.
  //
  // MEASURED: without the leading newline on `after`, a statement whose text is
  // a row-returning wrapper ends `) AS t` and the next clause is glued to it:
  //
  //   ERROR:  syntax error at or near "ROLE"   LINE 39: ) AS tRESET ROLE;
  //
  // which is unreadable — it names a migration's own alias and a role name and
  // never mentions the clause that caused it. The `\password` value is what
  // `after` usually carries, and it begins with its own newline for the same
  // reason, so this separator is belt-and-braces for the SQL case.
  //
  // The value the `\password` statement depends on is still LAST: `after` is the
  // final thing written and nothing is appended after it.
  const program = [
    parsed.before === undefined ? "" : parsed.before.endsWith("\n") ? parsed.before : `${parsed.before}\n`,
    // Both forms end with a semicolon. The row-returning wrapper carries its own
    // (see `rowReturningProgramV1`); a bare statement does not, and a caller that
    // appends `after` — a `RESET ROLE`, a `\\password` value — would otherwise
    // find the two glued together. A `\\password` statement is deliberately NOT
    // terminated: its value is read from the two lines that follow it, and a
    // semicolon between the command and its value is a third line.
    ...(returnsRows ? [rowReturningProgramV1(parsed.sql)] : [terminateStatementV1(parsed.sql)]),
    parsed.after === undefined || parsed.after.startsWith("\n") ? (parsed.after ?? "") : `\n${parsed.after}`,
  ].join("");
  const result = await spawnPgFamily({
    executable: join(root, "runtime", "pg-current", "bin", "psql"),
    args: psqlStatementArgumentsV1(parsed, { socketDirectory, port, returnsRows,
      quiet: statementIsQuietV1(parsed.sql) }),
    environment, uid: identity.uid, gid: identity.gid,
    // The role comes from the STATEMENT'S USER, not from the uid. Deriving it
    // from the uid would be the vulnerability: a caller asking `postgres` to run
    // as uid 0 would be labelled "deployer" and the root guard would wave it
    // through, so the superuser half of the phase could be run as root — exactly
    // what the peer map exists to prevent. The deployer is the ONLY role a root
    // uid may speak as, and it is named in the statement.
    role: parsed.user === "control_room_deployer" ? "deployer" : "database",
    profile, profileParameters, stdio: ["pipe", "pipe", "pipe"], cwd: pgRoot,
    stdin: program, onSpawn });
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code !== 0) {
    // `psql` prints `ERROR:  <message>` and only sometimes the SQLSTATE, and the
    // two are on different lines. The state is taken from libpq's own
    // `PGSQL_...` diagnostic OR from a `SQLSTATE`-shaped five-character token that
    // is NOT part of a word like "PGSQL" — a naive /\b([0-9A-Z]{5})\b/ matches the
    // `PGSQL` in `psql (PostgreSQL) 17.11` on the banner line and reports a
    // connection failure as SQLSTATE "PGSQL", which is worse than reporting
    // nothing because a test would assert on it.
    const explicit = /\b(?:SQLSTATE|code)\s*[:=]\s*([0-9A-Z]{5})\b/iu.exec(text)?.[1];
    const diagnostic = /\bPGSQL_([0-9]{5})\b/u.exec(text)?.[1];
    const bare = /^\s*(?:ERROR|FATAL):?\s+([0-9]{5})\b/mu.exec(text)?.[1];
    // The server's own message is appended and bounded, so a refusal names what
    // failed rather than only a class. It is the FIRST `ERROR:`/`FATAL:` line,
    // never the banner and never the connection summary.
    const reason = /^\s*(?:ERROR|FATAL):\s*(.+)$/mu.exec(text)?.[1]?.trim().slice(0, 160) ?? "";
    // A sandbox denial and a `psql` usage error produce no `ERROR:` line at all,
    // so the bounded diagnostic is included instead of an empty suffix. A refusal
    // that says only `unknown` is the one an operator cannot act on.
    const suffix = reason !== "" ? `:${reason}`
      : `:${text.trim().split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 200)}`;
    refuse(`pg_phase_sql_refused:${explicit ?? diagnostic ?? bare ?? "unknown"}${suffix}`);
  }
  if (!returnsRows) {
    // A non-row statement returns its OUTPUT LINES, not an empty array, and the
    // distinction is the difference between "nothing happened" and "here is what
    // the server said". A DDL statement legitimately prints nothing, so an empty
    // array is the honest answer for one; a `SHOW` prints exactly one value, and
    // returning `[]` for it would make a caller that asked "is ssl off?" see
    // "no rows", which it would have to interpret as either. Returning the lines
    // covers both, and a caller that wants DDL silence can assert on it.
    //
    // ONLY TRAILING NEWLINES ARE STRIPPED, never every empty line. MEASURED: the
    // socket-only cluster's own answer to `SHOW listen_addresses` is the EMPTY
    // STRING, printed by `psql -At` as a line containing nothing — and a
    // `.filter(Boolean)` drops it, so the assertion that the cluster binds no TCP
    // port would see "no rows" and pass for the wrong reason on a cluster that
    // WAS listening. The empty value is the most important value this module
    // ever returns.
    return Object.freeze(result.stdout.split("\n").slice(0, -1).map(line => line.trim()));
  }
  // A row-returning statement's rows come back as ONE line of JSON, because the
  // wrapper aggregates them. A statement that returns rows WITHOUT the wrapper
  // — only `SHOW` and `EXPLAIN`, and neither is wrapped — returns one line per
  // row, and each line is plain text rather than JSON. So the parse is: try the
  // single-line JSON first, and fall back to the raw lines.
  //
  // MEASURED: the grant-converger's catalog query is a six-arm `UNION`, and
  // reading it through the wrapper produced more than one line, which the
  // single-line parser refused with `pg_phase_rows_refused` — a refusal that
  // names nothing about the query. The fallback keeps the refusal for a
  // malformed single line and returns the lines otherwise, so a real multi-line
  // result is data rather than an error.
  const lines = result.stdout.split("\n").slice(0, -1).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return Object.freeze([]);
  if (lines.length === 1) {
    let rows;
    try { rows = JSON.parse(lines[0]); } catch { return Object.freeze(lines); }
    if (!Array.isArray(rows)) refuse("pg_phase_rows_refused");
    return Object.freeze(rows);
  }
  return Object.freeze(lines);
}

/**
 * Run SEVERAL statements in ONE transaction, as the given identity.
 *
 * This exists because `runSessionStatementV1` opens a connection per statement,
 * and a transaction cannot be assembled from several connections. MEASURED: the
 * first real run of this phase sent `BEGIN`, then `ALTER TABLE … OWNER TO …`,
 * then `COMMIT` as three separate `psql` invocations; the `COMMIT` was a
 * no-op on its own connection and the `ALTER` committed implicitly when that
 * connection closed, so the phase believed it had a transaction and had none.
 *
 * The transaction is an explicit `BEGIN;` … `COMMIT;` that THIS function writes
 * around the program, and the statements passed here must therefore never carry
 * their own `BEGIN`/`COMMIT` (they do not, at every call site). An earlier version
 * used psql's `--single-transaction` instead, on the measurement that an explicit
 * `BEGIN` broke the lexer; that failure was the missing terminator described in
 * the body below, and `--single-transaction` turned out to COMMIT a truncated
 * program — see the measurement where the program is sent.
 *
 * `ON_ERROR_STOP=1` is what turns a failed statement into a non-zero exit, so
 * there is no code path here that leaves a half-applied migration committed.
 *
 * `returnsRows` is not offered, because a caller that wanted rows from inside a
 * transaction would need a cursor this transport does not have, and pretending
 * otherwise would return an empty array for a real query — the same
 * silent-wrong-answer shape this file avoids elsewhere. A caller that needs rows
 * asks for them in their OWN connection, which is the only way a result is
 * defined here.
 */
export async function runSessionTransactionV1(statements, context, { user = "control_room_migrator",
  database = "control_room" } = {}) {
  if (!Array.isArray(statements) || statements.length === 0 || statements.length > 4096) {
    refuse("pg_phase_transaction_refused");
  }
  if (statements.some(value => typeof value !== "string" || value.length === 0
    || value.length > 4 * 1024 * 1024 || value.includes("\0"))) {
    refuse("pg_phase_transaction_refused");
  }
  // The identity is a NAMED parameter rather than a property smuggled onto the
  // array, because a property on the statement list is a place a caller could
  // set a role and forget, and this is the one function that opens a connection
  // as somebody other than the database account.
  if (!SESSION_USERS_V1.includes(user) || !SESSION_DATABASES_V1.includes(database)) {
    refuse("pg_phase_transaction_refused");
  }
  const { root, layout, identity, environment, port, profile, profileParameters, pgRoot, onSpawn } = context;
  // Every statement is TERMINATED AND SEPARATED BY A NEWLINE, and both halves are
  // measured. The ledger file and every migration in `db/migrations/` are read as
  // whole files, and a file whose last statement ends in `;\n` is fine on its
  // own. This function joins SEVERAL such pieces into one `-f -` program, and
  // psql's lexer splits that program on semicolons. A piece that arrives WITHOUT
  // its terminator — the `ALTER TABLE … OWNER TO` and the three `GRANT`s written
  // here as array elements — merges with the next piece and the failure lands on
  // the SECOND statement rather than the first:
  //
  //   ERROR:  syntax error at or near "GRANT"   LINE 2: GRANT CREATE, USAGE …
  //
  // which reads as a broken `GRANT` and is a missing semicolon on the line above.
  //
  // The NEWLINE is the other half, and it is not cosmetic. `.trimEnd()` — which
  // the semicolon rule needs — also removes the trailing newline a whole file
  // carries, so joining on `"\n"` afterwards left the next piece glued to the
  // previous `;`:
  //
  //   ERROR:  syntax error at or near "ROLE"     LINE 39: ) AS tRESET ROLE;
  //
  // So each piece keeps a terminator AND ends with a newline.
  //
  // A TRAILING COMMENT IS THE THIRD CASE, and it is the one that bit. Five of the
  // release's migration files end with a `--` comment after their last statement
  // (0059, 0065, 0093 and two others), so "does the trimmed text end in `;`" is
  // false for a file whose last STATEMENT does end in one. Appending `;` to such
  // a file puts the semicolon INSIDE the comment — where it comments out nothing
  // and terminates nothing — and the file's last real statement is then merged
  // with the next piece. So the terminator is placed after the last non-comment,
  // non-blank LINE, not at the end of the string.
  const program = statements.map(statement => {
    const lines = statement.replace(/\s+$/u, "").split("\n");
    let last = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const trimmed = lines[index].trim();
      if (trimmed !== "" && !trimmed.startsWith("--")) { last = index; break; }
    }
    if (last === -1) return `${statement}\n`;
    lines[last] = lines[last].trimEnd().endsWith(";") ? lines[last] : `${lines[last].trimEnd()};`;
    return `${lines.join("\n")}\n`;
  }).join("");
  // EXPLICIT `BEGIN;` … `COMMIT;`, and NOT `--single-transaction`, because only
  // this form is KILL-SAFE. MEASURED on PostgreSQL 17.11 (M1 fix round): psql reads
  // its program from a pipe this process writes, and a phase SIGKILLed while that
  // write is in flight leaves psql reading a TRUNCATED program. psql executes what
  // it has and, at end of input:
  //
  //   --single-transaction, program cut after two of N statements
  //       → psql issues its own COMMIT: the two statements are COMMITTED
  //   BEGIN; + the same two statements, no COMMIT reached
  //       → the session ends inside a transaction: the server ROLLS BACK
  //   BEGIN; + a statement cut mid-word
  //       → syntax error, ON_ERROR_STOP, exit 3: ROLLED BACK
  //
  // So with `--single-transaction` a kill could commit half a role file or half a
  // grant diff, and with an explicit `COMMIT` as the program's LAST line nothing
  // commits unless the whole program arrived. The earlier measurement that an
  // explicit `BEGIN` broke the lexer ("syntax error at or near CREATE") was the
  // missing-terminator bug documented above, not the `BEGIN`: re-measured with the
  // terminator rule, `BEGIN;` + the ledger table + migration 0001 + `COMMIT;` in one
  // `-f -` program exits 0 and creates every table.
  const result = await spawnPgFamily({
    executable: join(root, "runtime", "pg-current", "bin", "psql"),
    args: ["-h", layout.socketDirectory, "-p", String(port), "-U", user,
      "-d", database, "-w", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    environment, uid: identity.uid, gid: identity.gid,
    role: user === "control_room_deployer" ? "deployer" : "database",
    profile, profileParameters, stdio: ["pipe", "pipe", "pipe"], cwd: pgRoot,
    stdin: `BEGIN;\n${program}COMMIT;\n`, onSpawn });
  if (result.code !== 0) {
    const text = `${result.stderr}\n${result.stdout}`;
    const explicit = /\b(?:SQLSTATE|code)\s*[:=]\s*([0-9A-Z]{5})\b/iu.exec(text)?.[1];
    // A transaction refusal is the one an operator most needs the server's own
    // words for: the statement that failed is inside a migration file, and
    // `pg_phase_transaction_refused:unknown` names nothing. So the first
    // `ERROR:`/`FATAL:` line is appended, bounded, and when there is none — a
    // sandbox denial, a connection failure — the bounded diagnostic is.
    const reason = /^\s*(?:ERROR|FATAL):\s*(.+)$/mu.exec(text)?.[1]?.trim().slice(0, 200);
    const suffix = reason !== undefined ? `:${reason}`
      : `:${text.trim().split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 200)}`;
    refuse(`pg_phase_transaction_refused:${explicit ?? "unknown"}${suffix}`);
  }
}

/**
 * A `query(sql) => { rows }` surface, for `applyUpdaterSchemaV1`.
 *
 * The loader is TypeScript with an asserted result surface, so the shape it
 * needs is produced here rather than by rewriting its SQL to suit a `psql`
 * runner. Each call is its own connection, which is correct for that loader: it
 * opens no transaction and changes no session state, so nothing is lost, and a
 * failed statement leaves nothing half-open behind it. It is also what makes the
 * failure mode a refusal rather than a poisoned session.
 */
export function makeSessionClientV1(context) {
  return Object.freeze({
    query: async sql => ({ rows: await runSessionStatementV1({ ...context.database, sql }, context) }),
  });
}
