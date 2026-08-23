# CR-4B verification

**Completed:** 2026-08-22

**Result:** Pass

## Delivered

- Forward migrations `0003_canonical_domain_delivery.sql` and review-hardening `0004_cr4b_review_hardening.sql`.
- Normalized canonical tables and tenant-bound composite foreign keys.
- Payload/index mirror enforcement and append-only transition events.
- Canonical repository with initial-state enforcement, optimistic transitions, atomic job claim, attempt/epoch allocation, renewal, expiry, and retry claim.
- Durable inbox, outbox, idempotent operation result, stale-claim recovery, bounded retry, and dead-letter handling.
- Two documentation-only Hermes qualification reviews completed, semantically reviewed by Codex/Sol, and merged as PRs 3 and 4.
- Poison-message parking, acknowledgement-loss redelivery proof, canonical digest checks, expanded payload mirrors, timestamp sanity, and approval uniqueness backstops added from accepted findings.

## Verification evidence

```text
pnpm db:verify  PASS — 4 migrations, 40 tables
pnpm check      PASS
pnpm lint       PASS
pnpm test       PASS — 30 tests, 0 failures
pnpm test:build PASS — production build and 2 rendered-route tests
```

CR-4B tests cover:

- migration/table availability;
- legal, illegal, stale, and replayed transitions;
- application-store restart with durable replay;
- two simultaneous job claimants with one winner;
- one-active-lease exclusion;
- monotonic attempt numbers and epochs after expiry/retry;
- renewal version and epoch guards;
- atomic lease/attempt/job expiry handling;
- cross-tenant lineage rejection;
- payload/index mirror rejection;
- malformed digest and transition-history truncation rejection;
- monotonically increasing checkpoint declarations;
- duplicate-live-approval rejection;
- duplicate inbox delivery and conflicting body digests;
- handler rollback, durable failure counts, and poison-message parking;
- handler replay after store restart;
- idempotent result replay and key/digest collision;
- outbox claim tokens, retry timing, abandoned-claim recovery, late-ack rejection, acknowledgement replay, and dead letter;
- acknowledgement loss followed by redelivery and destination-side duplicate absorption.

## Sol review findings closed

1. Foreign keys initially relied on globally unique IDs without including the tenant boundary. They now use tenant-bound composite lineage.
2. Network authority ambiguity discovered during CR-4A remains closed by explicit destination allowlists.
3. Outbox processing claims initially lacked abandoned-claim and maximum-attempt behavior. Recovery and dead-letter paths are now implemented and tested.
4. Direct attempt/lease and coordinated job state mutations are now rejected by the generic transition API.
5. Indexed state/version columns and JSON payloads can no longer drift through direct SQL writes.
6. Hermes qualification findings were accepted with explicit disposition: CR-4B blockers are closed, CR-4C authorization findings are release gates, and real concurrency/kill-point proof remains in CR-5.

## Explicitly deferred

- actor authentication and permission enforcement;
- approval authenticity and strong-factor checks;
- canonical digest calculation and verification at boundaries;
- general secret/private-content redaction and safe-error mapping;
- audit hash chaining;
- live PostgreSQL/VPS deployment and crash/PITR drills;
- node, adapter, project, or external-provider connection.

## Next block

```text
CR-4C — Identity, authorization, policy, approval, digest verification, and redaction
Model: gpt-5.6-sol
Reasoning effort: xhigh
```
