# E17 — explicit verified worker startup

2026-09-06. Local composition; no production default or native service.

`createNativeQueueWorkerBootstrap` connects E16 identity/preflight to E09/E11 owned
runtime. A trusted caller supplies the pinned constructor, bounded pool factory,
application primary/login inventory and current-authority delivery handler. Import
opens nothing. Configuration rejects a different primary, a shared login, malformed
application login inventory and invalid concurrency before opening a resource.

The bootstrap snapshots configuration/callbacks, permits one attempt, verifies the
dedicated pool and transfers its memoized close to the runtime. Five-second preflight
and cleanup bounds retain uncertainty on timeout. Guarded preflight and runtime SQL
refuse work after close or pool unavailability. Late preflight callbacks cannot query
the closed pool. Runtime startup cleanup uncertainty is preserved, not relabeled a
simple startup failure. No custom queue polling/supervision was added.

## Evidence

- 45 queue unit checks pass, including invalid-topology zero-open cases and a timed-out
  preflight whose late callback executes zero SQL; the pool closes exactly once.
- 42 combined actual-package/PGlite checks pass. The dedicated LOGIN test now enters
  through the bootstrap, verifies failure cleanup with a missing worker grant, restores
  the grant, starts one worker, handles a synthetic job and closes once per attempt.
- Typecheck, targeted lint and whitespace validation pass. Initial TypeScript forwarding
  signatures lost the generic query result type; corrected without runtime casts.

These tests retain E16's PGlite TEMP substitution and single-engine identity limitations.
No real socket, independent physical pool, provider or fleet acceptance is claimed.

## Remaining integration

This is an explicit worker startup routine, not a mounted production worker. The host
composition must supply the complete application login inventory and bind delivery to
current canonical authorization, then coordinate worker shutdown before application
services disappear. Browser submission, full queue-schema acceptance, pinned production
dependency adoption, real PostgreSQL and owner task acceptance remain open.
No download, credentials, native service, deployment or GitHub publication.
