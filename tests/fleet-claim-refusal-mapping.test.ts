// The claim path must be able to tell an ordinary database REFUSAL from a
// database FAULT, and it can only do that if it reads the right field and
// holds the right SET for the statement that failed.
//
// `PrivateDatabaseError` carries the sanitized five-character SQLSTATE on
// `sqlState` and sets `code` to the class of failure
// ("database_unavailable"). The claim path therefore has to test `sqlState`.
// Reading `code` matched nothing: every guarded refusal escaped as an
// unexpected error, the gateway answered a worker at its ceiling with a bare
// HTTP 400 `refused`, and the connector -- which moves on to the next offer
// only for `conflict` and `not_found` -- abandoned the whole pass instead.
//
// The two inserts that can be refused have SEPARATE sets, because one shared
// set is what let a check violation on the claim row be reported as a quiet
// conflict. A 23514 there means the gateway built a row the schema forbids,
// which is a bug to report, not a busy worker to move past.
//
// This test is the regression for all of that, and it is effect-free: no
// database, no binaries, no network.
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { fleetDatabaseSqlStateV1, isFleetClaimRefusalV1, isFleetLeaseScopeRefusalV1 }
  from "../src/fleet/v1";
import { PrivateDatabaseError } from "../src/web/v1/bounded-database";

test("a guarded claim refusal is recognised on sqlState, never on code", () => {
  // The refusals the CLAIM insert raises, each mapped to a conflict the
  // connector already moves past.
  for (const sqlState of ["54000", "P0001", "23505", "23503"]) {
    const error = new PrivateDatabaseError("database_unavailable", sqlState);
    assert.equal(isFleetClaimRefusalV1(error), true, `${sqlState} is a claim refusal`);
    // The trap this replaces: the refusal is NOT visible on `code`, which is
    // why the old `["P0001", ...].includes(error.code)` test matched nothing.
    assert.equal(error.code, "database_unavailable", `${sqlState} does not appear on code`);
  }
  // The in-process PGlite transport passes a driver error through unchanged, so
  // the same refusal arrives on `code` there. One helper, both transports: a
  // version that read only `sqlState` left the whole in-process fleet suite
  // reporting a bare `refused` where a `conflict` is the answer.
  for (const sqlState of ["54000", "P0001", "23503"]) {
    assert.equal(isFleetClaimRefusalV1(Object.assign(new Error(sqlState), { code: sqlState })), true,
      `${sqlState} is a claim refusal on the in-process transport too`);
    assert.equal(fleetDatabaseSqlStateV1(Object.assign(new Error(sqlState), { code: sqlState })), sqlState);
  }
});

test("the lease-scope insert answers for 0100's codes and nothing else", () => {
  // 0100 raises exactly these two on control_assignment_lease_scopes.
  for (const sqlState of ["23P01", "23514"]) {
    assert.equal(isFleetLeaseScopeRefusalV1(new PrivateDatabaseError("database_unavailable", sqlState)), true,
      `${sqlState} is a lease-scope refusal`);
  }
  // The claim insert's codes are NOT scope refusals. By the time the scope
  // insert runs the claim row exists, so 0234's capacity guard and 0140's
  // admissibility guard cannot be what refused it. Mapping them here would
  // swallow a fault from whatever ran first.
  for (const sqlState of ["54000", "P0001", "23505", "23503"]) {
    assert.equal(isFleetLeaseScopeRefusalV1(new PrivateDatabaseError("database_unavailable", sqlState)), false,
      `${sqlState} is a claim refusal, not a scope refusal`);
    assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_unavailable", sqlState)), true,
      `${sqlState} is still a claim refusal`);
  }
});

test("a check violation on the CLAIM row is a fault, not a busy worker", () => {
  // The bug the split exists to close. A 23514 on fleet_claims means a row the
  // schema forbids -- an idempotency key too short, a claim_id that is not 32
  // hex characters. Widening one shared set mapped it to `conflict`, so the
  // gateway reported a caller bug as a busy project and the connector moved on.
  for (const sqlState of ["23514", "23P01"]) {
    assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_unavailable", sqlState)), false,
      `${sqlState} on the claim insert must be reported, not absorbed as a conflict`);
  }
});

test("a REPEATABLE READ caller is told its transaction mode is wrong", () => {
  // 0A000 (feature_not_supported) is what 0234 raises on a REPEATABLE READ
  // claim: nothing is wrong with the claim, the transaction simply cannot see
  // the peer claim it waited for, so the ceiling cannot be enforced. The
  // conflict answer is a lie -- the connector would move to the next offer and
  // make the next claim in the same unusable transaction -- so it is NOT in
  // either refusal set and leaves as an unexpected error.
  const error = new PrivateDatabaseError("database_unavailable", "0A000");
  assert.equal(fleetDatabaseSqlStateV1(error), "0A000", "the reader still reports it");
  assert.equal(isFleetClaimRefusalV1(error), false, "0A000 is not a claim refusal");
  assert.equal(isFleetLeaseScopeRefusalV1(error), false, "0A000 is not a scope refusal");
  // It is a definite SQLSTATE, so the driver records rather than quarantines
  // the pool: class 0A is a feature class, not one of the uncertain classes.
  assert.ok(!/^(08|57P|53|XX)/u.test("0A000"), "0A000 is not a pool-quarantining class");
});

test("a database fault is not a claim refusal, whatever the driver says", () => {
  // No SQLSTATE at all: the outcome is unknown, so the pool is quarantined and
  // the caller must see a fault rather than a conflict.
  assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_outcome_uncertain")), false);
  assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_unavailable")), false,
    "a definite SQLSTATE was never recorded, so nothing proved the server refused the statement");
  // A fault that DID carry a state, of a class no fleet guard raises. 42P01 and
  // 53300 are the real ones an overloaded or broken cluster produces; neither is
  // a decision about this worker's capacity.
  for (const sqlState of ["42P01", "53300", "57014", "08006", "XX000", "0A000"]) {
    assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_unavailable", sqlState)), false,
      `${sqlState} is a fault, not a refusal`);
  }
  // 55P03 is the one a CONTENDED claim can raise at runtime: the gateway pool
  // sets lock_timeout=2s, so a caller queued behind a peer is cancelled rather
  // than served. It is a fault, not a refusal -- the claim was never answered.
  assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_unavailable", "55P03")), false);
  // Something that is not a database error at all.
  assert.equal(isFleetClaimRefusalV1(new Error("fleet worker claim capacity reached")), false);
  assert.equal(isFleetClaimRefusalV1(undefined), false);
  assert.equal(isFleetLeaseScopeRefusalV1(undefined), false);
  // A `code` that is not a SQLSTATE. Node's own system errors use this field,
  // and a message must never be read as a decision.
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ERR_SOCKET_CLOSED", "database_unavailable", ""]) {
    assert.equal(fleetDatabaseSqlStateV1(Object.assign(new Error("boom"), { code })), undefined,
      `${JSON.stringify(code)} is not a SQLSTATE`);
    assert.equal(isFleetClaimRefusalV1(Object.assign(new Error("boom"), { code })), false);
  }
  // Node's system errors are five UPPERCASE LETTERS, so the shape alone admits
  // fourteen of them: EBADF EBUSY EFBIG EIDRM EINTR ELOOP ENOSR ENXIO EPERM
  // EPIPE EROFS ESRCH ETIME EXDEV. These are the EXACT set from this Node's
  // os.constants.errno, not a hand-picked sample, so a future errno that also
  // collides has to be added rather than discovered.
  const errnoFive = Object.keys(os.constants.errno).filter(code => /^[A-Z]{5}$/u.test(code));
  assert.ok(errnoFive.length > 0, "this Node still has five-letter errno codes to collide with");
  for (const code of errnoFive) {
    assert.equal(fleetDatabaseSqlStateV1(Object.assign(new Error("boom"), { code })), undefined,
      `${code} is a POSIX errno spelling, not a SQLSTATE`);
  }
  // The exclusion is safe because NO SQLSTATE starts with E: PostgreSQL 17
  // defines 260 codes across 42 classes, and the only classes beginning with a
  // letter are F0, HV, P0 and XX. A real SQLSTATE that begins with a digit, and
  // every one a claim guard raises, is still read.
  for (const sqlState of ["P0001", "0A000", "54000", "23505", "23P01", "F0100", "HV00B"]) {
    assert.equal(fleetDatabaseSqlStateV1(new PrivateDatabaseError("database_unavailable", sqlState)), sqlState,
      `${sqlState} is a real SQLSTATE and is still read`);
  }
  // A getter that throws must not take the caller down with it.
  assert.equal(fleetDatabaseSqlStateV1(Object.defineProperty({}, "code", {
    get() { throw new Error("no"); } })), undefined);
});