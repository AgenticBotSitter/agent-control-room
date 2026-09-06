import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier.ts";
import { createProjectHttpHandler } from "../src/web/v1/project-http.ts";
import { WebProjectService } from "../src/web/v1/project-service.ts";
import { createPrivateWebProcess } from "../src/web/v1/private-process.ts";
import { projectCatalogPageSchema } from "../src/web/v1/project-wire.ts";
import { fixture, now, trust, origin, request } from "./helpers/web-foundation.ts";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project.ts";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const proof = () => createAccessVerifier(trust)(request(), now);
async function setup() {
  const f = await fixture();
  const idea = await seedWebIdea(f.client);
  const service = new WebProjectService(f.client, scope, () => now, webIdeaKey);
  const handler = createProjectHttpHandler({ origin, trust, service, clock: () => now });
  return { ...f, ...idea, service, handler };
}

test("one catalog and detail read use real ordinary rows and authenticated Idea history without copying it", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.service.create(proof(), { title: "Ordinary", summary: "" }, "shared-create-0001");
  const page = projectCatalogPageSchema.parse(await (await f.handler(request())).json());
  assert.equal(page.projects.length, 2); assert.equal(page.nextCursor, null);
  assert.deepEqual(page.sources, { ordinary: "included", ideas: "included" }); assert.equal(page.canCreate, true);
  const idea = page.projects.find(p => p.origin === "idea_lab")!;
  assert.equal(idea.projectId, f.project.projectId); assert.equal(idea.lifecycleEditable, false);
  assert.equal(idea.title, f.project.title); assert.equal(idea.version, 1);
  assert.equal((await f.handler(request(`/api/v1/projects/${encodeURIComponent(idea.projectId)}`))).status, 200);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int n FROM control_manual_project_heads")).rows[0].n, 1);
  const before = await f.store.getProject("tenant:web", idea.projectId);
  // Ordinary commands never adopt an Idea record, even if a forged manual head is present.
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:web',$1,'active',1,$2,$2)`, [idea.projectId, new Date(now).toISOString()]);
  const mutation = await f.handler(request(`/api/v1/projects/${encodeURIComponent(idea.projectId)}/lifecycle`, "POST",
    { lifecycle: "archived", expectedVersion: 1 }, "idea-denied-write-0001"));
  assert.ok([400, 404].includes(mutation.status));
  assert.deepEqual(await f.store.getProject("tenant:web", idea.projectId), before);
  const colon = await seedWebIdea(f.client, { projectId: "project:idea-colon" });
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:web',$1,'active',1,$2,$2)`, [colon.project.projectId, new Date(now).toISOString()]);
  assert.equal((await f.handler(request(`/api/v1/projects/${encodeURIComponent(colon.project.projectId)}/lifecycle`, "POST",
    { lifecycle: "archived", expectedVersion: 1 }, "idea-colon-denied-0001"))).status, 404);
  assert.equal((await f.store.getProject("tenant:web", colon.project.projectId))!.version, 1);
});

test("operator permissions cannot reveal Idea records and owner Idea-only access cannot reveal ordinary records", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const ordinary = await f.service.create(proof(), { title: "Ordinary", summary: "" }, "access-create-0001");
  await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
  let page = await f.service.listPage(proof());
  assert.equal(page.projects.length, 1); assert.equal(page.sources.ideas, "not_authorized");
  await assert.rejects(f.service.getView(proof(), f.project.projectId), /not_found/);
  await f.db.query(`UPDATE control_role_grants SET role_key='owner',allowed_actions='["idea_lab.project_read"]'::jsonb WHERE id='grant:web'`);
  page = await f.service.listPage(proof());
  assert.equal(page.projects.length, 1); assert.equal(page.projects[0].origin, "idea_lab");
  assert.equal(page.sources.ordinary, "not_authorized"); assert.equal(page.canCreate, false);
  await assert.rejects(f.service.getView(proof(), ordinary.project.projectId), /not_found/);
  await f.db.query("UPDATE control_role_grants SET project_ids=$1::jsonb WHERE id='grant:web'", [JSON.stringify([f.project.projectId])]);
  assert.equal((await f.service.getView(proof(), f.project.projectId)).origin, "idea_lab");
  await assert.rejects(f.service.listPage(proof()), /access_denied/);
});

test("mixed keyset pagination crosses 200 records without omissions or duplicates and binds each page to current access", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const { project: template } = await f.service.create(proof(), { title: "Template", summary: "" }, "many-create-0001");
  await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    SELECT 'project:page-'||lpad(n::text,4,'0'),tenant_id,workspace_id,adapter_id,'project:page-'||lpad(n::text,4,'0'),
      source_version,title,description,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at
    FROM projects CROSS JOIN generate_series(1,209) n WHERE id=$1`, [template.projectId]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    SELECT tenant_id,id,'active',1,updated_at,updated_at FROM projects WHERE id LIKE 'project:page-%'`);
  const seen: string[] = []; let after: string | undefined; let pages = 0;
  do {
    const page = await f.service.listPage(proof(), after);
    assert.ok(page.projects.length <= 50); seen.push(...page.projects.map(p => p.projectId));
    after = page.nextCursor ?? undefined; pages++;
  } while (after);
  assert.equal(pages, 5); assert.equal(seen.length, 211); assert.equal(new Set(seen).size, 211);
  assert.deepEqual(seen, [...seen].sort()); assert.ok(seen.includes(f.project.projectId));
  const first = await f.service.listPage(proof());
  await f.db.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
  await assert.rejects(f.service.listPage(proof(), first.nextCursor!), /access_denied/);
});

test("workspace selection excludes other Idea records and wrong or absent integrity keys never invent an empty result", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:other','tenant:web','Other')");
  const other = await seedWebIdea(f.client, { workspaceId: "workspace:other", projectId: "project.idea:other" });
  assert.equal((await f.service.listPage(proof())).projects.length, 1);
  await assert.rejects(f.service.getView(proof(), other.project.projectId), /not_found/);
  const absent = new WebProjectService(f.client, scope, () => now);
  assert.equal((await absent.listPage(proof())).sources.ideas, "not_configured");
  await assert.rejects(absent.getView(proof(), f.project.projectId), /not_configured/);
  const wrong = new WebProjectService(f.client, scope, () => now, new Uint8Array(32).fill(0x64));
  await assert.rejects(wrong.listPage(proof()), /integrity_failed/);
  await assert.rejects(wrong.getView(proof(), f.project.projectId), /integrity_failed/);
});

test("Idea snapshot inconsistencies return fixed unavailable responses instead of unauthenticated data", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.db.query("UPDATE projects SET title='Changed outside the registry' WHERE id=$1", [f.project.projectId]);
  for (const path of ["/api/v1/projects", `/api/v1/projects/${encodeURIComponent(f.project.projectId)}`]) {
    const response = await f.handler(request(path));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }
});

test("existing Idea lifecycle changes appear in the shared read view without changing its event history", async t => {
  const f = await setup(); t.after(() => f.db.close());
  for (const [index, toState] of (["completed", "archived", "active"] as const).entries()) {
    await f.store.transitionProject({ tenantId: "tenant:web", projectId: f.project.projectId, expectedVersion: index + 1,
      toState, actorIdentityDigest: f.decision.ownerIdentityDigest, safeReasonCode: "test_owner_transition", occurredAt: new Date(now + index).toISOString() });
    const view = await f.service.getView(proof(), f.project.projectId);
    assert.equal(view.lifecycle, toState); assert.equal(view.version, index + 2);
    assert.equal((await f.service.listPage(proof())).projects[0].lifecycle, toState);
  }
  assert.equal((await f.store.listProjectLifecycleEvents("tenant:web", f.project.projectId)).length, 4);
});

test("Idea page/API/snapshot share session revocation and reject unsupported catalog query parameters", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, ideaProjects: { integrityKey: webIdeaKey },
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close()); const render = () => new Response("private shell");
  const id = encodeURIComponent(f.project.projectId);
  const paths = [`/projects/${id}`, `/projects/${id}/settings`, `/api/v1/projects/${id}`, `/api/v1/projects/${id}/events`];
  for (const path of paths) assert.equal((await app.handle(request(path), render)).status, 200);
  for (const query of ["after=", "after=a&after=b", "tenantId=other", "after=..%2Fescape", "limit=1000"])
    for (const path of ["/projects", "/api/v1/projects"])
      assert.equal((await app.handle(request(`${path}?${query}`), render)).status, 400);
  await app.handle(request("/api/v1/session/logout", "POST"), render);
  for (const path of paths) assert.equal((await app.handle(request(path), render)).status, 401);
});

test("Idea read permission expiry is rechecked before the shared transaction commits", async t => {
  let current = now; const f = await setup(); t.after(() => f.db.close());
  await f.db.query("UPDATE control_role_grants SET expires_at=$1 WHERE id='grant:web'", [new Date(now + 1000).toISOString()]);
  const client = { ...f.client, transactionWithPreCommitCheck: <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) =>
    f.client.transactionWithPreCommitCheck(run, async () => { current = now + 2000; await check(); }) };
  const service = new WebProjectService(client, scope, () => current, webIdeaKey);
  await assert.rejects(service.getView(proof(), f.project.projectId), /access_denied/);
  current = now; await assert.rejects(service.listPage(proof()), /access_denied/);
});

test("hidden Idea and ordinary IDs are indistinguishable from absent IDs across API, HTML and finite snapshots", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const ordinary = await f.service.create(proof(), { title: "Private ordinary", summary: "" }, "hidden-source-create-0001");
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, ideaProjects: { integrityKey: webIdeaKey },
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close()); let renders = 0;
  const render = () => { renders++; return new Response("private shell"); };
  for (const mode of ["ordinary_reader", "idea_reader", "no_read_access"] as const) {
    const role = mode === "ordinary_reader" ? "operator" : "owner";
    const actions = mode === "ordinary_reader" ? ["*"] : mode === "idea_reader" ? ["idea_lab.project_read"] : [];
    await f.db.query("UPDATE control_role_grants SET role_key=$1,allowed_actions=$2::jsonb WHERE id='grant:web'", [role, JSON.stringify(actions)]);
    const hidden = mode === "idea_reader" ? ordinary.project.projectId : f.project.projectId;
    for (const [prefix, suffix, html] of [["/api/v1/projects/", "", false], ["/projects/", "", true],
      ["/projects/", "/settings", true], ["/api/v1/projects/", "/events", false]] as const) {
      const capture = async (id: string) => {
        const input = request(`${prefix}${encodeURIComponent(id)}${suffix}`);
        if (html) input.headers.set("accept", "text/html");
        const response = await app.handle(input, render);
        return { status: response.status, headers: [...response.headers], body: await response.text() };
      };
      const missing = await capture("project:absent");
      assert.equal(missing.status, mode === "no_read_access" ? 403 : 404);
      assert.deepEqual(await capture(hidden), missing);
    }
  }
  assert.equal(renders, 0);
});
