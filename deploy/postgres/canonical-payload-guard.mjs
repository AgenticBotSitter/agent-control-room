// The columns the canonical-payload guard READS, read out of the guard's own
// body rather than from a second hand-maintained list.
//
// WHY THIS EXISTS. `validate_control_payload_mirror` (db/migrations/0004, which
// replaced the narrower 0003 body) mirrors each guarded table's indexed columns
// out of its `payload` JSONB and refuses any row where they disagree. It reads
// those columns by name out of `to_jsonb(NEW)`.
//
// So the guard has a silent failure mode: rename one of the columns it reads and
// the trigger function still applies, because PL/pgSQL resolves both spellings of
// a column reference at RUN time, not at CREATE time. The migration reports
// success, the ledger records the migration, and every subsequent write to that
// table is then refused: `canonical payload mirror mismatch` for a `row_data`
// spelling, or "record NEW has no field" for a `NEW.<column>` spelling. Either
// way a data guard has been broken by a schema change that itself succeeded.
// Measured before the fix (reports/cook-mdbfix2-final.md): a `RENAME COLUMN`
// applies in ~200 ms and the first writer to the table is then refused with
// SQLSTATE P0001.
//
// The refusal has to land at MIGRATION time, which means something must know
// which columns the guard reads. That knowledge is in the function body, so it is
// read from there. A hand-maintained list would be a second copy of the guard
// that can drift from the first, and a drifted list is the same silent failure
// one level up.
//
// BOTH SPELLINGS ARE PARSED, because the guard uses both and a rename breaks
// either one:
//   * `row_data->>'name'` -- the per-table branches. `to_jsonb(NEW)` drops a
//     renamed column silently, so the guard compares the payload key against
//     NULL and refuses.
//   * `NEW.name` -- the shared prelude. A renamed column raises at run time.
// Neither is a payload JSONB KEY: `NEW.payload->>'projectId'` names a key inside
// the JSONB document and no ALTER TABLE can take it away, so keys are not
// collected. Only COLUMN names of the row being checked are.
//
// WHY NOT IN SQL. `prosrc` is plain text and a PL/pgSQL body cannot be parsed by
// a SQL query. Doing it inside a migration would mean shipping an unproven parser
// in the very file whose failure it exists to prevent. It is a small pure
// function over one string, so it lives here, where it can be unit-tested
// against the ways it could quietly under-read -- which is the only thing that
// would make the whole mechanism a no-op.

/**
 * The guard's own name, and the only text that can introduce it. 0003 creates
 * the function and 0004 replaces its body, so "has any applied migration
 * created it yet" is answered from the migration texts the applier has already
 * read -- not from a migration number restated here, which would be a second
 * list that can drift from db/migrations/.
 */
export const GUARD_FUNCTION_NAME = "validate_control_payload_mirror";

const GUARD_INTRODUCED = new RegExp(
  `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${GUARD_FUNCTION_NAME}\\s*\\(`,
  "iu");

/**
 * Whether `sql` is a migration that creates or replaces the guard.
 *
 * Used by the applier to answer "should the guard exist by now?" without
 * hard-coding the migration that introduces it. A database that has applied
 * 0001 and 0002 has no guard yet and nothing to check; one that has applied
 * 0003 does, and its absence from then on is a refusal rather than a no-op.
 *
 * @param {string} sql
 */
export function introducesPayloadGuard(sql) {
  return typeof sql === "string" && GUARD_INTRODUCED.test(sql);
}

/** `IF TG_TABLE_NAME =` -- the boundary between the shared prelude and the branches. */
const PRELUDE_END = /IF\s+TG_TABLE_NAME\s*=/u;

/**
 * `row_data->>'name'`. Word-boundary anchored on `row_data` so a longer
 * identifier (`other_row_data`) can never be mistaken for one.
 */
const ROW_DATA_COLUMN = /(?<![\w.])row_data\s*->>\s*'([a-z0-9_]+)'/giu;

/**
 * `NEW.name`, but NOT `to_jsonb(NEW)` (which has no dot and so does not match)
 * and NOT `NEW.payload->>'key'` (whose `payload` is a real column, so it is
 * correctly collected once, while the key after it is not a column at all).
 */
const NEW_COLUMN = /(?<![\w.])NEW\.([a-z0-9_]+)/giu;

/** `ELSIF TG_TABLE_NAME = 'control_jobs'` / `IF TG_TABLE_NAME = 'control_jobs'`. */
const BRANCH_START = /(?:^|\s)(?:ELSIF|IF)\s+TG_TABLE_NAME\s*=\s*'([a-z0-9_]+)'/giu;

/**
 * The segment a branch owns: from its own `TG_TABLE_NAME = '...'` up to the next
 * branch's, or to the end of the body when it is the last one. Includes the
 * branch's own `IF`/`ELSIF` keyword, which names no column, and stops BEFORE the
 * next branch so one branch can never be credited with another's columns.
 */
function branchSpans(body) {
  const starts = [...body.matchAll(BRANCH_START)].map(match => ({ table: match[1], at: match.index }));
  return starts.map((entry, index) => ({
    table: entry.table,
    text: body.slice(entry.at, starts[index + 1]?.at ?? body.length),
  }));
}

/** Every match of one pattern in a chunk, sorted and de-duplicated. */
function columnsIn(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map(match => match[1]))].sort();
}

/**
 * Every column one region of the guard reads, by either spelling. A column named
 * by both is counted once, because the question being answered about it -- does
 * the table still have it -- has one answer.
 */
function regionColumns(text) {
  return [...new Set([...columnsIn(text, ROW_DATA_COLUMN), ...columnsIn(text, NEW_COLUMN)])].sort();
}

/**
 * Read the guard's own body and report which columns it reads.
 *
 * `prelude` and each branch's `columns` are COLUMN names only. The two spellings
 * are collected into one list per region because the caller's question is the
 * same for both -- "does this table still have every column the guard reads" --
 * and a column is missing whether one spelling or the other named it.
 *
 * A body with NO `TG_TABLE_NAME` branch is not a defect: 0003 shipped the guard
 * before 0004 gave it its per-table branches, so an install sitting between those
 * two rungs has a body that is entirely prelude. That is reported as
 * `branches: []` and the caller applies the prelude to every table carrying the
 * trigger -- which is exactly what such a guard does. Throwing there would
 * refuse every install that reaches 0003, and an unreadable body is still
 * refused (`payload_guard_body_unreadable`) so this cannot become a silent pass.
 *
 * @param {string} prosrc `pg_proc.prosrc` for `validate_control_payload_mirror`.
 * @returns {{ prelude: string[], branches: Array<{ table: string, columns: string[] }> }}
 */
export function guardColumnsV1(prosrc) {
  if (typeof prosrc !== "string" || prosrc.length === 0)
    throw new Error("payload_guard_body_unreadable");
  const firstBranch = prosrc.search(PRELUDE_END);
  return {
    prelude: firstBranch === -1 ? regionColumns(prosrc) : regionColumns(prosrc.slice(0, firstBranch)),
    branches: firstBranch === -1 ? [] : branchSpans(prosrc.slice(firstBranch))
      .map(span => ({ table: span.table, columns: regionColumns(span.text) })),
  };
}

/**
 * Every column the guard reads for one table: the shared prelude plus that
 * table's own branch. The two are unioned rather than reported separately
 * because a column is missing whether the prelude or the branch named it, and
 * every guarded table needs the prelude.
 *
 * A body with no per-table branches (`branches: []`, the 0003 shape) is a
 * branchless guard: the prelude IS the whole guard, so the prelude is returned
 * for every table. That is what the function does at run time, and it is why
 * this is not treated as an unreadable guard.
 *
 * @param {{ prelude: string[], branches: Array<{ table: string, columns: string[] }> }} guard
 * @param {string} table
 * @returns {string[]} sorted, de-duplicated
 */
export function guardColumnsForTableV1(guard, table) {
  const branch = guard.branches.find(candidate => candidate.table === table);
  if (!branch && guard.branches.length > 0) throw new Error(`payload_guard_has_no_branch:${table}`);
  return [...new Set([...guard.prelude, ...(branch?.columns ?? [])])].sort();
}
