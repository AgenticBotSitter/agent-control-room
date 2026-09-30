import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../../src/persistence/database";
import { WebTaskService } from "../../src/web/v1/task-service";
import { createTaskHttpHandler } from "../../src/web/v1/task-http";
import { createAccessVerifier } from "../../src/web/v1/access-verifier";
import { WebProjectService } from "../../src/web/v1/project-service";
import { SecurityStore } from "../../src/security";
import { fixture, now, origin, request, trust } from "./web-foundation";

export async function taskFixture(clock = () => now) {
  const f = await fixture(clock);
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: "Task project", summary: "Real disposable SQL" }, "task-project-create-001");
  const tasks = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, clock);
  const handler = createTaskHttpHandler({ origin, trust, service: tasks, clock });
  const path = `/api/v1/projects/${encodeURIComponent(project.projectId)}/tasks`;
  return { ...f, identity, project, tasks, handler, path };
}
export const taskDraft = { title: "Compare two launch ideas", instructions: "Compare the audience, effort and useful next steps. Return a short recommendation." };

/** The same schema-migrated web fixture opened over a caller-supplied data
 * directory, so a test can close it and open it again. Migrations run once, on
 * first open; a second open reuses the directory and applies nothing. */
export async function taskFixtureOnDisk(dataDir: string, clock = () => now) {
  const db = new PGlite(dataDir);
  const client = adaptPglite(db);
  await db.query("CREATE TABLE IF NOT EXISTS control_room_test_migrated (id int primary key, digest text NOT NULL)");
  const existing = (await client.query("SELECT digest FROM control_room_test_migrated WHERE id=1")).rows[0] as { digest: string } | undefined;
  if (!existing) {
    // Applied under SET ROLE control_room_schema_owner, exactly as
    // apply-migrations.mjs runs them in production. Replaying the files raw
    // leaves every object owned by PGlite's `postgres` superuser, which the
    // private startup preflight refuses: its SECURITY DEFINER allowlist requires
    // the shipped functions to be owned by control_room_schema_owner, so a
    // database whose functions a superuser owns is one an operator could
    // replace. See the same treatment in web-foundation.ts.
    await db.exec(`CREATE ROLE control_room_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS`);
    // The same grant apply-migrations.mjs issues after the migrate phase
    // (line 328): without CREATE on the schema the very first migration fails
    // with 42501 permission denied for schema public.
    await db.exec(`GRANT CREATE, USAGE ON SCHEMA public TO control_room_schema_owner`);
    for (const file of (await (await import("node:fs/promises")).readdir("db/migrations"))
      .filter(name => name.endsWith(".sql")).sort()) {
      await db.exec("BEGIN");
      await db.exec("SET LOCAL ROLE control_room_schema_owner");
      await db.exec(await (await import("node:fs/promises")).readFile(`db/migrations/${file}`, "utf8"));
      await db.exec("COMMIT");
    }
    await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:web','Test tenant')");
    await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Test workspace')");
    await new SecurityStore(client).bootstrapOwner({ tenantId: "tenant:web", provider: trust.issuer, subject: "test-owner",
      identityId: "identity:web", grantId: "grant:web", displayName: "Test owner",
      verifiedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
      now: new Date(now).toISOString() });
    await db.query("INSERT INTO control_room_test_migrated(id,digest) VALUES(1,'migrated')");
  }
  const identity = createAccessVerifier(trust)(request(), now);
  const service = new WebProjectService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, clock);
  const { project } = await service.create(identity, { title: "Task project", summary: "Real disposable SQL" },
    "task-project-create-001");
  const tasks = new WebTaskService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, clock);
  const handler = createTaskHttpHandler({ origin, trust, service: tasks, clock });
  const path = `/api/v1/projects/${encodeURIComponent(project.projectId)}/tasks`;
  return { db, client, service, tasks, handler, path, identity, project };
}
