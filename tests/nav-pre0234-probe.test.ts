// Confirm that the PRE_0234 move is 0240-0242 and nothing else: apply the whole
// ledger, roll back 0242/0241/0240 in reverse, and check we are back at the
// committed pre-0234 constant. That is what makes the re-pin honest rather than
// a value copied from a failing assertion.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const PORT = Number(process.env.NAVIGATION_PG_PORT ?? 59962);
const ALLOWED = Array.from({ length: 8 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
// cook/v1's whole-ledger digest: what this tree hashes to with 0240-0242 removed.
const COMMITTED_WHOLE_LEDGER = "013f4a8baa555bc726add9a916a347efbee8d0423912fa4e31590a957f70886e";
// What the whole ledger hashes to WITH navigation applied — the value the preflight pins.
const NEW_WHOLE_LEDGER = "4c905d5a30a7bcac0ffdd0cbc1f3aee2a4f083c2f680d487c0736f184c12c084";
// cook/v1's PRE_0234 constant: the whole ledger minus 0234. Unchanged by this
// branch, and THIS TEST IS WHAT PROVES IT rather than assuming it.
const COMMITTED_PRE_0234 = "9690e50b4055f6e2188d1b3d1dac3c5e38f3e02ae590030a12d2e907e96124b9";
// The whole ledger minus 0234 with 0240-0242 STILL APPLIED. This is the value
// tests/fleet-worker-capacity-down-postgres.test.ts must now pin, because that
// test rolls back only 0234.
const NEW_PRE_0234 = "109f032cdec05902b9fb88ff16f079db27135c383f083a6990ef437dc114bd6f";

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
    transactionWithPreCommitCheck: async () => { throw new Error("the digest reader never opens a transaction"); },
  });
};

test("rolling 0240-0242 back restores cook/v1's PRE_0234 constant exactly",
  PG ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    await admin.connect();
    const migrator = new Client(postgres.connection("migrator"));
    await migrator.connect();
    try {
      const withNavigation = await readPrivateWebSchemaDigest(facade(admin));
      assert.equal(withNavigation, NEW_WHOLE_LEDGER, "the whole ledger here hashes to the committed constant");
      for (const file of ["0242_navigation_owner_guards_and_grants", "0241_page_visits_and_pins", "0240_recurring_chores"])
        await migrator.query(await readFile(join(process.cwd(), "db/down", `${file}.sql`), "utf8"));
      const withoutNavigation = await readPrivateWebSchemaDigest(facade(admin));
      assert.notEqual(withoutNavigation, withNavigation, "rolling back 0240-0242 really changes the schema");
      // Rolling the three migration downs off leaves cook/v1's own whole-ledger
      // schema. It is NOT PRE_0234's value, because 0234 is still applied here —
      // which is exactly the distinction the two constants encode and exactly why
      // PRE_0234 has to be re-derived rather than assumed unaffected.
      assert.equal(withoutNavigation, COMMITTED_WHOLE_LEDGER,
        "the rest of the ledger is untouched, byte for byte");
      // Roll 0234's own down off too, and THAT is PRE_0234's domain. It lands on
      // cook/v1's EXISTING PRE_0234 constant, byte for byte — which is the proof
      // that the move is exactly these three migrations and nothing else. Had
      // this branch changed any earlier migration, this assertion would fail
      // instead of silently re-pinning a constant to describe a schema nobody
      // had built.
      await migrator.query(await readFile(join(process.cwd(), "db/down", "0234_fleet_worker_claim_capacity.sql"), "utf8"));
      const pre0234 = await readPrivateWebSchemaDigest(facade(admin));
      assert.equal(pre0234, COMMITTED_PRE_0234,
        "and the rest of the ledger is provably untouched by this branch");
    } finally { await migrator.end(); await admin.end(); }
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 300_000 });
});