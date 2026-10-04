// What the connectors and bots send back: Hermes session tool replies, native HTTP exchange
// packets, Codex app-server JSON-RPC lines, Claude Code stream-json lines, and the Hermes native
// supervision binary frames.
import { safeStringify } from "../lib/rng.mjs";
import { parseHermesSessionReplyV1, hermesSessionContinueResponseSchemaV1, hermesSessionJobStatusResponseSchemaV1, hermesSessionJobResultResponseSchemaV1 } from "../../../src/harness/hermes-gpt-v1/session-contract.ts";
import { nativeHttpRequestSchema, nativeHttpResponseSchema, decodeNativeHttpPacketUtf8, readNativeHttpBody, nativeHttpLimits } from "../../../src/harness/v1/native-http-exchange.ts";
import { NATIVE_WIRE_MAX_BYTES } from "../../../src/harness/v1/native-wire.ts";
import { createCodexReadJsonl } from "../../../src/harness/codex-v1/read-jsonl.ts";
import { decodeClaudeCodeStreamJsonLinesV1, createClaudeCodeStreamDecoderV1 } from "../../../src/harness/claude-code-v1/stream-json-decode.ts";
import { decodeHermesNativeSupervisionFrameV1, encodeHermesNativeSupervisionFrameV1, createHermesNativeSupervisionProtocolSessionV1 } from "../../../src/harness/hermes-021-v1/native-supervision-protocol.ts";

const jobId = "0123456789abcdef0123456789abcdef";
const hermes = {
  cont: () => ({ success: true, job_id: jobId, session_id: "session-1", status: "running" }),
  status: () => ({ success: true, job: { job_id: jobId, session_id: "session-1", status: "completed", created_at: "2026-10-02T00:00:00Z", return_code: 0, timeout: 60, prompt_len: 12, prompt_sha256: "a".repeat(64) } }),
  result: () => ({ success: true, job_id: jobId, session_id: "session-1", status: "completed", return_code: 0, response: "done", truncated: false }),
  error: () => ({ success: false, ok: false, error: "refused", layer: "session_control", code: "SESSION_BUSY", safe_message: "busy", suggested_action: "retry", trace_id: "t1" }),
};
const schemas = { cont: hermesSessionContinueResponseSchemaV1, status: hermesSessionJobStatusResponseSchemaV1, result: hermesSessionJobResultResponseSchemaV1 };
const states = ["starting", "running", "completed", "failed", "timed_out", "orphaned"];
const sessionId = "0f6a9b1c-1234-4abc-8def-0123456789ab";
const claudeLines = () => [
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, tools: [] }),
  JSON.stringify({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
  JSON.stringify({ type: "rate_limit_event", session_id: sessionId, rate_limit_info: {} }),
  JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, is_error: false, result: "done", terminal_reason: "completed", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } }),
];
const digest = `sha256:${"ab".repeat(32)}`;
const frames = () => [
  { protocol: "ACRHCP1", kind: "verified", sequence: 2, bindingDigest: digest, outcome: "none", ownedProcessGroupState: "none", escapedDescendantState: "none", descriptorIsolationObserved: true },
  { protocol: "ACRHCP1", kind: "terminal", sequence: 4, bindingDigest: digest, outcome: "completed", ownedProcessGroupState: "absent", escapedDescendantState: "not_observed", descriptorIsolationObserved: false },
];

function streamOf(chunks) {
  return new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next === undefined) controller.close(); else if (next?.$error) controller.error(new Error("producer failed")); else controller.enqueue(next); } });
}

export const targets = [
  {
    name: "hermes-session-reply",
    corpus: [hermes.cont(), hermes.status(), hermes.result()],
    corpusInput: v => ({ which: "job" in v ? "status" : "response" in v ? "result" : "cont", value: v }),
    generate(rng, c) {
      const which = rng.pick(["cont", "status", "result"]);
      const r = rng.float();
      const value = r < 0.7 ? rng.mutate(rng.pick(c), rng.int(1, 4)) : r < 0.85 ? rng.jsonValue(0, 5) : { ...hermes[which](), [rng.pick(["__proto__", "constructor", "extra", "trace_id"])]: rng.jsonValue(0, 2) };
      return { $label: which, $input: { which, value } };
    },
    invoke({ which, value }) {
      const reply = parseHermesSessionReplyV1(schemas[which], value, "fuzz");
      return { outcome: reply.outcome === "ok" ? "accepted" : "refused", value: reply };
    },
    expectedErrors: () => false,
    oracle({ which, value }, result) {
      if (({}).polluted !== undefined) return "Object.prototype polluted";
      if (result.outcome !== "accepted") { if (result.value.outcome === "refused" && (typeof result.value.code !== "string" || !result.value.code.length)) return "refusal without a code"; return undefined; }
      const v = result.value.value;
      if (v.success !== true) return "ok outcome without success:true";
      if (which === "cont" && (!/^[0-9a-f]{32}$/u.test(v.job_id) || v.status !== "running")) return "continue reply with bad job/status";
      if (which === "status" && (!/^[0-9a-f]{32}$/u.test(v.job.job_id) || !states.includes(v.job.status))) return "status reply with bad job";
      if (which === "result" && (!states.includes(v.status) || typeof v.response !== "string" || typeof v.truncated !== "boolean")) return "result reply with bad fields";
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return "accepted value with foreign prototype";
      if (!Object.isFrozen(v)) return "accepted value not frozen";
    },
  },
  {
    name: "native-http-exchange",
    corpusInput: v => ({ kind: "schema", value: v }),
    corpus: [{ schema: "control-room.native-http/v1", operation: "open", mode: "initial" }, { schema: "control-room.native-http/v1", operation: "exchange", connection: "connection:http:" + "a1b2c3d4-e5f6-7890-abcd-ef0123456789", packet: "{\"x\":1}" },
      { schema: "control-room.native-http/v1", connection: "connection:http:a1b2c3d4-e5f6-7890-abcd-ef0123456789", packets: ["a", "b"], more: false }],
    generate(rng, c) {
      const r = rng.float();
      if (r < 0.4) return { $label: "schema", $input: { kind: "schema", value: rng.bool(0.85) ? rng.mutate(rng.pick(c), rng.int(1, 3)) : rng.jsonValue(0, 4) } };
      if (r < 0.7) { const s = rng.bool(0.5) ? rng.nasty(NATIVE_WIRE_MAX_BYTES >> 8) : rng.pick(["\ud800", "a\udc00", "\u{10ffff}".repeat(rng.int(1, 400)), "x".repeat(rng.int(NATIVE_WIRE_MAX_BYTES - 2, NATIVE_WIRE_MAX_BYTES + 2))]); return { $label: "packet-string", $input: { kind: "packet", value: rng.bool(0.5) ? s : rng.bytes(rng.int(0, 300)) } }; }
      if (r < 0.75) return { $label: "packet-bytes", $input: { kind: "packet", value: Buffer.from(rng.pick(["\xff\xfe", "\xc0\x80", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xef\xbb\xbfok", "ok\xe2\x82"]), "latin1") } };
      const chunks = []; const n = rng.int(0, 8);
      for (let i = 0; i < n; i++) chunks.push(rng.weighted([[6, rng.bytes(rng.int(0, 70000))], [1, { $error: true }], [1, "not-bytes"], [1, null], [1, rng.bytes(nativeHttpLimits.bodyBytes + 1)]]));
      return { $label: "body-stream", $input: { kind: "body", chunks, abortAt: rng.bool(0.15) ? rng.int(0, 1) : -1 } };
    },
    async invoke(input) {
      if (input.kind === "schema") {
        const req = nativeHttpRequestSchema.safeParse(input.value), res = nativeHttpResponseSchema.safeParse(input.value);
        return { outcome: req.success || res.success ? "accepted" : "refused", value: req.success ? req.data : res.data };
      }
      if (input.kind === "packet") return { outcome: "accepted", value: decodeNativeHttpPacketUtf8(input.value) };
      const controller = new AbortController();
      if (input.abortAt === 0) controller.abort();
      const stream = streamOf([...input.chunks]);
      if (input.abortAt === 1) setTimeout(() => controller.abort(), 1);
      return { outcome: "accepted", value: await readNativeHttpBody(stream, controller.signal) };
    },
    expectedErrors: e => e instanceof Error && e.message === "native_http_unavailable",
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      if (input.kind === "packet" || input.kind === "body") {
        const text = result.value;
        if (Buffer.byteLength(text, "utf8") > (input.kind === "packet" ? NATIVE_WIRE_MAX_BYTES : nativeHttpLimits.bodyBytes)) return "accepted over-limit packet";
        if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text)) return "accepted lone surrogate";
        if (input.kind === "body" && input.chunks.some(c => c?.$error || typeof c === "string" || c === null)) return "accepted a stream that errored or produced non-bytes";
      }
      if (input.kind === "schema") { const v = result.value; if (v.packet && Buffer.byteLength(v.packet) > NATIVE_WIRE_MAX_BYTES) return "accepted oversize packet"; if (v.packets?.length > nativeHttpLimits.packets) return "accepted too many packets"; }
    },
  },
  {
    name: "codex-read-jsonl",
    corpusMustPass: false,
    corpus: ['{"id":1,"result":{"ok":true}}', '{"method":"codex/event","params":{"x":1}}', '{"id":2,"result":{"thread":{"id":"t"}}}'],
    generate(rng, c) {
      const n = rng.int(1, 6); const lines = [];
      for (let i = 0; i < n; i++) lines.push(rng.weighted([[5, rng.mutateText(rng.pick(c), rng.int(0, 2))], [2, safeStringify(rng.jsonValue(0, 4))], [1, JSON.stringify({ id: rng.pick([1, 2, "1", 1.0, true]), result: rng.jsonValue(0, 3), jsonrpc: rng.bool() ? "2.0" : undefined })], [1, "x".repeat(rng.int(262_000, 262_200))], [1, rng.nasty(40)]]));
      return { $label: `${n}-lines`, $input: lines };
    },
    invoke(lines) {
      const session = createCodexReadJsonl({ threadId: "thread-1", turnId: "turn-1" });
      session.initialize();
      const outcomes = [];
      for (const line of lines) {
        try { const kind = session.receive(line).kind; outcomes.push(kind); if (kind === "initialized") { session.initialized(); session.read(); } }
        catch (e) { if (e?.message !== "codex_read_session_unavailable") throw e; outcomes.push("closed"); break; }
      }
      return { outcome: outcomes.includes("observation") ? "accepted" : "refused", value: outcomes };
    },
    expectedErrors: e => e instanceof Error && /codex_read_session_unavailable|codex_read/u.test(e.message),
    oracle(lines, result) {
      const v = result.value;
      if (v.filter(k => k === "initialized").length > 1) return "initialized twice";
      if (v.includes("observation") && v.indexOf("observation") < v.indexOf("initialized")) return "observation before initialized";
      if (v.filter(k => k === "ignored_notification").length > 64) return "more than 64 notifications accepted";
      if (v.includes("observation")) { const after = v.slice(v.indexOf("observation") + 1); if (after.some(k => k !== "closed")) return "accepted frames after completion"; }
    },
  },
  {
    name: "claude-stream-json",
    corpus: claudeLines(),
    corpusInput: () => claudeLines(),
    generate(rng, c) {
      const lines = claudeLines(); const n = rng.int(1, 4);
      for (let i = 0; i < n; i++) {
        const at = rng.int(0, lines.length - 1); const op = rng.int(0, 5);
        if (op === 0) lines[at] = rng.mutateText(lines[at], rng.int(1, 3));
        else if (op === 1) { try { const v = JSON.parse(lines[at]); lines[at] = safeStringify(rng.mutate(v, rng.int(1, 3))); } catch { lines[at] = rng.mutateText(lines[at], 1); } }
        else if (op === 2) lines.splice(at, 0, rng.pick(c));
        else if (op === 3) lines.splice(at, 1);
        else if (op === 4) lines.push(JSON.stringify({ type: "result", subtype: rng.nasty(8), session_id: sessionId, is_error: rng.pick([false, true, "no"]), result: rng.bool(0.3) ? "r".repeat(rng.int(60000, 70000)) : rng.nasty(20), usage: rng.pick([{ input_tokens: -1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: 2 ** 53, output_tokens: 1 }, null, "x"]), total_cost_usd: rng.pick([0, -1, NaN, "1", 1e308]) }));
        else lines.push(safeStringify(rng.jsonValue(0, 3)));
      }
      return { $label: `${lines.length}-lines`, $input: lines };
    },
    invoke(lines) {
      const frames = decodeClaudeCodeStreamJsonLinesV1(lines);
      const decoder = createClaudeCodeStreamDecoderV1({ expectedSessionId: sessionId });
      for (const line of lines) decoder.accept(line);
      return { outcome: frames.some(f => f.kind === "result") ? "accepted" : "refused", value: { frames, state: decoder.state() } };
    },
    expectedErrors: () => false,
    oracle(lines, result) {
      const { frames } = result.value;
      const errors = frames.filter(f => f.kind === "decode_error");
      if (errors.length > 1) return "more than one decode_error emitted";
      if (errors.length && frames.indexOf(errors[0]) !== frames.length - 1) return "frames after decode_error";
      if (frames.length && frames[0].kind !== "init" && frames[0].kind !== "decode_error") return "first frame is not init";
      const results = frames.filter(f => f.kind === "result");
      if (results.length > 1) return "two terminal frames";
      for (const f of results) {
        if (f.resultBytes > 65_536 * 4) return "result over ceiling accepted";
        if (f.usage && (!Number.isSafeInteger(f.usage.inputTokens) || f.usage.inputTokens < 0 || f.usage.totalTokens !== f.usage.inputTokens + f.usage.outputTokens)) return "bad usage accepted";
        if (f.totalCostUsd !== undefined && !(Number.isFinite(f.totalCostUsd) && f.totalCostUsd >= 0)) return "bad cost accepted";
        if (!/^(success|error_max_turns|error_during_execution|unrecognized)$/u.test(f.subtypeCode)) return "raw subtype leaked";
        if (f.isError && f.outcome !== "failed") return "is_error with succeeded outcome";
      }
      const ids = frames.filter(f => "sessionId" in f).map(f => f.sessionId);
      if (new Set(ids).size > 1) return "mixed session ids accepted";
    },
  },
  {
    name: "hermes-native-frame",
    corpus: frames().map(f => encodeHermesNativeSupervisionFrameV1(f)),
    generate(rng, c) {
      const r = rng.float();
      if (r < 0.6) { const bytes = Buffer.from(rng.pick(c)); const n = rng.int(1, 4); for (let i = 0; i < n; i++) bytes[rng.int(0, 63)] = rng.int(0, 255); return { $label: "flip", $input: new Uint8Array(bytes) }; }
      if (r < 0.75) return { $label: "length", $input: rng.bytes(rng.pick([0, 1, 63, 65, 128, 64 * 2])) };
      if (r < 0.9) return { $label: "object", $input: rng.mutate(rng.pick(frames()), rng.int(1, 3)) };
      return { $label: "random64", $input: rng.bytes(64) };
    },
    invoke(input) {
      if (input instanceof Uint8Array) { const frame = decodeHermesNativeSupervisionFrameV1(input); return { outcome: "accepted", value: frame }; }
      return { outcome: "accepted", value: decodeHermesNativeSupervisionFrameV1(encodeHermesNativeSupervisionFrameV1(input)) };
    },
    expectedErrors: e => e instanceof Error && e.message === "hermes_native_supervision_protocol_refused",
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const frame = result.value;
      if (input instanceof Uint8Array && !Buffer.from(encodeHermesNativeSupervisionFrameV1(frame)).equals(Buffer.from(input))) return "decoded frame does not round-trip to the same bytes";
      if (frame.sequence < 1 || frame.sequence > 5) return "sequence out of range";
      if (frame.kind === "terminal" && frame.outcome === "completed" && frame.ownedProcessGroupState !== "absent") return "completed terminal without absent group";
      if (frame.kind !== "terminal" && frame.kind !== "verified" && frame.outcome !== "none") return "neutral frame with outcome";
      // session acceptance must refuse any frame that does not match the binding or sequence
      try {
        const session = createHermesNativeSupervisionProtocolSessionV1({ firstObservedAtUnixMs: 1, releaseSha256: digest, runtimeImageSha256: digest, runtimeManifestSha256: digest, sessionBindingDigest: digest });
        session.accept(encodeHermesNativeSupervisionFrameV1(frame), 2);
        if (frame.kind !== "verified" || frame.sequence !== 2) return "session accepted a non-verified or out-of-sequence first frame";
      } catch (e) { if (e?.message !== "hermes_native_supervision_protocol_refused") return `session threw ${e?.message}`; }
    },
  },
];
