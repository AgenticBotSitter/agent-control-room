import { createHash } from "node:crypto";
import { sha256Digest } from "../../security/canonical-digest";
import { claudeCodeConnectorProfileV1 } from "./connector-profile";

export const CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1 = "control-room.claude-code-stream-frame/v1" as const;

/** One decoded line may not exceed this; the framing layer applies the same ceiling. */
export const CLAUDE_CODE_MAX_LINE_BYTES_V1 = 262_144;
/** Reused from the already-published connector result contract; not a new number. */
export const CLAUDE_CODE_MAX_RESULT_BYTES_V1 = claudeCodeConnectorProfileV1.resultContract.maximumBytes;
/** A single stream is bounded in frame count so a wedged producer cannot grow state forever. */
export const CLAUDE_CODE_MAX_FRAMES_V1 = 4_096;

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ClaudeCodeDecodeReasonCodeV1 =
  | "decoder_failed"
  | "line_not_a_string"
  | "line_too_large"
  | "embedded_control_character"
  | "empty_line"
  | "malformed_json"
  | "frame_not_an_object"
  | "frame_type_missing"
  | "unknown_frame_type"
  | "unsupported_system_subtype"
  | "invalid_session_id"
  | "init_frame_not_first"
  | "duplicate_init_frame"
  | "session_id_mismatch"
  | "frame_after_terminal"
  | "duplicate_terminal_frame"
  | "frame_budget_exhausted"
  | "malformed_assistant_frame"
  | "result_is_error_missing"
  | "result_subtype_missing"
  | "malformed_terminal_reason"
  | "malformed_result_text"
  | "result_text_exceeds_ceiling"
  | "malformed_usage"
  | "malformed_cost";

export interface ClaudeCodeInitFrameV1 {
  readonly schema: typeof CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1;
  readonly kind: "init";
  readonly sessionId: string;
  readonly frameDigest: string;
}

export interface ClaudeCodeAssistantTurnFrameV1 {
  readonly schema: typeof CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1;
  readonly kind: "assistant_turn";
  readonly sessionId: string;
  /** The CLI reports assistant-side failures inline rather than as a distinct frame type. */
  readonly inlineError: boolean;
  readonly frameDigest: string;
}

/**
 * The CLI's `subtype` is untrusted upstream text, so it is never retained or
 * exported. It is mapped to one of these fixed values and otherwise discarded.
 */
export type ClaudeCodeResultSubtypeCodeV1 =
  | "success"
  | "error_max_turns"
  | "error_during_execution"
  | "unrecognized";

/** Same discipline for `terminal_reason`: mapped to a fixed value, never retained. */
export type ClaudeCodeTerminalReasonCodeV1 =
  | "none"
  | "max_turns"
  | "max_tokens"
  | "timeout"
  | "cancelled"
  | "refusal"
  | "error"
  | "unrecognized";

/** Exactly the `subtype` values this decoder recognises; anything else is discarded. */
const KNOWN_RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  "success",
  "error_max_turns",
  "error_during_execution",
]);

/** Exactly the `terminal_reason` values this decoder recognises. */
const KNOWN_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "max_turns",
  "max_tokens",
  "timeout",
  "cancelled",
  "refusal",
  "error",
]);

function mapSubtypeCode(raw: string): ClaudeCodeResultSubtypeCodeV1 {
  return KNOWN_RESULT_SUBTYPES.has(raw) ? (raw as ClaudeCodeResultSubtypeCodeV1) : "unrecognized";
}

function mapTerminalReasonCode(raw: string | undefined): ClaudeCodeTerminalReasonCodeV1 {
  if (raw === undefined) return "none";
  return KNOWN_TERMINAL_REASONS.has(raw) ? (raw as ClaudeCodeTerminalReasonCodeV1) : "unrecognized";
}

export interface ClaudeCodeResultFrameV1 {
  readonly schema: typeof CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1;
  readonly kind: "result";
  readonly sessionId: string;
  /** Derived from is_error and terminal-reason presence only; the subtype never classifies. */
  readonly outcome: "succeeded" | "failed";
  readonly isError: boolean;
  /** Fixed safe value. The raw upstream `subtype` text is discarded, never exported. */
  readonly subtypeCode: ClaudeCodeResultSubtypeCodeV1;
  /** Fixed safe value. The raw upstream `terminal_reason` text is discarded, never exported. */
  readonly terminalReasonCode: ClaudeCodeTerminalReasonCodeV1;
  /** Whether the frame carried a `terminal_reason` field at all; no content is retained. */
  readonly terminalReasonPresent: boolean;
  readonly resultText: string | undefined;
  readonly resultBytes: number;
  readonly resultTextDigest: string | undefined;
  readonly totalCostUsd: number | undefined;
  readonly usageReported: boolean;
  readonly frameDigest: string;
}

export interface ClaudeCodeDecodeErrorFrameV1 {
  readonly schema: typeof CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1;
  readonly kind: "decode_error";
  readonly reasonCode: ClaudeCodeDecodeReasonCodeV1;
}

export type ClaudeCodeStreamFrameV1 =
  | ClaudeCodeInitFrameV1
  | ClaudeCodeAssistantTurnFrameV1
  | ClaudeCodeResultFrameV1
  | ClaudeCodeDecodeErrorFrameV1;

export interface ClaudeCodeStreamDecoderStateV1 {
  readonly sessionId: string | undefined;
  readonly framesAccepted: number;
  readonly assistantTurns: number;
  readonly initObserved: boolean;
  readonly terminalObserved: boolean;
  readonly failed: boolean;
  readonly reasonCode: ClaudeCodeDecodeReasonCodeV1 | undefined;
}

export interface ClaudeCodeStreamDecoderV1 {
  /** Classifies exactly one already-framed line. Never throws and never performs I/O. */
  accept(line: string): ClaudeCodeStreamFrameV1;
  state(): ClaudeCodeStreamDecoderStateV1;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textDigest(value: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

/**
 * Strict, bounded decoder for the Claude Code CLI's newline-delimited
 * `--output-format stream-json` output. It is pure: no spawn, no environment, no
 * credential, no file and no network access. Any malformed line, unknown frame
 * type, out-of-order frame or duplicate terminal frame is a decode failure, and
 * the first failure permanently poisons the decoder rather than resynchronising.
 */
export function createClaudeCodeStreamDecoderV1(input: Readonly<{ expectedSessionId?: unknown }> = {}): ClaudeCodeStreamDecoderV1 {
  const expectedSessionId = input.expectedSessionId === undefined ? undefined : (() => {
    if (typeof input.expectedSessionId !== "string" || !sessionIdPattern.test(input.expectedSessionId)) {
      throw new Error("claude_code_stream_decoder_expected_session_invalid");
    }
    return input.expectedSessionId;
  })();
  let sessionId: string | undefined;
  let framesAccepted = 0;
  let assistantTurns = 0;
  let initObserved = false;
  let terminalObserved = false;
  let failed = false;
  let reasonCode: ClaudeCodeDecodeReasonCodeV1 | undefined;

  const fail = (code: ClaudeCodeDecodeReasonCodeV1): ClaudeCodeDecodeErrorFrameV1 => {
    if (!failed) {
      failed = true;
      reasonCode = code;
    }
    return Object.freeze({
      schema: CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1,
      kind: "decode_error" as const,
      reasonCode: code,
    });
  };

  const classify = (line: string): ClaudeCodeStreamFrameV1 => {
    if (failed) return fail("decoder_failed");
    if (typeof line !== "string") return fail("line_not_a_string");
    if (Buffer.byteLength(line, "utf8") > CLAUDE_CODE_MAX_LINE_BYTES_V1) return fail("line_too_large");
    if (line.includes("\n") || line.includes("\r")) return fail("embedded_control_character");
    if (line.trim().length === 0) return fail("empty_line");
    if (framesAccepted >= CLAUDE_CODE_MAX_FRAMES_V1) return fail("frame_budget_exhausted");

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail("malformed_json");
    }
    if (!plainObject(parsed)) return fail("frame_not_an_object");

    const type = parsed.type;
    if (typeof type !== "string" || type.length === 0) return fail("frame_type_missing");
    if (type !== "system" && type !== "assistant" && type !== "result") return fail("unknown_frame_type");
    if (type === "system" && parsed.subtype !== "init") return fail("unsupported_system_subtype");

    const frameSessionId = parsed.session_id;
    if (typeof frameSessionId !== "string" || !sessionIdPattern.test(frameSessionId)) {
      return fail("invalid_session_id");
    }

    if (terminalObserved) return fail(type === "result" ? "duplicate_terminal_frame" : "frame_after_terminal");
    if (type === "system") {
      if (initObserved) return fail("duplicate_init_frame");
      if (expectedSessionId !== undefined && frameSessionId !== expectedSessionId) return fail("session_id_mismatch");
    } else if (!initObserved) {
      return fail("init_frame_not_first");
    } else if (frameSessionId !== sessionId) {
      return fail("session_id_mismatch");
    }

    let frameDigest: string;
    try {
      frameDigest = sha256Digest(parsed);
    } catch {
      return fail("malformed_json");
    }

    if (type === "system") {
      initObserved = true;
      sessionId = frameSessionId;
      framesAccepted += 1;
      return Object.freeze({
        schema: CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1,
        kind: "init" as const,
        sessionId: frameSessionId,
        frameDigest,
      });
    }

    if (type === "assistant") {
      const message = parsed.message;
      if (!plainObject(message)) return fail("malformed_assistant_frame");
      const inlineError = message.error !== undefined
        || parsed.error !== undefined
        || message.is_api_error_message === true
        || parsed.is_api_error_message === true;
      assistantTurns += 1;
      framesAccepted += 1;
      return Object.freeze({
        schema: CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1,
        kind: "assistant_turn" as const,
        sessionId: frameSessionId,
        inlineError,
        frameDigest,
      });
    }

    const isError = parsed.is_error;
    if (typeof isError !== "boolean") return fail("result_is_error_missing");
    const subtype = parsed.subtype;
    if (typeof subtype !== "string" || subtype.length === 0 || subtype.length > 120) {
      return fail("result_subtype_missing");
    }
    let terminalReasonPresent = false;
    let terminalReasonCode: ClaudeCodeTerminalReasonCodeV1 = "none";
    if (parsed.terminal_reason !== undefined) {
      if (typeof parsed.terminal_reason !== "string" || parsed.terminal_reason.length === 0
        || parsed.terminal_reason.length > 200) return fail("malformed_terminal_reason");
      terminalReasonPresent = true;
      // The raw string is read for mapping only and is deliberately not captured.
      terminalReasonCode = mapTerminalReasonCode(parsed.terminal_reason);
    }
    let totalCostUsd: number | undefined;
    if (parsed.total_cost_usd !== undefined) {
      if (typeof parsed.total_cost_usd !== "number" || !Number.isFinite(parsed.total_cost_usd)
        || parsed.total_cost_usd < 0) return fail("malformed_cost");
      totalCostUsd = parsed.total_cost_usd;
    }
    if (parsed.usage !== undefined && !plainObject(parsed.usage)) return fail("malformed_usage");
    let resultText: string | undefined;
    let resultBytes = 0;
    let resultTextDigest: string | undefined;
    if (parsed.result !== undefined) {
      if (typeof parsed.result !== "string") return fail("malformed_result_text");
      resultBytes = Buffer.byteLength(parsed.result, "utf8");
      if (resultBytes > CLAUDE_CODE_MAX_RESULT_BYTES_V1) return fail("result_text_exceeds_ceiling");
      resultText = parsed.result;
      resultTextDigest = textDigest(parsed.result);
    }

    terminalObserved = true;
    framesAccepted += 1;
    return Object.freeze({
      schema: CLAUDE_CODE_STREAM_FRAME_SCHEMA_V1,
      kind: "result" as const,
      sessionId: frameSessionId,
      // Deliberately independent of subtype: a "success" subtype can carry is_error true.
      outcome: (isError || terminalReasonPresent ? "failed" : "succeeded") as "succeeded" | "failed",
      isError,
      subtypeCode: mapSubtypeCode(subtype),
      terminalReasonCode,
      terminalReasonPresent,
      resultText,
      resultBytes,
      resultTextDigest,
      totalCostUsd,
      usageReported: parsed.usage !== undefined,
      frameDigest,
    });
  };

  return Object.freeze({
    accept: classify,
    state: (): ClaudeCodeStreamDecoderStateV1 => Object.freeze({
      sessionId,
      framesAccepted,
      assistantTurns,
      initObserved,
      terminalObserved,
      failed,
      reasonCode,
    }),
  });
}

/** Convenience one-shot decode of an already-framed line sequence. Stops at the first failure. */
export function decodeClaudeCodeStreamJsonLinesV1(lines: readonly string[],
  options: Readonly<{ expectedSessionId?: unknown }> = {}): readonly ClaudeCodeStreamFrameV1[] {
  const decoder = createClaudeCodeStreamDecoderV1(options);
  const frames: ClaudeCodeStreamFrameV1[] = [];
  for (const line of lines) {
    const frame = decoder.accept(line);
    frames.push(frame);
    if (frame.kind === "decode_error") break;
  }
  return Object.freeze(frames);
}
