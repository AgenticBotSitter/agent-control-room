// The claim path must be able to tell an ordinary database REFUSAL from a
// database FAULT, and it can only do that if it reads the right field.
//
// `PrivateDatabaseError` carries the sanitized five-character SQLSTATE on
// `sqlState` and sets `code` to the class of failure
// ("database_unavailable"). The claim path therefore has to test `sqlState`.
// Reading `code` matched nothing: every guarded refusal escaped as an
// unexpected error, the gateway answered a worker at its ceiling with a bare
// HTTP 400 `refused`, and the connector -- which moves on to the next offer
// only for `conflict` and `not_found` -- abandoned the whole pass instead.
//
// This test is the regression for that, and it is effect-free: no database, no
// binaries, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { isFleetClaimRefusalV1 } from "../src/fleet/v1";
import { PrivateDatabaseError } from "../src/web/v1/bounded-database";

test("a guarded claim refusal is recognised on sqlState, never on code", () => {
  // The refusals 0140 and 0234 raise, each mapped to a conflict the connector
  // already moves past.
  for (const sqlState of ["54000", "P0001", "23505", "23503", "23P01", "23514"]) {
    const error = new PrivateDatabaseError("database_unavailable", sqlState);
    assert.equal(isFleetClaimRefusalV1(error), true, `${sqlState} is a claim refusal`);
    // The trap this replaces: the refusal is NOT visible on `code`, which is
    // why the old `["P0001", ...].includes(error.code)` test matched nothing.
    assert.equal(error.code, "database_unavailable", `${sqlState} does not appear on code`);
  }
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
  for (const sqlState of ["42P01", "53300", "57014", "08006", "XX000"]) {
    assert.equal(isFleetClaimRefusalV1(new PrivateDatabaseError("database_unavailable", sqlState)), false,
      `${sqlState} is a fault, not a refusal`);
  }
  // Something that is not a database error at all.
  assert.equal(isFleetClaimRefusalV1(new Error("fleet worker claim capacity reached")), false);
  assert.equal(isFleetClaimRefusalV1(undefined), false);
  // A driver error that still carries the raw `code` shape the old test read.
  // It must NOT be accepted: the bounded database is the only thing that may
  // interpret a SQLSTATE, and it moves it to `sqlState`.
  assert.equal(isFleetClaimRefusalV1(Object.assign(new Error("boom"), { code: "P0001" })), false,
    "a raw driver error is not a claim refusal the store may answer for");
});
