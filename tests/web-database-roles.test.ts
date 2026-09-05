import assert from "node:assert/strict";
import test from "node:test";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup";
import { now, request, trust, token } from "./helpers/web-foundation";
import { verifyPrivateDatabase, privateWebSchemaDigest, readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createAccessVerifier } from "../src/web/v1/access-verifier";

test("restricted schema matches the PG17 fingerprint; setup accepts injected database TEMP metadata only", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close());
  assert.equal(await readPrivateWebSchemaDigest(f.client), privateWebSchemaDigest);
  // The unmodified production gate refuses PGlite's unrevocable template1 TEMP privilege.
  await assert.rejects(verifyPrivateDatabase(f.client, startupConfig.database, startupConfig, now), /preflight_failed/);
  await verifyPrivateDatabase(f.pool.client, startupConfig.database, startupConfig, now);
});

test("the restricted role runs ordinary projects, Idea and connection reads, replay, lifecycle, audit and logout", async t => {
  const f = await limitedWebFixture();
  const app = createPrivateWebProcess({ ...startupConfig, database: f.pool, clock: () => now });
  t.after(() => app.close());
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const command = () => request(undefined, "POST", { title: "Restricted-role project", summary: "Disposable SQL" });
  const created = await handle(command()); assert.equal(created.status, 201);
  const { project } = await created.json();
  assert.equal((await (await handle(command())).json()).replayed, true);
  const catalog = await (await handle(request())).json();
  assert.equal(catalog.projects.length, 2); assert.equal(catalog.sources.ideas, "included");
  assert.equal((await handle(request(`/api/v1/projects/${encodeURIComponent(project.projectId)}/lifecycle`, "POST",
    { lifecycle: "completed", expectedVersion: 1 }, "limited-lifecycle-001"))).status, 200);
  const connections = await handle(request("/api/v1/connections")); assert.equal(connections.status, 200);
  assert.equal((await connections.json()).projection.summary.currentSignalCount, 1);
  assert.equal((await f.client.query("SELECT * FROM audit_events")).rows.length, 2);
  assert.equal((await handle(request("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handle(request())).status, 401);
  assert.equal((await handle(request("/api/v1/connections"))).status, 401);
});

test("lock-support columns cannot change authority and sessions cannot lose their revocation", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close());
  for (const table of ["control_identities", "control_role_grants", "workspaces", "control_connection_registry_heads"]) {
    await f.client.query(`UPDATE ${table} SET web_lock=false`);
    await assert.rejects(f.client.query(`UPDATE ${table} SET web_lock=true`));
  }
  for (const statement of [
    "UPDATE control_identities SET state='suspended'", "UPDATE control_role_grants SET revoked_at=now()",
    "UPDATE control_connection_registry_heads SET last_sequence=last_sequence", "DELETE FROM control_web_sessions",
    "UPDATE projects SET adapter_id=adapter_id", "TRUNCATE audit_events", "DELETE FROM control_web_project_commands",
    "SELECT * FROM tenants", "CREATE TABLE web_unexpected(id text)",
  ]) await assert.rejects(f.client.query(statement));
  const identity = createAccessVerifier(trust)(request(undefined, "GET", undefined, undefined, token()), now);
  await f.service.logout(identity);
  await assert.rejects(f.client.query("UPDATE control_web_sessions SET revoked_at=NULL"));
  await assert.rejects(f.client.query("UPDATE control_web_sessions SET expires_at=expires_at+interval '1 day'"));
  const row = (await f.client.query<{ revoked_at: unknown }>("SELECT revoked_at FROM control_web_sessions")).rows[0];
  assert.ok(row.revoked_at);
});

test("preflight rejects missing scope, stale owner, disabled deadlines, schema drift and extra effective privileges", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close());
  const verify = () => verifyPrivateDatabase(f.pool.client, startupConfig.database, startupConfig, now);
  await assert.rejects(verifyPrivateDatabase(f.pool.client, startupConfig.database,
    { ...startupConfig, workspaceId: "workspace:absent" }, now), /preflight_failed/);
  await f.db.exec("SET statement_timeout=0"); await assert.rejects(verify(), /preflight_failed/);
  await f.db.exec("SET statement_timeout='5s'; SET SESSION AUTHORIZATION postgres; GRANT SELECT ON tenants TO control_room_private_web; SET SESSION AUTHORIZATION web_test");
  await assert.rejects(verify(), /preflight_failed/);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; REVOKE SELECT ON tenants FROM control_room_private_web; UPDATE control_identities SET state='suspended'; SET SESSION AUTHORIZATION web_test");
  await assert.rejects(verify(), /preflight_failed/);
  await f.db.exec("SET SESSION AUTHORIZATION postgres; UPDATE control_identities SET state='active'; SET SESSION AUTHORIZATION web_test");
  await verify();
  await f.db.exec("SET SESSION AUTHORIZATION postgres; ALTER TABLE projects ADD COLUMN drift text; SET SESSION AUTHORIZATION web_test");
  await assert.rejects(verify(), /preflight_failed/);
});

test("preflight refuses omitted permissions, authority updates, broad memberships and disabled protection", async t => {
  for (const change of [
    "REVOKE UPDATE (web_lock) ON control_identities FROM control_room_private_web",
    "GRANT UPDATE (state) ON control_identities TO control_room_private_web",
    "CREATE ROLE web_extra; GRANT web_extra TO control_room_private_web",
    "ALTER TABLE control_web_sessions DISABLE TRIGGER control_web_sessions_revocation_guard",
    "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO control_room_private_web",
    "GRANT MAINTAIN ON projects TO control_room_private_web",
    "GRANT SET ON PARAMETER session_replication_role TO control_room_private_web",
    "GRANT ALTER SYSTEM ON PARAMETER statement_timeout TO control_room_private_web",
  ]) await t.test(change.split(" ").slice(0,4).join(" "), async t => {
    const f = await limitedWebFixture(); t.after(() => f.pool.close());
    await f.db.exec(`SET SESSION AUTHORIZATION postgres; ${change}; SET SESSION AUTHORIZATION web_test`);
    await assert.rejects(verifyPrivateDatabase(f.pool.client, startupConfig.database, startupConfig, now), /preflight_failed/);
  });
});
