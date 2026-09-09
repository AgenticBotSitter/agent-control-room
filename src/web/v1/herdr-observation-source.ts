import { createHerdrProjectProjection, type HerdrProjectBinding } from './herdr-observations';
import { createHash } from 'node:crypto';

/** Adaptation of the evaluated observer's epoch/freshness rules. A source is
 * operator-owned, belongs to one immutable enrollment, and has no effect ports.
 * Replacement requires revoking the old source; no raw response is retained.
 */
export function createHerdrObservationSource(input: HerdrProjectBinding, now: () => number = () => performance.now()) {
  const binding = structuredClone(input);
  const projection = createHerdrProjectProjection(binding);
  const sourceKey = createHash('sha256').update(JSON.stringify([binding.tenantId, binding.workspaceId,
    binding.projectId, binding.sourceId, binding.enrollmentRevision])).digest('hex');
  type Rows = ReturnType<typeof projection.project>;
  let epoch = 0, revoked = false, observedAt: number | null = null, lastClock = -Infinity;
  let rows: Rows = [], online = false;
  const clock = () => {
    const current = now();
    if (!Number.isFinite(current) || current < lastClock) {
      revoked = true; rows = []; observedAt = null; epoch++;
      throw new Error('observation_unavailable');
    }
    lastClock = current; return current;
  };
  const view = () => {
    const current = clock();
    return { projectId: binding.projectId,
      status: revoked ? 'not_configured' as const
        : online && observedAt !== null && current - observedAt < 5000 ? 'online' as const : 'offline' as const,
      rows: structuredClone(rows), ageMs: observedAt === null ? null : current - observedAt,
      executionAuthority: false as const, completionVerified: false as const, cleanupVerified: false as const };
  };
  return Object.freeze({
    tenantId: binding.tenantId, workspaceId: binding.workspaceId, projectId: binding.projectId, sourceKey,
    view,
    revoke() { revoked = true; epoch++; rows = []; observedAt = null; online = false; },
    disconnect() { epoch++; online = false; },
    begin() {
      if (revoked) throw new Error('observation_unavailable');
      const started = clock(), ticket = ++epoch;
      let settled = false;
      return Object.freeze({
        accept(raw: string, generation: number) {
          if (settled) throw new Error('observation_unavailable');
          settled = true;
          const current = clock();
          if (revoked || ticket !== epoch || current - started >= 5000) throw new Error('observation_unavailable');
          try {
            const projected = projection.project(raw, generation);
            rows = projected; observedAt = started; online = true;
          } catch { online = false; throw new Error('observation_unavailable'); }
        },
        fail() { if (!settled && ticket === epoch) online = false; settled = true; },
      });
    },
  });
}
export type HerdrObservationSource = ReturnType<typeof createHerdrObservationSource>;
export type HerdrObservationReader = Pick<HerdrObservationSource, 'tenantId' | 'workspaceId' | 'projectId' | 'sourceKey' | 'view'>;
