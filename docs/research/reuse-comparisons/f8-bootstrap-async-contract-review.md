# F8 bootstrap async-contract independent review

2026-09-08; source-only review against checkpoint `f2bac29` and current research
additions. Read the complete harness, 30-case receipt, caller audit and actual
`private-owner-bootstrap.ts`. No rerun was necessary; no downloads, connections,
credential access, application changes or Git writes.

## Disposition

No blocking finding for this **async migration contract experiment**. The evidence
does not qualify jose/jsonwebtoken or actual PostgreSQL bootstrap safety. Preserve
the caller audit's remaining candidate-specific experiment and final security review.

The harness hashes the actual bootstrap module and Node verifier. Single-occurrence
replacements add awaits to the intended helper, transaction boundaries and command
preflight, and deliberately preserve or fix the discarded precommit return. It runs
real Node signature/claims verification using generated synthetic keys; its async
factory wraps that synchronous result in an authored await. Therefore the observed
risks belong to a possible caller migration, not a defect in the unchanged synchronous
production path or an observed behavior of either candidate library. VM execution is
not a security sandbox; the explicit fake database prevents physical connections here.

## What the controls establish

- Unadapted identity Promise is refused before entering the synthetic transaction.
  Await-only accepts valid input but allows final verification's authored time advance
  or cancellation to reach the commit counter. The added post-await checks prevent
  that counter increment. Expiry here advances to **trust expiry**; token/max-age
  expiry during this bootstrap await is not separately exercised.
- Early await-only expiry can enter a transaction before the next boundary rejects;
  the fresh variant rejects before entry. Command preflight has the analogous
  observable difference: await-only opens then closes the injected database handle,
  fresh never opens it. Valid sync and fresh commands both open once, commit once
  and close once, ruling out an always-failing command fixture.
- Discarded-precommit control really leaves the fourth verification awaiting the
  unresolved `held` promise while the outer callback returns `undefined`; the fake
  transaction awaits that return and increments its commit counter. Recorded count
  is four verifications and one commit before release. No sleep assumption is needed
  for the unresolved-promise ordering. It is then released to avoid retaining that
  pending task. This does not test a rejected discarded promise or runtime handling
  of unhandled rejection.
- Pre-existing expired/cancelled/wrong-owner controls and precommit expiry/cancel
  controls continue to reject. Direct receipt records 30 cases, exit 0 and
  0.567371708 seconds; this reviewer inspected but did not independently rerun it.

## Necessary evidence limits

`SecurityStore.bootstrapOwner` is replaced by a write counter, and SQL replies only
acknowledge synthetic database/tenant/workspace lookups. Real grant policy, nested
SecurityStore checks, transaction isolation, SQL rollback, durable commit, bounded
driver cancellation and uncertain cleanup do not run. A failed case with `writes:1`
and `commits:0` means the fake callback was invoked before rejection—not proof a real
database rolled anything back. Resource counters describe fixture calls, not observed
server resources.

The research freshness patch is illustrative, not a production-ready migration.
Clock regression across successive post-await observations, invalid identity dates,
intermediate verification cancellation, actual candidate rejection and transaction
error/close-uncertainty variants are not comprehensively covered. In particular, the
bootstrap-local high-water value still records the pre-await time; a final production
design must preserve the full monotonic-time contract, not copy the illustration on
the strength of these 30 cases. Command clock wrapping and real policy inputs must
remain separately reviewed.

Caller inventory and removal estimates are appropriately conditional: synchronous
library adoption can preserve caller signatures, while async adoption affects repeated
bootstrap verification and six identity-consuming source files. This experiment
supports that distinction, not selection of either library or all-caller readiness.

Also reviewed the subsequently added `f8-bootstrap-async-contract-fit.md`. Its
counter/connection/candidate limitations agree with the harness. “Rejects clock
rollback” describes the added source check against that verification's own pre-await
sample, not an executed rollback case or proof of a global post-await high-water
fence; read it with the limitation above. No report correction required for the
bounded contract conclusion.
