import { z } from "zod";
import { assertNoSecretMaterial, sha256Digest } from "../../security";

const finiteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).catch(0);
const time = z.string().datetime({ offset: true });
const statusSchema = z.object({ version: z.string().min(1).max(80), active_session_count: finiteCount.optional(), active_sessions: finiteCount.optional(), gateway: z.object({ status: z.string().max(80).optional(), running: z.boolean().optional() }).passthrough().optional() }).passthrough();
const sessionSchema = z.object({ id: z.string().min(1).max(500), status: z.string().max(80).optional(), updated_at: time.optional(), input_tokens: finiteCount.optional(), output_tokens: finiteCount.optional(), cache_read_tokens: finiteCount.optional(), reasoning_tokens: finiteCount.optional() }).passthrough();
const cronSchema = z.object({ id: z.string().min(1).max(500), enabled: z.boolean().optional(), status: z.string().max(80).optional(), next_run_at: time.optional() }).passthrough();
const usageSchema = z.object({ input_tokens: finiteCount.optional(), output_tokens: finiteCount.optional(), cache_read_tokens: finiteCount.optional(), reasoning_tokens: finiteCount.optional() }).passthrough();

export interface HermesServeSnapshotInputV1 { status: unknown; sessions: unknown; cronJobs: unknown; usage: unknown; }
export interface HermesServeProjectionV1 {
  harnessVersion: string;
  gatewayState: "running" | "stopped" | "degraded" | "unknown";
  activeSessionCount: number;
  sessions: Array<{ sessionKeyDigest: string; state: "running" | "waiting" | "completed" | "failed" | "unknown"; updatedAt?: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number } }>;
  cronJobs: Array<{ jobKeyDigest: string; state: "active" | "paused" | "failed" | "unknown"; nextRunAt?: string }>;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number };
}

export function projectHermesServeSnapshotV1(input: HermesServeSnapshotInputV1, scope: { tenantId: string; nodeId: string }): HermesServeProjectionV1 {
  const status = statusSchema.parse(input.status);
  const sessions = z.array(sessionSchema).max(100).parse(input.sessions);
  const cronJobs = z.array(cronSchema).max(500).parse(input.cronJobs);
  const usage = usageSchema.parse(input.usage);
  const result: HermesServeProjectionV1 = {
    harnessVersion: status.version,
    gatewayState: gatewayState(status.gateway),
    activeSessionCount: status.active_session_count ?? status.active_sessions ?? sessions.filter((session) => normalizeSessionState(session.status) === "running").length,
    sessions: sessions.map((session) => ({
      sessionKeyDigest: opaqueDigest(scope,"session",session.id), state: normalizeSessionState(session.status), ...(session.updated_at ? { updatedAt: session.updated_at } : {}),
      usage: { inputTokens: session.input_tokens ?? 0, outputTokens: session.output_tokens ?? 0, cachedInputTokens: session.cache_read_tokens ?? 0, reasoningTokens: session.reasoning_tokens ?? 0 },
    })),
    cronJobs: cronJobs.map((job) => ({ jobKeyDigest: opaqueDigest(scope,"cron",job.id), state: normalizeCronState(job), ...(job.next_run_at ? { nextRunAt: job.next_run_at } : {}) })),
    usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cachedInputTokens: usage.cache_read_tokens ?? 0, reasoningTokens: usage.reasoning_tokens ?? 0 },
  };
  assertNoSecretMaterial(result, "Hermes serve projection");
  return result;
}

function opaqueDigest(scope: { tenantId: string; nodeId: string }, kind: string, raw: string): string { return sha256Digest({ ...scope, adapterId: "adapter.hermes.gateway.v1", kind, raw }); }
function gatewayState(gateway: z.infer<typeof statusSchema>["gateway"]): HermesServeProjectionV1["gatewayState"] {
  if (gateway?.running === true || gateway?.status === "running") return "running";
  if (gateway?.running === false || gateway?.status === "stopped") return "stopped";
  if (gateway?.status === "degraded") return "degraded";
  return "unknown";
}
function normalizeSessionState(value?: string): HermesServeProjectionV1["sessions"][number]["state"] {
  if (value === "running" || value === "active") return "running"; if (value === "waiting" || value === "waiting_input" || value === "waiting_approval") return "waiting";
  if (value === "completed" || value === "succeeded") return "completed"; if (value === "failed" || value === "error") return "failed"; return "unknown";
}
function normalizeCronState(job: z.infer<typeof cronSchema>): HermesServeProjectionV1["cronJobs"][number]["state"] {
  if (job.status === "failed" || job.status === "error") return "failed"; if (job.enabled === false || job.status === "paused") return "paused"; if (job.enabled === true) return "active"; return "unknown";
}
