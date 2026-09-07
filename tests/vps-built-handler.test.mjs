import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { fixture, now, origin, trust, request } from "./helpers/web-foundation.ts";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project.ts";
import { seedWebConnection, seedWebSignal, webConnectionKeys } from "./helpers/web-connection.ts";

test("compiled Node entry protects pages, APIs and streams before application composition", async () => {
  assert.equal(typeof handler, "function");
  for (const path of ["/", "/ideas", "/connections", "/api/v1/connections", "/api/v1/projects", "/api/v1/operator-surface", "/api/v1/projects/project:test/events"]) {
    const response = await handler(new Request(`https://private.example.invalid${path}`));
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: "private_app_not_configured" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
test("Node client/SSR artifacts are separate from Sites metadata", () => {
  assert.equal(existsSync("dist-vps/server/ssr/index.js"), true);
  assert.ok(readdirSync("dist-vps/client/_next/static").length > 0);
  assert.equal(existsSync("dist-vps/.openai/hosting.json"), false);
});

test("compiled private routes use the installed process, real disposable SQL, and shared revocation", async t => {
  const f = await fixture();
  const { project: idea } = await seedWebIdea(f.client);
  await seedWebConnection(f.client); await seedWebSignal(f.client);
  const app = installPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    ideaProjects: { integrityKey: webIdeaKey },
    connections: webConnectionKeys,
    database: { client: f.client, close: () => f.db.close() }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  assert.throws(() => installPrivateWebProcess({}), /already_configured/);
  const created = await handler(request(undefined, "POST", { title: "Compiled project", summary: "From the actual built API" }));
  assert.equal(created.status, 201); const { project } = await created.json();
  const catalog = await handler(request("/projects")); assert.equal(catalog.status, 200);
  const catalogHtml = await catalog.text();
  // The creation form waits for the authenticated catalog's canCreate result, not just a rendered shell.
  assert.match(catalogHtml, /Loading projects/); assert.doesNotMatch(catalogHtml, /<form/);
  // The client shell must wait for the authenticated catalog read before showing records.
  assert.equal(catalogHtml.includes(project.title), false);
  const path = `/projects/${encodeURIComponent(project.projectId)}`;
  const taskPath = `/api/v1/projects/${encodeURIComponent(project.projectId)}/tasks`;
  const taskSaved = await handler(request(taskPath, "POST", { title: "Compiled task", instructions: "Produce a useful comparison" }, "compiled-task-save-001"));
  assert.equal(taskSaved.status, 201); const { receipt: taskReceipt } = await taskSaved.json();
  const taskPage = await handler(request(`${path}/tasks`)); assert.equal(taskPage.status, 200);
  assert.match(await taskPage.text(), /Loading protected tasks/);
  const taskDetailPage = await handler(request(`${path}/tasks/${encodeURIComponent(taskReceipt.jobId)}`));
  assert.equal(taskDetailPage.status, 200); assert.match(await taskDetailPage.text(), /Task progress · Control Room/);
  const taskRead = await (await handler(request(`${taskPath}/${encodeURIComponent(taskReceipt.jobId)}`))).json();
  assert.equal(taskRead.task.title, "Compiled task"); assert.equal(taskRead.task.state, "proposed"); assert.equal(taskRead.review, "not_connected");
  const detail = await handler(request(`${path}/settings`)); assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Loading project/);
  const read = await handler(request(`/api/v1/projects/${encodeURIComponent(project.projectId)}`));
  assert.equal((await read.json()).project.title, "Compiled project");
  const combined = await (await handler(request())).json();
  assert.equal(combined.projects.length, 2); assert.equal(combined.sources.ideas, "included");
  const ideaRead = await (await handler(request(`/api/v1/projects/${encodeURIComponent(idea.projectId)}`))).json();
  assert.equal(ideaRead.project.origin, "idea_lab"); assert.equal(ideaRead.project.lifecycleEditable, false);
  const ideaPage = await handler(request(`/projects/${encodeURIComponent(idea.projectId)}/settings`));
  assert.equal(ideaPage.status, 200); assert.match(await ideaPage.text(), /Loading project/);
  const nextPage = await handler(request(`/projects?after=${encodeURIComponent(idea.projectId)}`));
  assert.equal(nextPage.status, 200); assert.match(await nextPage.text(), /Loading projects/);
  const nextRead = await (await handler(request(`/api/v1/projects?after=${encodeURIComponent(idea.projectId)}`))).json();
  assert.ok(nextRead.projects.every(item => item.projectId > idea.projectId));
  const archive = await handler(request(`/api/v1/projects/${encodeURIComponent(project.projectId)}/lifecycle`, "POST",
    { lifecycle: "archived", expectedVersion: 1 }, "compiled-archive-0001"));
  assert.equal(archive.status, 200);
  const connectionsPage = await handler(request("/connections")); assert.equal(connectionsPage.status, 200);
  const connectionsHtml = await connectionsPage.text(); assert.match(connectionsHtml, /Loading protected connection inventory/);
  assert.match(connectionsHtml, /<title>Connections · Control Room<\/title>/);
  assert.match(connectionsHtml, /Private connection inventory across all workspaces/);
  assert.match(connectionsHtml, /covers all workspaces in this Control Room account/);
  assert.match(connectionsHtml, /not a live fleet monitor/); assert.doesNotMatch(connectionsHtml, /node:private-test|connection:private-test/);
  const inventory = await (await handler(request("/api/v1/connections"))).json();
  assert.equal(inventory.projection.summary.connectionCount, 1); assert.equal(inventory.projection.summary.currentSignalCount, 1);
  assert.equal(inventory.projection.summary.livePanelEligibleCount, 0); assert.equal(inventory.telemetry, "configured");
  for (const legacy of ["/ideas", "/api/v1/fixture-snapshot", "/api/v1/local-pilot/session", "/api/v1/connections/enroll"])
    assert.equal((await handler(request(legacy))).status, 404, legacy);
  const stream = await handler(request(`/api/v1/projects/${encodeURIComponent(project.projectId)}/events`));
  assert.match(await stream.text(), /project-snapshot/);
  const session = await handler(request("/session")); assert.equal(session.status, 200);
  assert.match(await session.text(), /Access sessions for other protected applications/);
  assert.equal((await handler(request("/api/v1/session/logout", "POST"))).status, 204);
  for (const protectedPath of ["/projects", "/connections", "/api/v1/connections", path, `/projects/${encodeURIComponent(idea.projectId)}`,
    taskPath, `${path}/tasks`, `${path}/tasks/${encodeURIComponent(taskReceipt.jobId)}`,
    `/api/v1/projects/${encodeURIComponent(idea.projectId)}/events`, `/api/v1/projects/${encodeURIComponent(project.projectId)}/events`])
    assert.equal((await handler(request(protectedPath))).status, 401, protectedPath);
  await app.close(); assert.equal((await handler(request("/projects"))).status, 503);
});
