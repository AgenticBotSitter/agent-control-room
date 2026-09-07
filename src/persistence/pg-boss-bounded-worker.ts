import { z } from "zod";

type Job = { id: string; name: string; data: unknown; retryLimit: number; retryCount: number;
  state: string; policy: string; deadLetter: string | null; signal: AbortSignal };
const dispositionSchema = z.object({ disposition: z.enum(["delivered", "held"]) }).strict();
export type BoundedDeliveryDisposition = z.infer<typeof dispositionSchema>;

/** Trusted canonical service, not a native provider callback. It must re-read current
 * approval, attempt/capacity, project and node identity before delivery; record a held
 * outcome before returning held. Queue data and claiming never grant authority.
 * Return after recording delivery/hold, not after waiting for the agent or owner review. */
export type BoundedDeliveryHandler<T> = (reference: T, signal: AbortSignal) => Promise<BoundedDeliveryDisposition>;
export type BoundedRecoveryVerifier<T> = (reference: T, ordinal: number, signal: AbortSignal) => Promise<void>;
export interface PgBossBoundedWorkerClient {
  getQueue(name: string): Promise<unknown>;
  work(name: string, options: { batchSize: 1; includeMetadata: true; localConcurrency: number;
    pollingIntervalSeconds: 1 }, handler: (jobs: Job[]) => Promise<BoundedDeliveryDisposition>): Promise<string>;
  offWork(name: string, options: { id: string; wait: true }): Promise<void>;
  cancel(name: string, id: string): Promise<unknown>;
}
/** Fixed internal wrappers select this policy. Never accept it from a queued job or HTTP. */
export interface BoundedQueueProfile<T> {
  name: string; maximumRecoveries: number;
  parse(value: unknown): T;
  identify(value: T): string;
  assertQueue(value: unknown): void;
  errors: { unresolved: string; config: string; close: string };
}

/** Explicit opt-in on an already-started, dedicated pg-boss client. Uses upstream
 * pickup/concurrency/completion/shutdown, with no custom polling or retry mechanism.
 * Client/pool lifetime and infrastructure error handling belong to its caller.
 * This is not mounted in private startup and does not load any native adapter. */
export async function startPgBossBoundedWorker<T extends object>(client: PgBossBoundedWorkerClient, profile: BoundedQueueProfile<T>, input: {
  concurrency?: number; deliver: BoundedDeliveryHandler<T>; verifyRecovery?: BoundedRecoveryVerifier<T>;
}) {
  const { name, maximumRecoveries } = profile, errors = { ...profile.errors };
  const parse = profile.parse.bind(profile), identify = profile.identify.bind(profile), assertQueue = profile.assertQueue.bind(profile);
  const failed = (): never => { const error = new Error(errors.unresolved); error.stack = undefined; throw error; };
  const concurrency = input.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8 || typeof input.deliver !== "function"
    || input.verifyRecovery !== undefined && typeof input.verifyRecovery !== "function")
    throw new Error(errors.config);
  const deliver = input.deliver.bind(input);
  const verifyRecovery = input.verifyRecovery?.bind(input);
  const getQueue = client.getQueue.bind(client), work = client.work.bind(client);
  const offWork = client.offWork.bind(client), cancel = client.cancel.bind(client);
  assertQueue(await getQueue(name));
  let closing = false, active = 0, closePromise: Promise<void> | undefined;
  const stopped = new AbortController();
  const id = await work(name, { batchSize: 1, includeMetadata: true, localConcurrency: concurrency,
    pollingIntervalSeconds: 1 }, async jobs => {
    // One entry per handler avoids batch failure/retry applying to unrelated work.
    if (jobs.length !== 1) return failed();
    const job = jobs[0];
    active++;
    try {
      // Never pass automatically retried, rerouted or mismatched operational work
      // into the canonical service. Cancel only this operational row, not the task.
      let reference: T | undefined;
      try { reference = parse(job.data); } catch { /* Invalid locators never reach delivery. */ }
      let valid = reference !== undefined && job.name === name && job.retryLimit === 0
        && (job.retryCount === 0 || !!verifyRecovery && Number.isSafeInteger(job.retryCount) && job.retryCount > 0 && job.retryCount <= maximumRecoveries)
        && job.state === "active" && job.policy === "standard" && job.deadLetter == null;
      try { valid = valid && job.id === identify(reference!); } catch { valid = false; }
      if (!valid || !reference) { await cancel(name, job.id); return failed(); }
      // This is a shared operational queue. The trusted handler resolves the
      // reference's tenant through canonical authorization; do not discard another
      // tenant's valid job because a worker happens to serve one browser session.
      assertQueue(await getQueue(name));
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
        await offWork(name, { id, wait: true });
        if (active !== 0) throw new Error(errors.close);
      })();
      return closePromise;
    },
  });
}
