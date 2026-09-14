// In-process idempotency-replay cache for the project-coordination HTTP surface.
//
// The coordination lifecycle uses Idempotency-Key as a request-identity guard
// so that a retried POST after a transient network failure does not re-run
// the canonical engine. This module is a fakes-only implementation: an
// in-process TTL map that returns the prior outcome for any request whose
// (key, projectId, subaction, identitySubject) tuple matches an active entry.
//
// Production deployments MUST replace this layer with a canonical
// store-backed replay table (see review item #3). The API surface is shaped
// to match a SQL-backed implementation so the swap is a one-line change.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

/** A replayable outcome cached from a prior lifecycle POST. */
export interface CachedCoordinationOutcome {
  status: number;
  body: unknown;
  storedAtMs: number;
  expiresAtMs: number;
}

/** Composite cache key. The four-tuple prevents accidental cross-tenant or cross-action replay. */
export interface IdempotencyCacheKey {
  idempotencyKey: string;
  projectId: string;
  subaction: string;
  identitySubject: string;
}

export function buildIdempotencyCacheKey(key: IdempotencyCacheKey): string {
  return `${key.idempotencyKey}\n${key.projectId}\n${key.subaction}\n${key.identitySubject}`;
}

export interface IdempotencyReplayCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  clock?: () => number;
}

export class IdempotencyReplayCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, CachedCoordinationOutcome>();

  constructor(options: IdempotencyReplayCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = options.clock ?? Date.now;
  }

  /** Returns the cached outcome if one is active for the key, otherwise null. */
  lookup(key: IdempotencyCacheKey): CachedCoordinationOutcome | null {
    const composite = buildIdempotencyCacheKey(key);
    const entry = this.entries.get(composite);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.clock()) {
      this.entries.delete(composite);
      return null;
    }
    return entry;
  }

  /** Stores the outcome for the key. */
  record(key: IdempotencyCacheKey, status: number, body: unknown): CachedCoordinationOutcome {
    const now = this.clock();
    const entry: CachedCoordinationOutcome = {
      status,
      body,
      storedAtMs: now,
      expiresAtMs: now + this.ttlMs,
    };
    this.evictIfFull();
    this.entries.set(buildIdempotencyCacheKey(key), entry);
    return entry;
  }

  /** Clears every entry. Used by tests and by the controller's "reset" hook. */
  clear(): void {
    this.entries.clear();
  }

  /** Visible for tests. */
  size(): number {
    return this.entries.size;
  }

  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    // Drop the oldest by storedAtMs. The Map iteration order is insertion
    // order, which is sufficient for TTL eviction under the LRU cap.
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
