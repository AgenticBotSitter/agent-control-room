import { SqliteBridgeJournal } from "../../src/node-bridge/journal";
import { sha256Digest } from "../../src/security/canonical-digest";

// Synthetic evidence only: this fixture exercises journal durability, not Git.
const journal = new SqliteBridgeJournal(process.argv[2]);
const boundary = process.argv[3];
if (!["intent", "creation", "removal", "removed"].includes(boundary)) throw new Error("invalid_boundary");
const runId = "run:crash-boundary";
const intent = { schema: "control-room.workspace-intent/v1", tenantId: "tenant:fixture",
  projectId: "project:fixture", nodeId: "node:fixture", jobId: "job:fixture",
  attemptId: "attempt:fixture", leaseId: "lease:fixture", leaseEpoch: 1, runId,
  repositoryRoot: "/fixture/repository", workspaceRoot: "/fixture/workspaces",
  checkoutPath: `/fixture/workspaces/codex-${sha256Digest(runId).slice(7, 31)}`, revision: "a".repeat(40) };
journal.reserveWorkspaceIntent(intent, () => {});
const digest = journal.workspaceIntentInventory()[0].intentDigest;
if (boundary !== "intent") journal.recordWorkspaceCreation(digest, {
  realPath: intent.checkoutPath, repositoryRealPath: intent.repositoryRoot,
  headRevision: intent.revision, device: "1", inode: "2",
}, () => {});
if (boundary === "removal" || boundary === "removed") journal.reserveWorkspaceRemoval(digest, () => {});
if (boundary === "removed") journal.recordWorkspaceRemoved(digest);
// Do not close/checkpoint the database. Parent kills this exact child after ack.
process.on("message", () => {});
process.send?.({ type: "boundary", boundary });
