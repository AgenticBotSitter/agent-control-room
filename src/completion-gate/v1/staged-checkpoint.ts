import { parseRollbackCheckpointV1, rollbackCheckpointDigestV1,
  type RollbackCheckpointStoreV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";

/** Transaction-local buffering, not durable checkpoint storage. The caller must retain the SQL
 * integrity lock and flush only after its final authority checks, immediately before commit. */
export function stageCompletionCheckpoint(store: RollbackCheckpointStoreV1, tenantId: string, maxAdvances = 2) {
  if (!Number.isSafeInteger(maxAdvances) || maxAdvances < 1 || maxAdvances > 50) throw new Error("review_checkpoint_unavailable");
  const scope = `completion-gate:${tenantId}`, read = store.read.bind(store), advance = store.advance.bind(store);
  let known: RollbackCheckpointV1 | undefined, loaded = false, closed = false;
  const pending: { expected: string; next: RollbackCheckpointV1 }[] = [];
  const fail = () => { throw new Error("review_checkpoint_unavailable"); };
  const requireOpen = () => { if (closed) fail(); };
  const current = () => {
    requireOpen();
    if (!loaded) { loaded = true; const value = read(scope); known = value ? parseRollbackCheckpointV1(value) : undefined;
      if (known && known.scope !== scope) fail(); }
    return known;
  };
  const checkpoints: RollbackCheckpointStoreV1 = Object.freeze({
    read(requested: string) { if (requested !== scope) return fail(); const value = current(); return value ? { ...value } : undefined; },
    initialize: fail,
    advance(expected: string, value: RollbackCheckpointV1) {
      const previous = current(), next = parseRollbackCheckpointV1(value);
      if (!previous || next.scope !== scope || expected !== rollbackCheckpointDigestV1(previous)
        || next.revision !== previous.revision + 1 || pending.length >= maxAdvances) return fail();
      pending.push({ expected, next: { ...next } }); known = { ...next };
    },
  });
  return Object.freeze({ checkpoints, flush() {
    requireOpen(); closed = true;
    // Exactly the existing CAS sequence. A partial/uncertain flush is not repaired or retried.
    try {
      for (const item of pending) {
        const outcome: unknown = advance(item.expected, { ...item.next });
        // TypeScript permits async functions in void-returning slots. This port is
        // synchronous: a Promise is not a completed CAS and must never permit SQL
        // commit. Observe any late rejection, but do not retry or continue the batch.
        if (outcome !== undefined) { void Promise.resolve(outcome).catch(() => {}); fail(); }
      }
    } catch { fail(); }
  } });
}
