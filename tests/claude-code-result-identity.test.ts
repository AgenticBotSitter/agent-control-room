import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { sha256Digest } from "../src/security/canonical-digest";
import { connectorOperationNamesV1 } from "../src/harness/v1/connector-profile";
import { claudeCodeConnectorProfileV1 } from "../src/harness/claude-code-v1/connector-profile";
import {
  bindClaudeCodeResultIdentityV1,
  CLAUDE_CODE_RESULT_IDENTITY_SCHEMA_V1,
} from "../src/harness/claude-code-v1/result-identity";
import {
  claudeCodeOperationRefusalsV1,
  refuseClaudeCodeOperationV1,
} from "../src/harness/claude-code-v1/unsupported-operations";
import { CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1,
  type ClaudeCodeSessionDispositionV1 } from "../src/harness/claude-code-v1/owned-process-session";
import { decodeClaudeCodeStreamJsonLinesV1, type ClaudeCodeInitFrameV1,
  type ClaudeCodeResultFrameV1 } from "../src/harness/claude-code-v1/stream-json-decode";

// All identities below are synthetic placeholders authored for this test.
const SESSION = "00000000-0000-4000-8000-00000000cd01";
const TEXT = "placeholder final answer";

const lineage = Object.freeze({
  tenantId: "tenant.placeholder",
  projectId: "project.placeholder",
  jobId: "job.placeholder",
  attemptId: "attempt.placeholder.0001",
  runId: "run.placeholder.0001",
  nodeId: "node.placeholder",
});

function disposition(overrides: Partial<ClaudeCodeSessionDispositionV1> = {}): ClaudeCodeSessionDispositionV1 {
  return Object.freeze({
    schema: CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1,
    processAttemptId: "attempt.process.0001",
    runId: lineage.runId,
    attemptId: lineage.attemptId,
    closed: true,
    cleanupUncertain: false,
    exitObserved: true,
    exitMalformed: false,
    terminalResultConfirmed: true,
    resubmissionSafe: false,
    reasonCode: "closed_with_decoded_terminal_result",
    grantsExecutionAuthority: false,
    canonicalPublicationAllowed: false,
    permitsRetry: false,
    permitsResume: false,
    ...overrides,
  }) as ClaudeCodeSessionDispositionV1;
}

function decoded(resultOverrides: Record<string, unknown> = {}) {
  const frames = decodeClaudeCodeStreamJsonLinesV1([
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: SESSION,
      result: TEXT, ...resultOverrides }),
  ]);
  assert.equal(frames[0].kind, "init");
  assert.equal(frames[1].kind, "result");
  return { init: frames[0] as ClaudeCodeInitFrameV1, result: frames[1] as ClaudeCodeResultFrameV1 };
}

const bind = (input: Partial<Parameters<typeof bindClaudeCodeResultIdentityV1>[0]> = {}) => {
  const frames = decoded();
  return bindClaudeCodeResultIdentityV1({
    lineage, expectedSessionId: SESSION, init: frames.init, result: frames.result,
    disposition: disposition(), assistantInlineErrorObserved: false,
    observedAt: "2026-09-13T12:00:00.000Z", ...input,
  });
};

test("a decoded stream binds to the supplied run identity with a verifiable digest", () => {
  const identity = bind();
  assert.equal(identity.schema, CLAUDE_CODE_RESULT_IDENTITY_SCHEMA_V1);
  assert.deepEqual({ ...identity.lineage }, { ...lineage });
  assert.equal(identity.terminalState, "completed");
  assert.equal(identity.source.sessionId, SESSION);
  assert.equal(identity.content?.sizeBytes, Buffer.byteLength(TEXT, "utf8"));
  assert.equal(identity.content?.contentHash,
    `sha256:${createHash("sha256").update(Buffer.from(TEXT, "utf8")).digest("hex")}`);
  const { identityDigest, ...material } = identity;
  assert.equal(identityDigest, sha256Digest(material));
  assert.equal(Object.isFrozen(identity), true);
  assert.equal(Object.isFrozen(identity.source), true);
});

test("the bound record stays inert in every direction", () => {
  const identity = bind();
  assert.equal(identity.canonicalPublicationAllowed, false);
  assert.equal(identity.qualityAccepted, false);
  assert.equal(identity.completionRecorded, false);
  assert.equal(identity.grantsExecutionAuthority, false);
  assert.equal(identity.permitsRetry, false);
  assert.equal(identity.permitsResume, false);
});

test("a success subtype with is_error true binds as a failed terminal state", () => {
  const frames = decoded({ subtype: "success", is_error: true });
  const identity = bind({ init: frames.init, result: frames.result });
  assert.equal(identity.source.reportedSubtype, "success");
  assert.equal(identity.terminalState, "failed");
  assert.equal(identity.source.isError, true);
});

test("session identity, lineage and disposition must all agree", () => {
  const frames = decoded();
  const cases: Array<Partial<Parameters<typeof bindClaudeCodeResultIdentityV1>[0]>> = [
    { expectedSessionId: "00000000-0000-4000-8000-00000000cd99" },
    { lineage: { ...lineage, runId: "run.placeholder.0002" } },
    { disposition: disposition({ runId: "run.placeholder.0002" }) },
    { disposition: disposition({ attemptId: "attempt.placeholder.0002" }) },
    { disposition: disposition({ closed: false }) },
    { disposition: disposition({ terminalResultConfirmed: false }) },
    { observedAt: "2026-09-13T12:00:00Z" },
    { init: frames.result as unknown as ClaudeCodeInitFrameV1 },
  ];
  for (const override of cases) {
    assert.throws(() => bind(override), /claude_code_result_identity_unavailable/, JSON.stringify(override));
  }
});

test("an uncertain cleanup is recorded on the bound record rather than hidden", () => {
  const identity = bind({ disposition: disposition({ cleanupUncertain: true }) });
  assert.equal(identity.source.cleanupUncertain, true);
  assert.equal(identity.permitsRetry, false);
  assert.equal(identity.permitsResume, false);
});

test("a successful terminal frame with no result text is refused", () => {
  const frames = decodeClaudeCodeStreamJsonLinesV1([
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: SESSION }),
  ]);
  assert.throws(() => bind({
    init: frames[0] as ClaudeCodeInitFrameV1, result: frames[1] as ClaudeCodeResultFrameV1,
  }), /claude_code_result_identity_unavailable/);
});

test("every profile operation refuses explicitly with the profile's own reason code", () => {
  const refusals = claudeCodeOperationRefusalsV1();
  for (const name of connectorOperationNamesV1) {
    const refusal = refusals[name];
    assert.equal(refusal.operation, name);
    assert.equal(refusal.refused, true);
    assert.equal(refusal.attempted, false);
    assert.equal(refusal.status, "unsupported");
    assert.equal(refusal.reasonCode, claudeCodeConnectorProfileV1.operations[name].reasonCode);
    assert.equal(refusal.evidence, claudeCodeConnectorProfileV1.operations[name].evidence);
    assert.equal(refusal.grantsExecutionAuthority, false);
    assert.equal(Object.isFrozen(refusal), true);
  }
});

test("an unknown operation name cannot be refused silently", () => {
  for (const name of ["", "publish", 7, null, undefined]) {
    assert.throws(() => refuseClaudeCodeOperationV1(name), /claude_code_operation_refusal_unavailable/);
  }
});
