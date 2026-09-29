import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const task = z.object({ projectId: id, jobId: id, title: z.string().min(1).max(200), since: z.string().datetime() }).strict();
const result = z.object({ projectId: id, jobId: id, title: z.string().min(1).max(200),
  status: z.enum(["succeeded", "failed", "cancelled", "orphaned"]), finishedAt: z.string().datetime() }).strict();
export const workerBoardReadSchemaV1 = z.object({ observedAt: z.string().datetime(),
  workers: z.array(z.object({ workerId: id, currentTask: task.nullable(), recentResults: z.array(result).max(3) }).strict()).max(500) }).strict();
export type WorkerBoardReadV1 = z.infer<typeof workerBoardReadSchemaV1>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export async function readWorkerBoardV1(fetcher: FetchLike = fetch, signal?: AbortSignal): Promise<
  { state: "available"; view: WorkerBoardReadV1 } | { state: "unavailable" }> {
  try {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const response = await fetcher("/api/v1/workers-board", { method: "GET", credentials: "same-origin", cache: "no-store", signal: bounded });
    if (!response.ok) return { state: "unavailable" };
    const parsed = workerBoardReadSchemaV1.safeParse(await response.json());
    return parsed.success ? { state: "available", view: parsed.data } : { state: "unavailable" };
  } catch { return { state: "unavailable" }; }
}
