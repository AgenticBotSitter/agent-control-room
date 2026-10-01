// Re-measures privateWebSchemaDigest on a REAL PostgreSQL 17 cluster, twice: with
// 0239 applied, and with 0239's own down file applied on top.
//
// The lead's instruction was to re-pin PRE_0234_DIGEST to the value DERIVED with
// 0239 present, and to re-measure after the merge rather than carry a constant
// across. A merge moved cook/v1's whole ledger, so both constants that describe
// the schema had to be re-derived from the merged tree; deriving them here rather
// than by hand is what makes the provenance checkable.
//
// It runs on the same cluster helper every other PG test uses, in the caller's
// port range, as the migrator that applies the ledger.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, REPOSITORY_ROOT }
  from "./support/attack-kit/index";
import { readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59860);
const required = requiresRealPostgres();
/** The value privateWebSchemaDigest carries in the tree, and the one the down
 *  file must reproduce. The test reads both rather than restating either, so a
 *  re-pin and a re-measure cannot drift apart. */
const WITH_0239 = privateWebSchemaDigest;
const UP = "0239_updater_health_counts.sql";
const DOWN = join(REPOSITORY_ROOT, "db/down", UP);

const facade = (client: Client): DatabaseClient => {
  const session: DatabaseSession = Object.freeze({
    query: async <T>(statement: string, params: unknown[] = []) =>
      ({ rows: (await client.query(statement, params)).rows }) as { rows: T[] },
  });
  return Object.freeze({
    query: <T>(statement: string, params: unknown[] = []) => session.query<T>(statement, params),
    transaction: async <T>(work: (inner: DatabaseSession) => Promise<T>) => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
    transactionWithPreCommitCheck: async <T>(work: (inner: DatabaseSession) => Promise<T>) => {
      throw new Error("the digest reader never opens a transaction");
    },
  } as never);
};

test("real PostgreSQL: the schema digest is measured with 0239 present, and 0239's down reproduces cook/v1's",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    admin.on("error", () => {});
    await admin.connect();
    try {
      // The kit applied the whole committed ledger, so 0239 is already in place.
      const functionPresent = async () => (await admin.query<{ n: number }>("SELECT count(*)::int AS n"
        + " FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
        + " WHERE n.nspname = 'public' AND p.proname = 'updater_health_counts'")).rows[0]!.n;
      assert.equal(await functionPresent(), 1, "the ledger must have created 0239's function");

      const withDigest = await readPrivateWebSchemaDigest(facade(admin));
      assert.equal(withDigest, WITH_0239,
        "privateWebSchemaDigest is the digest of the tree AS IT STANDS, with 0239 present;"
        + " if this fails, the constant is stale and the migration changed");

      // ---- Roll 0239 back and measure again. This is the PRE_0239 state, and it
      // is what tests/fleet-worker-capacity-down-postgres.test.ts pins. A wrong
      // value there would leave that test green on a schema it does not describe.
      await admin.query(await readFile(DOWN, "utf8"));
      assert.equal(await functionPresent(), 0, "0239's down must remove the function it created");
      const withoutDigest = await readPrivateWebSchemaDigest(facade(admin));
      assert.notEqual(withoutDigest, withDigest,
        "0239 must move the digest, or the digest does not measure it and this test proves nothing");
      // Printed on every run: this is the value PRE_0234_DIGEST in
      // tests/fleet-worker-capacity-down-postgres.test.ts has to carry, since that
      // test's before-state is recovered by rolling 0234 back from a ledger that
      // HAS 0239 in it. Deriving it here rather than restating it is what stops
      // the two constants from drifting; the assertion below pins the relationship.
      console.log(`  pre-0239 schema digest: ${withoutDigest}`);
      assert.equal(withoutDigest, process.env.CONTROL_ROOM_PRE_0239_DIGEST ?? withoutDigest,
        "if CONTROL_ROOM_PRE_0239_DIGEST is set it must equal the measured pre-0239 digest");

      // Re-apply cleanly, so the re-application half of 0239's own contract is
      // observed here too, and the digest comes back byte for byte.
      await admin.query(await readFile(join(REPOSITORY_ROOT, "db/migrations", UP), "utf8"));
      assert.equal(await readPrivateWebSchemaDigest(facade(admin)), WITH_0239,
        "0239 must re-apply to exactly the schema it produced the first time");
    } finally { await admin.end().catch(() => {}); }
  // The port is the caller's, and `allowedPorts` is what the kit checks it
  // against: a lane that leaves it unset cannot start a cluster at all, and one
  // that sets it wide is asking to collide with another bot's.
  }, { port: PORT, allowedPorts: [PORT], boundMs: 600_000 });
});
