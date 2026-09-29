import assert from "node:assert/strict";
import test, { after } from "node:test";
import { buildProjectEventPageV1, type ProjectEventReadRequestV1 } from "../src/project-events/v1";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceOrigin,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("B-093 activity HTTP is owner-only, project-scoped, and resumes from Last-Event-ID", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "activity-http" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const reads: ProjectEventReadRequestV1[] = []; let mismatch = false;
  const app = createPrivateWebProcess({ origin: conformanceOrigin, issuer: fixture.trust.issuer,
    audience: fixture.trust.audience, tenantId: fixture.configuration.tenantId,
    workspaceId: fixture.configuration.workspaceId, maxSessionSeconds: fixture.trust.maxSessionSeconds,
    loadKeys: async () => fixture.trust.keys, database: { client: fixture.client, close: async () => {} },
    clock: () => conformanceNow, projectEvents: { async read(request) { reads.push(request);
      return buildProjectEventPageV1({ tenantId: request.tenantId, workspaceId: request.workspaceId,
        projectId: mismatch ? "project:wrong-scope" : request.projectId, mode: request.afterCursor ? "replay" : "snapshot",
        events: [], nextCursor: request.afterCursor ?? null, hasMore: false, truncatedBefore: false });
    } } });
  t.after(() => app.close());
  const auth = { "cf-access-jwt-assertion": fixture.assertion };
  const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`${conformanceOrigin}${path}`, init),
    () => new Response("shell"));
  const created = await call("/api/v1/projects", { method: "POST", headers: { ...auth, origin: conformanceOrigin,
    "content-type": "application/json", "idempotency-key": "activity-http-project-001" },
    body: JSON.stringify({ title: "Activity HTTP project", summary: "Owner-only timeline proof" }) });
  assert.equal(created.status, 201, await created.clone().text());
  const projectId = (await created.json() as { project: { projectId: string } }).project.projectId;

  const snapshot = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/activity?limit=25`, { headers: auth });
  assert.equal(snapshot.status, 200); assert.equal((await snapshot.json() as { page: { projectId: string } }).page.projectId, projectId);
  assert.deepEqual(reads.at(-1), { tenantId: fixture.configuration.tenantId, workspaceId: fixture.configuration.workspaceId,
    projectId, limit: 25 });

  const stream = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/events?after=query-cursor-value&limit=25`, {
    headers: { ...auth, "last-event-id": "newer-browser-cursor" },
  });
  assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(reads.at(-1)?.afterCursor, "newer-browser-cursor", "native reconnect cursor takes precedence over initial seed query");

  mismatch = true;
  const wrongScope = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/activity?limit=25`, { headers: auth });
  assert.equal(wrongScope.status, 503); assert.doesNotMatch(await wrongScope.text(), /project:wrong-scope/);
  mismatch = false;

  await fixture.client.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1 AND id=$2",
    [fixture.configuration.tenantId, fixture.configuration.grantId]);
  const ordinaryProjectRead = await call(`/api/v1/projects/${encodeURIComponent(projectId)}`, { headers: auth });
  assert.equal(ordinaryProjectRead.status, 200, "operator still has the general project read used by other pages");
  const beforeDeniedReadCount = reads.length;
  const denied = await call(`/api/v1/projects/${encodeURIComponent(projectId)}/activity?limit=25`, { headers: auth });
  assert.equal(denied.status, 403); assert.equal(reads.length, beforeDeniedReadCount, "denial happens before the event source is read");
});
