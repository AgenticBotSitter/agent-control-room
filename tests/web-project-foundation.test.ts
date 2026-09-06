import assert from "node:assert/strict";
import test from "node:test";
import { AuditStore } from "../src/audit/audit-store.ts";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { fixture, now, trust, token, request } from "./helpers/web-foundation.ts";
import { createProjectBrowserClient } from "../src/web/v1/browser-client.ts";

test("browser reconciles a lost create receipt after another tab changes the saved project", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let dropReply = true; let writes = 0;
  const browser = createProjectBrowserClient((async (path, init) => {
    const method = init?.method ?? "GET";
    const response = await f.handler(request(String(path), method,
      init?.body ? JSON.parse(String(init.body)) : undefined, new Headers(init?.headers).get("idempotency-key") ?? "read-only-key"));
    if (method === "POST") { writes++; if (dropReply) { dropReply = false; throw new Error("lost response after commit"); } }
    return response;
  }) as typeof fetch, () => "original-browser-create-key");
  const draft = { title: "My project", summary: "Work" };
  await assert.rejects(browser.create(draft), /uncertain/);
  const catalog = await browser.list();
  assert.equal(catalog.projects.length, 1); assert.equal(writes, 1);
  const saved = catalog.projects[0];
  assert.equal((await f.handler(request(`/api/v1/projects/${encodeURIComponent(saved.projectId)}/lifecycle`, "POST",
    { lifecycle: "archived", expectedVersion: 1 }, "other-tab-archive-key"))).status, 200);
  const receipt = await browser.retryPending();
  assert.equal(receipt.projectId, saved.projectId); assert.equal(receipt.version, 1);
  assert.equal((await browser.get(saved.projectId)).lifecycle, "archived", "receipt is historical, fresh GET owns current state");
  assert.equal(writes, 2);
  const audit = await new AuditStore(f.client).verify("tenant:web", "month:2026-09");
  assert.equal(audit.valid, true); assert.equal(audit.checkedEvents, 2, "explicit replay creates no duplicate project effect");
});

test("real SQL flow creates, lists, archives and reopens an ordinary project with audit and replay", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const create = () => f.handler(request(undefined, "POST", { title: "  General project  ", summary: "Useful ordinary work" }));
  const first = await create(); assert.equal(first.status, 201);
  const { project } = await first.json(); assert.equal(project.title, "General project"); assert.equal(project.lifecycle, "active");
  const replay = await create(); assert.equal(replay.status, 200); assert.equal((await replay.json()).project.projectId, project.projectId);
  assert.equal((await f.handler(request(undefined, "POST", { title: "Different", summary: "" }))).status, 409);
  const transition = (lifecycle: string, expectedVersion: number, key: string) =>
    f.handler(request(`/api/v1/projects/${encodeURIComponent(project.projectId)}/lifecycle`, "POST", { lifecycle, expectedVersion }, key));
  assert.equal((await transition("archived", 1, "archive-project-0001")).status, 200);
  assert.equal((await transition("active", 1, "reopen-project-0001")).status, 409);
  assert.equal((await transition("active", 2, "reopen-project-0002")).status, 200);
  const listed = await (await f.handler(request())).json(); assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0].version, 3); assert.equal(listed.projects[0].lifecycle, "active");
  const audit = await new AuditStore(f.client).verify("tenant:web", "month:2026-09");
  assert.equal(audit.valid, true); assert.equal(audit.checkedEvents, 3);
  const detail = await f.handler(request(`/api/v1/projects/${encodeURIComponent(project.projectId)}`));
  assert.equal(detail.status, 200); assert.equal((await detail.json()).project.version, 3);
  const count = await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs");
  assert.equal(count.rows[0].count, 0);
});
test("identity, membership and logout revocation are checked against durable SQL state", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.equal((await f.handler(request())).status, 200);
  await f.db.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
  assert.equal((await f.handler(request())).status, 403);
  await f.db.query("UPDATE control_role_grants SET revoked_at=NULL WHERE id='grant:web'");
  assert.equal((await f.handler(request("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await f.handler(request())).status, 401);
  // A new upstream sign-in assertion is distinct; the revoked token itself never becomes usable again.
  assert.equal((await f.handler(request(undefined, undefined, undefined, undefined, token({ iat: now / 1000 - 30 })))).status, 200);
  await f.db.query("UPDATE control_identities SET state='suspended' WHERE id='identity:web'");
  assert.equal((await f.handler(request(undefined, undefined, undefined, undefined, token({ iat: now / 1000 - 30 })))).status, 403);
});
test("request shape, tenant boundaries and fixed public errors are enforced", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const body of [{ title: "", summary: "" }, { title: "x", summary: "", tenantId: "other" }, { title: "x", summary: "x".repeat(9000) }])
    assert.equal((await f.handler(request(undefined, "POST", body))).status, 400);
  assert.equal((await f.handler(request(undefined, undefined, undefined, undefined, token({ sub: "someone-else" })))).status, 403);
  const proof = createAccessVerifier(trust)(request(), now);
  await assert.rejects(() => new WebProjectService(f.client, { tenantId: "tenant:other", workspaceId: "workspace:web" }, () => now).list(proof), /access_denied/);
  await f.db.query("UPDATE control_role_grants SET project_ids='[\"project:one\"]'::jsonb WHERE id='grant:web'");
  assert.equal((await f.handler(request())).status, 403);
  assert.equal((await f.handler(request(undefined, "POST", { title: "x", summary: "" }))).status, 403);
});
test("simultaneous duplicate creates persist one project and expiry rolls a mutation back", async t => {
  let current = now;
  const f = await fixture(() => current); t.after(() => f.db.close());
  const responses = await Promise.all([1, 2, 3].map(() => f.handler(request(undefined, "POST", { title: "Concurrent", summary: "" }))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201]);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM projects")).rows[0].n, 1);
  const client = { ...f.client, transactionWithPreCommitCheck: <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) =>
    f.client.transactionWithPreCommitCheck(run, async () => { current = now + 301_000; await check(); }) };
  const service = new WebProjectService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => current);
  await assert.rejects(() => service.create(createAccessVerifier(trust)(request(), now), { title: "Expired", summary: "" }, "expired-create-0001"), /authentication_required/);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM projects")).rows[0].n, 1);
});
test("append-only command evidence is enforced by the migration", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.handler(request(undefined, "POST", { title: "Retained", summary: "" }));
  await assert.rejects(() => f.db.query("DELETE FROM control_web_project_commands"));
  await assert.rejects(() => f.db.query("TRUNCATE control_web_project_commands"));
});

test("project-specific read grants do not widen catalog or lifecycle access", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const created = await (await f.handler(request(undefined, "POST", { title: "Scoped", summary: "" }))).json();
  const id = created.project.projectId;
  await f.db.query("UPDATE control_role_grants SET allowed_actions='[\"projects.read\"]'::jsonb,project_ids=$1::jsonb WHERE id='grant:web'", [JSON.stringify([id])]);
  assert.equal((await f.handler(request(`/api/v1/projects/${encodeURIComponent(id)}`))).status, 200);
  assert.equal((await f.handler(request("/api/v1/projects/project:other"))).status, 403);
  assert.equal((await f.handler(request())).status, 403);
  assert.equal((await f.handler(request(`/api/v1/projects/${encodeURIComponent(id)}/lifecycle`, "POST", { lifecycle: "archived", expectedVersion: 1 }, "scope-mutation-0001"))).status, 403);
});

test("grant expiry during a save rolls back both the project and audit", async t => {
  let current = now;
  const f = await fixture(() => current); t.after(() => f.db.close());
  await f.db.query("UPDATE control_role_grants SET expires_at=$1 WHERE id='grant:web'", [new Date(now + 1000).toISOString()]);
  const client = { ...f.client, transactionWithPreCommitCheck: <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) =>
    f.client.transactionWithPreCommitCheck(run, async () => { current = now + 2000; await check(); }) };
  const service = new WebProjectService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => current);
  await assert.rejects(() => service.create(createAccessVerifier(trust)(request(), now), { title: "Expired grant", summary: "" }, "grant-expiry-0001"), /access_denied/);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM projects")).rows[0].n, 0);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events")).rows[0].n, 0);
});

for (const [label, change] of [
  ["identity suspension", "UPDATE control_identities SET state='suspended' WHERE id='identity:web'"],
  ["identity revocation", "UPDATE control_identities SET state='revoked' WHERE id='identity:web'"],
  ["grant revocation", "UPDATE control_role_grants SET revoked_at='2026-09-04T12:00:00Z' WHERE id='grant:web'"],
  ["grant expiry", "UPDATE control_role_grants SET expires_at='2026-09-04T12:00:00Z' WHERE id='grant:web'"],
  ["permission removal", "UPDATE control_role_grants SET allowed_actions='[]'::jsonb WHERE id='grant:web'"],
  ["project scope narrowing", "UPDATE control_role_grants SET project_ids='[\"project:one\"]'::jsonb WHERE id='grant:web'"],
  ["strong factor requirement", "UPDATE control_role_grants SET require_strong_factor=true WHERE id='grant:web'"],
]) {
  test(`exact-session logout remains available after ${label}`, async t => {
    const f = await fixture(); t.after(() => f.db.close());
    assert.equal((await f.handler(request())).status, 200);
    await f.db.query(change);
    assert.equal((await f.handler(request())).status, 403);
    assert.equal((await f.handler(request("/api/v1/session/logout", "POST"))).status, 204);
    assert.equal((await f.handler(request("/api/v1/session/logout", "POST"))).status, 204);
    await f.db.query("UPDATE control_identities SET state='active' WHERE id='identity:web'");
    await f.db.query("UPDATE control_role_grants SET revoked_at=NULL,expires_at=NULL,allowed_actions='[\"*\"]'::jsonb,project_ids='[\"*\"]'::jsonb,require_strong_factor=false WHERE id='grant:web'");
    assert.equal((await f.handler(request())).status, 401);
    assert.equal((await f.handler(request(undefined, undefined, undefined, undefined, token({ iat: now / 1000 - 30 })))).status, 200);
  });
}

test("manual lifecycle heads cannot disagree with their project's workspace", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const result = await f.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='control_manual_project_heads'");
  assert.equal(result.rows.some(row => row.column_name === "workspace_id"), false);
  await assert.rejects(() => f.db.query("INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at) VALUES('tenant:web','project:absent','active',1,now(),now())"));
});
