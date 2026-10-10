// CR-E081 partitions independent clusters across file clocks without changing
// their assertions, real migration ledger, roles, faults or 240000ms budget.
// Lifecycle, shutdown faults and role refusals each close their own lane.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.

import assert from "node:assert/strict";

import test, { describe } from "node:test";
import { isPrivilegeDenied, roleCannot, withRealPostgres } from "./support/attack-kit/index.ts";
import { createLane, PORTS } from "./support/attack-kit/suite-lane.ts";

const lane = await createLane();
const { needsPgOrFail, countedRealPostgresRun, temporary } = lane;

describe("attack kit: real PostgreSQL", () => {

  test("roleCannot catches a role that was wrongly granted", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[3]!;
    await withRealPostgres(async postgres => {
      const result = await postgres.query("app", "SELECT current_user");
      assert.equal(result.rows[0]!.current_user, "control_room_app");
      // The application role is refused CREATE today, so roleCannot passes.
      await roleCannot(postgres, "app", "CREATE TABLE attack_kit_grant_probe (id int)");

      // Grant the privilege for real, then prove roleCannot notices.
      await postgres.query("app", "SELECT 1");
      const admin = postgres.admin();
      const { Client } = await import("pg");
      const client = new Client(admin);
      await client.connect();
      try {
        await client.query("GRANT CREATE ON SCHEMA public TO control_room_app");
      } finally {
        await client.end();
      }
      await assert.rejects(
        roleCannot(postgres, "app", "CREATE TABLE attack_kit_grant_probe (id int)"),
        (error: unknown) => {
          assert.match(`${(error as Error).message}`, /role_cannot_succeeded/);
          return true;
        },
      );
    }, { port, allowedPorts: PORTS, database: "attack_kit_grant" });
  });

  test("isPrivilegeDenied distinguishes a refusal from any other error", () => {
    assert.equal(isPrivilegeDenied({ code: "42501" }), true);
    assert.equal(isPrivilegeDenied({ code: "42P01" }), false, "a missing table is not a privilege refusal");
    assert.equal(isPrivilegeDenied({ code: "42601" }), false, "a syntax error is not a privilege refusal");
    assert.equal(isPrivilegeDenied(new Error("boom")), false);
  });

  // `42000` (syntax_error_or_access_rule_violation) and `0A000`
  // (feature_not_supported) used to count as proof of denial. They are broad
  // classes: a typo, a missing relation, a revoked TEMP privilege on a
  // DATABASE and an unimplemented feature all land in one of them, so a
  // `roleCannot` assertion satisfied by either would pass against a database
  // where the role could have done the thing. Only PostgreSQL's own
  // "insufficient privilege" code counts.
  test("isPrivilegeDenied accepts 42501 only", () => {
    assert.equal(isPrivilegeDenied({ code: "42501" }), true, "the genuine privilege refusal is recognised");
    assert.equal(isPrivilegeDenied({ code: "42000" }), false,
      "42000 is a broad class, not proof that a grant was missing");
    assert.equal(isPrivilegeDenied({ code: "0A000" }), false,
      "0A000 is feature_not_supported, not a privilege refusal");
    assert.equal(isPrivilegeDenied({ code: "28000" }), false, "an invalid authorization specification is not a denial");
    assert.equal(isPrivilegeDenied({ code: "42P07" }), false, "duplicate_table carries no information about grants");
    assert.equal(isPrivilegeDenied({}), false, "a failure with no SQLSTATE is not a denial");
    assert.equal(isPrivilegeDenied({ code: 42501 }), false, "a numeric code is not a SQLSTATE string");
  });

  test("roleCannot rejects a refusal that is not a privilege refusal", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[4]!;
    await withRealPostgres(async postgres => {
      // A missing table fails, but it fails for the wrong reason. Accepting it
      // as proof that a grant was removed would let a typo'd table name satisfy
      // any roleCannot assertion, which is the exact false pass this guards.
      await assert.rejects(
        roleCannot(postgres, "web", "SELECT 1 FROM attack_kit_no_such_table"),
        (error: unknown) => {
          assert.match(`${(error as Error).message}`, /refused_for_the_wrong_reason:42P01/);
          return true;
        },
      );
      // A syntax error is equally not a privilege refusal.
      await assert.rejects(
        roleCannot(postgres, "web", "SELEKT 1"),
        (error: unknown) => {
          assert.match(`${(error as Error).message}`, /refused_for_the_wrong_reason:42601/);
          return true;
        },
      );
      // The genuine refusal still passes, so the check is not simply refusing
      // everything.
      await roleCannot(postgres, "web", "DELETE FROM tenants WHERE true");
    }, { port, allowedPorts: PORTS, database: "attack_kit_wrongreason" });
  });
});

lane.closeLane(["attack-kit-pg-"]);
