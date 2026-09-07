import { parseRollbackCheckpointV1, type AwaitableRollbackCheckpointStoreV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";
import { stageCompletionCheckpoint } from "./staged-checkpoint";
import { databaseOperationSignal } from "../../persistence/operation-signal";

/** Reuses the synchronous stage's scope/CAS/batch checks. External reads are lazy,
 * under the caller's SQL integrity lock; external writes run only in awaited flush.
 * This buffers one transaction, not durable storage or a retry/recovery engine. */
export function stageAsyncCompletionCheckpoint(store: AwaitableRollbackCheckpointStoreV1, tenantId: string, maxAdvances = 2) {
  if (!Number.isSafeInteger(maxAdvances) || maxAdvances < 1 || maxAdvances > 50) throw new Error("review_checkpoint_unavailable");
  const scope = `completion-gate:${tenantId}`, read = store.read.bind(store), advance = store.advance.bind(store);
  const pending: { expected: string; next: RollbackCheckpointV1 }[] = [];
  let closed = false, operations = 0, stage: Promise<ReturnType<typeof stageCompletionCheckpoint>> | undefined;
  let signal: AbortSignal | undefined;
  const fail = (): never => { throw new Error("review_checkpoint_unavailable"); };
  const requireActive = () => { if (signal?.aborted) fail(); };
  const requireOpen = () => { requireActive(); if (closed) fail(); };
  const load = () => stage ??= (async () => {
    signal = databaseOperationSignal(); requireActive();
    const value = await read(scope, signal); requireOpen();
    const snapshot = value === undefined ? undefined : parseRollbackCheckpointV1(value);
    if (snapshot && snapshot.scope !== scope) return fail();
    return stageCompletionCheckpoint({ read: () => snapshot, initialize: fail,
      advance(expected, next) { pending.push({ expected, next: { ...next } }); } }, tenantId, maxAdvances);
  })();
  async function withStage<T>(work: (value: ReturnType<typeof stageCompletionCheckpoint>) => T): Promise<T> {
    requireOpen(); operations++;
    try { const value = await load(); requireOpen(); return work(value); }
    catch { closed = true; return fail(); }
    finally { operations--; }
  }
  const checkpoints = Object.freeze({
    async read(requested: string) {
      if (requested !== scope) return fail();
      return withStage(value => value.checkpoints.read(requested));
    },
    initialize: fail,
    async advance(expected: string, next: RollbackCheckpointV1) {
      const snapshot = parseRollbackCheckpointV1(next);
      await withStage(value => value.checkpoints.advance(expected, snapshot));
    },
  } satisfies AwaitableRollbackCheckpointStoreV1);
  return Object.freeze({ checkpoints, async flush(assertCurrent: () => void | Promise<void> = () => {}) {
    requireOpen(); closed = true;
    // Unawaited reads/writes must not become a successful empty flush.
    if (operations) return fail();
    if (!stage) return;
    try {
      await assertCurrent();
      (await stage).flush();
      for (const item of pending) {
        await assertCurrent();
        requireActive();
        await advance(item.expected, { ...item.next }, signal);
        requireActive();
        await assertCurrent();
      }
    } catch { fail(); }
  } });
}
