import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_MAX_LINE_BYTES_V1,
  CLAUDE_CODE_MAX_RESULT_BYTES_V1,
  createClaudeCodeStreamDecoderV1,
  decodeClaudeCodeStreamJsonLinesV1,
} from "../src/harness/claude-code-v1/stream-json-decode";
import { claudeCodeConnectorProfileV1 } from "../src/harness/claude-code-v1/connector-profile";

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
