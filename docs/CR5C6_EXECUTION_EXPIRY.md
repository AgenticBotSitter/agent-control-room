# CR-5C.6 execution-time expiry and cancellation state machine

**Status:** Implemented  
**Date:** 2026-08-23  
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md` and ADR-035  
**Scope:** Deterministic effective deadlines, local authority revocation, cancellation requests, pre-effect rechecks, and restart classification

## Outcome

Execution authority is now a durable node-local object rather than an implication of an earlier accepted decision. Its effective deadline is the earliest of the ceiling/authority duration limit measured from admission, authority expiry, lease expiry, optional approval expiry, and optional executor-reservation expiry. Every tied limiting source is retained as evidence. Deadline equality is expired; there is no grace state.

The pure transition machine permits admission, execution, an optional advisory `expiring_soon` state, cancellation request, expiry, and explicit terminal settlement. It rejects time-moving-backwards events, starting at or after the deadline, stale lease epochs, mid-attempt authority replacement, renewal at or after expiry, and every attempted transition out of a terminal state. A valid pre-expiry lease renewal can alter only the lease-expiry clamp. It cannot change the immutable duration, authority, approval, or reservation clamps.

The monitor is deliberately an observer rather than a timer or decision maker. Given a durable snapshot and injected clock instant, it emits either no signal, an explicitly configured advisory signal, or a deadline-crossed signal. Crossing the deadline immediately moves local authority to `expired`. If work was in flight, the same durable transition records that cancellation must be requested. This code does not deliver that cancellation or invoke an executor.

## Durable state and restart behavior

`SqliteExecutionStateStore` requires a filesystem path outside explicit tests and uses WAL, full synchronous writes, foreign keys, an immediate transaction, and optimistic snapshot versions. Creation is idempotent against an immutable creation digest even after the execution has advanced. Event IDs are idempotent only for identical event content; conflicting reuse fails closed.

The current snapshot and its query mirrors are digest-checked on every load. Event content and transition metadata have separate digests, chronological rows form a checked state chain, and the final history state must match the current snapshot. Malformed JSON, mirror drift, broken history, or reused IDs produce only `ExecutionStateConflictError`.

Restart classification is conservative:

- `admitted` requires a fresh pre-effect recheck;
- `executing`, `expiring_soon`, or `cancellation_requested` requests cancellation;
- `expired` remains expired, and retains any outstanding cancellation request; and
- settled terminal states require no action.

Effect-fired ambiguity cannot be resolved honestly until durable effect claims and pre-effect markers exist, so that narrower classification remains the CR-5C.8 boundary.

## Pre-effect seam

`recheckBeforeExternalEffect` is a pure fail-closed guard for the future executor wrapper. Immediately before an external effect it requires:

1. an executing, nonterminal state;
2. a clock instant strictly before the effective deadline;
3. currently available protected key material;
4. an unchanged normalized operation digest;
5. no local pause; and
6. an already held, unambiguous effect claim.

The claim state is an input seam only. This slice does not create a claim, write a pre-effect marker, consume an approval, or perform an effect.

## Deliberate stop boundary

This slice does not add native timers, executor dispatch, cancellation transport, target I/O, effect claims, pre-effect markers, tombstones, ambiguity settlement, approval consumption/issuance, cost/concurrency reservations, platform key providers, or live deployment. Execution-state construction is not yet wired to the bridge because later reservation and effect-claim transactions must close that boundary without creating a second dispatch path.

## Verification

`tests/node-execution-authority.test.ts` covers minimum/tied deadlines, exact equality, explicit advisory thresholds, idle versus in-flight expiry, cancellation evidence, renewal narrowing/extension, stale epochs, authority-digest replacement, permanent no-resurrection, every pre-effect mutable recheck, durable restart, duplicate/conflicting events, late creation replay, production path requirements, and persisted mirror tampering.

The repository completion gate is `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.
