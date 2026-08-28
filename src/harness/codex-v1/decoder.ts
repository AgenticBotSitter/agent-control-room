import { z } from "zod";
import { sha256Digest } from "../../security";
import { harnessRunEventSchemaV1, type HarnessRunEventV1 } from "../v1";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const frameSchema = z.object({ type: z.string().min(1).max(80) }).passthrough();

export interface CodexDecoderContextV1 {
  tenantId: string;
  nodeId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  verificationCommands?: readonly string[];
}

export interface CodexDecodedFrameV1 {
  nativeThreadId?: string;
  finalTextDigest?: string;
  events: HarnessRunEventV1[];
}

export function decodeCodexJsonLineV1(line: string, context: CodexDecoderContextV1): CodexDecodedFrameV1 {
  if (line.length > 1_000_000) throw new Error("Codex JSONL frame too large");
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { throw new Error("invalid Codex JSONL frame"); }
  const frame = frameSchema.parse(raw);
  const events: HarnessRunEventV1[] = [];
  const push = (payload: HarnessRunEventV1["payload"], suffix: string) => {
    events.push(harnessRunEventSchemaV1.parse({
      schemaVersion: "control-room-harness-event/v1", tenantId: context.tenantId, runId: context.runId,
      sequence: context.sequence + events.length, occurredAt: context.occurredAt, source: "adapter",
      sourceEventKeyDigest: sha256Digest({ nodeId: context.nodeId, runId: context.runId, sequence: context.sequence, frameType: frame.type, suffix, ordinal: events.length }), payload,
    }) as HarnessRunEventV1);
  };

  if (frame.type === "thread.started") {
    const parsed = z.object({ thread_id: z.string().uuid() }).parse(frame);
    push({ category: "transport", state: "connected" }, "thread");
    return { nativeThreadId: parsed.thread_id, events };
  }
  if (frame.type === "turn.started") push({ category: "lifecycle", state: "running" }, "turn-started");
  else if (frame.type === "turn.completed") {
    const usage = z.object({ input_tokens: count, cached_input_tokens: count.default(0), output_tokens: count, reasoning_output_tokens: count.default(0) }).parse(frame.usage);
    push({ category: "usage", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.cached_input_tokens, reasoningTokens: usage.reasoning_output_tokens }, "usage");
    push({ category: "lifecycle", state: "succeeded" }, "turn-completed");
  } else if (frame.type === "turn.failed") push({ category: "lifecycle", state: "failed", reasonCode: "codex_turn_failed" }, "turn-failed");
  else if (frame.type === "error") push({ category: "transport", state: "drift", reasonCode: "codex_error" }, "error");
  else if (frame.type === "item.started" || frame.type === "item.updated" || frame.type === "item.completed") {
    const item = z.object({ type: z.string().min(1).max(80), status: z.string().max(80).optional() }).passthrough().parse(frame.item);
    const phase = frame.type === "item.started" ? "started" : frame.type === "item.updated" ? "progress" : item.status === "failed" ? "failed" : "completed";
    const command = item.type === "command_execution" ? z.string().max(100_000).optional().parse(item.command) : undefined;
    const activity = item.type === "file_change" ? "file" : command && context.verificationCommands?.includes(command) ? "test" : item.type === "command_execution" || item.type === "mcp_tool_call" ? "tool" : undefined;
    const changeCount = item.type === "file_change" ? z.array(z.unknown()).max(10_000).optional().parse(item.changes)?.length : undefined;
    if (activity) push({ category: "activity", activity, phase, ...(changeCount === undefined ? {} : { count: changeCount }) }, `${item.type}-${phase}`);
    if (item.type === "agent_message" && frame.type === "item.completed") {
      const text = z.string().max(1_000_000).parse(item.text);
      return { events, finalTextDigest: sha256Digest(text) };
    }
  } else if (!["item.started", "item.updated", "item.completed"].includes(frame.type)) push({ category: "transport", state: "drift", reasonCode: "codex_event_unknown" }, "unknown");
  return { events };
}
