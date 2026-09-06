# E50 — default lifecycle regression reconciliation

2026-09-06. Local verification and test-runner repairs, no remote CI execution.

Ran `pnpm test` against the current default lifecycle after E46 restored the hidden
posttest list. The configured inventory is 71 pretest, 188 main and 59 posttest files.
This is not an exhaustive discovery of every repository test and does not exercise
real deployment, native agents or browser interaction.

Two failures were found in the main phase:

1. The CI lane planner rejected the two actual-package queue tests because they live
   in `scripts/research`, not `tests`. They became visible after the duplicate script
   repair. The parser now accepts exactly those two additional paths; unknown research
   tests and the native PostgreSQL evaluation remain rejected. Full-plan uniqueness,
   path containment, file checks, exact argv and no shell/retry behavior are unchanged.
2. The historical Hermes isolation test expected no external consumers. The accepted
   CR14C connector lifecycle already has two node bridge modules consuming runtime
   types and pure snapshot contracts. The test now names exactly those consumers,
   requires the runtime import to be type-only, and checks the connector's only runtime
   contract imports are snapshotSchema and terminalNativeState. Existing sole native
   HTTPS import ownership and prohibited effects checks remain. No production adapter
   or connector code was changed to make a test pass.

Architecture evidence: `CR14C_CONNECTOR_LIFECYCLE_ACCEPTANCE.md` explicitly accepts
supplied runtime/client/host ownership and records independent review and synthetic
integration. It does not authorize native host activation or a new importer.

All nine focused lane/isolation tests pass after repair. TypeScript and targeted lint
pass. The original broad run completed with 1,812 main-phase passes, two failures and
two skips; its follow-up suite did not execute. That run is not retroactively green.

After its process exited 1, reran the complete `pnpm test` lifecycle. It exited 0:

| Phase | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Pretest | 770 | 0 | 0 |
| Main | 1,814 | 0 | 2 |
| Posttest | 479 | 0 | 0 |
| Total | 3,063 | 0 | 2 |

The skipped checks are Windows-only platform key-store/qualification checks and are
not certified by this Mac run. Posttest includes the restored actual-package queue
checks. Existing experimental SQLite notices remain warnings, not failures. No build
or live acceptance is inferred from this lifecycle result; compiled acceptance remains
the separately recorded E49 evidence. Tests and runner are the only executable changes.

No downloads, dependency updates, GitHub Actions, publication, credentials, listeners,
real PostgreSQL or provider calls. This is verification of local implementation, not
evidence that the remaining product outcomes are complete.
