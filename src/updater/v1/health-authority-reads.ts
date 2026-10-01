/** The updater's side of the §8.4 count comparison.
 *
 * `UpdaterHealthAuthorityReadPortV1.readHealthCounts()` must answer, through the
 * updater's OWN database authority, the same three counts the production web
 * login reports, and the evaluator compares the two. This module is that answer.
 *
 * WHY A FUNCTION CALL AND NOT SQL HERE. The obvious adapter -- run the three
 * count queries on the updater's connection -- cannot exist. The updater's login
 * holds column-scoped SELECT on exactly three release tables (the owner-session
 * guard's inputs) and nothing else, and src/updater/v1/schema-installer.ts FAILS
 * THE UPDATER AT STARTUP if that grows. Granting it `projects` or
 * `control_update_candidates` would also hand release-schema rows to the login
 * that holds the owner's approval authority, which is the authority growth R10a
 * exists to forbid. So db/migrations/0239 defines
 * `public.updater_health_counts()`: SECURITY DEFINER, owned by the release
 * schema owner, zero-argument (pre-bound to the live tenant/workspace), and
 * returning three integers. This adapter calls exactly that and nothing else.
 *
 * WHY THE RESULT IS RE-CAPTURED HERE RATHER THAN TRUSTED. The evaluator compares
 * these three values against the signed web response. A driver that returned a
 * bigint as a string (node-pg does, by design) would otherwise compare "3" !== 3
 * and fail a perfectly healthy release. So the counts are captured through the
 * same strict validator the web response uses, and anything that is not a
 * non-negative safe integer refuses here rather than downstream.
 */
import type { UpdaterHealthAuthorityReadPortV1, UpdaterHealthComparisonCountsV1 }
  from "../../updater/v1/health-ports";

/** The minimum surface an updater connection must offer. Structural on purpose:
 * the updater bundle must not import `pg`'s types at compile time when it is
 * bundled by the fixed esbuild step (design §6.6b, and the same rule
 * src/updater/v1/schema-installer.ts follows). */
export interface UpdaterHealthCountConnectionV1 {
  query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }>;
}

/** node-pg returns bigint/int8 as a string to avoid precision loss, so a count
 * arrives as text. This is the ONLY accepted spelling besides a number, and it is
 * digits only: " 3", "3.0", "0x3", "3n" and "" all refuse. */
function countFromPostgres(value: unknown, field: string): number {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint"
    ? String(value) : undefined;
  if (text === undefined || !/^(?:0|[1-9][0-9]{0,6})$/u.test(text))
    throw new Error(`updater_health_authority_counts_refused:${field}`);
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000)
    throw new Error(`updater_health_authority_counts_refused:${field}`);
  return count;
}

/** The one statement. Schema-qualified, no parameters, and nothing selected but
 * the three counts: there is no tenant, id or filter a caller could vary. */
export const UPDATER_HEALTH_AUTHORITY_COUNTS_SQL_V1 =
  "SELECT home_summary_count, project_count, updates_panel_count FROM public.updater_health_counts()";

/**
 * Build the authority read port around one updater connection.
 *
 * The connection is expected to be the updater's own (the deployer login, or a
 * role the design names for it), pre-bound by construction: the function takes
 * no scope argument, so this cannot be pointed at another tenant even by a caller
 * that reaches this function. What it CAN do is report a count for a different
 * installation's database, which the evaluator catches by comparing against the
 * web login's independently-read counts.
 */
export function createUpdaterHealthAuthorityReadPortV1(
  connection: UpdaterHealthCountConnectionV1): UpdaterHealthAuthorityReadPortV1 {
  if (!connection || typeof connection.query !== "function")
    throw new Error("updater_health_authority_connection_invalid");
  return Object.freeze({
    async readHealthCounts(): Promise<UpdaterHealthComparisonCountsV1> {
      const rows = await connection.query<Record<string, unknown>>(UPDATER_HEALTH_AUTHORITY_COUNTS_SQL_V1);
      // Exactly one row or none. The function yields no row when the tenant
      // binding is absent or ambiguous; anything else means the database is not
      // the one this adapter was bound to.
      if (!Array.isArray(rows.rows) || rows.rows.length > 1)
        throw new Error("updater_health_authority_counts_refused:row_count");
      const row = rows.rows[0];
      if (!row || typeof row !== "object")
        throw new Error("updater_health_authority_counts_refused:no_row");
      const keys = Object.keys(row).sort();
      if (keys.join("\0") !== ["home_summary_count", "project_count", "updates_panel_count"].join("\0"))
        throw new Error("updater_health_authority_counts_refused:shape");
      return Object.freeze({
        homeSummaryCount: countFromPostgres(row.home_summary_count, "home_summary_count"),
        projectCount: countFromPostgres(row.project_count, "project_count"),
        updatesPanelCount: countFromPostgres(row.updates_panel_count, "updates_panel_count"),
      });
    },
  });
}