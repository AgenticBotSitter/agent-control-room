// TEMPORARY DIAGNOSTIC (cook/desk2, Marvin). Delete before hand-in.
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59170);
const PG = requiresRealPostgres();

test("probe", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      const r = await admin.query(
        `SELECT c.relname, r.rolname, a.privilege_type FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, ARRAY[]::aclitem[])) a
         JOIN pg_roles r ON r.oid=a.grantee
         WHERE n.nspname='public' AND c.relname='control_improvement_requests'
         ORDER BY 1,2,3`);
      console.log("PROBE=" + JSON.stringify(r.rows));
    } finally { await admin.end(); }
  }, { port: PORT + 3, allowedPorts: [PORT + 3], boundMs: 180_000 });
});
