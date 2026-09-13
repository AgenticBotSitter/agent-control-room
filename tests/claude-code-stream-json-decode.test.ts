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
  assert.equal(terminal.subtype, "success");
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
  assert.equal(terminal.kind === "result" && terminal.terminalReason, "budget_exhausted");
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
