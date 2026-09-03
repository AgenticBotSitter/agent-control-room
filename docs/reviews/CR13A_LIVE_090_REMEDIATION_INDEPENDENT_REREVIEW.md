# CR13A-LIVE-090 remediation independent re-review

## Scope and independence

- Integration base: `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
- Rejected target: `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
- Rejected implementation: `5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`
- Remediation implementation: `28a1c0833e8e2b2b3368644536b7442c96bbadcb`
- Remediation review target: `89be9d7fb486a3fb5855402073466108a19a75ec`
- Original packet SHA-256: `88dc35513f595fc08b75b0136bb20c7addb46bbcc8f837a265cd5df25c81d97f`
- Negative report SHA-256: `0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`
- Remediation packet SHA-256: `5be8352094f95217c35ff171181d5a3494ed5fff67d4cf11e9dc82d67dbdcc36`
- Reviewer: `/root/cr13a_live090_remediation_rereview`, different from the producer and first reviewer.
- Mode: independent, zero-repair, report only.

The review used a detached disposable local clone at the exact remediation target. No product or shared-checkout file was edited, repaired, committed, or pushed.

## Original finding closure

M-001 is closed. `finish()` during an in-flight admission now returns a non-mutating `state_conflict` before runtime-custody checks or evidence cleanup. Asynchronous contention and synchronous admission-method re-entry both preserved the original call, receiver, exact one-call count, ordered cleanup, and final correlated receipt.

## Findings

### High

None.

### Medium

#### M-002 — A malformed rejected native Promise can escape through strict Node rejection handling

Evidence: `src/connection-registry/v1/private-loopback-listener-session.ts:106-123` and `:338-340`.

An already-rejected same-realm native Promise bearing an own ordinary data property named `constructor` is rejected as malformed, but its rejection is not observed. Under strict Node rejection policy, the bounded subprocess terminated with status `1` from an unhandled rejection instead of returning only the session’s safe local failure.

The reproduction used this inert descriptor:

- property: `constructor`
- `configurable: true`
- `enumerable: false`
- `writable: false`
- value: the active realm’s native `Promise` constructor—the same native constructor captured when the module loaded, not another value.

This requires a malformed in-process admission collaborator result rather than a remote frame alone, so severity is Medium.

Required remediation: ensure every admitted same-realm rejected-Promise shape has bounded rejection ownership without reading or executing supplied getters, then add strict-process regressions for inert constructor data properties and hostile constructor/accessor cases. Foreign thenables, Proxies, subclasses, and supplied behavior must remain unassimilated and inert.

### Low

None.

## Required command outcomes

- macOS stage zero: passed, `ready_for_runtime_check`; no native attempt.
- `pnpm run check`: passed.
- `pnpm run lint`: passed.
- `pnpm run test:cr13a-listener-session`: passed, 43/43.
- `pnpm run test:cr13a-connections`: passed, 85/85.
- `pnpm test`: passed:
  - pretests: 769/769;
  - core: 419/421, with two established platform skips;
  - posttests: 336/336.
- `pnpm run test:build`: passed; production build and 4/4 rendered checks.
- `pnpm run db:verify`: failed at the documented sandbox boundary because `tsx` received `listen EPERM` while creating its local IPC pipe.
- `node --import tsx scripts/verify-migrations.ts`: passed; migrations `0001`–`0036`, 119 PostgreSQL tables.
- Base-to-target and narrow-remediation `git diff --check`: passed.

The final general hostile matrix passed 9/9. Preliminary private-probe failures caused by reviewer-harness assertions were preserved during execution and corrected only in the disposable probe; no product file changed. The separate strict-process probe reproduced M-002.

## Mandatory remediation answers

1. **Yes.** During `admitting`, `finish()` rejects before runtime assertion or state/evidence mutation.
2. **Yes.** Synchronous admission re-entry is contained; receiver binding and exactly one admission call are preserved.
3. **Yes.** Finish, abort, close, drain, frame push, and repeated completion remain non-mutating while the intrinsic Promise is pending.
4. **Yes.** After rejected contention, the first call can settle and complete exact close/drain/listener-close ordering with one receipt.
5. **Yes.** Post-await runtime drift fails terminally without executing the replacement; the early finish guard preserves that behavior.
6. **No overall.** The established terminal paths remain bounded, but M-002 permits strict-process termination for the described malformed rejected Promise.
7. **Yes.** Raw frames, delivery IDs, signatures, locator material, credentials, and arbitrary downstream text remain absent from retained state, errors, and receipts.
8. **Yes.** Receipt construction binds the declared correlations and fixes all native/effect/authority facts to false. Public digest recomputation grants no authority.
9. **Yes.** No listener, socket, SSH, timer, route, credential operation, provider call, production database contact, deployment, or network effect exists in this target.
10. **No overall.** All deterministic gates, M-001 regressions, disposal checks, and other hostile probes passed, but M-002 remains an open Medium defect.

## Effects and cleanup

No application, listener, port, SSH connection, credential store, Hermes/provider, production database, deployment, DNS, hosting, or external network was contacted. No installation or download occurred.

Disposable directory `/private/tmp/cr13a-live-090-remediation-review.o7QovS` was removed and its absence confirmed. The shared checkout remained clean at `0534ab4c5f25d549bb51e18fcc2abf69a05e313d`.

This report grants no integration, listener, connection, SSH, credential, native, provider, production, deployment, DNS, public-hosting, or network authority.

**Disposition: rejected**
