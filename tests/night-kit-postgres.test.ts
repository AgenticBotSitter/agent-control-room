// Real-PostgreSQL production-login proof for the first-night kit. This test is
// intentionally skipped when PostgreSQL 17 cannot start. A DB-capable lead must
// run the exact package command documented in the owner guide and final report.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

const PORT = 58430, PG = requiresRealPostgres();
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

test("night-kit SQL surfaces are available only through their production logins", needsPg(), async () => {
  const result = await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:night-kit-pg','Night kit fixture')");
      await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:night-kit-pg','tenant:night-kit-pg','Night kit fixture')");
    } finally { await admin.end(); }

    const web = new Client(postgres.connection("web")), coordinator = new Client(postgres.connection("coordinator"));
    await web.connect(); await coordinator.connect();
    try {
      const pipeline = await web.query<{ count: string }>("SELECT count(*)::text AS count FROM pipeline_runs WHERE tenant_id=$1", ["tenant:night-kit-pg"]);
      const batches = await web.query<{ count: string }>("SELECT count(*)::text AS count FROM work_batches WHERE tenant_id=$1", ["tenant:night-kit-pg"]);
      const supervisor = await coordinator.query<{ count: string }>("SELECT count(*)::text AS count FROM control_supervisor_loop_heads WHERE tenant_id=$1", ["tenant:night-kit-pg"]);
      assert.deepEqual([pipeline.rows[0]!.count, batches.rows[0]!.count, supervisor.rows[0]!.count], ["0", "0", "0"]);
      await assert.rejects(web.query("INSERT INTO pipeline_advance_receipts(id) VALUES('night-kit-forged')"), /permission denied|violates/u);
      await assert.rejects(coordinator.query("DELETE FROM work_batches"), /permission denied/u);
    } finally { await web.end(); await coordinator.end(); }
    return postgres.appliedMigrations;
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
  assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []); assert.ok(result.value > 0);
});
