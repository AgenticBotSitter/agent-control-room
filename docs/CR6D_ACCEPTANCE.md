# CR-6D acceptance record

**Status:** Complete for effect-free service, schedule, incident, and reconciliation implementation.

## Delivered

- deterministic cron, interval, and once schedule calculation with bounded windows and stable occurrence keys;
- explicit IANA timezone behavior: nonexistent spring-forward local times are skipped and repeated fall-back local times produce one occurrence at the earlier UTC instant;
- atomic tenant-scoped occurrence plus outbox materialization, exact replay, and cross-tenant isolation;
- stale outbox claim recovery, delivery retry, and restart reconciliation that marks only the delivered occurrence dispatched;
- desired-versus-observed service reconciliation that creates safe projections without starting, stopping, or repairing a service;
- durable correlated incident generations: repeated evidence updates one open incident, matching recovery resolves it, and later recurrence creates a new generation;
- stable, non-machine-changing remedy codes on every open incident; and
- one end-to-end acceptance case covering daylight-saving fallback, concurrent duplicate materialization, stale claim recovery, delivery retry, restart reconciliation, incident creation, and incident recovery.

## Verification

- TypeScript check and ESLint: passed.
- Full repository suite: 292 passed, 0 failed, 1 intentionally skipped.
- Production build and rendered-route checks: passed.
- Database verification: migrations 0001 through 0018 applied; 63 PostgreSQL tables verified.

## Boundary retained

This block creates durable internal proposals and incident projections only. It does not install or start a service, call a provider, dispatch a real job, change credentials, or perform any consequential external effect. Those operations remain separately authorized downstream work.
