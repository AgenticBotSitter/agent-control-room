import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import {
  projectCodexTerminalResultEvidenceV1,
  projectHermesTerminalResultEvidenceV1,
  projectUpstreamHermesSessionResultEvidenceV1,
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

/* ------------------------------------------------------------------ */
/* Upstream Hermes session result evidence                              */
/* ------------------------------------------------------------------ */

const upstreamReplyDigest = (overrides: Record<string, unknown>) => {
  const { response: _response, ...base } = upstreamReply(overrides);
  return sha256Digest(base);
};

function upstreamReply(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    job_id: "0123456789abcdef0123456789abcdef",
    session_id: "session:one",
    status: "completed",
    return_code: 0,
    response: "exact upstream terminal result",
    truncated: false,
    ...overrides,
  };
}

const upstreamConnectorProfileDigest = digest("upstream-profile");
const upstreamResponseText = "exact upstream terminal result";
const upstreamResponseBytes = Buffer.from(upstreamResponseText, "utf8");
const upstreamResponseContentHash = `sha256:${createHash("sha256").update(upstreamResponseBytes).digest("hex")}`;
const upstreamResponseSizeBytes = upstreamResponseBytes.byteLength;

function upstreamInput(overrides: Record<string, unknown> = {}) {
  return {
    lineage,
    retained: {
      connectorProfileDigest: upstreamConnectorProfileDigest,
      upstreamSessionId: "session:one",
      upstreamJobId: "0123456789abcdef0123456789abcdef",
    },
    outcome: upstreamReply(),
    upstreamCeilingTruncated: false,
    observedAt: "2026-09-15T12:00:00.000Z",
    claimedContentHash: upstreamResponseContentHash,
    claimedSizeBytes: upstreamResponseSizeBytes,
    ...overrides,
  };
}

test("projects strict inert upstream Hermes session result evidence without authorizing publication", () => {
  const input = upstreamInput();
  const result = projectUpstreamHermesSessionResultEvidenceV1(input);
  assert.equal(result.kind, "upstream_hermes_session_result");
  assert.deepEqual(result.lineage, lineage);
  assert.equal(result.terminalState, "completed");
  assert.equal(result.source.upstreamSessionId, input.retained.upstreamSessionId);
  assert.equal(result.source.upstreamJobId, input.retained.upstreamJobId);
  assert.equal(result.source.connectorProfileDigest, upstreamConnectorProfileDigest);
  assert.equal(result.source.upstreamReplyDigest, upstreamReplyDigest({}));
  const expectedBytes = Buffer.from(input.outcome.response, "utf8");
  assert.equal(result.content.sizeBytes, expectedBytes.byteLength);
  assert.equal(result.content.contentHash, `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`);
  assert.equal(result.canonicalPublicationAllowed, false);
  assert.equal(result.qualityAccepted, false);
  assert.equal(result.completionRecorded, false);
  assert.equal(result.grantsExecutionAuthority, false);
  assert.equal(result.permitsRetry, false);
  assert.equal(result.permitsResume, false);
  assert.deepEqual(terminalResultEvidenceSchemaV1.parse(result), result);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.source));
  assert.ok(Object.isFrozen(result.lineage));
});

test("upstream Hermes projection is deterministic on exact replay and accepts both truncation flags independently", () => {
  const first = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput());
  const replay = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput());
  assert.deepEqual(replay, first);
  // Both flags are independent: a truncated upstream response with a
  // separately-applied ceiling flag preserves both facts.
  const truncated = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ truncated: true }),
    upstreamCeilingTruncated: true,
  }));
  assert.equal(truncated.source.upstreamTruncated, true);
  assert.equal(truncated.source.upstreamCeilingTruncated, true);
  // A non-truncated reply defaults the ceiling flag to false when omitted.
  const plain = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({ upstreamCeilingTruncated: undefined }));
  assert.equal(plain.source.upstreamTruncated, false);
  assert.equal(plain.source.upstreamCeilingTruncated, false);
});

test("refuses upstream Hermes evidence for mismatched upstream identity and tampered digests", () => {
  // Wrong upstream job id (forged reply under the right session).
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    retained: { connectorProfileDigest: upstreamConnectorProfileDigest,
      upstreamSessionId: "session:one", upstreamJobId: "fedcba9876543210fedcba9876543210" },
  })), /terminal_result_evidence_unavailable/);
  // Wrong upstream session id (job id matches, session does not).
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ session_id: "session:other" }),
  })), /terminal_result_evidence_unavailable/);
  // Tampered evidence digest.
  const baseline = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput());
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...baseline,
    evidenceDigest: digest("tampered-evidence") }), /terminal result evidence digest mismatch/);
  // Mismatched upstream reply digest: a reply whose status/return_code/
  // truncated fields were silently changed after projection would still have
  // the wrong upstreamReplyDigest. The projection recomputes it from the
  // reply material, so a tampered reply produces a distinct evidence
  // digest and cannot collide with the original.
  const fresh = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ truncated: true, return_code: 1 }),
  }));
  assert.equal(fresh.source.upstreamReplyDigest, upstreamReplyDigest({ truncated: true, return_code: 1 }));
  assert.notEqual(fresh.evidenceDigest, baseline.evidenceDigest);
});

test("refuses upstream Hermes evidence for non-completed, refusal envelopes, empty/whitespace text, malformed Unicode and forged shape", () => {
  // The projection refuses every non-completed terminal state before
  // publication: failed, running, starting, timed_out, orphaned, pending.
  for (const status of ["failed", "running", "starting", "timed_out", "orphaned", "pending"]) {
    assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
      outcome: upstreamReply({ status }),
    })), /terminal_result_evidence_unavailable/);
  }
  // Refusal envelopes (success:false) are rejected without coercing.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: { success: false, error: "refused", layer: "session_control", code: "JOB_NOT_FOUND",
      safe_message: "Job not found", suggested_action: "check" },
  })), /terminal_result_evidence_unavailable/);
  // Empty response text fails closed; the publisher cannot accept below floor.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ response: "" }),
  })), /terminal_result_evidence_unavailable/);
  // Whitespace-only text also fails closed.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ response: "   \n   " }),
  })), /terminal_result_evidence_unavailable/);
  // Malformed Unicode fails closed even when its self-digest would match.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ response: "\ud800" }),
  })), /terminal_result_evidence_unavailable/);
  // An unknown extra outcome field is refused (no silent coercion).
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: { ...upstreamReply(), phantom: "field" },
  })), /terminal_result_evidence_unavailable/);
  // Cross-variant inputs (Codex / Hermes-native snapshots) are rejected.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1({
    ...upstreamInput(),
    snapshot,
  }), /terminal_result_evidence_unavailable/);
  // A `text`-only shape that looks like the runtime outcome is NOT accepted
  // by the projection; the projection requires the exact upstream reply.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1({
    lineage, retained: { connectorProfileDigest: upstreamConnectorProfileDigest,
      upstreamSessionId: "session:one", upstreamJobId: "0123456789abcdef0123456789abcdef" },
    outcome: { kind: "completed", text: "exact upstream terminal result" },
  }), /terminal_result_evidence_unavailable/);
});

test("upstream Hermes projection refuses responses whose claimed content hash or size disagrees with the recomputed text", () => {
  // Changed-text substitution with a retained old digest: the runtime
  // claims the original digest but the actual response text differs.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ response: "forged different text" }),
    claimedContentHash: upstreamResponseContentHash,
    claimedSizeBytes: upstreamResponseSizeBytes,
  })), /terminal_result_evidence_unavailable/);
  // Retained old size with a tampered response: the runtime claims the
  // original byte length but the actual UTF-8 length differs.
  const longerText = "exact upstream terminal result (longer)";
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    outcome: upstreamReply({ response: longerText }),
    claimedContentHash: upstreamResponseContentHash,
    claimedSizeBytes: upstreamResponseSizeBytes,
  })), /terminal_result_evidence_unavailable/);
  // Same response but a fabricated hash: the runtime claims a digest that
  // does not match the bytes. The projection recomputes and refuses.
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(upstreamInput({
    claimedContentHash: digest("fabricated"),
    claimedSizeBytes: upstreamResponseSizeBytes,
  })), /terminal_result_evidence_unavailable/);
  // A response with the matching recomputed hash/size is accepted: the
  // claim is consistent with the bytes.
  const baseline = projectUpstreamHermesSessionResultEvidenceV1(upstreamInput());
  assert.equal(baseline.evidenceDigest.length > 0, true);
});

test("upstream Hermes projection rejects inputs whose observedAt is missing or malformed", () => {
  // The projection refuses to invent a wall-clock value. A replay that
  // omits observedAt cannot produce byte-identical evidence to one that
  // supplies it; we require the caller to pin it explicitly.
  const { observedAt: _omit, ...rest } = upstreamInput();
  assert.throws(() => projectUpstreamHermesSessionResultEvidenceV1(rest),
    /terminal_result_evidence_unavailable/);
});

test("upstream Hermes projection is order-independent across rebuilds and deeply freezes the result", () => {
  const input = upstreamInput();
  const before = projectUpstreamHermesSessionResultEvidenceV1(input);
  // Mutate the retained binding; the frozen result must not change.
  (input.retained as { connectorProfileDigest: string }).connectorProfileDigest = digest("other");
  (input.outcome as { response: string }).response = "tampered-after-projection";
  assert.equal(before.source.connectorProfileDigest, upstreamConnectorProfileDigest);
  assert.equal(before.content.sizeBytes, Buffer.byteLength("exact upstream terminal result"));
  // Deep freeze guards against post-projection mutation.
  assert.throws(() => { (before.source as { upstreamTruncated: boolean }).upstreamTruncated = true; }, TypeError);
  assert.throws(() => { (before.content as { sizeBytes: number }).sizeBytes = 0; }, TypeError);
});
