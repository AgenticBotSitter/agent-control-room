import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProtectedProjectWorkspaceReadPanel } from "../app/components/protected-project-workspace-read.tsx";
import { fetchProjectWorkspaceReadModelV1, ProjectWorkspaceReadServiceV1, type ProjectWorkspaceOperatorReadSourceV1 } from "../src/project-workspace/v1/index.ts";
import { buildOperatorSurfaceSnapshotV1, OPERATOR_SURFACES_CONTRACT_V1 } from "../src/operator-surfaces/v1/index.ts";

const now = "2026-08-31T18:00:00.000Z";
const identity = { tenantId: "tenant.owner", workspaceId: "workspace.alpha", projectId: "project.alpha" };
const boundDigest = `sha256:${"a".repeat(64)}`;

async function model() {
  const source: ProjectWorkspaceOperatorReadSourceV1 = { read: async () => buildOperatorSurfaceSnapshotV1({
    contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: identity.tenantId, generatedAt: now,
    fleet: [], bottlenecks: [], activeWork: [], services: [], schedules: [], serviceIncidents: [], actionInbox: [], ownerFocus: [],
    portfolio: [{ projectId: identity.projectId, workflowCount: 1, activeJobCount: 0, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: now }],
  }) };
  const result = await new ProjectWorkspaceReadServiceV1(source, [identity]).read({ scope: {
    ...identity, actorId: "actor.owner", grantedAt: now, expiresAt: "2026-08-31T18:01:00.000Z",
    sessionDigest: boundDigest, catalogId: "catalog.owner", catalogRevision: 1,
    catalogDigest: boundDigest, catalogCheckpointDigest: boundDigest,
  }, now });
  assert.equal(result.state, "available");
  if (result.state !== "available") throw new Error("model unavailable");
  return result.model;
}

test("CR12A protected panel keeps loading and unavailable states honest", () => {
  const loading = renderToStaticMarkup(<ProtectedProjectWorkspaceReadPanel data={{ state: "loading" }} sectionId="overview" />);
  assert.match(loading, /Protected project read is loading/);
  assert.match(loading, /fixture content remains separately labelled/i);
  const unavailable = renderToStaticMarkup(<ProtectedProjectWorkspaceReadPanel data={{ state: "unavailable", code: "authentication_required" }} sectionId="work" />);
  assert.match(unavailable, /Authentication Required/);
  assert.match(unavailable, /No fixture record is being presented as protected truth/);
});

test("CR12A protected panel renders current project facts without operational controls", async () => {
  const html = renderToStaticMarkup(<ProtectedProjectWorkspaceReadPanel data={{ state: "available", model: await model() }} sectionId="work" />);
  assert.match(html, /Protected project read/);
  assert.match(html, /Current/);
  assert.match(html, /0 active protected jobs/);
  assert.doesNotMatch(html, /<button|Approve now|Run now/i);
});

test("CR12A protected HTTP reader validates scope, status, body, and digest", async () => {
  const value = await model();
  const available = await fetchProjectWorkspaceReadModelV1(identity.projectId, async () => Response.json({ model: value }));
  assert.equal(available.state, "available");
  assert.deepEqual(await fetchProjectWorkspaceReadModelV1(identity.projectId, async () => new Response(null, { status: 401 })), { state: "unavailable", code: "authentication_required" });
  assert.deepEqual(await fetchProjectWorkspaceReadModelV1(identity.projectId, async () => new Response(null, { status: 403 })), { state: "unavailable", code: "project_read_forbidden" });
  assert.deepEqual(await fetchProjectWorkspaceReadModelV1(identity.projectId, async () => new Response(null, { status: 404 })), { state: "unavailable", code: "project_not_found" });
  assert.deepEqual(await fetchProjectWorkspaceReadModelV1(identity.projectId, async () => Response.json({ model: { ...value, projectId: "project.foreign" } })), { state: "unavailable", code: "invalid_response" });
  assert.deepEqual(await fetchProjectWorkspaceReadModelV1(identity.projectId, async () => Response.json({ model: value, hiddenAuthority: true })), { state: "unavailable", code: "invalid_response" });
  assert.deepEqual(await fetchProjectWorkspaceReadModelV1("../foreign", async () => Response.json({ model: value })), { state: "unavailable", code: "invalid_response" });
});
