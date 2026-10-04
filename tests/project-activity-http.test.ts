import assert from "node:assert/strict";
import test, { after } from "node:test";
import { buildProjectEventPageV1, ProjectEventErrorV1, ProjectEventStoreV1, TaskProjectEventWriterV1,
  type ProjectEventReadRequestV1 } from "../src/project-events/v1";
import { sha256Digest } from "../src/security";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceOrigin,
  privateOwnerBootstrapFixture, syntheticAssertion } from "./helpers/private-owner-bootstrap-conformance";

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
  const eventStore = new ProjectEventStoreV1(fixture.client, new Uint8Array(32).fill(41),
    () => new Date(conformanceNow).toISOString());
  await fixture.client.transaction(tx => new TaskProjectEventWriterV1(eventStore).appendInSession(tx, {
    tenantId: fixture.configuration.tenantId, workspaceId: fixture.configuration.workspaceId, projectId,
    subjectId: "job:owner-isolation", action: "task_created", sourceId: "job:owner-isolation",
    sourceVersion: "owner-isolation-v1", occurredAt: new Date(conformanceNow).toISOString(),
  }));

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

  const otherTenant = "tenant:activity-http-other-owner", otherWorkspace = "workspace:activity-http-other-owner";
  const otherIdentity = "identity:activity-http-other-owner", otherSubject = "other-owner@example.invalid";
  const instant = new Date(conformanceNow).toISOString();
  await fixture.client.query("INSERT INTO tenants(id,display_name) VALUES($1,'Other tenant')", [otherTenant]);
  await fixture.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Other workspace')",
    [otherWorkspace, otherTenant]);
  await fixture.client.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Other owner',$3,$4,'active',$5,$5)`,
  [otherIdentity, otherTenant, fixture.trust.issuer, sha256Digest({ provider: fixture.trust.issuer, subject: otherSubject }), instant]);
  await fixture.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:activity-http-other-owner',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
  [otherTenant, otherIdentity, instant]);
  const otherAssertion = syntheticAssertion(fixture.key, { sub: otherSubject, email: otherSubject });
  await assert.rejects(eventStore.read({ tenantId: otherTenant, workspaceId: otherWorkspace, projectId, limit: 25 }),
    (error: unknown) => error instanceof ProjectEventErrorV1 && error.safeCode === "project_not_found");
  const otherApp = createPrivateWebProcess({ origin: conformanceOrigin, issuer: fixture.trust.issuer,
    audience: fixture.trust.audience, tenantId: otherTenant,
    workspaceId: otherWorkspace, maxSessionSeconds: fixture.trust.maxSessionSeconds,
    loadKeys: async () => fixture.trust.keys, database: { client: fixture.client, close: async () => {} },
    clock: () => conformanceNow, projectEvents: { async read() { throw new ProjectEventErrorV1("project_not_found"); } } });
  t.after(() => otherApp.close());
  const foreign = await otherApp.handle(new Request(
    `${conformanceOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/activity?limit=25`,
    { headers: { "cf-access-jwt-assertion": otherAssertion } }), () => new Response("shell"));
  const foreignBody = await foreign.text();
  assert.equal(foreign.status, 404, foreignBody); assert.doesNotMatch(foreignBody, /Task created|owner-isolation/,
    "another owner cannot read lifecycle event content");
});
