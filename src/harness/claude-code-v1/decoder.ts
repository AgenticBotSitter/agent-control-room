import { z } from "zod";
import { sha256Digest } from "../../security";
import { harnessRunEventSchemaV1, type HarnessRunEventV1 } from "../v1";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const frameSchema = z.object({ type: z.string().min(1).max(80) }).passthrough();

/** Formats a JS number as the schema's bounded decimal-string money type. */
function moneyString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid Claude Code cost value");
  const fixed = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed.length ? fixed : "0";
}

function safeReasonSuffix(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned.slice(0, 60) : "unspecified";
}

export interface ClaudeCodeDecoderContextV1 {
  tenantId: string;
  nodeId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
}

export interface ClaudeCodeDecodedFrameV1 {
  nativeSessionId?: string;
  finalTextDigest?: string;
  events: HarnessRunEventV1[];
}

/**
 * Decodes one `--output-format stream-json` line from the Claude Code CLI into canonical
 * harness events. Only the three frame shapes captured live and unauthenticated in Stage A0
 * (docs/claude/CLAUDE_CODE_A0_VERIFICATION.md — system/init, assistant, result) are modeled;
 * everything else falls through to a drift marker rather than guessing at an unverified
 * shape. In particular: `result.subtype` can read "success" while `result.is_error` is
 * true, so classification here keys off `is_error`/`terminal_reason`, never `subtype`.
 */
export function decodeClaudeCodeStreamJsonLineV1(line: string, context: ClaudeCodeDecoderContextV1): ClaudeCodeDecodedFrameV1 {
  if (line.length > 1_000_000) throw new Error("Claude Code stream-json frame too large");
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { throw new Error("invalid Claude Code stream-json frame"); }
  const frame = frameSchema.parse(raw);
  const events: HarnessRunEventV1[] = [];
  const push = (payload: HarnessRunEventV1["payload"], suffix: string) => {
    events.push(harnessRunEventSchemaV1.parse({
      schemaVersion: "control-room-harness-event/v1", tenantId: context.tenantId, runId: context.runId,
      sequence: context.sequence + events.length, occurredAt: context.occurredAt, source: "adapter",
      sourceEventKeyDigest: sha256Digest({ nodeId: context.nodeId, runId: context.runId, sequence: context.sequence, frameType: frame.type, suffix, ordinal: events.length }),
      payload,
    }) as HarnessRunEventV1);
  };

  if (frame.type === "system") {
    const parsed = z.object({ subtype: z.string().min(1).max(80), session_id: z.string().uuid() }).passthrough().parse(frame);
    if (parsed.subtype !== "init") { push({ category: "transport", state: "drift", reasonCode: `claude_code_system_${safeReasonSuffix(parsed.subtype)}` }, "system-unknown"); return { events }; }
    push({ category: "transport", state: "connected" }, "system-init");
    return { nativeSessionId: parsed.session_id, events };
  }

  if (frame.type === "assistant") {
    const parsed = z.object({ session_id: z.string().uuid().optional(), error: z.string().max(200).optional(), is_api_error_message: z.boolean().optional() }).passthrough().parse(frame);
    if (parsed.is_api_error_message || parsed.error) {
      push({ category: "lifecycle", state: "running" }, "assistant-error-observed");
      return { events, ...(parsed.session_id ? { nativeSessionId: parsed.session_id } : {}) };
    }
    push({ category: "lifecycle", state: "running" }, "assistant-turn");
    return { events, ...(parsed.session_id ? { nativeSessionId: parsed.session_id } : {}) };
  }

  if (frame.type === "result") {
    const parsed = z.object({
      is_error: z.boolean(), terminal_reason: z.string().min(1).max(80).optional(), result: z.string().max(1_000_000).optional(),
      total_cost_usd: z.number().min(0).optional(),
      usage: z.object({ input_tokens: count, output_tokens: count, cache_creation_input_tokens: count.optional(), cache_read_input_tokens: count.optional() }).passthrough().optional(),
      session_id: z.string().uuid().optional(),
    }).passthrough().parse(frame);

    if (parsed.usage) {
      const cachedInputTokens = (parsed.usage.cache_creation_input_tokens ?? 0) + (parsed.usage.cache_read_input_tokens ?? 0);
      push({
        category: "usage", inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens,
        cachedInputTokens, reasoningTokens: 0,
        ...(parsed.total_cost_usd === undefined ? {} : { estimatedCostUsd: moneyString(parsed.total_cost_usd) }),
      }, "result-usage");
    }

    if (parsed.is_error) {
      const reasonCode = `claude_code_${safeReasonSuffix(parsed.terminal_reason ?? "run_failed")}`;
      push({ category: "lifecycle", state: "failed", reasonCode }, "result-failed");
      return { events, ...(parsed.session_id ? { nativeSessionId: parsed.session_id } : {}) };
    }

    push({ category: "lifecycle", state: "succeeded" }, "result-succeeded");
    return {
      events, ...(parsed.session_id ? { nativeSessionId: parsed.session_id } : {}),
      ...(parsed.result === undefined ? {} : { finalTextDigest: sha256Digest(parsed.result) }),
    };
  }

  push({ category: "transport", state: "drift", reasonCode: `claude_code_frame_${safeReasonSuffix(frame.type)}` }, "unknown");
  return { events };
}
