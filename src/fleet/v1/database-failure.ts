/**
 * The SQLSTATE a database error actually carries, whichever transport raised
 * it, or `undefined` when the error proves nothing about the server's decision.
 *
 * There are two database paths into this code and they report the SQLSTATE on
 * different fields:
 *
 *  - The private web pool (`boundPrivateDatabase` over `private-pg-driver`)
 *    rewrites every error into a `PrivateDatabaseError`, moving the sanitized
 *    five-character SQLSTATE onto `sqlState` and setting `code` to the class of
 *    failure. Anything in class 08, 53, 57P, XX, and `40003`, is treated as NOT
 *    proving what the server did, so `sqlState` is absent for those.
 *
 *  - The in-process PGlite adapter (`adaptPglite`) passes the driver error
 *    through unchanged, so a `RAISE ... USING ERRCODE` arrives as an ordinary
 *    error carrying `code`.
 *
 * Reading only `code` matched nothing on the private pool -- every guarded
 * refusal escaped as an unexpected error, and a worker at its ceiling got a
 * bare HTTP 400 `refused` that ended its whole pass. Reading only `sqlState`
 * then broke the in-process path. Both carry the same fact, so both are read
 * here, and the five-character shape is required so neither a message nor a
 * class name is ever mistaken for a SQLSTATE.
 */
export function fleetDatabaseSqlStateV1(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const field of ["sqlState", "code"]) {
    let value: unknown;
    try { value = Reflect.get(error, field); } catch { continue; }
    if (typeof value === "string" && /^[0-9A-Z]{5}$/u.test(value)) return value;
  }
  return undefined;
}

/** PostgreSQL SQLSTATEs the fleet claim path knows how to answer for, rather
 * than to pass on as an unexpected database fault.
 *
 *  - `54000` program_limit_exceeded: 0234's capacity guard. The worker is at
 *    its own configured `maxConcurrent`, which is an ordinary outcome and the
 *    next offer may still be claimable. It is class 54 and NOT class 53 because
 *    the private pool driver treats class 53 as not proving what the server did
 *    and quarantines the pool on it, so a 53 would have turned a worker's own
 *    configured limit into a poisoned database for the whole gateway.
 *  - `P0001` raise_exception: 0140's guard. Revoked worker, closed offer, out
 *    of scope, lapsed credential, or a job already leased.
 *  - `23505` unique_violation and `23503` foreign_key_violation: two callers
 *    racing for one offer, or a claim that lost a race to another.
 *  - `23P01` exclusion_violation: 0100's lease-scope collision. Another lease
 *    already holds this project area.
 *  - `23514` check_violation: 0100's own claim-path refusals, where the lease
 *    scope a claim wants is not the scope the job declared.
 *
 * Anything else is a fault, not a decision, and must keep travelling.
 */
const CLAIM_REFUSAL_SQL_STATES: ReadonlySet<string> = new Set([
  "54000", "P0001", "23505", "23503", "23P01", "23514",
]);

/** True when this error is a claim-path refusal the store can answer for. */
export function isFleetClaimRefusalV1(error: unknown): boolean {
  const sqlState = fleetDatabaseSqlStateV1(error);
  return sqlState !== undefined && CLAIM_REFUSAL_SQL_STATES.has(sqlState);
}
