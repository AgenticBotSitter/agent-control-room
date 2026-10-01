// 0234's down, proved on a real cluster, and the claim it makes about bytes.
//
// A down migration is the thing an operator reaches for when an upgrade has
// gone wrong, and a down that does not run is worse than none. Worse still is a
// down that RUNS and leaves the database subtly different from the one it was
// given, because then the rollback is invisible: every query afterwards answers,
// and none of them answers wrongly.
//
// That is the specific hazard here. 0234 re-declares 0140's claim guard with
// its capacity clause removed, and its down puts the clause back. If either
// file restates the body rather than reproducing it -- adding an ERRCODE,
// splitting `END $$` onto its own line, reformatting a header -- then
// pg_get_functiondef changes even though the MEANING does not, and
// privateWebSchemaDigest (which hashes exactly that, in
// src/web/v1/private-database-preflight.ts) moves. A database that went up and
// then down would no longer be the database it started as, and nothing would
// say so.
//
// So this test measures the digest at three points on one live database:
//   before 0234  ->  after 0234  ->  after 0234's down
// and requires the first and third to be EQUAL. It also compares
// pg_get_functiondef itself, so a failure names the function rather than a hash.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, REPOSITORY_ROOT } from "./support/attack-kit/index";
import { readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59480) + 4;
const required = requiresRealPostgres();
const MIGRATION = "0234_fleet_worker_claim_capacity.sql";

/**
 * The schema digest of this schema WITHOUT 0234, as a constant.
 *
 * The equality below proves the down is idempotent and the up is re-applicable,
 * which is not the same claim as "the down restores the database it was given":
 * the before-state above is recovered by running the down over a database that
 * already has 0234, so a change to an EARLIER migration would move both the
 * before and the after together and the test would still pass. Pinning the
 * constant closes that -- now a change to any other migration has to be a
 * deliberate edit here, which names it in the diff.
 *
 * Measured on real PostgreSQL 17 by applying the whole ledger and then this
 * migration's own down. It is also cook/v1's own committed
 * privateWebSchemaDigest, which is the point: this branch adds 0234 and nothing
 * else, so after applying it onto current cook/v1 and running 0234's down, the
 * schema must come back to exactly what cook/v1 says it is.
 */
// Re-pinned twice, for two separate reasons, and both are visible in the diff
// rather than buried:
//  1. files part 2 (0209-0211, numbered before 0234) landed, so the pre-0234
//     schema they produce became the before-state. Equals files2's own pre-0234
//     schema digest.
//  2. THIS merge. The text-copy derivations are 0212-0213, ALSO numbered before
//     0234, so 0234's down now leaves them in place and the before-state moves
//     again. The value below is measured on real PostgreSQL 17 from the merged
//     tree, not carried across: it is cook/v1's value plus 0212+0213 exactly,
//     which is provable because the merged tree minus 0212/0213 minus 0234
//     reproduces cook/v1's own PRE_0234 constant above (`45393cc6...`) byte for
//     byte. Carrying the old constant instead would have left this test green on
//     a schema it no longer describes -- the failure mode the file's own header
//     exists to prevent.
const PRE_0234_DIGEST = "73ebc791e5800ff7a33d4d6ff18edddca06bc352b1bd2d3abc6ae85ee277bf85";

/** The digest reader wants a DatabaseClient; a `pg` client is one, thinly wrapped. */
const facade = (client: Client): DatabaseClient => {
  const session: DatabaseSession = Object.freeze({
    query: async (statement: string, params: unknown[] = []) => ({ rows: (await client.query(statement, params)).rows }),
  });
  return Object.freeze({
    query: <T>(statement: string, params: unknown[] = []) => session.query<T>(statement, params),
    transaction: async <T>(work: (inner: DatabaseSession) => Promise<T>) => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
    // The digest reader only calls `query`, but the interface requires the
    // shape, and a facade that throws if it is ever reached is better than one
    // that silently pretends.
    transactionWithPreCommitCheck: async <T>(work: (inner: DatabaseSession) => Promise<T>) => {
      throw new Error("the digest reader never opens a transaction");
    },
  });
};

test("real PostgreSQL: 0234's down restores the schema exactly, byte for byte",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    admin.on("error", () => {});
    await admin.connect();
    try {
      // pg_get_functiondef is what the digest hashes, so it is what has to come
      // back. Compared as text, the failure names the difference.
      const guardDefinition = async () => (await admin.query<{ definition: string }>(
        "SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace"
        + " WHERE n.nspname='public' AND p.proname='guard_fleet_claim_insert'")).rows[0]!.definition;
      const capacityObjects = async () => ({
        function: (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc p"
          + " JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'"
          + " AND p.proname='enforce_fleet_worker_claim_capacity'")).rows[0]!.n,
        trigger: (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger t"
          + " JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='fleet_claims' AND NOT t.tgisinternal"
          + " AND t.tgname LIKE '%capacity_guard%'")).rows[0]!.n,
      });

      // ---- BEFORE 0234. The kit applied the whole ledger, so 0234 is already
      // in place; the pre-state is recovered by running its own down, which is
      // the only way to obtain it and the same way an operator would.
      await admin.query(await readFile(join(REPOSITORY_ROOT, "db/down", MIGRATION), "utf8"));
      const beforeDigest = await readPrivateWebSchemaDigest(facade(admin));
      const beforeDefinition = await guardDefinition();
      const beforeCapacity = await capacityObjects();
      assert.deepEqual(beforeCapacity, { function: 0, trigger: 0 },
        "0234's down removed its own function and trigger, so this is the pre-0234 state");
      assert.ok(beforeDefinition.includes(">=worker.max_concurrent"),
        "and 0140's own capacity clause is back, which is the clause 0234 removed");
      assert.equal(beforeDigest, PRE_0234_DIGEST,
        "and this before-state really is the pre-0234 schema, not merely whatever 0234's down happens to leave");

      // ---- UP.
      await admin.query(await readFile(join(REPOSITORY_ROOT, "db/migrations", MIGRATION), "utf8"));
      const afterUpDigest = await readPrivateWebSchemaDigest(facade(admin));
      const afterUpDefinition = await guardDefinition();
      assert.notEqual(afterUpDigest, beforeDigest, "0234 changes the schema digest, so the digest really measures it");
      assert.ok(!afterUpDefinition.includes("max_concurrent"),
        "0234's up really did remove 0140's capacity clause");
      assert.deepEqual(await capacityObjects(), { function: 1, trigger: 1 },
        "and 0234's capacity guard and its trigger are in place");
      // The trigger name is load-bearing, not cosmetic: BEFORE triggers on one
      // table fire in NAME order, so this name is what puts the capacity guard
      // AFTER 0140's and keeps an inadmissible claim from taking the lock.
      const order = (await admin.query<{ tgname: string }>("SELECT t.tgname FROM pg_trigger t"
        + " JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname='fleet_claims' AND NOT t.tgisinternal"
        + " ORDER BY t.tgname")).rows.map(row => row.tgname);
      assert.ok(order.indexOf("fleet_claims_zz_capacity_guard") > order.indexOf("fleet_claims_guard"),
        `the capacity guard fires last in name order (${order.join(", ")})`);

      // ---- DOWN, and the claim.
      await admin.query(await readFile(join(REPOSITORY_ROOT, "db/down", MIGRATION), "utf8"));
      const afterDownDigest = await readPrivateWebSchemaDigest(facade(admin));
      assert.equal(afterDownDigest, beforeDigest,
        "an up followed by a down restores the pre-0234 schema digest exactly");
      assert.equal(await guardDefinition(), beforeDefinition,
        "and restores pg_get_functiondef character for character, which is what the digest hashes");

      // The re-up has to work from the restored state, or a rollback would leave
      // a database that cannot be upgraded again.
      await admin.query(await readFile(join(REPOSITORY_ROOT, "db/migrations", MIGRATION), "utf8"));
      assert.equal(await readPrivateWebSchemaDigest(facade(admin)), afterUpDigest,
        "and 0234 re-applies cleanly onto its own down");
    } finally { await admin.end().catch(() => {}); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});