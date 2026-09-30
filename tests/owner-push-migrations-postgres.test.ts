import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, REPOSITORY_ROOT } from "./support/attack-kit/index";

// The down files are part of the deliverable, and a down migration that does
// not run is worse than none: it is the thing an operator reaches for when an
// upgrade has gone wrong. These run the REAL 0226 -> 0225 -> 0224 down sequence
// against a real cluster, as the role that owns the objects, and assert that
// each step revokes exactly what its own up file granted and nothing else.

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59480);
const PORTS = Object.freeze([PORT, PORT + 1, PORT + 2, PORT + 3, PORT + 4, PORT + 5, PORT + 6, PORT + 7, PORT + 8, PORT + 9]);
const TENANT = "tenant:pushdown";
const required = requiresRealPostgres();

const run = async (admin: Client, file: string) => {
  const sql = await readFile(join(REPOSITORY_ROOT, "db/down", file), "utf8");
  await admin.query(sql);
};

/** Run a down file on its own connection. Each down file is a transaction, and a
 * file that RAISEs leaves its connection aborted, so sharing one admin
 * connection across a refusal and the statements after it would fail those with
 * 25P02 -- an artefact of the test, not of the migration. */
const runIsolated = async (postgres: { admin(options?: { database?: string }): { host: string; port: number; database: string; user: string; password: string } }, file: string) => {
  const connection = new Client(postgres.admin());
  try { await connection.connect(); await connection.query(await readFile(join(REPOSITORY_ROOT, "db/down", file), "utf8")); }
  finally { await connection.end().catch(() => {}); }
};

test("real PostgreSQL: 0226 down revokes exactly the 0226 grants and no more",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    // The INSERT and UPDATE checks must run as the OWNER WEB LOGIN. Run as
    // `fixture_admin` they would succeed anyway -- that role owns the table,
    // which is exactly why an admin-only test of a web-role grant proves
    // nothing about the web role.
    const asOwnerWeb = async (statement: string) => {
      const web = new Client(postgres.connection("web"));
      try { await web.connect(); return await web.query(statement); }
      finally { await web.end().catch(() => {}); }
    };
    // The FOUR-argument form: (role, table, column, privilege). The
    // three-argument form takes a column OID and reads a bare role identifier as
    // a COLUMN of pg_attribute, so the first version raised 42704 and the
    // second silently answered "no columns" -- which would have made the
    // post-down assertion below pass for the wrong reason.
    const columns = async () => (await admin.query<{ column_name: string }>(`SELECT a.attname AS column_name
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='control_owner_push_attempt_heads'
        AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege('control_room_private_web','control_owner_push_attempt_heads',
          a.attname, 'UPDATE') ORDER BY a.attname`)).rows
      .map(row => row.column_name);
    try {
      assert.deepEqual(await columns(), ["attempt_count", "completed_at", "last_attempt_at",
        "next_attempt_at", "reserved_at", "safe_reason_code", "state", "updated_at"],
        "0226 granted exactly the retry bookkeeping, and not the link or the item id");
      await run(admin, "0226_owner_push_attempt_grants.sql");
      // Every UPDATE column revoked...
      assert.deepEqual(await columns(), [], "the column-scoped UPDATE is gone");
      // ...and the SELECT/INSERT revoked, while the table and its index survive,
      // because those belong to 0224 and this down file must not touch them.
      await assert.rejects(() => asOwnerWeb(
        "INSERT INTO control_owner_push_attempt_heads(tenant_id,action_inbox_id,link,attempt_count,state,next_attempt_at,created_at,updated_at)"
        + " VALUES('tenant:pushdown','attention:x','/needs-me',0,'pending',now(),now(),now())"),
      /permission denied/, "INSERT is revoked too, and the web role really cannot write");
      // The UPDATE revoke is the point of this file, and it is checked AS the
      // web role rather than read from the catalog alone: a grant that the
      // catalog still shows but the login cannot use is not revoked.
      await assert.rejects(() => asOwnerWeb(
        "UPDATE control_owner_push_attempt_heads SET attempt_count=1 WHERE tenant_id='tenant:pushdown'"),
      /permission denied/, "the column-scoped UPDATE is revoked for the login itself");
      const table = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_class WHERE relname='control_owner_push_attempt_heads'");
      assert.equal(table.rows[0]!.n, 1, "the table itself is 0224's, not 0226's, and survives");
      const index = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_class WHERE relname='control_owner_push_attempt_heads_due'");
      assert.equal(index.rows[0]!.n, 1, "so does the due index");
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: 0225 down removes the guard and 0224 down removes the table, each on its own",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const exists = async (name: string) => (await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_class WHERE relname=$1", [name])).rows[0]!.n === 1;
    const hasFunction = async (name: string) => (await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname=$1", [name])).rows[0]!.n;
    try {
      // 0225 down drops ONLY the trigger and its function.
      assert.equal(await hasFunction("guard_owner_push_attempt_head_write"), 1, "0225 created the guard");
      await run(admin, "0225_owner_push_attempt_guards.sql");
      assert.equal(await hasFunction("guard_owner_push_attempt_head_write"), 0, "0225 down removed it");
      assert.equal(await exists("control_owner_push_attempt_heads"), true,
        "0225 down did NOT drop the table 0224 created");
      const trigger = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger "
        + "WHERE tgrelid='control_owner_push_attempt_heads'::regclass AND NOT tgisinternal");
      assert.equal(trigger.rows[0]!.n, 0, "and did not leave a trigger on it");

      // 0224 down refuses while a delivery record exists, because dropping the
      // ledger is exactly how a stall gets alerted about twice.
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Down')", [TENANT]);
      await admin.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
        VALUES('attention:down',$1,'p','j','failure','open','not_requested',now(),NULL,'{}'::jsonb)`, [TENANT]);
      await admin.query(`INSERT INTO control_owner_push_attempt_heads
        (tenant_id,action_inbox_id,link,attempt_count,state,next_attempt_at,reserved_at,last_attempt_at,completed_at,created_at,updated_at)
        VALUES($1,'attention:down','/needs-me',1,'delivered',now(),now(),now(),now(),now(),now())`, [TENANT]);
      await assert.rejects(() => runIsolated(postgres, "0224_owner_push_attempt_heads.sql"),
        /down migration refused: delivery records exist/);
      assert.equal(await exists("control_owner_push_attempt_heads"), true, "the refusal really kept the table");

      // With the record gone -- the operator's explicit decision -- it drops.
      await admin.query("DELETE FROM control_owner_push_attempt_heads WHERE tenant_id=$1", [TENANT]);
      await run(admin, "0224_owner_push_attempt_heads.sql");
      assert.equal(await exists("control_owner_push_attempt_heads"), false, "0224 down removed only its own table");
      // The action inbox item it referenced is untouched: the cascade is the
      // table's to perform, not the down file's to undo.
      const item = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM control_action_inbox WHERE id='attention:down'");
      assert.equal(item.rows[0]!.n, 1, "the attention item is 0019's, and survives");
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});
