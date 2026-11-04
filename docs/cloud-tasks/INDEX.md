# Cloud task pack 1

Each task file is self-contained. The cloud machine clones one public branch and cannot read external reports or workstation files. The lead publishes the named base with its task file included; the builder receives only “Read docs/cloud-tasks/<id>.md and do exactly that task.” This local pack does not publish anything.

| Task id | Base branch the lead must push | Goal | Readiness |
|---|---|---|---|
| `selfcheck-load-lanes` | `cook/mutation-lane-selfcheck` + this documentation pack | Fail both load self-checks when the enabling flag disappears despite a matching name pattern. | READY for build after base publication; output `cloud/selfcheck-load-lanes`. |
| `ci-load-lane-contract` | `cloud/pack-1` | Pin the two load flags and exact selectors in the existing CI coverage guard. | READY for build after base publication; output `cloud/ci-load-lane-contract`. |

Do not start `selfcheck-load-lanes` from the pack branch alone. Its helper exists on `cook/mutation-lane-selfcheck` at `b2561e2f9`; the lead must carry the documentation-only pack commit onto that branch before pushing. The other task starts from this pack branch, based on `e6dacd39e17196964add00c4cfa463fb2dc149dc`. Neither builder needs to fetch a second branch or external specification. The guard task and runtime task add independent tests to `tests/check-test-lane-coverage.test.mjs`; integrate those additive tests deliberately. Never merge automatically.

No reviewed feature spec is ready at pack preparation. Latest review verdicts below are all NEEDS-FIX; a newer unreviewed revision does not earn readiness. These are status entries, not instructions to build a feature:

| Spec stream | Newest revision | Latest reviewed revision/verdict | Readiness |
|---|---|---|---|
| B7 policy (P71/P72) | R3, draft in progress | R2 / NEEDS-FIX | NOT READY. |
| B7 providers (P73a/P73b) | R3, draft in progress | R2 / NEEDS-FIX | NOT READY. |
| B8 selection/presets (U81/U82/U83a/U83b/D01a/D01b) | R2, draft in progress | R1 / NEEDS-FIX | NOT READY. |
| B11 second project (J11a/J11b) | R3, draft in progress | R2 / NEEDS-FIX | NOT READY. |
| B12 copy/soak (C121/C122) | R2, draft in progress | R1 / NEEDS-FIX | NOT READY. |
| B13 accept/update (A131/A132) | R2 | R1 / NEEDS-FIX | NOT READY: no CLEAN review of R2. |
| B16 installed self-build (S161/S162) | R2, draft in progress | R1 / NEEDS-FIX | NOT READY. |

The fallback tasks are safe now because they repair existing synthetic tests and CI coverage contracts already present on the integration head or its self-check follow-up. The CI task is the narrow F05b2 coverage portion; it does not claim full timing/hosted acceptance. No roster, policy, provider, project-copy, updater or engine feature is inferred from an unreviewed specification. Cloud implementation readiness does not imply feature release readiness.

Privacy qualification: the private-name guard needs the real session/CI denylist. Public cloud clones do not receive repository secrets. Record an unavailable list honestly; never substitute a fabricated list and call it a full private-name pass. Local pack validation and any remaining limitations are recorded in the lead's build report.
