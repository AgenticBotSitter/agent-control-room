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
 *
 * This is the ONE reader for the claim path. Both refusal predicates below go
 * through it, so there is a single place where "which field carries the
 * SQLSTATE" is answered.
 */
export function fleetDatabaseSqlStateV1(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const field of ["sqlState", "code"]) {
    let value: unknown;
    try { value = Reflect.get(error, field); } catch { continue; }
    if (isSqlStateV1(value)) return value;
  }
  return undefined;
}

/**
 * Five uppercase alphanumerics, and not a POSIX errno spelling.
 *
 * Node's own system errors share this field and are also five UPPERCASE
 * LETTERS -- `EPIPE`, `EBADF`, `ESRCH`, `ETIME` -- so the shape alone admits
 * fourteen of them. No SQLSTATE starts with `E`: read off PostgreSQL 17's own
 * `utils/errcodes.h`, which defines 260 codes across 42 classes, and the only
 * classes beginning with a letter are `F0`, `HV`, `P0` and `XX`. So excluding a
 * leading `E` costs nothing and cannot reject a real code.
 *
 * The alternative was to leave the shape alone, since nothing here is decided
 * by set membership: a stray `EPIPE` cannot be mistaken for a refusal, because
 * no refusal set contains it. Excluding it anyway keeps the returned value
 * honest as a SQLSTATE for anything that logs, reports or displays it, rather
 * than merely harmless.
 */
function isSqlStateV1(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Z]{5}$/u.test(value) && !/^E/u.test(value);
}

/**
 * PostgreSQL SQLSTATEs the fleet CLAIM insert knows how to answer for, rather
 * than to pass on as an unexpected database fault. Every one is a decision
 * about whether this claim may exist, so `conflict` is the right answer and the
 * connector moves to the next offer.
 *
 *  - `54000` program_limit_exceeded: 0234's capacity guard. The worker is at
 *    its own configured `maxConcurrent`, which is an ordinary outcome and the
 *    next offer may still be claimable. It is class 54 and NOT class 53 because
 *    the private pool driver treats class 53 as not proving what the server did
 *    and quarantines the pool on it, so a 53 would have turned a worker's own
 *    configured limit into a poisoned database for the whole gateway.
 *  - `P0001` raise_exception: 0140's guard. Revoked worker, closed offer, out
 *    of scope, lapsed credential, or a job already leased. 0234 raises it too,
 *    for a claim naming a worker that has no row, which is the same fact.
 *  - `23505` unique_violation: two callers racing for one claim, attempt,
 *    lease, or worker idempotency key.
 *  - `23503` foreign_key_violation: a claim that lost a race, so the tenant,
 *    offer or worker it named is gone by commit.
 *
 * `0A000` is deliberately NOT here. 0234 raises it on a REPEATABLE READ
 * caller, where nothing is wrong with this claim at all: that transaction
 * cannot enforce the ceiling because its snapshot predates its wait for the
 * lock. Reporting it as a conflict would be a lie -- the connector would move
 * to the next offer and make the next claim in the same unusable transaction
 * -- so it travels on as an unexpected error and ends the pass, which is what
 * tells the caller its transaction mode is wrong.
 */
const CLAIM_INSERT_REFUSALS: ReadonlySet<string> = new Set(["54000", "P0001", "23505", "23503"]);

/**
 * PostgreSQL SQLSTATEs the LEASE-SCOPE insert knows how to answer for.
 *
 *  - `23P01` exclusion_violation: 0100's lease-scope collision. Another lease
 *    already holds this project area.
 *  - `23514` check_violation: 0100's own refusals, where the scope a claim
 *    wants is not a scope the job declared, or the lease is not active.
 *
 * This set is SEPARATE from the claim set, and the split is the point. One
 * widened set for both inserts reported a `23514` on the CLAIM row as a quiet
 * `conflict`: a check violation there means the gateway built a row the schema
 * forbids -- an idempotency key shorter than the pattern, a claim_id that is
 * not 32 hex characters -- which is a bug in the caller, not a busy worker, and
 * answering it as a conflict hides it. The gateway validates those fields
 * before it writes, so it is not reachable today; it is kept out of the set so
 * that if it ever is, the failure is reported rather than absorbed.
 *
 * `54000` and `P0001` are absent here for the mirror reason: 0234 and 0140
 * fire on the claim insert, and this insert runs after that claim exists, so
 * neither code is a refusal of a SCOPE. Mapping them would swallow a genuine
 * fault from whatever ran first.
 */
const LEASE_SCOPE_REFUSALS: ReadonlySet<string> = new Set(["23P01", "23514"]);

/** True when the `fleet_claims` insert was refused by a decision, not a fault. */
export function isFleetClaimRefusalV1(error: unknown): boolean {
  const sqlState = fleetDatabaseSqlStateV1(error);
  return sqlState !== undefined && CLAIM_INSERT_REFUSALS.has(sqlState);
}

/** True when the lease-scope insert was refused by a decision, not a fault. */
export function isFleetLeaseScopeRefusalV1(error: unknown): boolean {
  const sqlState = fleetDatabaseSqlStateV1(error);
  return sqlState !== undefined && LEASE_SCOPE_REFUSALS.has(sqlState);
}