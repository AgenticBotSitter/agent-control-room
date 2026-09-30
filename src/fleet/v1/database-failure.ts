import { PrivateDatabaseError } from "../../web/v1/bounded-database";

/** PostgreSQL SQLSTATEs the fleet claim path knows how to answer for, rather
 * than to pass on as an unexpected database fault.
 *
 *  - `54000` program_limit_exceeded: 0234's capacity guard. The worker is at
 *    its own configured `maxConcurrent`, which is an ordinary outcome and the
 *    next offer may still be claimable. It is class 54 and NOT class 53 because
 *    the driver treats class 53 as not proving what the server did and
 *    quarantines the pool on it.
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
 *
 * The SQLSTATE arrives as `PrivateDatabaseError.sqlState`, never as `code`:
 * the bounded database rewrites every definite SQLSTATE onto `sqlState` and
 * sets `code` to `database_unavailable`. Reading `code` alone therefore matched
 * nothing, every guarded refusal escaped as an unexpected error, and the
 * gateway answered a worker at its ceiling with a bare HTTP 400 `refused`
 * instead of the conflict the connector already knows how to move past.
 */
const CLAIM_REFUSAL_SQL_STATES: ReadonlySet<string> = new Set([
  "54000", "P0001", "23505", "23503", "23P01", "23514",
]);

/** True when this error is a claim-path refusal the store can answer for. */
export function isFleetClaimRefusalV1(error: unknown): boolean {
  if (!(error instanceof PrivateDatabaseError)) return false;
  return error.sqlState !== undefined && CLAIM_REFUSAL_SQL_STATES.has(error.sqlState);
}
