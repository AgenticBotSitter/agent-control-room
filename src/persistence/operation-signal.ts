import { AsyncLocalStorage } from "node:async_hooks";

// Cancellation context only, never identity, credentials or execution authority.
// Node's existing async-context mechanism also backs our pg-boss transaction bridge.
const signals = new AsyncLocalStorage<AbortSignal>();

export function databaseOperationSignal(): AbortSignal | undefined { return signals.getStore(); }

/** Used by the owning database driver; joined transaction wrappers inherit it. */
export function withDatabaseOperationSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return signals.run(signal, work);
}
