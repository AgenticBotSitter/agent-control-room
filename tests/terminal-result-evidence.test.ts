import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import {
  projectCodexTerminalResultEvidenceV1,
  projectHermesTerminalResultEvidenceV1,
  terminalResultEvidenceSchemaV1,
} from "../src/harness/v1/terminal-result-evidence";

const digest = (value: string) => sha256Digest(value);
const lineage = { tenantId: "tenant:one", projectId: "project:one", jobId: "job:one",
  attemptId: "attempt:one", runId: "run:one", nodeId: "node:one" };
const text = "exact terminal result";
const contentHash = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const snapshot = {
  runId: lineage.runId, projectId: lineage.projectId, jobId: lineage.jobId, attemptId: lineage.attemptId,
  leaseId: "lease:one", leaseEpoch: 1, bindingDigest: digest("binding"), sessionKeyDigest: digest("session"),
  nativeRunKeyDigest: digest("native-run"), snapshotVersion: 4, observedAt: "2026-09-13T12:00:00.000Z",
  upstreamUpdatedAt: "2026-09-13T11:59:59.000Z", state: "completed", availability: "current",
  lastActivity: "message_progress", stopAttempted: false, safeReason: "none",
  result: { contentHash, sizeBytes: Buffer.byteLength(text) }, usage: null,
};
const expectedHermes = () => ({ lineage: structuredClone(lineage), registration: {
  leaseId: snapshot.leaseId, leaseEpoch: snapshot.leaseEpoch, bindingDigest: snapshot.bindingDigest,
  sessionKeyDigest: snapshot.sessionKeyDigest,
} });

function completedTurn() {
  const material = {
    schema: "control-room.codex-exact-package-completed-turn/v1" as const,
    threadId: "thread:one", turnId: "turn:one", itemId: "item:one", phase: "final_answer" as const,
    text, sizeBytes: Buffer.byteLength(text), contentHash, rawResultDigest: digest("raw"),
    matchedTurnDigest: digest("turn"), source: "exact_package_generated_schema" as const,
    selectedResultItemSchemaQualified: true as const, canonicalPublicationAllowed: false as const,
    completionVerified: false as const, grantsExecutionAuthority: false as const, permitsRetry: false as const,
    permitsResume: false as const, permitsThreadRead: false as const,
  };
  return { ...material, projectionDigest: sha256Digest(material) };
}

function changedCompletedTurn(overrides: Record<string, unknown>) {
  const { projectionDigest: _projectionDigest, ...base } = completedTurn();
  const material = { ...base, ...overrides };
  return { ...material, projectionDigest: sha256Digest(material) };
}

const codexInput = () => ({ lineage, identity: { runId: lineage.runId, threadId: "thread:one", turnId: "turn:one" },
  completedTurn: completedTurn(), qualificationDigest: digest("qualification"), observedAt: "2026-09-13T12:00:01.000Z" });

test("projects strict inert Hermes terminal evidence from the exact native snapshot identity", () => {
  const result = projectHermesTerminalResultEvidenceV1({ expected: expectedHermes(), snapshot });
  assert.equal(result.kind, "hermes_native_snapshot");
  assert.deepEqual(result.lineage, lineage);
  assert.equal(result.source.snapshotDigest, sha256Digest(snapshot));
  assert.deepEqual(result.content, snapshot.result);
  assert.equal(result.canonicalPublicationAllowed, false);
  assert.equal(result.grantsExecutionAuthority, false);
  assert.equal(result.qualityAccepted, false);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.source)); assert.ok(Object.isFrozen(result.lineage));
  assert.deepEqual(terminalResultEvidenceSchemaV1.parse(result), result);
});

test("binds exact Codex identity, result and qualification digests without authorizing publication", () => {
  const input = codexInput(), result = projectCodexTerminalResultEvidenceV1(input);
  assert.equal(result.kind, "codex_exact_completed_turn");
  assert.equal(result.source.threadId, input.identity.threadId);
  assert.equal(result.source.turnId, input.identity.turnId);
  assert.equal(result.source.itemId, input.completedTurn.itemId);
  assert.equal(result.source.projectionDigest, input.completedTurn.projectionDigest);
  assert.equal(result.source.qualificationDigest, input.qualificationDigest);
  assert.deepEqual(result.content, { contentHash, sizeBytes: Buffer.byteLength(text) });
  assert.equal(result.canonicalPublicationAllowed, false);
  assert.equal(result.completionRecorded, false);
  assert.equal(result.grantsExecutionAuthority, false);
});

test("refuses cross-variant and unknown fields", () => {
  assert.throws(() => projectHermesTerminalResultEvidenceV1({ expected: expectedHermes(), snapshot,
    qualificationDigest: digest("wrong-variant") }), /terminal_result_evidence_unavailable/);
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(),
    snapshot }), /terminal_result_evidence_unavailable/);
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(), unknown: true }),
    /terminal_result_evidence_unavailable/);
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({
    ...projectHermesTerminalResultEvidenceV1({ expected: expectedHermes(), snapshot }), threadId: "thread:cross",
  }));
});

test("refuses mismatched identities and altered digest or byte claims", () => {
  assert.throws(() => projectHermesTerminalResultEvidenceV1({ expected: { ...expectedHermes(),
    lineage: { ...lineage, runId: "run:other" } }, snapshot }),
    /terminal_result_evidence_unavailable/);
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(),
    identity: { ...codexInput().identity, threadId: "thread:other" } }), /terminal_result_evidence_unavailable/);
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(),
    completedTurn: { ...completedTurn(), projectionDigest: digest("altered") } }), /terminal_result_evidence_unavailable/);
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(),
    completedTurn: changedCompletedTurn({ sizeBytes: Buffer.byteLength(text) + 1 }) }), /terminal_result_evidence_unavailable/);
  const evidence = projectCodexTerminalResultEvidenceV1(codexInput());
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...evidence,
    evidenceDigest: digest("tampered-evidence") }));
});

test("refuses invalid terminal states and unsafe Hermes evidence", () => {
  for (const changed of [
    { ...snapshot, state: "running", result: null },
    { ...snapshot, availability: "offline" },
    { ...snapshot, safeReason: "run_unavailable" },
    { ...snapshot, nativeRunKeyDigest: null },
  ]) assert.throws(() => projectHermesTerminalResultEvidenceV1({ expected: expectedHermes(), snapshot: changed }),
    /terminal_result_evidence_unavailable/);
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(), completedTurn: {
    ...completedTurn(), completionVerified: true,
  } }), /terminal_result_evidence_unavailable/);
});

test("refuses every mismatched Hermes registration and snapshot lineage field", () => {
  const changes = [
    { ...snapshot, runId: "run:other" },
    { ...snapshot, projectId: "project:other" },
    { ...snapshot, jobId: "job:other" },
    { ...snapshot, attemptId: "attempt:other" },
    { ...snapshot, leaseId: "lease:other" },
    { ...snapshot, leaseEpoch: 2 },
    { ...snapshot, bindingDigest: digest("other-binding") },
    { ...snapshot, sessionKeyDigest: digest("other-session") },
  ];
  for (const changed of changes) assert.throws(() => projectHermesTerminalResultEvidenceV1({
    expected: expectedHermes(), snapshot: changed,
  }), /terminal_result_evidence_unavailable/);
});

test("refuses Codex commentary and malformed Unicode even when their self-digests match", () => {
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(),
    completedTurn: changedCompletedTurn({ phase: "commentary" }) }), /terminal_result_evidence_unavailable/);
  const malformed = "\ud800", bytes = Buffer.from(malformed, "utf8");
  assert.throws(() => projectCodexTerminalResultEvidenceV1({ ...codexInput(), completedTurn: changedCompletedTurn({
    text: malformed, sizeBytes: bytes.byteLength,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  }) }), /terminal_result_evidence_unavailable/);
});

test("captures inputs and deeply freezes both variants against mutation", () => {
  const hermesInput = { expected: expectedHermes(), snapshot: structuredClone(snapshot) };
  const codex = codexInput();
  const hermesResult = projectHermesTerminalResultEvidenceV1(hermesInput);
  const codexResult = projectCodexTerminalResultEvidenceV1(codex);
  hermesInput.expected.lineage.runId = "run:mutated";
  codex.identity.threadId = "thread:mutated";
  assert.equal(hermesResult.lineage.runId, lineage.runId);
  assert.equal(codexResult.source.threadId, "thread:one");
  assert.throws(() => { (hermesResult.source as { snapshotVersion: number }).snapshotVersion = 9; }, TypeError);
  assert.throws(() => { (codexResult.content as { sizeBytes: number }).sizeBytes = 1; }, TypeError);
});
