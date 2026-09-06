# E14 — explicit producer startup and ownership

2026-09-06. Local composition, no database/agent activation.

Private task bootstrap accepts an explicit coordinator `nativeQueue: true` only with
approval configuration and an injected trusted producer factory. There is no default
factory, dependency installation or package loading. All configured database roles
pass E13's queue-aware checks before producer preparation. The resulting scoped
submission operation is server-side only, not installed as an HTTP endpoint.

Preparation is bounded to five seconds. Timeout fences later SQL, denies installation
and reports cleanup uncertainty. A late returned producer is closed. A rejected
factory without a returned handle is also uncertain: bootstrap cannot prove disposal
of resources the factory acquired internally. No automatic retry or replacement.

The owned coordinator captures optional producer close, drains admitted operations,
then attempts bounded producer stop before closing its SQL pool. Stop failure does
not skip pool cleanup. Bootstrap memoizes producer close across application-construction
and installer failures; repeated closes do not retry effects. This supersedes E12's
external-only producer cleanup contract when an owned close method is supplied.

## Evidence

- 38 combined actual pg-boss/PGlite checks pass, including startup with the pinned
  package after real catalog preflight, successful canonical submission, installer
  failure, preparation rejection, close failure and late preparation after timeout.
- 28 coordinator lifecycle/startup checks pass. The enqueue-drain test asserts that
  producer close runs once before pool close; invalid queue configuration opens nothing.
- Typecheck, targeted lint and whitespace checks pass.

The first expanded close-failure test expected the coordinator's internal error code;
the private application correctly returned its existing cleanup-uncertain code. The
test expectation and teardown were corrected; runtime uncertainty was not weakened.
PGlite's existing TEMP-metadata substitution remains explicit in the startup fixture.

## Still open

The production singleton has no producer factory and cannot activate this option.
Pinned package adoption, queue schema/version acceptance, real PostgreSQL qualification,
worker LOGIN/settings/bootstrap and current-authority delivery routing remain open.
Browser submission and a live owner task journey are not claimed. No new download,
GitHub publication, native database, listener, credentials or provider call.
