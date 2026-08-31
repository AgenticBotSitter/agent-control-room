import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectWorkspaceProtectedReadHandlerV1,
  GET,
} from "../app/api/v1/project-workspace/[projectId]/route.ts";
import type { ProjectWorkspaceProtectedRuntimeV1 } from "../app/project-workspace-protected-runtime.ts";
import { buildOperatorSurfaceSnapshotV1, OPERATOR_SURFACES_CONTRACT_V1 } from "../src/operator-surfaces/v1/index.ts";
import {
  ProjectWorkspaceContractErrorV1,
  type AuthorizedProjectWorkspaceReadScopeV1,
} from "../src/project-workspace/v1/index.ts";

const tenantId = "tenant.owner";
const workspaceId = "workspace.alpha";
const projectId = "project.alpha";
const digest = `sha256:${"a".repeat(64)}`;
const context = (id: string) => ({ params: Promise.resolve({ projectId: id }) });

function runtime(authorize: (input: { credential: unknown; projectId: string; now: string }) => Promise<AuthorizedProjectWorkspaceReadScopeV1>): ProjectWorkspaceProtectedRuntimeV1 {
  return {
    scopeAuthority: { authorize } as ProjectWorkspaceProtectedRuntimeV1["scopeAuthority"],
    readSource: {
      read: async ({ now }) => buildOperatorSurfaceSnapshotV1({
        contractVersion: OPERATOR_SURFACES_CONTRACT_V1,
        tenantId,
        generatedAt: now,
        fleet: [],
        bottlenecks: [],
        activeWork: [],
        portfolio: [{
          projectId,
          workflowCount: 1,
          activeJobCount: 0,
          waitingApprovalJobCount: 0,
          failedJobCount: 0,
          lastActivityAt: now,
        }],
        services: [],
        schedules: [],
        serviceIncidents: [],
        actionInbox: [],
        ownerFocus: [],
      }),
    },
  };
}

function validScope(now: string): AuthorizedProjectWorkspaceReadScopeV1 {
  return {
    tenantId,
    workspaceId,
    projectId,
    actorId: "identity.owner",
    grantedAt: now,
    expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    sessionDigest: digest,
    catalogId: "catalog.owner",
    catalogRevision: 1,
    catalogDigest: digest,
    catalogCheckpointDigest: digest,
  };
}

test("CR12A-PILOT-015 default endpoint is closed and ignores caller-supplied identity headers", async () => {
  const response = await GET(new Request(`http://localhost/api/v1/project-workspace/${projectId}`, {
    headers: {
      "oai-authenticated-user-id": "identity.owner",
      "x-control-room-tenant-id": tenantId,
      "x-control-room-workspace-id": workspaceId,
    },
  }), context(projectId));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "protected_identity_boundary_unavailable" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("CR12A-PILOT-015 configured endpoint authenticates before reading protected project data", async () => {
  let readCalls = 0;
  const configured = runtime(async () => { throw new ProjectWorkspaceContractErrorV1("authentication_required"); });
  const originalRead = configured.readSource.read;
  configured.readSource.read = async (input) => { readCalls += 1; return originalRead(input); };
  const response = await createProjectWorkspaceProtectedReadHandlerV1(configured)(
    new Request(`http://localhost/api/v1/project-workspace/${projectId}`), context(projectId),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
  assert.equal(readCalls, 0);
});

test("CR12A-PILOT-015 configured endpoint returns only the catalog-bound project", async () => {
  let credentialWasRequest = false;
  const handler = createProjectWorkspaceProtectedReadHandlerV1(runtime(async ({ credential, now }) => {
    credentialWasRequest = credential instanceof Request;
    return validScope(now);
  }));
  const response = await handler(new Request(`http://localhost/api/v1/project-workspace/${projectId}`), context(projectId));
  assert.equal(response.status, 200);
  const body = await response.json() as { model: { projectId: string; tenantId: string; workspaceId: string; grantsExecutionAuthority: boolean } };
  assert.deepEqual(
    [body.model.tenantId, body.model.workspaceId, body.model.projectId, body.model.grantsExecutionAuthority],
    [tenantId, workspaceId, projectId, false],
  );
  assert.equal(credentialWasRequest, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("CR12A-PILOT-015 configured endpoint safely maps missing, revoked, and forbidden projects", async () => {
  for (const [safeCode, status, error] of [
    ["not_found", 404, "project_not_found"],
    ["catalog_revoked", 404, "project_not_found"],
    ["policy_denied", 403, "project_read_forbidden"],
  ] as const) {
    const handler = createProjectWorkspaceProtectedReadHandlerV1(runtime(async () => {
      throw new ProjectWorkspaceContractErrorV1(safeCode);
    }));
    const response = await handler(new Request(`http://localhost/api/v1/project-workspace/${projectId}`), context(projectId));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
});

test("CR12A-PILOT-015 rejects malformed project paths before session or source access", async () => {
  let authorityCalls = 0;
  const handler = createProjectWorkspaceProtectedReadHandlerV1(runtime(async ({ now }) => {
    authorityCalls += 1;
    return validScope(now);
  }));
  const response = await handler(new Request("http://localhost/api/v1/project-workspace/bad"), context("../owner"));
  assert.equal(response.status, 404);
  assert.equal(authorityCalls, 0);
});
