# CR-4A verification

**Completed:** 2026-08-22

**Block:** Canonical domain contracts and state machines

**Result:** Pass

## Delivered

- `control-room-domain/v1` TypeScript contracts for request, workflow, job, attempt, lease, checkpoint, effect intent, approval, service, schedule, incident, artifact manifest, node, and message envelope.
- Strict Zod runtime validators with record-local invariants.
- Generated Draft 2020-12 JSON Schema and an equality test that detects schema drift.
- Explicit, exhaustive transition tables for every lifecycle.
- Parent/child authority comparison that fails on project, executor, operation, credential, network destination, effect, duration, cost, expiry, or parent-digest expansion.
- State-machine guard and cross-record invariant specification for CR-4B.

## Verification evidence

```text
pnpm domain:generate  PASS
pnpm check            PASS
pnpm test             PASS — 20 tests, 0 failures
```

The suite validates all 13 domain entity variants, exhaustive transition rows, terminal job states, retry/orphan paths, authority narrowing, project-bound authority, approval requirements for high-risk effects, signed-credential rejection in artifact locators, message expiry, and generated-schema equality.

## Sol review finding closed

The initial draft represented network authority with ambiguous ordinal labels. Before acceptance it was replaced with `none | allowlist` plus explicit destination references and parent-subset enforcement. This prevents a child job from interpreting a vague network class more broadly than its parent.

## Explicitly not delivered

- PostgreSQL tables or repositories;
- transactional optimistic concurrency;
- lease claims or epoch enforcement in storage;
- inbox/outbox delivery;
- authentication, authorization, owner approval verification, or redaction implementation;
- node enrollment or any live external effect.

Those remain gated to CR-4B and CR-4C.

## Next block

```text
CR-4B — PostgreSQL migrations, repositories, leases, inbox/outbox, and idempotency
Model: gpt-5.6-sol
Reasoning effort: xhigh
```
