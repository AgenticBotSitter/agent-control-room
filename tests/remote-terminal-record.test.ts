import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteTerminalRecordV1, remoteTerminalRecordSchemaV1 } from "../src/harness/v1/remote-terminal-record";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const base = {
  tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local",
  runId: "run:local", nodeId: "node:remote", workerId: "worker:remote",
  deliveryReceiptDigest: digest("a"), enrollmentDigest: digest("b"), terminalEvidenceDigest: digest("c"),
  outcome: "completed" as const, contentHash: digest("d"), sizeBytes: 42,
  startedAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:00:01.000Z",
};

test("a remote terminal record has a stable identity independent of a transport envelope", () => {
  const first = createRemoteTerminalRecordV1(base);
  const replay = createRemoteTerminalRecordV1({ ...base });
  assert.equal(replay.terminalIdentityDigest, first.terminalIdentityDigest);
  assert.equal(first.outcome, "completed");
  assert.equal(first.sizeBytes, 42);
});

test("a changed remote result or invalid time order cannot reuse a terminal identity", () => {
  const first = createRemoteTerminalRecordV1(base);
  const changed = createRemoteTerminalRecordV1({ ...base, contentHash: digest("e") });
  assert.notEqual(changed.terminalIdentityDigest, first.terminalIdentityDigest);
  assert.equal(remoteTerminalRecordSchemaV1.safeParse({ ...first, terminalIdentityDigest: changed.terminalIdentityDigest }).success, false);
  assert.throws(() => createRemoteTerminalRecordV1({ ...base, finishedAt: "2026-09-23T23:59:59.000Z" }), /time order/);
});
