# E33 — compiled queue startup acceptance

2026-09-06. Local built artifact and disposable PGlite tests only.

The actual-package submission suite now supports explicit
`CR_REUSE_COMPILED_STARTUP=1`, selecting the existing built taskBootstrap export rather
than its source module. It does not build, download, install or open a listener itself.
This makes the same startup/HTTP/recovery/cleanup assertions reusable against packaging.

Command (after `node scripts/build-vps.mjs`):

```sh
CR_REUSE_COMPILED_STARTUP=1 CR_REUSE_EVAL_ROOT=/private/tmp/control-room-reuse-eval.4GX1mK node --import tsx --test --test-reporter=spec --test-name-pattern='explicit startup prepares' scripts/research/pg-boss-submission-integration.test.mjs
```

All eight compiled actual-package startup checks pass: fresh HTTP submission, canonical
replay, receipt readback, configured projections, current owner revocation, producer
preparation/installation failure, close ownership, late preparation and recovery opt-in.
The injected pg-boss adapter remains the source implementation with retained actual
pg-boss 12.30.0; the compiled boundary is task bootstrap/application/router/coordinator.
Do not describe the entire dependency/adapter chain as compiled package adoption.

The complete `tests/vps-built-*.test.mjs` suite also passes: 35 checks covering protected
pages/APIs, disposable SQL, assignment, approval, native evidence, result ownership,
quality/revision, capacity release, role separation, compiled asset exclusions, and
cleanup. No physical listener, native agent/provider or live database service was used.

This closes a packaging-evidence gap, not the remaining full-host queue/managed-session
journey. Next: combine actual worker startup with all configured application roles and
signed delivery, then browser interaction verification. Real PostgreSQL physical pools,
upstream complete-schema acceptance, installed host packaging, identity configuration
and authorized owner/live-agent journeys still require completion.

No acquisitions or GitHub writes. Source defaults still use the source startup factory;
the compiled opt-in fails if its required build artifact is absent rather than rebuilding.
