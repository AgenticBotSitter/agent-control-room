# CR13A-LIVE-180 unwired retained-resource driver port boundary

**Status:** effect-free architecture frozen; implementation verification pending
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Base:** merged `main` at `4f0970bfc1c453934f5b860f0057c8c5db79bb0a`
**Accepted LIVE-170 product:** `7e76e1980541075f9a1fa45479d20f06a823ef29`
**Accepted LIVE-170 review SHA-256:**
`3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381`

## Decision

LIVE-180 implements only the repository side of a future physical-driver handoff port. The port is a module-private,
single-use state machine that proves the required ordering with a non-production resource fake:

1. The custody side prepares one privately branded fake resource.
2. The driver port accepts that exact fake once without replacing it.
3. Handoff settlement is serialized before cleanup.
4. Definite rejection before acceptance and uncertainty after acceptance remain distinct terminal truth.
5. Cleanup is mandatory; cleanup failure remains terminal until a no-reopen recovery observation closes it.
6. The fake records continuous identity, one spend, no retry, and no second resource.

The public surface returns only fixed, sanitized state and counts. It never returns a resource, locator, address, port,
handle, capability, native error, or host identity. Private fake identity is held only by module-private weak collections.

## Allowed repository scope

- One immutable implementation description.
- One exact repository-fake factory with four fixed scenarios.
- One frozen driver surface with `prepare`, `handoff`, `status`, `close`, and `recover`.
- Exact provenance parsers for implementation and status.
- Hostile tests for substitution, sequence, concurrency, cleanup, replay, receiver, ambient replacement, privacy,
  non-wiring, and zero effects.
- Acceptance and independent-review records.

## Forbidden scope

This block must not import a native backend or the accepted physical driver, create or inspect a native resource, select
or expose an address/port, bind/listen/connect, close a real resource, issue a real capability, persist a live spend,
wire an application/runtime consumer, clear the custody blocker, assemble a qualification candidate, perform a physical
attempt, contact a provider, or grant production authority.

The fake may increment only simulation counters. Every actual host, port, native-resource, listener, socket, timer,
network, protected-value, and external-effect counter remains zero. `driverReservationHandoffGapPresent` and
`exclusivePortCustodyMissing` remain true because no real native driver seam exists.

## State and failure rules

- `created -> prepared -> accepted -> closed_verified` is the one successful fake path.
- A definite pre-acceptance rejection becomes `failed_before_acceptance` and cannot hand off again.
- Uncertainty after the acceptance boundary becomes `ambiguous_after_acceptance`; it cannot retry and must clean up.
- Cleanup failure becomes `cleanup_failed`; recovery may only observe/complete close and cannot reopen or re-handoff.
- Concurrent calls collapse behind the same in-flight operation. Close never races ahead of an unsettled handoff.
- Every terminal result is stable on replay and no path can create a second resource or second spend.

## Acceptance

Acceptance requires immutable product identity, stage zero, TypeScript, lint, focused and aggregate CR13A tests, the
complete lifecycle, production build/render checks, migration verification, whitespace validation, and a different
independent report-only review with no open High, Medium, or Low finding. Acceptance permits ordinary integration only.
