// Disposable full-schema logical restore. No existing database is a valid target.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Client, Pool } from "pg";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { verifyPrivateDatabase, readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { SecurityStore } from "../src/security/security-store";
import { WebProjectService } from "../src/web/v1/project-service";

assert.ok(process.argv[2], "supply reviewed PG17 bin directory");
const bin = resolve(process.argv[2]), exec = promisify(execFile);
const run = await mkdtemp(join(tmpdir(), "cr-restore-pg17-")), data = join(run, "data"), socket = join(run, "socket");
await mkdir(socket, { mode: 0o700 });
const native = (name: string, args: string[]) => exec(join(bin, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 30000, maxBuffer: 262144 });
const config = (database: string, username = "fixture_admin") => ({ host: "127.0.0.1" as const, port: 65433, database,
  username, password: "synthetic_socket_only", majorVersion: 17 as const });
const options = (database: string, username = "fixture_admin") => ({ ...privatePgOptions(config(database, username)), host: socket });
const connections: Client[] = [];
const connect = async (database: string) => { const client = new Client(options(database)); connections.push(client); await client.connect(); return client; };
const scope = { tenantId: "tenant:restore", workspaceId: "workspace:restore" };
const owner = { ...scope, ownerIdentityId: "identity:restore", issuer: "https://fixture.invalid" };
const now = Date.parse("2026-09-08T12:00:00Z");
const identity = { provider: owner.issuer, subject: "fixture-owner", tokenDigest: `sha256:${"a".repeat(64)}`,
  issuedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 300000).toISOString(), verificationExpiresAt: new Date(now + 300000).toISOString() };
const table = "control_connection_enrollment_protocol_deliveries";
const constraint = "control_connection_enrollment_protocol_delive_delivery_id_check";
const check = "CHECK (char_length(delivery_id) >= 3 AND char_length(delivery_id) <= 160 AND delivery_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')";
const snapshot = async (client: Client) => {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const rows = [];
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z0-9_]+$/);
    const values = (await client.query(`SELECT to_jsonb(t) AS value FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    rows.push({ table: tablename, count: values.length, hash: createHash("sha256").update(JSON.stringify(values)).digest("hex") });
  }
  const acl = (await client.query(`SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,
    coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))::text AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S') ORDER BY c.relname`)).rows;
  const functions = (await client.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,
    pg_get_userbyid(p.proowner) AS owner,coalesce(p.proacl,acldefault('f',p.proowner))::text AS acl,p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,args`)).rows;
  return { rows, acl, functions };
};
let started = false, stopped = false;
try {
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"]);
  started = true;
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "10", "-o",
    `-k ${socket} -p 65433 -h '' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12`, "start"]);
  const admin = await connect("postgres");
  assert.equal((await admin.query("SHOW listen_addresses")).rows[0].listen_addresses, "");
  await admin.query("CREATE ROLE fixture_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  for (const name of ["fixture_source", "fixture_restore_one", "fixture_restore_two"])
    await admin.query(`CREATE DATABASE ${name} OWNER fixture_owner`);
  const source = await connect("fixture_source");
  await source.query("SET ROLE fixture_owner; SET search_path=public");
  for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort()) await source.query(await readFile(join("db/migrations", file), "utf8"));
  await source.query("RESET ROLE; SET search_path=pg_catalog, public");
  await source.query(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await source.query(await readFile("db/roles/private_web_database.sql", "utf8"));
  await source.query("ALTER DEFAULT PRIVILEGES FOR ROLE fixture_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
  await source.query("CREATE ROLE fixture_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_private_web TO fixture_web");
  const seed = bindPrivatePgPool(new Pool(options("fixture_source")));
  try {
    await seed.client.query("INSERT INTO tenants(id,display_name) VALUES('tenant:restore','Synthetic')");
    await seed.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:restore','tenant:restore','Synthetic')");
    await new SecurityStore(seed.client).bootstrapOwner({ tenantId: scope.tenantId, provider: owner.issuer, subject: identity.subject,
      identityId: owner.ownerIdentityId, grantId: "grant:restore", displayName: "Synthetic", verifiedAt: identity.issuedAt, expiresAt: identity.expiresAt, now: new Date(now).toISOString() });
  } finally { await seed.close(); }
  for (const value of [null, "", "a", "ab", "abc", "a".repeat(160), "a".repeat(161), "a b", "éab", "a._:-z"]) {
    assert.equal((await source.query(`SELECT ((char_length($1::text) BETWEEN 3 AND 160 AND $1 ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')
      IS NOT DISTINCT FROM (char_length($1::text) >= 3 AND char_length($1::text) <= 160 AND $1 ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')) AS same`, [value])).rows[0].same, true);
  }
  for (const [payload, accepted] of [[null, false], [{}, false], [{ status: "extracted" }, false],
    [{ status: "extracted", text: "" }, false], [{ status: "extracted", text: "a" }, true],
    [{ status: "extracted", text: "a".repeat(131072) }, true], [{ status: "extracted", text: "a".repeat(131073) }, false],
    [{ status: "extracted", text: "é".repeat(65536) }, true], [{ status: "extracted", text: "é".repeat(65537) }, false],
    [{ status: "extracted", text: [] }, false], [{ status: "other", text: "a" }, false]] as const) {
    const checked = (await source.query(`SELECT COALESCE(jsonb_typeof($1::jsonb)='object' AND $1::jsonb->>'status'='extracted'
      AND jsonb_typeof($1::jsonb->'text')='string' AND octet_length($1::jsonb->>'text') BETWEEN 1 AND 131072,false) AS old,
      COALESCE(jsonb_typeof($1::jsonb)='object' AND $1::jsonb->>'status'='extracted' AND jsonb_typeof($1::jsonb->'text')='string'
      AND octet_length($1::jsonb->>'text')>=1 AND octet_length($1::jsonb->>'text')<=131072,false) AS current`,
    [payload === null ? null : JSON.stringify(payload)])).rows[0];
    assert.equal(checked.old, accepted); assert.equal(checked.current, accepted);
  }
  const verify = async (name: string, create = false, selectedOwner = owner) => {
    const db = bindPrivatePgPool(new Pool(options(name, "fixture_web")));
    try {
      assert.equal(await readPrivateWebSchemaDigest(db.client), privateWebSchemaDigest);
      await verifyPrivateDatabase(db.client, config(name, "fixture_web"), selectedOwner, now);
      const projects = new WebProjectService(db.client, scope, () => now);
      if (create) await projects.create(identity, { title: "Restored fixture project", summary: "Synthetic evidence" }, "restore-project-key");
      assert.equal((await projects.list(identity)).length, 1);
    } finally { await db.close(); }
  };
  await verify("fixture_source", true);
  const expected = await snapshot(source);
  let from = "fixture_source";
  for (const name of ["fixture_restore_one", "fixture_restore_two"]) {
    const archive = join(run, `${name}.dump`);
    await native("pg_dump", ["--host", socket, "--port", "65433", "--username", "fixture_admin", "--dbname", from, "--format=custom", "--no-password", "--file", archive]);
    await native("pg_restore", ["--host", socket, "--port", "65433", "--username", "fixture_admin", "--dbname", name, "--single-transaction", "--exit-on-error", "--no-password", archive]);
    const restored = await connect(name);
    await restored.query(await readFile("db/roles/private_web_database.sql", "utf8"));
    assert.deepEqual(await snapshot(restored), expected);
    await verify(name); from = name;
    console.log(JSON.stringify({ restored: name, rowsRelationAndFunctionAcl: "equal", restrictedPreflight: "passed", schemaDigest: privateWebSchemaDigest }));
  }
  const altered = await connect("fixture_restore_two");
  await altered.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint} ${check.replace("<= 160", "<= 161")}`);
  await assert.rejects(verify("fixture_restore_two"));
  await altered.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint} ${check}`);
  await altered.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
  await assert.rejects(verify("fixture_restore_two"));
  await altered.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${check}`);
  await altered.query("GRANT INSERT ON control_abs_article_details TO fixture_web");
  await assert.rejects(verify("fixture_restore_two"));
  await altered.query("REVOKE INSERT ON control_abs_article_details FROM fixture_web");
  await assert.rejects(verify("fixture_restore_two", false, { ...owner, ownerIdentityId: "identity:missing" }));
  await verify("fixture_restore_two");
  console.log(JSON.stringify({ boundsEquivalent: true, articleBoundaryCases: 11, repeatedRestores: 2, changedBoundRejected: true, droppedConstraintRejected: true, excessGrantRejected: true, missingOwnerRejected: true }));
} finally {
  await Promise.allSettled(connections.map(client => client.end()));
  if (started) { await native("pg_ctl", ["-D", data, "-w", "-t", "10", "-m", "fast", "stop"]); stopped = true; }
  if (!started || stopped) { await rm(run, { recursive: true, force: true }); console.log(JSON.stringify({ cleanup: true })); }
}
