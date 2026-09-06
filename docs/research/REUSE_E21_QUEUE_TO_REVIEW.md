# E21 — actual queue pickup through signed result review

2026-09-06. Local, in-memory integration; no live agent or server.

## Result

The retained pg-boss 12.30.0 package now has a connected regression covering
canonical enqueue, continuous worker pickup, approved-node managed-session routing,
signed dispatch and receipt, synthetic native progress, stored result bytes, and an
exact pending review target. Browser logout before pickup does not supply or fabricate
a browser identity for server delivery (ADR-251).

The test observes one dispatch and one delivery callback. An outstanding receipt
leaves the operational queue job failed with retries disabled. A subsequent signed
receipt and completion still enter the evidence/review path; they do not silently
rewrite the queue failure as success. Artifact content matches submitted bytes, the
review is pending with qualityAccepted false, and canonical task state does not
change merely because a provider reported completion.

## Evidence

- Focused connected test passed, followed by all 44 actual-package worker/submission
  checks passing together.
- Stage-zero readiness, TypeScript, targeted ESLint and whitespace checks passed.
- The unfinished test referenced an undefined role-script variable; corrected before
  execution. No failing run was relabeled as passing.

Reproduce using the existing logged acquisition:

```sh
CR_REUSE_EVAL_ROOT=/private/tmp/control-room-reuse-eval.4GX1mK node --import tsx --test --test-reporter=spec scripts/research/pg-boss-worker-integration.test.mjs scripts/research/pg-boss-submission-integration.test.mjs
```

## Limits and next work

The fixture uses privileged canonical setup, a restricted queue worker role and
restricted managed authentication/evidence/result identities on one PGlite engine.
It does not prove six independent production pools or native PostgreSQL behavior.
Native execution is simulated. The manager's queue routes use the fixture's explicit
opt-in coordinator; the actual producer commits operational work. This is not
whole-host startup or a browser journey.

Next integrate host startup and worker lifecycle, explicitly addressing pickup before
the assigned node connects. Missing-node and uncertain-send cases must not be treated
as equivalent or blindly retried. Exact-role/full-schema acceptance, real PostgreSQL,
browser enqueue, live Marvin acceptance, packaging and recovery remain open.

No downloads, credentials, persistent services, deployment or GitHub publication.
