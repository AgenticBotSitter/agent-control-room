import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_WORKSPACE_CORE_SECTIONS_V1,
  ProjectWorkspaceContractErrorV1,
  buildProjectWorkspaceSnapshotV1,
  parseProjectWorkspaceSnapshotV1,
} from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const now = "2026-08-29T19:30:00.000Z";

function input() {
  return {
    snapshotId: "snapshot.project.workspace.test",
    tenantId: "tenant.owner",
    workspaceId: "workspace.test",
    projectId: "project.test",
    adapterId: "adapter.test.v1",
    projectType: "test-project",
    title: "Test project",
    summary: "A safe synthetic project workspace projection.",
    authorityMode: "advisory" as const,
    generatedAt: now,
    extensionSections: [{ sectionId: "daily-brief", extensionKind: "daily_brief", label: "Daily Brief", itemCount: 2 }],
    sourceStatuses: [{ sourceId: "source.synthetic", sourceKind: "fixture", label: "Synthetic source", mode: "synthetic" as const, state: "available" as const, safeStatusCode: "synthetic_fixture", checkedAt: now, lastSuccessfulAt: now, itemCount: 2, grantsNetworkAuthority: false as const }],
    activeItemCount: 2,
    waitingReviewCount: 1,
    failedItemCount: 0,
    snapshotHighWaterDigest: sha256Digest({ highWater: 1 }),
  };
}

function expectCode(action: () => unknown, code: ProjectWorkspaceContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === code);
}

test("CR9D project workspace fixes the shared owner navigation and carries no authority", () => {
  const snapshot = buildProjectWorkspaceSnapshotV1(input());
  assert.deepEqual(parseProjectWorkspaceSnapshotV1(snapshot), snapshot);
  assert.deepEqual(snapshot.sections.slice(0, 9).map(({ sectionId, kind, label }) => ({ sectionId, kind, label })), PROJECT_WORKSPACE_CORE_SECTIONS_V1);
  assert.equal(snapshot.sections[9]?.extensionKind, "daily_brief");
  assert.deepEqual({ presentationOnly: snapshot.presentationOnly, approval: snapshot.grantsApproval, network: snapshot.grantsNetworkAuthority, command: snapshot.grantsCommandAuthority, lease: snapshot.grantsLeaseAuthority, execution: snapshot.grantsExecutionAuthority }, { presentationOnly: true, approval: false, network: false, command: false, lease: false, execution: false });
});

test("CR9D project extension sections cannot replace core sections or duplicate one another", () => {
  expectCode(() => buildProjectWorkspaceSnapshotV1({ ...input(), extensionSections: [{ sectionId: "work", extensionKind: "replacement", label: "Different work" }] }), "invalid_input");
  expectCode(() => buildProjectWorkspaceSnapshotV1({ ...input(), extensionSections: [{ sectionId: "custom", extensionKind: "one", label: "One" }, { sectionId: "custom", extensionKind: "two", label: "Two" }] }), "invalid_input");
});

test("CR9D snapshot digest and negative authority flags fail closed", () => {
  const snapshot = buildProjectWorkspaceSnapshotV1(input());
  expectCode(() => parseProjectWorkspaceSnapshotV1({ ...snapshot, title: "Changed" }), "digest_mismatch");
  expectCode(() => parseProjectWorkspaceSnapshotV1({ ...snapshot, grantsCommandAuthority: true }), "invalid_input");
  expectCode(() => parseProjectWorkspaceSnapshotV1({ ...snapshot, sections: snapshot.sections.map((section, index) => index === 0 ? { ...section, position: 1 } : section) }), "digest_mismatch");
});

test("CR9D source status is honest about mode, freshness, and network authority", () => {
  expectCode(() => buildProjectWorkspaceSnapshotV1({ ...input(), sourceStatuses: [{ ...input().sourceStatuses[0], checkedAt: undefined }] }), "invalid_input");
  expectCode(() => buildProjectWorkspaceSnapshotV1({ ...input(), sourceStatuses: [{ ...input().sourceStatuses[0], grantsNetworkAuthority: true }] }), "invalid_input");
  expectCode(() => buildProjectWorkspaceSnapshotV1({ ...input(), sourceStatuses: [input().sourceStatuses[0], input().sourceStatuses[0]] }), "invalid_input");
});

test("CR9D exact boundary rejects accessors and proxies without executing traps", () => {
  let getterCalls = 0;
  const accessor = { ...input() } as Record<string, unknown>;
  Object.defineProperty(accessor, "title", { enumerable: true, get() { getterCalls += 1; return "unsafe"; } });
  expectCode(() => buildProjectWorkspaceSnapshotV1(accessor), "invalid_input");
  assert.equal(getterCalls, 0);
  const proxied = observedProxy(input(), "transparent");
  expectCode(() => buildProjectWorkspaceSnapshotV1(proxied.value), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
});

test("CR9D workspace rejects secret-like projection content", () => {
  expectCode(() => buildProjectWorkspaceSnapshotV1({ ...input(), summary: "api_key=unsafe-value-123" }), "redaction_rejected");
});
