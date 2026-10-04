// The first-row INSERT of `control_project_settings`, shared by BOTH owner-facing
// Settings writers.
//
// Why one function and not two statements
// ---------------------------------------
// Two panels write this row: the worker-settings panel (WebProjectService.updateSettings)
// and the chief-of-staff panel (PostgresProjectOrchestrationStoreV1.saveSettings). They
// disagree about how to lose a first-row race. One had `ON CONFLICT ... DO NOTHING
// RETURNING` with no catch at all; the other had a catch that translated 23503 and 23505
// but a bare INSERT. Each was correct about half of what a caller can hit, and neither was
// correct about the other half -- which is a defect in itself, because the owner's
// answer must not depend on which panel they pressed.
//
// So the statement and its refusal mapping live here, once:
//
//   * `ON CONFLICT (tenant_id, project_id) DO NOTHING` -- the row does not exist, so
//     `SELECT ... FOR UPDATE` locked nothing and every concurrent first save read version
//     0 and reached this INSERT for one (tenant_id, project_id). Without DO NOTHING the
//     losers take a primary-key violation, which the installed private-postgreSQL driver
//     deliberately reports to the owner as `database_unavailable`: the database declared
//     down for a collision between two of that owner's own saves.
//   * `RETURNING version` -- it reports whether *THIS* statement wrote the row, which is
//     how the winner tells itself from the loser. A follow-up SELECT could be raced by a
//     third writer bumping the version in between, and would then report a conflict for a
//     save that did happen. Zero rows back means someone else created the row first, so
//     the caller's expectedVersion is stale: the named conflict.
//   * the catch is the class-level backstop, and it is what the project-service path
//     previously did not have. 23505 is any unique violation on this table -- a unique
//     index a later migration adds is refused on exactly the same terms, because the
//     situation is the same: two writers, one row. 23503 is a foreign key: the project or
//     the identity went away under the caller's feet, which is not available rather than
//     changed. Anything else is not ours to relabel and travels unchanged, which is what
//     keeps this a classification rather than a catch-all.
//
// The conflict target is NAMED, so the statement binds to 0135's PRIMARY KEY
// (tenant_id, project_id) and cannot start silently swallowing a different unique
// violation that a later migration adds.

import { databaseSqlStateIsAnyV1, type DatabaseSession } from "../../persistence/database";
import { WebAccessError } from "./access-verifier";

/**
 * Create this project's settings row, or report that a concurrent writer already did.
 *
 * `values` must be (tenantId, projectId, version, writtenByIdentityId, now) followed by
 * this caller's own columns, named in `columns`. Returns nothing when THIS call created
 * the row, and throws `WebAccessError("conflict")` when another caller got there first --
 * which is the caller's `expectedVersion: 0` being stale, not an outage.
 *
 * WHY THE COLUMNS ARE THE CALLER'S, not one fixed list
 * ---------------------------------------------------
 * A single shared statement was tempting and is wrong for this table. 0201 added
 * `planner_mode text NOT NULL DEFAULT 'inherit'`, so a writer that does not MENTION it
 * gets 'inherit' and a writer that names it NULL is refused outright. The two panels
 * therefore need different column lists: the worker-settings panel must not mention any
 * planner column (so the column default applies and the row reads as 'inherit'), and the
 * chief-of-staff panel must name planner_mode explicitly. Naming one fixed list would
 * have made one of the two panels write the other's state -- and it did, until this was
 * measured: a worker-settings first save that won the race stored planner_mode = NULL.
 *
 * What IS shared, and is the whole point of this function, is the part that decides how a
 * lost race is answered. Both panels agreed on that before and must agree on it again:
 *
 *   * `ON CONFLICT (tenant_id, project_id) DO NOTHING` -- the row does not exist, so
 *     `SELECT ... FOR UPDATE` locked nothing and every concurrent first save read version
 *     0 and reached this INSERT for one (tenant_id, project_id). Without DO NOTHING the
 *     losers take a primary-key violation, which the installed private-postgreSQL driver
 *     deliberately reports to the owner as `database_unavailable`: the database declared
 *     down for a collision between two of that owner's own saves.
 *   * `RETURNING version` -- it reports whether *THIS* statement wrote the row, which is
 *     how the winner tells itself from the loser. A follow-up SELECT could be raced by a
 *     third writer bumping the version in between, and would then report a conflict for a
 *     save that did happen. Zero rows back means someone else created the row first, so
 *     the caller's expectedVersion is stale: the named conflict.
 *   * the catch is the class-level backstop. 23505 is any unique violation on this table
 *     -- a unique index a later migration adds is refused on exactly the same terms,
 *     because the situation is the same: two writers, one row. 23503 is a foreign key:
 *     the project or the identity went away under the caller's feet, which is not
 *     available rather than changed. Anything else is not ours to relabel and travels
 *     unchanged, which keeps this a classification rather than a catch-all.
 *
 * The conflict target is NAMED, so the statement binds to 0135's PRIMARY KEY
 * (tenant_id, project_id) and cannot start silently swallowing a different unique
 * violation that a later migration adds.
 */
export async function insertProjectSettingsRowV1(tx: DatabaseSession, columns: string,
  values: readonly unknown[]): Promise<void> {
  // `eligible_worker_kinds` is the only jsonb column on this table. PostgreSQL would infer
  // the parameter type from the target column, so the cast is not required for it to work --
  // measured, and the tests pass without it. It is spelled out anyway, because an inferred
  // type for a jsonb parameter is exactly the thing that changes silently when a driver
  // changes how it sends a string, and 0135's CHECK on that column (`jsonb_typeof(...) =
  // 'array'` AND containment) is the guard that would read the change as bad data.
  const jsonbColumns = new Set(["eligible_worker_kinds"]);
  // The cast goes AFTER its own parameter: `::jsonb$6` is a syntax error, which is what a
  // first attempt produced and what PostgreSQL reported as 42601 at the scanner -- a
  // misleading name for the cause, since nothing was duplicated.
  const placeholders = columns.split(",")
    .map((column, index) => `$${index + 1}${jsonbColumns.has(column.trim()) ? "::jsonb" : ""}`)
    .join(",");
  try {
    const inserted = await tx.query<{ version: string | number }>(
      `INSERT INTO control_project_settings(${columns}) VALUES(${placeholders})
       ON CONFLICT (tenant_id,project_id) DO NOTHING RETURNING version`,
      [...values]);
    if (inserted.rows.length !== 1) throw new WebAccessError("conflict");
  } catch (error) {
    // The conflict thrown just above is this class already and must not be re-read as a
    // database refusal. `conflict` is eight characters and so never matches the SQLSTATE
    // shape, but being explicit keeps the ordering from mattering to a reader.
    if (error instanceof WebAccessError) throw error;
    if (databaseSqlStateIsAnyV1(error, ["23505"])) throw new WebAccessError("conflict");
    if (databaseSqlStateIsAnyV1(error, ["23503"])) throw new WebAccessError("not_found");
    throw error;
  }
}
