import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import handler from "../dist-vps/server/index.js";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { sha256Digest } from "../src/security/index.ts";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session.ts";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process.ts";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap.ts";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance.ts";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("built Mac-local pages, owner navigation and their browser reads stay reachable", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "built-local-navigation" });
  t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const origin = "http://127.0.0.1:3210", ownerCode = "mac-local-owner-code-long-enough";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: fixture.configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: fixture.configuration.tenantId,
      provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }),
      sessionSeconds: 900 },
    database: { client: fixture.client, close: async () => {} }, clock: () => conformanceNow,
    workerReadiness: { read: () => [
      { kind: "hermes-021", state: "ready", proof: "not_proven" },
      { kind: "claude-code", state: "ready", proof: "not_proven" },
      { kind: "codex", state: "ready", proof: "not_proven" },
    ] }, taskWorkersStarted: true });
  installPrivateApplication(app);
  t.after(() => app.close());
  const send = (path, init = {}) => handler(new Request(`${origin}${path}`, init));
  const login = await send("/api/v1/local-owner-session", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
  assert.equal(login.status, 201);
  const cookie = login.headers.get("set-cookie"); assert.ok(cookie);
  const get = path => send(path, { headers: { cookie } });
  const post = (path, body, key) => send(path, { method: "POST", headers: {
    cookie, origin, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  const projectResponse = await post("/api/v1/projects", { title: "Built Mac project", summary: "Page navigation proof" },
    "built-local-project-001");
  assert.equal(projectResponse.status, 201);
  const { project } = await projectResponse.json();
  const projectId = encodeURIComponent(project.projectId);
  const taskResponse = await post(`/api/v1/projects/${projectId}/tasks`,
    { title: "Built Mac task", instructions: "Return a short safe answer" }, "built-local-task-001");
  assert.equal(taskResponse.status, 201);
  const { receipt } = await taskResponse.json();
  const taskId = encodeURIComponent(receipt.jobId);

  for (const path of ["/", "/projects", "/workers", `/projects/${projectId}`,
    `/projects/${projectId}/tasks`, `/projects/${projectId}/tasks/${taskId}`]) {
    const signedOut = await send(path);
    assert.equal(signedOut.status, 303, `signed-out ${path}`);
    assert.equal(new URL(signedOut.headers.get("location"), origin).href, `${origin}/session`);
  }
  const home = await get("/");
  assert.equal(home.status, 303);
  assert.equal(new URL(home.headers.get("location"), origin).href, `${origin}/projects`);

  const pages = ["/projects", ...["active", "paused", "completed", "archived"].map(lifecycle =>
    `/projects?lifecycle=${lifecycle}`), "/workers", `/projects/${projectId}`,
  `/projects/${projectId}/tasks`, `/projects/${projectId}/tasks/${taskId}`];
  const visited = new Set();
  const queue = [...pages];
  while (queue.length) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const response = await get(path);
    const html = await response.text();
    assert.equal(response.status, 200, `built page ${path}: ${html.slice(0, 500)}`);
    const document = new JSDOM(html).window.document;
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      if (!href?.startsWith("/") || href.startsWith("/_next/") || href === "/session") continue;
      const url = new URL(href, origin);
      if (url.pathname === "/") continue; // Root redirect is checked separately.
      if (!visited.has(url.pathname + url.search)) queue.push(url.pathname + url.search);
    }
  }
  assert.ok(visited.has("/workers"));
  assert.ok(visited.has(`/projects/${projectId}/tasks`));
  for (const path of ["/api/v1/local-workers", "/api/v1/projects", `/api/v1/projects/${projectId}`,
    `/api/v1/projects/${projectId}/tasks`, `/api/v1/projects/${projectId}/tasks/${taskId}`]) {
    const response = await get(path);
    assert.equal(response.status, 200, `browser fetch ${path}`);
  }
  // Mac-local pages must not advertise hosted-only navigation or call its APIs.
  for (const path of ["/setup", "/workboard", "/needs-me", "/settings", "/ideas", "/connections"])
    assert.equal(visited.has(path), false, `unsupported link ${path}`);
});
