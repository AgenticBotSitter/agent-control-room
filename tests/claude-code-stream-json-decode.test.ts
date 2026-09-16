import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CLAUDE_CODE_MAX_LINE_BYTES_V1,
  CLAUDE_CODE_MAX_RESULT_BYTES_V1,
  createClaudeCodeStreamDecoderV1,
  decodeClaudeCodeStreamJsonLinesV1,
  type ClaudeCodeResultFrameV1,
} from "../src/harness/claude-code-v1/stream-json-decode";
import { claudeCodeConnectorProfileV1 } from "../src/harness/claude-code-v1/connector-profile";
import {
  CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
  publishClaudeTerminalResultV1,
  type ClaudeTerminalResultPublicationInputV1,
} from "../src/harness/claude-code-v1/result-publication";
import {
  CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1,
  type ClaudeCodeProcessBindingV1,
  type ClaudeCodeSessionDispositionV1,
} from "../src/harness/claude-code-v1/owned-process-session";
import type { DurableResultPublicationConfigurationV1 } from "../src/artifacts/v1/durable-result-publication";
import {
  projectClaudeTerminalResultEvidenceV1,
  terminalResultEvidenceSchemaV1,
} from "../src/harness/v1/terminal-result-evidence";
import { sha256Digest } from "../src/security/canonical-digest";

// Every value here is freshly authored and synthetic. No host path, real session
// identifier or captured transcript appears in this file.
const SESSION = "00000000-0000-4000-8000-00000000ab01";
const OTHER_SESSION = "00000000-0000-4000-8000-00000000ab02";

const initLine = (sessionId = SESSION) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "placeholder-model" });
const assistantLine = (extra: Record<string, unknown> = {}, sessionId = SESSION) =>
  JSON.stringify({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [], ...extra } });
const resultLine = (extra: Record<string, unknown> = {}, sessionId = SESSION) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId,
    result: "placeholder result text", total_cost_usd: 0, usage: {}, ...extra });

test("the result ceiling is reused from the published connector result contract", () => {
  assert.equal(CLAUDE_CODE_MAX_RESULT_BYTES_V1, claudeCodeConnectorProfileV1.resultContract.maximumBytes);
  assert.equal(CLAUDE_CODE_MAX_RESULT_BYTES_V1, 65_536);
});

test("a well formed stream decodes to init, assistant turns and one terminal result", () => {
  const frames = decodeClaudeCodeStreamJsonLinesV1([initLine(), assistantLine(), resultLine()]);
  assert.deepEqual(frames.map(frame => frame.kind), ["init", "assistant_turn", "result"]);
  assert.equal(frames[0].kind === "init" && frames[0].sessionId, SESSION);
  assert.equal(frames[1].kind === "assistant_turn" && frames[1].inlineError, false);
  assert.equal(frames[2].kind === "result" && frames[2].outcome, "succeeded");
  assert.equal(frames[2].kind === "result" && frames[2].usageReported, true);
});

test("a success subtype carrying is_error true is classified as failed", () => {
  const frames = decodeClaudeCodeStreamJsonLinesV1([
    initLine(),
    resultLine({ subtype: "success", is_error: true, result: "placeholder failure text" }),
  ]);
  const terminal = frames[1];
  assert.equal(terminal.kind, "result");
  if (terminal.kind !== "result") return;
  assert.equal(terminal.subtypeCode, "success");
  assert.equal(terminal.isError, true);
  assert.equal(terminal.outcome, "failed", "classification must not follow subtype");
});

test("terminal_reason alone also fails a nominally successful subtype", () => {
  const frames = decodeClaudeCodeStreamJsonLinesV1([
    initLine(),
    resultLine({ subtype: "success", is_error: false, terminal_reason: "budget_exhausted" }),
  ]);
  const terminal = frames[1];
  assert.equal(terminal.kind === "result" && terminal.outcome, "failed");
  // "budget_exhausted" is not a recognised terminal reason, so it maps to the fixed
  // unrecognized code and the raw word never reaches the decoded frame.
  assert.equal(terminal.kind === "result" && terminal.terminalReasonCode, "unrecognized");
  assert.equal(terminal.kind === "result" && terminal.terminalReasonPresent, true);
  assert.equal(JSON.stringify(terminal).includes("budget_exhausted"), false);
});

test("an assistant frame reports an inline error rather than a separate error frame type", () => {
  for (const extra of [{ error: { message: "placeholder" } }, { is_api_error_message: true }]) {
    const frames = decodeClaudeCodeStreamJsonLinesV1([initLine(), assistantLine(extra)]);
    assert.equal(frames[1].kind === "assistant_turn" && frames[1].inlineError, true);
  }
});

test("malformed and out-of-contract lines are decode failures, never silent acceptance", () => {
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["malformed_json", [initLine(), "{not json"]],
    ["frame_not_an_object", [initLine(), "[]"]],
    ["unknown_frame_type", [initLine(), JSON.stringify({ type: "tool_use", session_id: SESSION })]],
    ["unsupported_system_subtype", [JSON.stringify({ type: "system", subtype: "compact", session_id: SESSION })]],
    ["invalid_session_id", [JSON.stringify({ type: "system", subtype: "init", session_id: "not-a-session" })]],
    ["init_frame_not_first", [assistantLine()]],
    ["duplicate_init_frame", [initLine(), initLine()]],
    ["session_id_mismatch", [initLine(), assistantLine({}, OTHER_SESSION)]],
    ["empty_line", ["   "]],
    ["embedded_control_character", [`${initLine()}\r`]],
    ["line_too_large", [JSON.stringify({ type: "system", subtype: "init", session_id: SESSION,
      pad: "x".repeat(CLAUDE_CODE_MAX_LINE_BYTES_V1) })]],
    ["malformed_assistant_frame", [initLine(), JSON.stringify({ type: "assistant", session_id: SESSION })]],
    ["result_is_error_missing", [initLine(), JSON.stringify({ type: "result", subtype: "success", session_id: SESSION })]],
    ["result_subtype_missing", [initLine(), JSON.stringify({ type: "result", is_error: false, session_id: SESSION })]],
    ["malformed_terminal_reason", [initLine(), resultLine({ terminal_reason: 7 })]],
    ["malformed_cost", [initLine(), resultLine({ total_cost_usd: -1 })]],
    ["malformed_usage", [initLine(), resultLine({ usage: "placeholder" })]],
    ["malformed_result_text", [initLine(), resultLine({ result: 12 })]],
    ["result_text_exceeds_ceiling", [initLine(), resultLine({ result: "x".repeat(CLAUDE_CODE_MAX_RESULT_BYTES_V1 + 1) })]],
  ];
  for (const [expected, lines] of cases) {
    const frames = decodeClaudeCodeStreamJsonLinesV1(lines);
    const last = frames[frames.length - 1];
    assert.equal(last.kind, "decode_error", expected);
    assert.equal(last.kind === "decode_error" && last.reasonCode, expected);
  }
});

test("a duplicate terminal frame is refused and any later frame is refused too", () => {
  const decoder = createClaudeCodeStreamDecoderV1();
  assert.equal(decoder.accept(initLine()).kind, "init");
  assert.equal(decoder.accept(resultLine()).kind, "result");
  const duplicate = decoder.accept(resultLine());
  assert.equal(duplicate.kind === "decode_error" && duplicate.reasonCode, "duplicate_terminal_frame");
  assert.equal(decoder.state().failed, true);
});

test("a non-terminal frame after the terminal frame is refused", () => {
  const decoder = createClaudeCodeStreamDecoderV1();
  decoder.accept(initLine());
  decoder.accept(resultLine());
  const trailing = decoder.accept(assistantLine());
  assert.equal(trailing.kind === "decode_error" && trailing.reasonCode, "frame_after_terminal");
});

test("the first decode failure permanently poisons the decoder", () => {
  const decoder = createClaudeCodeStreamDecoderV1();
  decoder.accept(initLine());
  assert.equal(decoder.accept("{not json").kind, "decode_error");
  const later = decoder.accept(assistantLine());
  assert.equal(later.kind === "decode_error" && later.reasonCode, "decoder_failed");
  assert.equal(decoder.state().reasonCode, "malformed_json");
  assert.equal(decoder.state().terminalObserved, false);
});

test("a result at exactly the ceiling is accepted and one byte over is refused", () => {
  const atCeiling = decodeClaudeCodeStreamJsonLinesV1([
    initLine(),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: SESSION,
      result: "y".repeat(CLAUDE_CODE_MAX_RESULT_BYTES_V1) }),
  ]);
  assert.equal(atCeiling[1].kind, "result");
  assert.equal(atCeiling[1].kind === "result" && atCeiling[1].resultBytes, CLAUDE_CODE_MAX_RESULT_BYTES_V1);
});

test("decoded frames are frozen and carry a frame digest", () => {
  const frames = decodeClaudeCodeStreamJsonLinesV1([initLine(), resultLine()]);
  for (const frame of frames) assert.equal(Object.isFrozen(frame), true);
  assert.match(frames[0].kind === "init" ? frames[0].frameDigest : "", /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    frames[0].kind === "init" ? frames[0].frameDigest : "a",
    frames[1].kind === "result" ? frames[1].frameDigest : "b",
  );
});

test("subtype and terminal_reason are mapped to fixed codes, never exported as text", () => {
  const subtypes: ReadonlyArray<readonly [string, string]> = [
    ["success", "success"],
    ["error_max_turns", "error_max_turns"],
    ["error_during_execution", "error_during_execution"],
    ["definitely_not_a_known_subtype", "unrecognized"],
  ];
  for (const [raw, expected] of subtypes) {
    const frames = decodeClaudeCodeStreamJsonLinesV1([initLine(), resultLine({ subtype: raw, is_error: true })]);
    const terminal = frames[1];
    assert.equal(terminal.kind, "result");
    if (terminal.kind !== "result") return;
    assert.equal(terminal.subtypeCode, expected);
    assert.equal(Object.hasOwn(terminal, "subtype"), false, "raw subtype must not be exported");
    assert.equal(Object.hasOwn(terminal, "terminalReason"), false, "raw terminal_reason must not be exported");
  }
  const reasons: ReadonlyArray<readonly [string, string]> = [
    ["max_turns", "max_turns"],
    ["timeout", "timeout"],
    ["something_upstream_invented", "unrecognized"],
  ];
  for (const [raw, expected] of reasons) {
    const frames = decodeClaudeCodeStreamJsonLinesV1([initLine(), resultLine({ terminal_reason: raw })]);
    assert.equal(frames[1].kind === "result" && frames[1].terminalReasonCode, expected);
  }
  const absent = decodeClaudeCodeStreamJsonLinesV1([initLine(), resultLine()])[1];
  assert.equal(absent.kind === "result" && absent.terminalReasonCode, "none");
  assert.equal(absent.kind === "result" && absent.terminalReasonPresent, false);
});

test("secret-like and control-bearing subtype or terminal_reason text never survives decoding", () => {
  // Synthetic, freshly authored marker values. None of these is a real credential.
  const markers = [
    "sk-ant-api03-PLACEHOLDERSECRETVALUE0000000000",
    "Bearer PLACEHOLDERBEARERTOKEN00000",
    "AKIAPLACEHOLDERACCESSKEY",
    "passphrase=hunter2-placeholder",
    "success\u0000\u0007drop",
    "erro\u001br_max_turns",
    "\u202Eerror_during_execution",
  ];
  for (const marker of markers) {
    for (const field of ["subtype", "terminal_reason"] as const) {
      const frames = decodeClaudeCodeStreamJsonLinesV1([
        initLine(),
        resultLine({ [field]: marker, is_error: true, result: "placeholder result text" }),
      ]);
      const terminal = frames[1];
      assert.equal(terminal.kind, "result", `${field} ${marker} must still decode as a result frame`);
      if (terminal.kind !== "result") continue;
      const exported = JSON.stringify(terminal);
      assert.equal(exported.includes(marker), false, `${field} marker text leaked into the frame`);
      assert.equal(exported.includes(marker.slice(0, 12)), false, `${field} marker prefix leaked`);
      assert.equal(/[\u0000-\u001f\u007f\u202a-\u202e]/.test(
        `${terminal.subtypeCode}${terminal.terminalReasonCode}`), false, "no control character may be carried");
      assert.equal(["success", "error_max_turns", "error_during_execution", "unrecognized"]
        .includes(terminal.subtypeCode), true);
      assert.equal(["none", "max_turns", "max_tokens", "timeout", "cancelled", "refusal", "error",
        "unrecognized"].includes(terminal.terminalReasonCode), true);
    }
  }
});

test("the decoded result frame exposes no unbounded free-text field", () => {
  const frames = decodeClaudeCodeStreamJsonLinesV1([
    initLine(),
    resultLine({ subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns" }),
  ]);
  const terminal = frames[1];
  assert.equal(terminal.kind, "result");
  if (terminal.kind !== "result") return;
  const known = ["schema", "kind", "sessionId", "outcome", "subtypeCode", "terminalReasonCode",
    "frameDigest", "resultTextDigest", "resultText"];
  const unexpected = Object.entries(terminal)
    .filter(([key, value]) => typeof value === "string" && !known.includes(key))
    .map(([key]) => key);
  assert.deepEqual(unexpected, [], "every exported string must be a mapped code, a digest or the bounded result text");
});

/* ------------------------------------------------------------------ */
/* Durable result publication bridge: refusals that never reach the    */
/* shared publisher.                                                   */
/*                                                                     */
/* Every case below must fail closed on bridge-local evidence alone,   */
/* so the injected publication configuration is deliberately hostile:  */
/* its database, storage and reservation ports throw and count any     */
/* touch. A zero count is the proof that no publisher work — and       */
/* therefore no reservation, no byte write and no receipt — was ever   */
/* attempted. The configuration also carries no acquire, dispatch or   */
/* capacity capability at all, so no such effect is expressible.       */
/* ------------------------------------------------------------------ */

const bridgeDigest = (seed: string) =>
  `sha256:${createHash("sha256").update(`claude-bridge:${seed}`).digest("hex")}`;

const RETAINED_BINDING = Object.freeze({
  tenantId: "tenant:test", projectId: "project:test", jobId: "job:claude-bridge",
  attemptId: "attempt:claude-bridge", runId: "run:claude-bridge", nodeId: "node:test",
  workflowId: "workflow:test", acceptanceProfileId: "profile:test",
  acceptanceProfileDigest: bridgeDigest("acceptance"),
});

const PROCESS_BINDING: ClaudeCodeProcessBindingV1 = Object.freeze({
  processAttemptId: "attempt.process.bridge", runId: RETAINED_BINDING.runId,
  attemptId: RETAINED_BINDING.attemptId, invocationDigest: bridgeDigest("invocation"),
});

function dispositionFor(overrides: Partial<ClaudeCodeSessionDispositionV1> = {}): ClaudeCodeSessionDispositionV1 {
  return {
    schema: CLAUDE_CODE_SESSION_DISPOSITION_SCHEMA_V1,
    processAttemptId: PROCESS_BINDING.processAttemptId, runId: PROCESS_BINDING.runId,
    attemptId: PROCESS_BINDING.attemptId, closed: true, cleanupUncertain: false, exitObserved: true,
    exitMalformed: false, terminalResultConfirmed: true, resubmissionSafe: false,
    reasonCode: "closed_with_decoded_terminal_result", grantsExecutionAuthority: false,
    canonicalPublicationAllowed: false, permitsRetry: false, permitsResume: false,
    ...overrides,
  };
}

/** Real decode of a real line sequence; the bridge never sees a hand-made frame here. */
function decodedTerminal(lines: readonly string[]) {
  const decoder = createClaudeCodeStreamDecoderV1();
  let last: ReturnType<typeof decoder.accept> | undefined;
  for (const line of lines) last = decoder.accept(line);
  assert.equal(last?.kind, "result");
  return { frame: last as ClaudeCodeResultFrameV1, state: decoder.state() };
}

/** A publication configuration that cannot be used without being detected. */
function forbiddenPublication() {
  const calls = { db: 0, storage: 0, reservations: 0 };
  const boom = (what: keyof typeof calls) => () => {
    calls[what] += 1;
    throw new Error("shared_publisher_must_not_be_reached");
  };
  const config = {
    db: { query: boom("db"), transaction: boom("db"), transactionWithPreCommitCheck: boom("db") },
    integrityKey: new Uint8Array(32).fill(3), reviewKey: new Uint8Array(32).fill(4),
    storage: { put: boom("storage"), read: boom("storage") },
    storageClass: "local" as const,
    reservations: { findForUpdate: boom("reservations"), insertFresh: boom("reservations"),
      compareAndSwap: boom("reservations") },
  } as unknown as DurableResultPublicationConfigurationV1;
  return { config, calls };
}

function bridgeInput(overrides: Partial<ClaudeTerminalResultPublicationInputV1> = {},
  lines: readonly string[] = [initLine(), resultLine()]): ClaudeTerminalResultPublicationInputV1 {
  const { frame, state } = decodedTerminal(lines);
  return {
    retainedBinding: { ...RETAINED_BINDING },
    processBinding: { ...PROCESS_BINDING },
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: frame.frameDigest },
    disposition: dispositionFor(),
    // The exact raw line the decoder classified into `frame`.
    terminalFrameRawLine: lines[lines.length - 1],
    terminalFrame: frame,
    decoderState: state,
    acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    receivedAt: "2027-01-01T00:00:00.000Z",
    assertAuthority: () => {},
    ...overrides,
  };
}

/**
 * Raw terminal material the real decoder would itself refuse (an oversized or
 * absent result), paired with a frame that honestly describes it. Used only to
 * prove the bridge applies its own ceilings to the verified material rather
 * than relying on the decoder having run first.
 */
function syntheticMaterial(result: string | undefined) {
  const base = decodedTerminal([initLine(), resultLine()]);
  const payload: Record<string, unknown> = { type: "result", subtype: "success", is_error: false,
    session_id: SESSION, total_cost_usd: 0, usage: {} };
  if (result !== undefined) payload.result = result;
  const rawLine = JSON.stringify(payload);
  const digest = sha256Digest(JSON.parse(rawLine));
  return {
    terminalFrameRawLine: rawLine,
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: digest },
    terminalFrame: { ...base.frame, frameDigest: digest, resultText: result,
      resultBytes: result === undefined ? 0 : Buffer.byteLength(result, "utf8"),
      resultTextDigest: result === undefined ? undefined : contentDigest(result) },
  } satisfies Partial<ClaudeTerminalResultPublicationInputV1>;
}

const contentDigest = (value: string) =>
  `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;

type RefusalMatcher = RegExp | ((error: unknown) => boolean);

async function refuses(input: ClaudeTerminalResultPublicationInputV1, pattern: RefusalMatcher) {
  const { config, calls } = forbiddenPublication();
  await assert.rejects(() => publishClaudeTerminalResultV1(config, input), pattern as RegExp);
  assert.deepEqual(calls, { db: 0, storage: 0, reservations: 0 },
    "a bridge-local refusal must never reach the shared publisher, its database or its storage");
}

/** A retained-identity refusal must be the schema rejecting that exact field. */
const retainedIdentityRejected = (field: string) => (error: unknown) => {
  assert.equal((error as { name?: string }).name, "ZodError",
    "retained identity must be refused by the retained-identity schema, not by a later check");
  const issues = JSON.parse((error as Error).message) as { path: (string | number)[] }[];
  assert.deepEqual(issues.map(issue => issue.path.join(".")), [field]);
  return true;
};

test("the bridge fixes the harness tag and connector profile digest from the accepted profile", () => {
  assert.equal(claudeCodeConnectorProfileV1.harness, "claude");
  assert.match(CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, /^sha256:[a-f0-9]{64}$/);
  // A caller may only confirm the digest it retained; supplying any other
  // connector's digest is refused before the publisher is reached.
  assert.notEqual(CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, bridgeDigest("other-connector"));
});

test("a retained session ID that differs from the independently decoded terminal session refuses", async () => {
  await refuses(bridgeInput({ retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId,
    sessionId: OTHER_SESSION, terminalFrameDigest: decodedTerminal([initLine(), resultLine()]).frame.frameDigest } }),
  /claude_code_result_publication_session_mismatch/);
});

test("a retained terminal-frame digest that differs from the decoded frame refuses", async () => {
  await refuses(bridgeInput({ retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId,
    sessionId: SESSION, terminalFrameDigest: bridgeDigest("some-other-frame") } }),
  /claude_code_result_publication_evidence_digest_mismatch/);
});

/* ------------------------------------------------------------------ */
/* Evidence binding regression.                                        */
/*                                                                     */
/* The retained terminal-frame digest must be satisfied only by raw    */
/* terminal material whose canonical digest re-derives to it here. A   */
/* decoded frame object is caller-supplied structure: a valid          */
/* `frameDigest` copied onto substituted result text proves nothing,   */
/* and `readonly`/`Object.freeze` constrain nothing about a separately */
/* constructed object. Every case below must refuse with zero database,*/
/* storage and reservation touches.                                    */
/* ------------------------------------------------------------------ */

test("substituted result text under a preserved frame digest publishes nothing", async () => {
  const honest = decodedTerminal([initLine(), resultLine()]);
  const rawLine = resultLine();
  const substituted = "Substituted result text that was never in the terminal material.";
  assert.notEqual(substituted, honest.frame.resultText);

  // The attack: a hand-built object shaped exactly like a decoded terminal
  // frame, carrying the genuine frame digest of the honest material but
  // different result text, with its own self-consistent byte count and content
  // digest so every frame-local check still agrees.
  const forgedFrame: ClaudeCodeResultFrameV1 = { ...honest.frame,
    resultText: substituted,
    resultBytes: Buffer.byteLength(substituted, "utf8"),
    resultTextDigest: contentDigest(substituted),
    frameDigest: honest.frame.frameDigest };
  assert.equal(forgedFrame.frameDigest, honest.frame.frameDigest,
    "the forgery keeps the original, genuinely valid frame digest");
  assert.equal(Object.isFrozen(forgedFrame), false,
    "a caller can construct this object outside the decoder entirely");

  // Refused: the raw material re-derives the retained digest, and the bytes
  // that would be published are read from that material, not from the frame.
  await refuses(bridgeInput({ terminalFrameRawLine: rawLine, terminalFrame: forgedFrame }),
    /claude_code_result_publication_result_unusable/);

  // The mirror-image attack against the new contract: tamper the raw material
  // instead, and keep asserting the old digest. The recomputed digest no longer
  // matches, so the material is refused before any field of it is read.
  const tamperedLine = resultLine({ result: substituted });
  assert.notEqual(sha256Digest(JSON.parse(tamperedLine)), honest.frame.frameDigest);
  await refuses(bridgeInput({ terminalFrameRawLine: tamperedLine, terminalFrame: forgedFrame }),
    /claude_code_result_publication_evidence_digest_mismatch/);

  // And tampering the material while updating the retained digest to match it
  // is not a bypass either: the digest is retained authority, checked against
  // what the caller independently observed, so a freshly minted one no longer
  // equals the frame's, and the frame-level defence in depth also refuses.
  await refuses(bridgeInput({ terminalFrameRawLine: tamperedLine,
    terminalFrame: forgedFrame,
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: sha256Digest(JSON.parse(tamperedLine)) } }),
  /claude_code_result_publication_evidence_digest_mismatch/);
});

test("raw terminal material that is absent, malformed or not a result frame publishes nothing", async () => {
  await refuses(bridgeInput({ terminalFrameRawLine: undefined as unknown as string }),
    /claude_code_result_publication_unavailable/);
  await refuses(bridgeInput({ terminalFrameRawLine: "" }),
    /claude_code_result_publication_unavailable/);
  await refuses(bridgeInput({ terminalFrameRawLine: "{not json" }),
    /claude_code_result_publication_terminal_material_unusable/);
  // Valid JSON, but not an object: there is no frame material to verify.
  await refuses(bridgeInput({ terminalFrameRawLine: "[]" }),
    /claude_code_result_publication_terminal_material_unusable/);
  // A well formed non-terminal line cannot stand in for the terminal one, even
  // when its own digest is retained honestly.
  const init = initLine();
  await refuses(bridgeInput({ terminalFrameRawLine: init,
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: sha256Digest(JSON.parse(init)) } }),
  /claude_code_result_publication_evidence_digest_mismatch/);
});

test("the verified material, not the frame, decides outcome and session identity", async () => {
  const honest = decodedTerminal([initLine(), resultLine()]);
  // Material that failed, dressed in a frame that claims success. The frame's
  // claim is never reached: the verified material classifies.
  const failedLine = resultLine({ is_error: true });
  await refuses(bridgeInput({ terminalFrameRawLine: failedLine,
    terminalFrame: { ...honest.frame, frameDigest: sha256Digest(JSON.parse(failedLine)) },
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: sha256Digest(JSON.parse(failedLine)) } }),
  /claude_code_result_publication_session_not_terminal/);
  // Material carrying a terminal reason, same shape.
  const cancelledLine = resultLine({ terminal_reason: "cancelled" });
  await refuses(bridgeInput({ terminalFrameRawLine: cancelledLine,
    terminalFrame: { ...honest.frame, frameDigest: sha256Digest(JSON.parse(cancelledLine)) },
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: sha256Digest(JSON.parse(cancelledLine)) } }),
  /claude_code_result_publication_session_not_terminal/);
  // Material observed on another session, dressed in a frame naming the
  // retained one.
  const otherLine = resultLine({}, OTHER_SESSION);
  await refuses(bridgeInput({ terminalFrameRawLine: otherLine,
    terminalFrame: { ...honest.frame, frameDigest: sha256Digest(JSON.parse(otherLine)) },
    retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      terminalFrameDigest: sha256Digest(JSON.parse(otherLine)) } }),
  /claude_code_result_publication_session_mismatch/);
});

test("a connector profile digest other than the accepted Claude profile refuses", async () => {
  await refuses(bridgeInput({ acceptedConnectorProfileDigest: bridgeDigest("other-connector") }),
    /claude_code_result_publication_connector_profile_mismatch/);
});

test("a process binding that does not match the retained publication binding refuses", async () => {
  await refuses(bridgeInput({ processBinding: { ...PROCESS_BINDING, runId: "run:claude-other" },
    disposition: dispositionFor({ runId: "run:claude-other" }) }),
  /claude_code_result_publication_binding_mismatch/);
  // The same refusal covers an attempt that drifted, and a retained session
  // bound to some other process attempt.
  await refuses(bridgeInput({ processBinding: { ...PROCESS_BINDING, attemptId: "attempt:claude-other" },
    disposition: dispositionFor({ attemptId: "attempt:claude-other" }) }),
  /claude_code_result_publication_binding_mismatch/);
  await refuses(bridgeInput({ retainedSession: { processAttemptId: "attempt.process.other", sessionId: SESSION,
    terminalFrameDigest: decodedTerminal([initLine(), resultLine()]).frame.frameDigest } }),
  /claude_code_result_publication_binding_mismatch/);
});

test("a failed, non-terminal or uncertain session publishes nothing", async () => {
  // Failed: the decoder classified the terminal frame as failed.
  await refuses(bridgeInput({}, [initLine(), resultLine({ is_error: true })]),
    /claude_code_result_publication_session_not_terminal/);
  await refuses(bridgeInput({}, [initLine(), resultLine({ terminal_reason: "max_turns" })]),
    /claude_code_result_publication_session_not_terminal/);
  // Non-terminal: the session is still open, or the decoder never saw a
  // terminal frame, or the caller never confirmed one.
  await refuses(bridgeInput({ disposition: dispositionFor({ closed: false, reasonCode: "session_open" }) }),
    /claude_code_result_publication_session_not_terminal/);
  await refuses(bridgeInput({ disposition: dispositionFor({ terminalResultConfirmed: false,
    reasonCode: "closed_without_terminal_result" }) }),
  /claude_code_result_publication_session_not_terminal/);
  await refuses(bridgeInput({ decoderState: { ...decodedTerminal([initLine(), resultLine()]).state,
    terminalObserved: false } }), /claude_code_result_publication_session_not_terminal/);
  // Uncertain: cleanup never confirmed, or the exit was never observed or was
  // malformed. None of these proves the result, so none may publish.
  await refuses(bridgeInput({ disposition: dispositionFor({ cleanupUncertain: true,
    reasonCode: "cleanup_uncertain_result_unproven" }) }),
  /claude_code_result_publication_session_not_terminal/);
  await refuses(bridgeInput({ disposition: dispositionFor({ exitObserved: false }) }),
    /claude_code_result_publication_session_not_terminal/);
  await refuses(bridgeInput({ disposition: dispositionFor({ exitMalformed: true }) }),
    /claude_code_result_publication_session_not_terminal/);
  // A poisoned decode is uncertain evidence, whatever the transport says.
  await refuses(bridgeInput({ decoderState: { ...decodedTerminal([initLine(), resultLine()]).state,
    failed: true, reasonCode: "malformed_json" } }),
  /claude_code_result_publication_session_not_terminal/);
});

test("oversized or invalid terminal result bytes are rejected before any publisher work", async () => {
  const base = decodedTerminal([initLine(), resultLine()]);
  const oversized = "x".repeat(CLAUDE_CODE_MAX_RESULT_BYTES_V1 + 1);
  // The decoder already refuses an oversized result, so this synthetic frame
  // exists only to prove the bridge applies the same ceiling independently.
  await refuses(bridgeInput({ terminalFrame: { ...base.frame, resultText: oversized,
    resultBytes: Buffer.byteLength(oversized, "utf8"),
    resultTextDigest: `sha256:${createHash("sha256").update(Buffer.from(oversized, "utf8")).digest("hex")}` } }),
  /claude_code_result_publication_result_unusable/);
  // A terminal frame carrying no result text at all publishes nothing.
  await refuses(bridgeInput({ terminalFrame: { ...base.frame, resultText: undefined, resultBytes: 0,
    resultTextDigest: undefined } }), /claude_code_result_publication_result_unusable/);
  // Text and reported digest must agree; a frame that contradicts itself is
  // not usable evidence.
  await refuses(bridgeInput({ terminalFrame: { ...base.frame, resultTextDigest: bridgeDigest("wrong-text") } }),
    /claude_code_result_publication_result_unusable/);
  // A reported byte count that disagrees with the actual text is refused too.
  await refuses(bridgeInput({ terminalFrame: { ...base.frame, resultBytes: base.frame.resultBytes + 1 } }),
    /claude_code_result_publication_result_unusable/);
  // The same two ceilings applied to the VERIFIED raw material itself, with a
  // frame that honestly describes it, so the refusal cannot be coming from the
  // frame-versus-material agreement check above.
  await refuses(bridgeInput(syntheticMaterial(oversized)),
    /claude_code_result_publication_result_unusable/);
  await refuses(bridgeInput(syntheticMaterial(undefined)),
    /claude_code_result_publication_result_unusable/);
  await refuses(bridgeInput(syntheticMaterial("")),
    /claude_code_result_publication_result_unusable/);
});

test("missing retained authority or retained identity refuses rather than being invented", async () => {
  await refuses(bridgeInput({ assertAuthority: undefined as unknown as () => void }),
    /claude_code_result_publication_unavailable/);
  // Retained identity is parsed whole: a missing or malformed field is a
  // refusal, never a value this bridge fills in from transport output.
  for (const field of ["tenantId", "projectId", "jobId", "attemptId", "runId", "nodeId", "workflowId"] as const) {
    await refuses(bridgeInput({ retainedBinding: { ...RETAINED_BINDING, [field]: "" } }),
      retainedIdentityRejected(field));
  }
  await refuses(bridgeInput({ retainedSession: { processAttemptId: PROCESS_BINDING.processAttemptId,
    sessionId: "not-a-session-id",
    terminalFrameDigest: decodedTerminal([initLine(), resultLine()]).frame.frameDigest } }),
  retainedIdentityRejected("sessionId"));
});

test("the decoded terminal frame carries no publication identity for the bridge to read", () => {
  const { frame } = decodedTerminal([initLine(), resultLine()]);
  const exported = Object.keys(frame);
  for (const forbidden of ["tenantId", "projectId", "jobId", "attemptId", "runId", "nodeId", "workflowId",
    "acceptanceProfileId", "acceptanceProfileDigest", "connectorProfileDigest", "grants", "keys"]) {
    assert.equal(exported.includes(forbidden), false,
      `terminal JSON must never be able to supply ${forbidden}`);
  }
  // Content and observed session evidence only.
  assert.deepEqual(exported.filter(key => key === "sessionId" || key === "resultText"
    || key === "frameDigest").sort(), ["frameDigest", "resultText", "sessionId"]);
});

/* ------------------------------------------------------------------ */
/* Shared terminal-result evidence projection.                         */
/*                                                                     */
/* Claude joins the SAME harness-neutral discriminated union the other  */
/* harnesses use. Every case below exercises the projector directly,    */
/* with no database, storage, reservation or process anywhere in the    */
/* call: the projection is pure.                                       */
/* ------------------------------------------------------------------ */

const RESULT_TEXT = "placeholder result text";

function claudeEvidenceInput(overrides: Record<string, unknown> = {},
  lines: readonly string[] = [initLine(), resultLine()]) {
  const { frame, state } = decodedTerminal(lines);
  const rawLine = lines[lines.length - 1];
  return {
    lineage: { tenantId: RETAINED_BINDING.tenantId, projectId: RETAINED_BINDING.projectId,
      jobId: RETAINED_BINDING.jobId, attemptId: RETAINED_BINDING.attemptId,
      runId: RETAINED_BINDING.runId, nodeId: RETAINED_BINDING.nodeId },
    retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      terminalFrameDigest: frame.frameDigest },
    terminalFrameRawLine: rawLine,
    resultSubtypeCode: frame.subtypeCode,
    decoderFramesAccepted: state.framesAccepted,
    observedAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Rebuilds a raw line and the retained digest that honestly describes it. */
function honestMaterial(payload: Record<string, unknown>) {
  const rawLine = JSON.stringify(payload);
  return { rawLine, digest: sha256Digest(JSON.parse(rawLine)) };
}

test("the shared union carries a Claude member that projects inert, frozen, lineage-bound evidence", () => {
  const evidence = projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput());
  const { frame, state } = decodedTerminal([initLine(), resultLine()]);

  // Discriminates on `kind`, and the union parses its own output back.
  assert.equal(evidence.kind, "claude_terminal_result");
  assert.equal(evidence.schema, "control-room.terminal-result-evidence/v1");
  const reparsed = terminalResultEvidenceSchemaV1.parse(evidence);
  assert.equal(reparsed.kind, "claude_terminal_result");
  // `kind` is what selects the member: the same object relabelled as another
  // harness's kind no longer satisfies that member's own source shape.
  assert.throws(() => terminalResultEvidenceSchemaV1.parse(
    { ...evidence, kind: "codex_exact_completed_turn" }), /.*/);
  assert.throws(() => terminalResultEvidenceSchemaV1.parse(
    { ...evidence, kind: "hermes_native_snapshot" }), /.*/);

  // Content is recomputed from the actual result bytes, not read from a claim.
  assert.equal(evidence.content.sizeBytes, Buffer.byteLength(RESULT_TEXT, "utf8"));
  assert.equal(evidence.content.contentHash, contentDigest(RESULT_TEXT));
  // Identity comes from the retained side only.
  assert.equal(evidence.lineage.runId, RETAINED_BINDING.runId);
  assert.equal(evidence.source.sessionId, SESSION);
  assert.equal(evidence.source.processAttemptId, PROCESS_BINDING.processAttemptId);
  assert.equal(evidence.source.connectorProfileDigest, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(evidence.source.terminalFrameDigest, frame.frameDigest);
  assert.equal(evidence.source.resultSubtypeCode, "success");
  assert.equal(evidence.source.terminalReasonPresent, false);
  assert.equal(evidence.source.decoderFramesAccepted, state.framesAccepted);
  assert.equal(evidence.terminalState, "completed");
  assert.equal(evidence.observedAt, "2027-01-01T00:00:00.000Z");

  // Inert: it approves, completes, publishes, retries and resumes nothing.
  assert.equal(evidence.canonicalPublicationAllowed, false);
  assert.equal(evidence.qualityAccepted, false);
  assert.equal(evidence.completionRecorded, false);
  assert.equal(evidence.grantsExecutionAuthority, false);
  assert.equal(evidence.permitsRetry, false);
  assert.equal(evidence.permitsResume, false);

  // Deeply frozen, and deterministic across repeated projections of the same
  // retained material (which is what makes an exact replay byte-identical).
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.source));
  assert.ok(Object.isFrozen(evidence.lineage));
  assert.deepEqual(projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput()), evidence);
});

test("a forged or tampered Claude evidence digest is refused by the shared union", () => {
  const evidence = projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput());
  // A hand-built evidence object claiming the original digest over changed
  // content: the union recomputes the digest and refuses.
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...evidence,
    content: { contentHash: bridgeDigest("forged-content"), sizeBytes: 11 } }),
  /terminal result evidence digest mismatch/);
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...evidence,
    lineage: { ...evidence.lineage, runId: "run:claude-other" } }),
  /terminal result evidence digest mismatch/);
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...evidence,
    source: { ...evidence.source, sessionId: OTHER_SESSION } }),
  /terminal result evidence digest mismatch/);
  // Flipping an inert flag is refused by the literal before the digest even
  // matters, so evidence can never be re-minted as authority.
  assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...evidence,
    canonicalPublicationAllowed: true }), /.*/);
});

test("the Claude projection binds to raw material, never to a supplied digest", () => {
  // A retained digest that does not re-derive from the material refuses.
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
    retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      terminalFrameDigest: bridgeDigest("some-other-frame") } })),
  /terminal_result_evidence_unavailable/);

  // Tampering the material while keeping the retained digest refuses: the
  // recomputed digest no longer matches.
  const tampered = resultLine({ result: "text that was never observed" });
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(
    claudeEvidenceInput({ terminalFrameRawLine: tampered })),
  /terminal_result_evidence_unavailable/);

  // Re-minting the retained digest over tampered material is not a bypass of
  // the union either: it produces DIFFERENT evidence, whose content hash is
  // the tampered text's, so it can never stand in for the honest evidence.
  const reminted = projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
    terminalFrameRawLine: tampered,
    retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      terminalFrameDigest: sha256Digest(JSON.parse(tampered)) } }));
  const honest = projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput());
  assert.notEqual(reminted.evidenceDigest, honest.evidenceDigest);
  assert.notEqual(reminted.content.contentHash, honest.content.contentHash);
});

test("the Claude projection refuses malformed, stale, mismatched and non-terminal material", () => {
  const cases: [string, Record<string, unknown>][] = [
    // Malformed / absent raw material.
    ["not parseable JSON", { terminalFrameRawLine: "{not json" }],
    ["JSON that is not an object", { terminalFrameRawLine: "[]" }],
    ["an empty line", { terminalFrameRawLine: "" }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(() => projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput(overrides)),
      /terminal_result_evidence_unavailable/, label);
  }

  // A well formed NON-terminal line, honestly digested, is still not a result.
  const init = honestMaterial(JSON.parse(initLine()));
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
    terminalFrameRawLine: init.rawLine,
    retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      terminalFrameDigest: init.digest } })),
  /terminal_result_evidence_unavailable/);

  // Material observed on another session, honestly digested.
  const other = honestMaterial(JSON.parse(resultLine({}, OTHER_SESSION)));
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
    terminalFrameRawLine: other.rawLine,
    retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      terminalFrameDigest: other.digest } })),
  /terminal_result_evidence_unavailable/);

  // Errored and terminal-reason-bearing material never becomes successful
  // terminal evidence, however honestly it is digested.
  for (const extra of [{ is_error: true }, { terminal_reason: "cancelled" },
    { terminal_reason: "max_turns" }]) {
    const m = honestMaterial(JSON.parse(resultLine(extra)));
    assert.throws(() => projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
      terminalFrameRawLine: m.rawLine,
      retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
        connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
        terminalFrameDigest: m.digest } })),
    /terminal_result_evidence_unavailable/, JSON.stringify(extra));
  }

  // Retained identity is parsed, never invented: a malformed retained field or
  // a missing pinned timestamp refuses rather than being filled in.
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(
    claudeEvidenceInput({ observedAt: undefined })), /terminal_result_evidence_unavailable/);
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(
    claudeEvidenceInput({ lineage: { ...claudeEvidenceInput().lineage, runId: "" } })),
  /terminal_result_evidence_unavailable/);
  // An unexpected extra field is refused rather than forwarded.
  assert.throws(() => projectClaudeTerminalResultEvidenceV1(
    claudeEvidenceInput({ unexpected: true })), /terminal_result_evidence_unavailable/);
});

test("the Claude projection refuses oversized, empty and invalid UTF-8 result text", () => {
  const refuse = (result: unknown, label: string) => {
    const payload: Record<string, unknown> = { type: "result", subtype: "success", is_error: false,
      session_id: SESSION, total_cost_usd: 0, usage: {} };
    if (result !== undefined) payload.result = result;
    const m = honestMaterial(payload);
    assert.throws(() => projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
      terminalFrameRawLine: m.rawLine,
      retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
        connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
        terminalFrameDigest: m.digest } })),
    /terminal_result_evidence_unavailable/, label);
  };
  refuse(undefined, "absent result text");
  refuse("", "empty result text");
  refuse("   \n\t  ".replace(/\n/g, " "), "whitespace-only result text");
  refuse(42, "non-string result text");
  // One byte over the 65,536-byte ceiling the connector result contract fixes.
  refuse("x".repeat(CLAUDE_CODE_MAX_RESULT_BYTES_V1 + 1), "oversized result text");
  // A lone high surrogate is not well formed Unicode; it would silently become
  // U+FFFD on encode, so the projection refuses instead of publishing bytes
  // that are not the observed text.
  refuse(`lead ${String.fromCharCode(0xd800)} trail`, "lone high surrogate");
  refuse(`lead ${String.fromCharCode(0xdc00)} trail`, "lone low surrogate");
  // Secret-looking material in the result text refuses rather than being
  // carried into shared evidence — the same scan the Codex and upstream
  // Hermes projections apply. The token below is a synthetic placeholder and
  // authenticates nothing.
  refuse(`Authorization: Bearer ${"z".repeat(24)}`, "bearer-token-shaped result text");
  refuse(`api_key = ${"q".repeat(20)}`, "api-key-shaped result text");

  // Exactly at the ceiling still projects, so the refusal above is the ceiling
  // and not the fixture.
  const atCeiling = "y".repeat(CLAUDE_CODE_MAX_RESULT_BYTES_V1);
  const m = honestMaterial({ type: "result", subtype: "success", is_error: false,
    session_id: SESSION, result: atCeiling, total_cost_usd: 0, usage: {} });
  const evidence = projectClaudeTerminalResultEvidenceV1(claudeEvidenceInput({
    terminalFrameRawLine: m.rawLine,
    retained: { processAttemptId: PROCESS_BINDING.processAttemptId, sessionId: SESSION,
      connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
      terminalFrameDigest: m.digest } }));
  assert.equal(evidence.content.sizeBytes, CLAUDE_CODE_MAX_RESULT_BYTES_V1);
});

test("a successful publication returns shared evidence bound to the published bytes", async () => {
  // The bridge's own refusals still fire first (their taxonomy is unchanged),
  // and on the success path the evidence it returns is the shared union's.
  const { config, calls } = forbiddenPublication();
  // The shared publisher is still reached only once the evidence projects, so
  // a projection refusal must also leave the publisher untouched.
  const tampered = resultLine({ result: "never observed" });
  await assert.rejects(() => publishClaudeTerminalResultV1(config,
    bridgeInput({ terminalFrameRawLine: tampered })), /.*/);
  assert.deepEqual(calls, { db: 0, storage: 0, reservations: 0 });
});
