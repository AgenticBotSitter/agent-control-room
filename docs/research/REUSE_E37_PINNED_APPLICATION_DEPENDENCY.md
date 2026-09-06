# E37 — reproducible queue dependency

2026-09-06. Local package adoption; no worker activation or deployment.

After complete local queue/host journeys passed, pg-boss 12.30.0 is pinned in package.json
and pnpm-lock.yaml. Frozen, script-disabled installation adds its 21-package dependency
closure. All versions and integrity hashes match the retained E01 lockfile. No existing
dependency version was upgraded. Acquisition, storage, license metadata and cleanup
disposition are recorded in REUSE_DOWNLOAD_LOG.md.

Actual-package tests now default to the repository's own node_modules; an explicit absolute
CR_REUSE_EVAL_ROOT still supports comparisons. The normal posttest lifecycle includes both
actual-package suites and the submission-client suite. test:queue-integration names the
queue suites separately. These tests never automatically install their package or database.

Verified: all 66 package checks pass without the temporary evaluation root; TypeScript,
targeted lint, whitespace and stage-zero pass. Reproducible direct test command:

```sh
node --import tsx --test scripts/research/pg-boss-submission-integration.test.mjs scripts/research/pg-boss-worker-integration.test.mjs
```

Local pnpm run prechecks currently disagree with the installed workspace metadata. An
automatic reinstall refused without a TTY; explicit error-only checks and an already-up-to-date
frozen reinstall preserve the issue. No purge/force was attempted. Use the verified direct
command pending diagnosis; do not claim normal pnpm script invocation passed here.

This removes the temporary-folder dependency, not production acceptance gates. Runtime
still requires explicit prepared resources and factories. Real PostgreSQL pool isolation,
upstream complete-schema acceptance, actual browser interaction and host activation remain
open. No credentials, provider calls, listener, service, GitHub write or deployment.
