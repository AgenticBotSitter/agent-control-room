import { z } from "zod";
import { MAX_NATIVE_UNSENT_RECOVERIES, nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference } from "./native-task-submission";
import { assertPgBossNativeQueue, nativeTaskSubmissionId, PG_BOSS_NATIVE_SUBMISSION as spec } from "./pg-boss-native-task-submission";

type Job = { id: string; name: string; data: unknown; retryLimit: number; retryCount: number;
  state: string; policy: string; deadLetter: string | null; signal: AbortSignal };
const dispositionSchema = z.object({ disposition: z.enum(["delivered", "held"]) }).strict();
export type NativeDeliveryDisposition = z.infer<typeof dispositionSchema>;

/** Trusted canonical service, not a native provider callback. It must re-read current
 * approval, attempt/capacity, project and node identity before delivery; record a held
 * outcome before returning held. Queue data and claiming never grant authority.
 * Return after recording delivery/hold, not after waiting for the agent or owner review. */
export type NativeTaskDeliveryHandler = (reference: NativeTaskSubmissionReference, signal: AbortSignal) => Promise<NativeDeliveryDisposition>;
export type NativeTaskRecoveryVerifier = (reference: NativeTaskSubmissionReference, ordinal: number, signal: AbortSignal) => Promise<void>;
export interface PgBossNativeWorkerClient {
  getQueue(name: string): Promise<unknown>;
  work(name: string, options: { batchSize: 1; includeMetadata: true; localConcurrency: number;
    pollingIntervalSeconds: 1 }, handler: (jobs: Job[]) => Promise<NativeDeliveryDisposition>): Promise<string>;
  offWork(name: string, options: { id: string; wait: true }): Promise<void>;
  cancel(name: string, id: string): Promise<unknown>;
}
const failed = (): never => {
  const error = new Error("native_task_delivery_unresolved");
  error.stack = undefined; // pg-boss serializes errors; do not retain local paths or upstream details.
  throw error;
};

/** Explicit opt-in on an already-started, dedicated pg-boss client. Uses upstream
 * pickup/concurrency/completion/shutdown, with no custom polling or retry mechanism.
 * Client/pool lifetime and infrastructure error handling belong to its caller.
 * This is not mounted in private startup and does not load any native adapter. */
export async function startPgBossNativeTaskWorker(client: PgBossNativeWorkerClient, input: {
  concurrency?: number; deliver: NativeTaskDeliveryHandler; verifyRecovery?: NativeTaskRecoveryVerifier;
}) {
  const concurrency = input.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8 || typeof input.deliver !== "function"
    || input.verifyRecovery !== undefined && typeof input.verifyRecovery !== "function")
    throw new Error("native_task_worker_config_invalid");
  const deliver = input.deliver.bind(input);
  const verifyRecovery = input.verifyRecovery?.bind(input);
  const getQueue = client.getQueue.bind(client), work = client.work.bind(client);
  const offWork = client.offWork.bind(client), cancel = client.cancel.bind(client);
  assertPgBossNativeQueue(await getQueue(spec.name));
  let closing = false, active = 0, closePromise: Promise<void> | undefined;
  const stopped = new AbortController();
  const id = await work(spec.name, { batchSize: 1, includeMetadata: true, localConcurrency: concurrency,
    pollingIntervalSeconds: 1 }, async jobs => {
    // One entry per handler avoids batch failure/retry applying to unrelated work.
    if (jobs.length !== 1) return failed();
    const job = jobs[0];
    active++;
    try {
      // Never pass automatically retried, rerouted or mismatched operational work
      // into the canonical service. Cancel only this operational row, not the task.
      const parsed = nativeTaskSubmissionReferenceSchema.safeParse(job.data);
      let valid = parsed.success && job.name === spec.name && job.retryLimit === 0
        && (job.retryCount === 0 || !!verifyRecovery && Number.isSafeInteger(job.retryCount) && job.retryCount > 0 && job.retryCount <= MAX_NATIVE_UNSENT_RECOVERIES)
        && job.state === "active" && job.policy === "standard" && job.deadLetter == null;
      try { valid = valid && job.id === nativeTaskSubmissionId(parsed.data!); } catch { valid = false; }
      if (!valid) { await cancel(spec.name, job.id); return failed(); }
      const reference = parsed.data!;
      // This is a shared operational queue. The trusted handler resolves the
      // reference's tenant through canonical authorization; do not discard another
      // tenant's valid job because a worker happens to serve one browser session.
      assertPgBossNativeQueue(await getQueue(spec.name));
      if (closing || !(job.signal instanceof AbortSignal) || job.signal.aborted) return failed();
      const signal = AbortSignal.any([job.signal, stopped.signal]);
      if (job.retryCount > 0) await verifyRecovery!(Object.freeze(reference), job.retryCount, signal);
      if (signal.aborted || closing) return failed();
      const result = dispositionSchema.parse(await deliver(Object.freeze(reference), signal));
      // An ignored cancellation cannot turn a late return into a successful receipt.
      if (signal.aborted || closing) return failed();
      return result;
    } catch { return failed(); }
    finally { active--; }
  });
  return Object.freeze({
    isAccepting: () => !closing,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true; stopped.abort();
      closePromise = (async () => {
        // pg-boss stops admission and drains this returned worker group. The owning
        // startup must bound this call and close its dedicated client on uncertainty;
        // resolving offWork is not proof an uncooperative native process stopped.
        await offWork(spec.name, { id, wait: true });
        if (active !== 0) throw new Error("native_task_worker_close_uncertain");
      })();
      return closePromise;
    },
  });
}
