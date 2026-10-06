/**
 * Which SQLSTATEs the fleet claim path answers for, rather than passing on as
 * an unexpected database fault.
 *
 * The reader that produces the SQLSTATE is NOT here: it is
 * `databaseSqlStateV1` in src/persistence/database.ts, shared with every other
 * caller, because the private-PostgreSQL driver sanitizes and moves the code
 * onto `sqlState`, and there is exactly one place that needs to know which field
 * each transport put it on. These two sets are the fleet's answer to "which of
 * those codes is a DECISION about this claim", which is a per-statement question
 * rather than a per-transport one.
 */

/**
 * The `fleet_claims` insert. Every code here is a decision about whether this
 * claim may exist, so `conflict` is the right answer and the connector moves to
 * the next offer.
 *
 *  - `54000` program_limit_exceeded: 0234's capacity guard. The worker is at its
 *    own configured `maxConcurrent`, an ordinary outcome, and the next offer may
 *    still be claimable. It is class 54 and NOT 53 because the private pool
 *    driver treats class 53 as not proving what the server did and quarantines
 *    the pool on it -- a 53 would have turned a worker's own configured limit
 *    into a poisoned database for the whole gateway.
 *  - `P0001` raise_exception: 0140's guard. Revoked worker, closed offer, out of
 *    scope, lapsed credential, or a job already leased. 0234 raises it too, for
 *    a claim naming a worker that has no row, which is the same fact.
 *  - `23505` unique_violation: two callers racing for one claim, attempt, lease,
 *    or worker idempotency key.
 *  - `23503` foreign_key_violation: a claim that lost a race, so the tenant,
 *    offer or worker it named is gone by commit.
 *
 * `0A000` is deliberately NOT here. 0234 raises it on a REPEATABLE READ caller,
 * where nothing is wrong with this claim at all: that transaction cannot enforce
 * the ceiling because its snapshot predates its wait for the lock. Reporting it
 * as a conflict would be a lie -- the connector would move to the next offer and
 * make the next claim in the same unusable transaction -- so it travels on as an
 * unexpected error and ends the pass, which is what tells the caller its
 * transaction mode is wrong.
 */
export const FLEET_CLAIM_INSERT_REFUSAL_SQL_STATES_V1: readonly string[] =
  ["54000", "P0001", "23505", "23503"];

/**
 * The `control_assignment_lease_scopes` insert: exactly the two codes 0100
 * raises there, `23P01` for a scope collision and `23514` for a scope the job
 * never declared or a lease that is not active.
 *
 * This set is SEPARATE from the claim set, and the split is the point. One
 * widened set for both inserts reported a `23514` on the CLAIM row as a quiet
 * `conflict`: a check violation there means the gateway built a row the schema
 * forbids -- an idempotency key shorter than the pattern, a claim_id that is not
 * 32 hex characters -- which is a bug in the caller, not a busy worker, and
 * answering it as a conflict hides it. The gateway validates those fields before
 * it writes, so it is not reachable today; it is kept out of the set so that if
 * it ever is, the failure is reported rather than absorbed.
 *
 * `54000` and `P0001` are absent here for the mirror reason: 0234 and 0140 fire
 * on the claim insert, and this insert runs after that claim exists, so neither
 * code is a refusal of a SCOPE. Mapping them would swallow a genuine fault from
 * whatever ran first.
 */
export const FLEET_LEASE_SCOPE_REFUSAL_SQL_STATES_V1: readonly string[] = ["23P01", "23514"];