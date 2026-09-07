import { z } from "zod";
import { nativeId, nativeLimits, usageSchema, type NativeBinding, type NativeState, type NativeUsage,
  type NativeWireResponse } from "./contracts";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const endpoint = (method: string, path: string) => z.object({ method: z.literal(method), path: z.literal(path) });
const capabilities = z.object({ object: z.literal("hermes.api_server.capabilities"), platform: z.literal("hermes-agent"),
  auth: z.object({ type: z.literal("bearer"), required: z.literal(true) }),
  runtime: z.object({ mode: z.literal("server_agent"), tool_execution: z.literal("server"), split_runtime: z.literal(false) }),
  features: z.object({ run_submission: z.literal(true), run_status: z.literal(true), run_events_sse: z.literal(true),
    run_stop: z.literal(true), runs_idempotency: z.object({ supported: z.literal(true), durable: z.literal(true), retention_seconds: count.positive() }) }),
  endpoints: z.object({ runs: endpoint("POST", "/v1/runs"), run_status: endpoint("GET", "/v1/runs/{run_id}"),
    run_events: endpoint("GET", "/v1/runs/{run_id}/events"), run_stop: endpoint("POST", "/v1/runs/{run_id}/stop") }),
});
export function readJson(response: NativeWireResponse, status: number): unknown {
  if (response.status !== status || !/^application\/json(?:\s*;|$)/i.test(response.contentType)
    || response.body.byteLength > nativeLimits.jsonBytes) throw new Error("native_protocol_mismatch");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
}
export function readCapabilities(response: NativeWireResponse, requiredRetentionSeconds: number) {
  const result = capabilities.parse(readJson(response, 200));
  if (result.features.runs_idempotency.retention_seconds < requiredRetentionSeconds) throw new Error("native_retention_insufficient");
  return Object.freeze({ durableIdempotency: true, retentionSeconds: result.features.runs_idempotency.retention_seconds,
    eventReplay: false, stopConfirmation: "separate_status" as const, hardCostLimit: false });
}
export function readStart(response: NativeWireResponse) {
  const value = z.object({ run_id: nativeId, status: z.literal("started"), replayed: z.literal(false) }).parse(readJson(response, 202));
  return value.run_id;
}
const statusSchema = z.object({ object: z.literal("hermes.run"), run_id: nativeId,
  status: z.enum(["queued", "running", "waiting_for_approval", "stopping", "completed", "failed", "cancelled", "interrupted"]),
  session_id: z.string().min(1).max(256), created_at: z.number().finite().nonnegative(), updated_at: z.number().finite().nonnegative(),
  output: z.string().optional(), usage: z.object({ input_tokens: count.optional(), output_tokens: count.optional(), total_tokens: count.optional() }).optional(),
});
export function readStatus(response: NativeWireResponse, runId: string, binding: NativeBinding): {
  state: NativeState; upstreamUpdatedAt: number; resultText: string | null; usage: NativeUsage | null;
} {
  const value = statusSchema.parse(readJson(response, 200));
  if (value.run_id !== runId || value.session_id !== binding.sessionId || value.updated_at < value.created_at
    || value.updated_at * 1000 > Number.MAX_SAFE_INTEGER) throw new Error("native_identity_mismatch");
  if (value.output !== undefined && Buffer.byteLength(value.output) > nativeLimits.resultBytes) throw new Error("native_result_limit");
  const state = value.status === "waiting_for_approval" ? "waiting_approval" : value.status;
  const usage = value.usage ? usageSchema.parse({ inputTokens: value.usage.input_tokens ?? null, outputTokens: value.usage.output_tokens ?? null,
    totalTokens: value.usage.total_tokens ?? null, provenance: "upstream_reported", cachedInputTokens: null, reasoningTokens: null,
    calls: null, costUsd: null, hardCostLimitEnforced: false }) : null;
  return { state, upstreamUpdatedAt: Math.floor(value.updated_at * 1000),
    resultText: state === "completed" && value.output !== undefined ? value.output : null, usage };
}
export function readStop(response: NativeWireResponse, runId: string, binding: NativeBinding) {
  const raw = readJson(response, 200);
  const stopping = z.object({ run_id: nativeId, status: z.literal("stopping") }).safeParse(raw);
  if (stopping.success) {
    if (stopping.data.run_id !== runId) throw new Error("native_identity_mismatch");
    return { state: "stopping" as const };
  }
  const terminal = readStatus(response, runId, binding);
  if (!["completed", "failed", "cancelled", "interrupted"].includes(terminal.state)) throw new Error("native_stop_mismatch");
  return terminal;
}

export interface NativeActivity { kind: "tool_started" | "tool_completed" | "message_progress" | "approval_requested" | "status_resnapshot" }
/** Bounded UTF-8/SSE framing for the pinned single-consumer run stream. Text/tool arguments/reasoning
 * are not retained as progress evidence. Status resnapshot, not an SSE terminal event, owns final outcome.
 */
export function createNativeEventDecoder(runId: string, receive: (event: NativeActivity) => void) {
  nativeId.parse(runId);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data: string[] = [], dataBytes = 0, bytes = 0, frames = 0, stopped = false;
  const flush = () => {
    if (!data.length) return;
    if (++frames > nativeLimits.streamEvents) throw new Error("native_event_limit");
    const value = JSON.parse(data.join("\n")) as unknown; data = []; dataBytes = 0;
    const event = z.object({ event: z.string().min(1).max(100), run_id: nativeId }).parse(value);
    if (event.run_id !== runId) throw new Error("native_event_identity");
    const kind = event.event === "tool.started" ? "tool_started" : event.event === "tool.completed" ? "tool_completed"
      : event.event === "message.delta" ? "message_progress" : event.event === "approval.request" ? "approval_requested" : "status_resnapshot";
    receive({ kind });
  };
  const consume = (text: string) => {
    buffer += text;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.includes("\r") || Buffer.byteLength(line) > nativeLimits.eventBytes) throw new Error("native_event_framing");
      if (!line) { flush(); continue; }
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) { const part = line.slice(5).replace(/^ /, ""); dataBytes += Buffer.byteLength(part) + 1;
        if (dataBytes > nativeLimits.eventBytes) throw new Error("native_event_limit"); data.push(part); }
      // The pinned source has data-only frames. Replay ids/retry directives are not honored.
      else if (!line.startsWith("event:")) throw new Error("native_event_framing");
    }
    if (Buffer.byteLength(buffer) > nativeLimits.eventBytes) throw new Error("native_event_limit");
  };
  return Object.freeze({ push(chunk: Uint8Array) {
    if (stopped) throw new Error("native_stream_closed");
    try { bytes += chunk.byteLength; if (bytes > nativeLimits.streamBytes) throw new Error("native_stream_limit"); consume(decoder.decode(chunk, { stream: true })); }
    catch (error) { stopped = true; throw error; }
  }, finish() {
    if (stopped) throw new Error("native_stream_closed");
    try { consume(decoder.decode()); if (buffer || data.length) throw new Error("native_event_incomplete"); }
    finally { stopped = true; }
  } });
}
