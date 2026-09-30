import { z } from "zod";
import { MODEL_IDENTIFIER_PATTERN_V1 } from "../../domain/v1/model-identifier";

const catcher = z.object({ label: z.string().min(1).max(60), count: z.number().int().min(1) }).strict();
const scorecardWindow = z.object({ finished: z.number().int().min(0), passedFirstTime: z.number().int().min(0),
  neededFixes: z.number().int().min(0), failedOrBlocked: z.number().int().min(0),
  caughtBy: z.array(catcher).max(20) }).strict();
export const workerScorecardReadSchemaV1 = z.object({ observedAt: z.string().datetime(),
  groups: z.array(z.object({ workerKind: z.enum(["codex", "claude-code", "hermes"]),
    model: z.string().regex(MODEL_IDENTIFIER_PATTERN_V1), effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]),
    provider: z.string().min(1).max(80).nullable(), profile: z.string().min(1).max(80).nullable(),
    last7Days: scorecardWindow, last30Days: scorecardWindow }).strict()).max(200) }).strict();
export type WorkerScorecardReadV1 = z.infer<typeof workerScorecardReadSchemaV1>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export async function readWorkerScorecardV1(fetcher: FetchLike = fetch, signal?: AbortSignal): Promise<
  { state: "available"; view: WorkerScorecardReadV1 } | { state: "unavailable" }> {
  try {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const response = await fetcher("/api/v1/workers-scorecard", { method: "GET", credentials: "same-origin", cache: "no-store", signal: bounded });
    if (!response.ok) return { state: "unavailable" };
    const parsed = workerScorecardReadSchemaV1.safeParse(await response.json());
    return parsed.success ? { state: "available", view: parsed.data } : { state: "unavailable" };
  } catch { return { state: "unavailable" }; }
}
