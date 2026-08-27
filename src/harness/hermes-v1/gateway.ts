import { z } from "zod";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { HARNESS_EVENT_SCHEMA_VERSION_V1, harnessRunEventSchemaV1, type HarnessEventPayloadV1, type HarnessRunEventV1 } from "../v1";

const eventFrameSchema = z.object({
  jsonrpc: z.literal("2.0"), method: z.literal("event"), params: z.object({ type: z.string().min(1).max(100), session_id: z.string().min(1).max(500).optional(), payload: z.unknown().optional() }).strict(),
}).strict();

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).catch(0);
const usagePayload = z.object({
  input_tokens: count.optional(), output_tokens: count.optional(), cache_read_tokens: count.optional(), cached_input_tokens: count.optional(), reasoning_tokens: count.optional(), estimated_cost_usd: z.union([z.string(),z.number()]).optional(),
}).passthrough();

const ignoredStreamingEvents = new Set(["message.delta", "reasoning.delta", "thinking.delta", "message.start", "message.interim"]);

export interface HermesGatewayNormalizationContext {
  tenantId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  nativeSessionId: string;
}

export function normalizeHermesGatewayEventV1(frame: unknown, context: HermesGatewayNormalizationContext): HarnessRunEventV1 | undefined {
  const parsed = eventFrameSchema.parse(frame);
  if (ignoredStreamingEvents.has(parsed.params.type)) return undefined;
  if (parsed.params.session_id !== context.nativeSessionId) throw new Error("Hermes event session mismatch");
  const payload = normalizePayload(parsed.params.type, parsed.params.payload);
  if (!payload) return undefined;
  const event = harnessRunEventSchemaV1.parse({
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION_V1, tenantId: context.tenantId, runId: context.runId, sequence: context.sequence,
    occurredAt: context.occurredAt, source: "adapter",
    sourceEventKeyDigest: sha256Digest({ tenantId: context.tenantId, runId: context.runId, sequence: context.sequence, occurredAt: context.occurredAt, type: parsed.params.type }), payload,
  }) as HarnessRunEventV1;
  assertNoSecretMaterial(event, "normalized Hermes event");
  return event;
}

function normalizePayload(type: string, raw: unknown): HarnessEventPayloadV1 | undefined {
  if (type === "gateway.ready" || type === "session.info") return { category: "transport", state: "connected" };
  if (type === "message.complete") return { category: "lifecycle", state: "succeeded" };
  if (type === "terminal.close") return { category: "transport", state: "disconnected", reasonCode: "hermes_terminal_closed" };
  if (type === "error") return { category: "lifecycle", state: "failed", reasonCode: "hermes_reported_failure" };
  if (type === "approval.request" || type === "sudo.request" || type === "secret.request") return { category: "attention", attention: "approval", state: "requested" };
  if (type === "clarify.request") return { category: "attention", attention: "input", state: "requested" };
  if (type === "tool.start") return { category: "activity", activity: "tool", phase: "started" };
  if (type === "tool.progress" || type === "tool.generating") return { category: "activity", activity: "tool", phase: "progress" };
  if (type === "tool.complete") return { category: "activity", activity: "tool", phase: "completed" };
  if (type === "session.usage") {
    const usage = usagePayload.parse(raw ?? {});
    const cost = usage.estimated_cost_usd;
    const estimatedCostUsd = cost === undefined ? undefined : typeof cost === "number" ? cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0" : cost;
    return { category: "usage", inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cachedInputTokens: usage.cached_input_tokens ?? usage.cache_read_tokens ?? 0, reasoningTokens: usage.reasoning_tokens ?? 0, ...(estimatedCostUsd ? { estimatedCostUsd } : {}) };
  }
  if (type.startsWith("voice.") || type.startsWith("browser.") || type.startsWith("preview.") || type.startsWith("moa.")) return undefined;
  return { category: "transport", state: "drift", reasonCode: "hermes_event_unsupported" };
}
