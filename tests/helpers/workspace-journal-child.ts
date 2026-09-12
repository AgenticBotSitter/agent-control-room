import { SqliteBridgeJournal } from "../../src/node-bridge/journal";
import { sha256Digest } from "../../src/security/canonical-digest";
// Parent-created disposable database only. No workspace or Git operations.
const journal = new SqliteBridgeJournal(process.argv[2]);
process.send?.({ type: "ready" });
process.once("message", message => {
  try {
    if (message !== "reserve") throw new Error("invalid_fixture_message");
    const runId = "run:two-processes";
    const result = journal.reserveWorkspaceIntent({ schema: "control-room.workspace-intent/v1",
      tenantId: "tenant:fixture", projectId: "project:fixture", nodeId: "node:fixture",
      jobId: "job:fixture", attemptId: "attempt:fixture", leaseId: "lease:fixture", leaseEpoch: 1, runId,
      repositoryRoot: "/fixture/repository", workspaceRoot: "/fixture/workspaces",
      checkoutPath: `/fixture/workspaces/codex-${sha256Digest(runId).slice(7,31)}`, revision: "a".repeat(40),
    }, () => {});
    process.send?.({ type: "result", result });
  } finally { journal.close(); process.disconnect?.(); }
});
