import { PrivateDatabaseError } from "./bounded-database";
import type { PrivatePgPool } from "./private-pg-driver";

/** Transport check only; the existing schema/role/owner preflight is still required. */
export async function qualifyPrivatePgSession(client: Awaited<ReturnType<PrivatePgPool["connect"]>>) {
  const result = await client.query(`SELECT
    current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
    AND NOT pg_is_in_recovery()
    AND current_setting('transaction_read_only') = 'off'
    AND current_setting('search_path') = 'pg_catalog, public'
    AND current_setting('TimeZone') = 'UTC'
    AND current_setting('statement_timeout') = '5s'
    AND current_setting('lock_timeout') = '2s'
    AND current_setting('transaction_timeout') = '10s'
    AND current_setting('idle_in_transaction_session_timeout') = '5s'
    AS qualified`, []);
  if (result.rows.length !== 1 || (result.rows[0] as { qualified?: unknown } | null)?.qualified !== true)
    throw new PrivateDatabaseError("database_unavailable");
}
