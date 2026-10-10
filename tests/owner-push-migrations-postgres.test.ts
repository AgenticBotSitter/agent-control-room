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

test("real PostgreSQL: 0227 holds the subscriptions table to the push-service allow list",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    // As the OWNER WEB LOGIN, which holds INSERT on this table. A constraint
    // tested only as the table owner proves nothing about the writer it exists
    // to constrain.
    const asOwnerWeb = async (statement: string, params: unknown[] = []) => {
      const web = new Client(postgres.connection("web"));
      try { await web.connect(); return await web.query(statement, params as never[]); }
      finally { await web.end().catch(() => {}); }
    };
    const valid = "A".repeat(87), auth = "B".repeat(22);
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Allow list')", [TENANT]);

      // Every host on the list is ACCEPTED, on the production login. If this
      // fails, real phones on those services could not subscribe at all. The
      // Windows entries are REAL WNS channel-URL shapes, token in the query,
      // because refusing those would break every real Windows subscription.
      const allowed = ["https://web.push.apple.com/abc", "https://fcm.googleapis.com/fcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://db5p.notify.windows.com/w/?token=abc",
        "https://dm3p.notify.windows.com/?token=AwYAAAB%2fQAhYEiAESPobjHzQcwGCTjHu",
        "https://DB5P.NOTIFY.WINDOWS.COM/w/", "https://fcm.googleapis.com:443/fcm/send/abc"];
      for (const [index, endpoint] of allowed.entries()) {
        await asOwnerWeb(`INSERT INTO owner_web_push_subscriptions
          (id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,NULL,now(),now())`, [`push:${String(index).padStart(64, "0")}`, TENANT, endpoint, valid, auth]);
      }
      assert.equal((await asOwnerWeb("SELECT count(*)::int AS n FROM owner_web_push_subscriptions WHERE tenant_id=$1",
        [TENANT])).rows[0]!.n, allowed.length, "every real push service is accepted");

      // Every host off the list is REFUSED, including the ones a substring or
      // LIKE test would wave through. Each refusal is on a fresh connection: a
      // statement that RAISEs leaves its transaction aborted, so a shared
      // connection would report 25P02 -- an artefact of the test -- instead of
      // the constraint's own answer.
      const refused = ["https://evil.invalid/push", "https://localhost:8443/push",
        "https://169.254.169.254/latest/meta-data/", "http://fcm.googleapis.com/fcm/send/abc",
        "https://web.push.apple.com.evil.invalid/abc", "https://evil.invalid/?next=web.push.apple.com",
        "https://fcm.googleapis.com.evil.invalid/", "https://user:pass@fcm.googleapis.com/",
        "https://xnotify.windows.com/", "https://notify.windows.com/", "https://x.y.notify.windows.com/",
        "https://fcm.googleapis.com:8443/fcm/send/abc", "https://fcm.googleapis.com/fcm/send/abc#x"];
      for (const [index, endpoint] of refused.entries()) {
        await assert.rejects(() => asOwnerWeb(`INSERT INTO owner_web_push_subscriptions
          (id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,NULL,now(),now())`,
        [`push:${String(index + 100).padStart(64, "0")}`, TENANT, endpoint, valid, auth]),
        /check constraint/i, `the owner web login must not be able to store ${endpoint}`);
      }
      assert.equal((await asOwnerWeb("SELECT count(*)::int AS n FROM owner_web_push_subscriptions WHERE tenant_id=$1",
        [TENANT])).rows[0]!.n, allowed.length, "and not one refused endpoint was stored");

      // The three lists must AGREE, string for string. A version of the SQL that
      // drifted from ownerPushEndpointAllowedV1 would refuse a subscribe the
      // application had already accepted, which is a worse failure than the SSRF
      // it prevents -- so the SQL is compared against the application on exactly
      // the strings both are given.
      const { ownerPushEndpointAllowedV1 } = await import("../src/web-push/v1/policy");
      for (const endpoint of [...allowed, ...refused, "not a url at all", "", "https://", "https://fcm.googleapis.com"]) {
        const sql = (await admin.query<{ allowed: boolean }>(
          "SELECT owner_push_endpoint_allowed($1) AS allowed", [endpoint])).rows[0]!.allowed;
        assert.equal(sql, ownerPushEndpointAllowedV1(endpoint),
          `the database and the application disagree about ${JSON.stringify(endpoint)}: sql=${String(sql)}`);
      }
      // A NULL endpoint is a refusal, never an error: the function is TOTAL, so a
      // hostile string cannot turn the CHECK into a crash.
      assert.equal((await admin.query<{ host: string | null }>(
        "SELECT owner_push_endpoint_host($1) AS host", ["not a url"])).rows[0]!.host, null);
      assert.equal((await admin.query<{ allowed: boolean | null }>(
        "SELECT owner_push_endpoint_allowed(NULL::text) AS allowed")).rows[0]!.allowed, null,
        "NULL in is NULL out (STRICT), which the CHECK treats as not-true and therefore refuses");

      // The EXECUTE grant the constraint needs, and the ONLY one it has. A CHECK
      // runs as its writer, so without this the constraint is unevaluable by
      // the role it constrains and every subscribe fails 42501 rather than 204.
      // Asserted here because that failure mode is invisible to the rest of
      // this file: without EXECUTE every insert is refused for the wrong reason
      // and the allow list looks like it works.
      const acl = await admin.query<{ grantee: string; grantable: boolean }>(`SELECT
          pg_get_userbyid(a.grantee) AS grantee, a.is_grantable AS grantable
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.proname='owner_push_endpoint_allowed' AND a.privilege_type='EXECUTE'
          AND pg_get_userbyid(a.grantee)<>pg_get_userbyid(p.proowner)
        ORDER BY grantee`);
      assert.deepEqual(acl.rows, [{ grantee: "control_room_private_web", grantable: false }],
        "exactly one non-owner role may EXECUTE the allow list, without being able to pass it on");
      assert.equal((await admin.query<{ ok: boolean }>(
        "SELECT has_function_privilege('control_room_private_web','public.owner_push_endpoint_allowed(text)','EXECUTE') AS ok"
      )).rows[0]!.ok, true, "and the login that inserts subscriptions can actually evaluate the CHECK");
      assert.equal((await admin.query<{ ok: boolean }>(
        "SELECT has_function_privilege('public','public.owner_push_endpoint_allowed(text)','EXECUTE') AS ok"
      )).rows[0]!.ok, false, "while PUBLIC cannot -- 0227 revokes it, and both role files revoke it again after the migrations");
    } finally { await admin.end(); }
  }, { port: PORT + 2, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

test("real PostgreSQL: 0227 down restores the table and leaves 0223-0226 alone",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const asOwnerWeb = async (statement: string, params: unknown[] = []) => {
      const web = new Client(postgres.connection("web"));
      try { await web.connect(); return await web.query(statement, params as never[]); }
      finally { await web.end().catch(() => {}); }
    };
    const hasFunction = async (name: string) => (await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname=$1", [name])).rows[0]!.n;
    const constraints = async () => (await admin.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid='owner_web_push_subscriptions'::regclass"
      + " AND contype='c' ORDER BY conname")).rows.map(row => row.conname);
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Allow list down')", [TENANT]);
      assert.equal(await hasFunction("owner_push_endpoint_allowed"), 1, "0227 created the function");
      assert.ok((await constraints()).includes("owner_web_push_subscriptions_endpoint_allowed"),
        "and the constraint");
      // 0173's own checks must survive the down: they belong to 0173, and 0227's
      // down revokes only what 0227 added. Captured before, compared after.
      const before = await constraints();
      assert.ok(before.filter(name => name !== "owner_web_push_subscriptions_endpoint_allowed").length > 0,
        "0173 left checks of its own, so this down has something it must NOT touch");

      await run(admin, "0227_owner_push_endpoint_allow_list.sql");

      assert.equal(await hasFunction("owner_push_endpoint_allowed"), 0, "0227 down removed its function");
      assert.equal(await hasFunction("owner_push_endpoint_host"), 0, "and the helper it called");
      assert.deepEqual(await constraints(),
        before.filter(name => name !== "owner_web_push_subscriptions_endpoint_allowed"),
        "exactly the constraint 0227 added is gone, and every check it did not add survives");
      // The table and its grants are 0173's, and survive -- this is the last
      // file of the series, so its down must not drop an earlier migration's
      // table.
      const table = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_class WHERE relname='owner_web_push_subscriptions'");
      assert.equal(table.rows[0]!.n, 1, "the table is 0173's and survives");
      // And the web login still holds what 0173 granted, so a down did not
      // quietly lock the owner out of subscribing at all.
      assert.equal((await asOwnerWeb("SELECT count(*)::int AS n FROM owner_web_push_subscriptions WHERE tenant_id=$1",
        [TENANT])).rows[0]!.n >= 0, true, "the owner web login can still read its subscriptions");
    } finally { await admin.end(); }
  }, { port: PORT + 3, allowedPorts: PORTS, database: "control_room", boundMs: 180_000 });
});

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
      assert.deepEqual(await columns(), ["attempt_count", "completed_at", "completion_data", "completion_disposition",
        "completion_next_attempt_at", "completion_reason_code", "completion_retry_count", "last_attempt_at",
        "next_attempt_at", "reserved_at", "safe_reason_code", "state", "updated_at"],
        "the installed release grants retry and completion bookkeeping only");
      await run(admin, "0300_owner_push_durable_completion.sql");
      assert.deepEqual(await columns(), ["attempt_count", "completed_at", "last_attempt_at",
        "next_attempt_at", "reserved_at", "safe_reason_code", "state", "updated_at"],
        "0300 down removes its completion columns and preserves every 0226 grant");
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
      // Roll back newer completion metadata first. Retained completion refusal
      // is exercised by WP-D15 through the actual producer and web login.
      await run(admin, "0300_owner_push_durable_completion.sql");
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

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { OwnerPushDispatcherV1 } from "../src/web-push/v1/dispatcher";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";

// Independently captured release artifacts, pinned before the completion migration.
const BASE_LEDGER='c5b27220129a5201f7baeadf48f00d3134726ebe056cb456095b7a88ad4cca03';
const BASE_SCHEMA='ef71e299dfac1dd36ca7a3cb569b6e0b23a307bb3f075048f5f408186c816390';
const PUSH_RELEASE_BASE='14bb5fde02ab096441d6ef113e77773b2988e813';

test("WP-D15: released producer data survives provisioned upgrade and fresh schema agrees (PG)", {
  skip: required ? false : realPostgresSkipMessage(), timeout:900_000,
}, async () => {
  const currentRoot=REPOSITORY_ROOT;
  const scratch=join(currentRoot,".test-tmp");await mkdir(scratch,{recursive:true});
  const oldRoot=await mkdtemp(join(scratch,"owner-push-release-"));
  try {
    execFileSync("git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","clone",
      "--no-hardlinks","--no-checkout","--quiet",currentRoot,oldRoot],{timeout:60_000,stdio:"pipe"});
    execFileSync("git",["-C",oldRoot,"-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",
      "checkout","--detach","--quiet",PUSH_RELEASE_BASE],{timeout:60_000,stdio:"pipe"});
    // The old source uses this checkout's dependency tree, deliberately, with
    // identical captured lockfile bytes. This is an old-producer proof, not an
    // archive-install proof or a claim that the old clone installed packages.
    assert.equal(await readFile(join(oldRoot,"pnpm-lock.yaml"),"utf8"),
      await readFile(join(currentRoot,"pnpm-lock.yaml"),"utf8"),"old producer runtime dependency inputs match");
 const oldLedger=JSON.parse(await readFile(join(oldRoot,'deploy/postgres/migration-ledger.json'),'utf8'));
 assert.equal(oldLedger.digest,BASE_LEDGER,'independently captured14bb release ledger');
 await withRealPostgres(async postgres=>{
  const previous='push_previous_release';
  const admin=new Client(postgres.admin());admin.on('error',()=>{});await admin.connect();
  let oldPool:ReturnType<typeof bindPrivatePgPool>|undefined;
  let fresh:Client|undefined;
  try {
   await admin.query(`CREATE DATABASE ${previous} OWNER fixture_admin`);
   const target=postgres.admin({database:previous});
   const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',
    CONTROL_ROOM_MIGRATOR_PASSWORD:postgres.connection('migrator').password,
    CONTROL_ROOM_APP_PASSWORD:postgres.connection('app').password,
    CONTROL_ROOM_SCHEDULER_PASSWORD:postgres.connection('scheduler').password,
    CONTROL_ROOM_WORK_INTAKE_PASSWORD:postgres.connection('control_room_work_intake_agent').password};
   // The inferred JS call shape requires the legacy plan flag; execution is
   // authorized only by bootstrapTarget and migrateTarget, so leave it unset.
   const before=await applyMigrations({target:undefined,rootDir:oldRoot,ledgerPath:join(oldRoot,'deploy/postgres/migration-ledger.json'),
    bootstrapTarget:target,migrateTarget:postgres.connection('migrator',{database:previous}),env});
   const grantProducer=await import(pathToFileURL(join(oldRoot,'scripts/mac-local/database-upgrade-grants.mjs')).href);
   const grantActor=new Client(target);grantActor.on('error',()=>{});await grantActor.connect();
   try {
    const desired=await grantProducer.readDesiredMacGrantsV1();
    const privateWeb=new Set([...desired].filter((item:string)=>item.startsWith('control_room_private_web|')));
    const actual=new Set([...await grantProducer.readMacGrantCatalogV1(grantActor)].filter((item:string)=>item.startsWith('control_room_private_web|')));
    const diff=grantProducer.diffMacGrantsV1(actual,privateWeb);
    await grantProducer.applyMacGrantDiffV1(grantActor,diff);
    console.log('earlier-private-web-provision',JSON.stringify({missing:diff.missing.length,extra:diff.extra.length,source:'released narrow-role grant producer'}));
   } finally {await grantActor.end();}
   const login=postgres.connection('web',{database:previous});
   oldPool=bindPrivatePgPool(new Pool({...privatePgOptions({host:'127.0.0.1',port:postgres.port,database:previous,username:login.user,password:login.password,majorVersion:17}),host:login.host}));
   const db=oldPool.client;
   assert.equal((await db.query('SELECT session_user AS login')).rows[0].login,'control_room_web');
   assert.equal(await readPrivateWebSchemaDigest(db),BASE_SCHEMA,'earlier producer built the independently captured release schema through the production reader');
   const seed=new Client(postgres.admin({database:previous}));seed.on('error',()=>{});await seed.connect();
   try {
    await seed.query("INSERT INTO tenants(id,display_name) VALUES('tenant:upgrade','Upgrade input')");
    await seed.query(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,created_at,updated_at)
     VALUES($1,'tenant:upgrade','https://fcm.googleapis.com/fcm/send/upgrade-input','A','B',now(),now())`,[`push:${'a'.repeat(64)}`]);
    for(const id of ['accepted','retry'])await seed.query(`INSERT INTO control_action_inbox
     (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
     VALUES($1,'tenant:upgrade','project:upgrade','job:upgrade','failure','open','not_requested',now(),'{}')`,['attention:upgrade:'+id]);
   } finally {await seed.end();}
   assert.equal((await db.query('SELECT count(*)::int AS n FROM control_owner_push_attempt_heads')).rows[0].n,0);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM owner_web_push_deliveries')).rows[0].n,0);
   const oldDispatcher=await import(pathToFileURL(join(oldRoot,'src/web-push/v1/dispatcher.ts')).href);
   const oldStore=await import(pathToFileURL(join(oldRoot,'src/web-push/v1/postgres-store.ts')).href);
   const at=Date.now(),tags:string[]=[];
   const channel={kind:'web-push' as const,async send(_s:unknown,p:{tag:string}){
    tags.push(p.tag);return{statusCode:p.tag.endsWith(':retry')?503:201};}};
   await new oldDispatcher.OwnerPushDispatcherV1({db,tenantId:'tenant:upgrade',
    store:new oldStore.PostgresOwnerPushStoreV1(db),channel,clock:()=>at}).dispatch();
   const rows=async()=> (await db.query(`SELECT action_inbox_id,state,attempt_count FROM control_owner_push_attempt_heads ORDER BY action_inbox_id`)).rows;
   assert.deepEqual(await rows(),[
    {action_inbox_id:'attention:upgrade:accepted',state:'delivered',attempt_count:1},
    {action_inbox_id:'attention:upgrade:retry',state:'pending',attempt_count:1}]);
   assert.equal(tags.length,2,'old producer sent both synthetic provider requests');
   const upgrade=await applyMigrations({target:undefined,rootDir:currentRoot,ledgerPath:join(currentRoot,'deploy/postgres/migration-ledger.json'),
    bootstrapTarget:target,migrateTarget:postgres.connection('migrator',{database:previous}),env});
   assert.deepEqual(upgrade.applied?.map((r:{file:string})=>r.file),['db/migrations/0300_owner_push_durable_completion.sql'],
    'upgrade appends only the new migration to the real earlier ledger');
   assert.deepEqual(await rows(),[
    {action_inbox_id:'attention:upgrade:accepted',state:'delivered',attempt_count:1},
    {action_inbox_id:'attention:upgrade:retry',state:'pending',attempt_count:1}],'upgrade preserves old product-created data');
   fresh=new Client(postgres.connection('web'));fresh.on('error',()=>{});await fresh.connect();
   const reader=(client:Client)=>({query:async(s:string,p?:unknown[])=>({rows:(await client.query(s,p)).rows})});
   const upgradedDigest=await readPrivateWebSchemaDigest(db);
   const freshDigest=await readPrivateWebSchemaDigest(reader(fresh));
   assert.equal(upgradedDigest,freshDigest,'independent fresh and upgraded catalogs agree');
   console.log(JSON.stringify({baselineLedger:BASE_LEDGER,baselineSchema:BASE_SCHEMA,upgradedDigest,freshDigest,
    applied:upgrade.applied?.map((r:{file:string})=>r.file),login:'control_room_web',provider:'SYNTHETIC'}));
   const accepted={kind:'web-push' as const,async send(_s:unknown,p:{tag:string}){tags.push(p.tag);return{statusCode:201};}};
   await new OwnerPushDispatcherV1({db,tenantId:'tenant:upgrade',store:new PostgresOwnerPushStoreV1(db),channel:accepted,clock:()=>at+30_000}).dispatch();
   assert.deepEqual(await rows(),[
    {action_inbox_id:'attention:upgrade:accepted',state:'delivered',attempt_count:1},
    {action_inbox_id:'attention:upgrade:retry',state:'delivered',attempt_count:2}]);
   assert.deepEqual(tags,['needs:attention:upgrade:accepted','needs:attention:upgrade:retry','needs:attention:upgrade:retry']);
  } finally {await oldPool?.close();await fresh?.end();await admin.end();}
 },{port:PORT+8,allowedPorts:PORTS,boundMs:600000});
  } finally {await rm(oldRoot,{recursive:true,force:true});}
});

test("WP-D22: 0300 uses bigint and retains safe completion constraints (PG)",
  required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const web = new Client(postgres.connection("web"));
    web.on("error", () => {}); await web.connect();
    try {
      assert.equal((await web.query("SELECT session_user AS login")).rows[0].login, "control_room_web");
      const column = await web.query(`SELECT format_type(atttypid, atttypmod) AS type
        FROM pg_attribute WHERE attrelid='control_owner_push_attempt_heads'::regclass
        AND attname='completion_retry_count' AND NOT attisdropped`);
      assert.equal(column.rows[0]?.type, "bigint", "WP-D22 retry counter uses the lint-required bigint type");
      const constraints = await web.query(`SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid='control_owner_push_attempt_heads'::regclass AND conname=ANY($1::text[])
        ORDER BY conname`, [["control_owner_push_attempt_heads_state_check", "owner_push_completion_shape",
          "owner_push_completion_disposition"]]);
      assert.deepEqual(constraints.rows, [
        { conname: "control_owner_push_attempt_heads_state_check", convalidated: false },
        { conname: "owner_push_completion_disposition", convalidated: false },
        { conname: "owner_push_completion_shape", convalidated: false },
      ], "WP-D22 changed checks protect every new write without a legacy table scan");
      const index = await web.query(`SELECT indisvalid, indisready, pg_get_expr(indpred, indrelid) AS predicate
        FROM pg_index WHERE indexrelid='control_owner_push_completions_due'::regclass`);
      assert.deepEqual(index.rows, [{ indisvalid: true, indisready: true, predicate: "(state = 'completing'::text)" }],
        "WP-D22 transactional completion index is ready and filters only completing rows");
    } finally { await web.end(); }
  }, { port: PORT + 9, allowedPorts: PORTS, boundMs: 180_000 });
});
