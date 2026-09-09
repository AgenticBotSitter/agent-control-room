import assert from "node:assert/strict";
import test from "node:test";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { readNativeRestartInventory } from "../src/harness/hermes-native-v1/restart-inventory";
import { sha256Digest } from "../src/security/canonical-digest";
import { createLeaseAwareNativeNodeRuntime } from "../src/harness/hermes-native-v1/node-runtime";
import { enrollment } from "./hermes-native-fixture";

test("restart inventory includes unresolved workspace evidence without private paths or new authority", () => {
  const journal = new SqliteBridgeJournal(":memory:");
  const runId = "run:workspace-restart";
  const intent = { schema: "control-room.workspace-intent/v1", tenantId: "tenant:fixture", nodeId: "node:fixture",
    projectId: "project:fixture", jobId: "job:fixture", attemptId: "attempt:fixture", leaseId: "lease:fixture", leaseEpoch: 1,
    runId, repositoryRoot: "/private-fixture/repo", workspaceRoot: "/private-fixture/work",
    checkoutPath: `/private-fixture/work/codex-${sha256Digest(runId).slice(7,31)}`, revision: "a".repeat(40) };
  const scope = { tenantId: intent.tenantId, nodeId: intent.nodeId };
  const deps = { bridge: journal, runs: { inventory: () => [], load: () => undefined },
    effects: { countActive: () => 0, confirmation: () => undefined },
    executions: { load: () => undefined, events: () => [] } };
  const read = () => readNativeRestartInventory(scope, deps, new AbortController().signal);
  try {
    assert.equal(read().status, "no_unresolved_local_work");
    journal.reserveWorkspaceIntent(intent, () => {});
    const result = read();
    assert.equal(result.status, "reconciliation_required");
    assert.equal(result.pendingWorkspaces.length, 1);
    assert.equal(result.pendingWorkspaces[0].reason, "workspace_without_delivery");
    assert.equal(result.grantsExecutionAuthority, false);
    assert.equal(result.permitsFreshPickup, false);
    assert.equal(result.currentCleanupVerified, false);
    // Deliberately incomplete post-gate resources: startup must refuse before
    // resolving keys, configuring transport or composing any native executor.
    let securityReads = 0;
    const startupDeps = { journal, runs: deps.runs, local: { effects: deps.effects, executions: deps.executions }, recovery: {},
      security: new Proxy({}, { get: () => { securityReads++; throw new Error("unexpected_security_access"); } }) };
    assert.throws(() => createLeaseAwareNativeNodeRuntime({ assignment: "queue",
      enrollment: { ...enrollment, ...scope }, nodeKeyId: "key:fixture", serverId: "server:fixture",
      serverKeyId: "key:server", serverPublicKeySpki: "synthetic-not-a-real-key" },
      {} as Parameters<typeof createLeaseAwareNativeNodeRuntime>[1],
      startupDeps as unknown as Parameters<typeof createLeaseAwareNativeNodeRuntime>[2]), /native_node_restart_reconciliation_required/);
    assert.equal(securityReads, 0);
    assert.equal(JSON.stringify(journal.nativeRestartInventory()).includes("/private-fixture"), false);
    assert.equal(JSON.stringify(result).includes("/private-fixture"), false);
    const delivery = { queueId: "queue:fixture", tenantId: intent.tenantId, nodeId: intent.nodeId,
      projectId: intent.projectId, jobId: intent.jobId, attemptId: intent.attemptId, leaseId: intent.leaseId,
      leaseEpoch: intent.leaseEpoch, runId, bindingDigest: sha256Digest("synthetic-binding"), deliveryDigest: sha256Digest("synthetic-delivery") };
    const withDelivery = (overrides: Partial<typeof delivery> = {}) => ({ ...deps, bridge: {
      nativeRestartInventory: () => ({ ...journal.nativeRestartInventory(), deliveries: [{ ...delivery, ...overrides }] }),
    } });
    assert.equal(readNativeRestartInventory(scope, withDelivery(), new AbortController().signal).pendingWorkspaces[0].reason,
      "workspace_reconciliation_required");
    for (const mismatch of [{ projectId: "project:other" }, { jobId: "job:other" }, { leaseEpoch: 2 }, { runId: "run:other" }])
      assert.throws(() => readNativeRestartInventory(scope, withDelivery(mismatch), new AbortController().signal), /inventory_unavailable/);
    assert.throws(() => readNativeRestartInventory({ ...scope, nodeId: "node:other" }, deps, new AbortController().signal), /inventory_unavailable/);
    const digest = sha256Digest(intent);
    journal.recordWorkspaceCreation(digest, { realPath: intent.checkoutPath, repositoryRealPath: intent.repositoryRoot,
      headRevision: intent.revision, device: "1", inode: "2" }, () => {});
    journal.reserveWorkspaceRemoval(digest, () => {});
    assert.equal(read().status, "reconciliation_required");
    let sweeps = 0;
    assert.throws(() => readNativeRestartInventory(scope, { ...deps, bridge: { nativeRestartInventory: () => {
      if (++sweeps === 2) journal.recordWorkspaceRemoved(digest);
      return journal.nativeRestartInventory();
    } } }, new AbortController().signal), /inventory_unavailable/);
    const removed = read();
    assert.equal(removed.status, "no_unresolved_local_work");
    assert.equal(removed.permitsFreshPickup, false);
    assert.equal(removed.currentCleanupVerified, false);
    assert.equal(journal.nativeRestartInventory().workspaces[0].state, "historically_removed");
  } finally { journal.close(); }
});
