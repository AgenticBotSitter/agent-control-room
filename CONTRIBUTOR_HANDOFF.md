# Contributor handoff — September 9, 2026

## Start here

Latest implementation branch: `codex/component-batch-4`. This branch contains the
stacked local implementation batches, not just batch four. Code checkpoint before
this handoff: `478e719`. Freeze the current published commit when taking an assignment.
Main remains the earlier preview until review and integration are complete.

All 17 component directions are settled; none of the six complete delivery batches
is accepted finished. Selection is not integration, simulated tests are not live
compatibility, and compiled templates are not an operational deployment.

Read COMPONENT_DECISIONS.md, IMPLEMENTATION_PACKAGES.md, IMPLEMENTATION_PROGRESS.md
and CONTRIBUTING.md. The progress file preserves historical checkpoints; its newest
entries supersede earlier unfinished statements about the same component.

## Substantial remaining work

| Batch | Already present — reuse it | Next substantial deliverable |
| --- | --- | --- |
| 1: database, queue, execution, recovery | node-postgres adapter; pg-boss integration; exact-ID Codex read projection/protocol/lifecycle; recovery fences | Codex-specific durable identity and admission contract, then authenticated recovery composition and real task/result acceptance. Do not reuse Hermes dispatch as Codex authorization. |
| 2: identity, signing, checkpoints | JWT policy adapter; bounded signing adapters; checkpoint compare-and-set and mismatch detection | Review key custody/consent and independent checkpoint placement; implement supported split-commit recovery, then separately approved native acceptance. |
| 3: Idea Lab, projects, results | Multi-round fake-participant workflow; protected results; ordinary/Idea lifecycle persistence and route/retry tests | Browser accessibility and mobile acceptance; real participant/result integration and crash recovery without duplicating uncertain work. |
| 4: news and research | Bounded extraction, stored source identity, protected article reader and research-task creation | Qualify source/resource policy and complete article-to-real-agent-to-reviewed-result acceptance. |
| 5: schedules and workspaces | cron-parser/Luxon; persisted occurrences; native Git port and durable workspace intentions | Automatic dispatch/recovery and safe workspace re-adoption under current authorization; finish interruption/retention integration. |
| 6: optional monitoring | Scoped Herdr observation projection, stale/revocation handling and unwired native port | Review endpoint identity and resource limits; separately qualify native collection. Kuma/Beszel remain optional, not MVP blockers. |

Cross-cutting notices now use the selected CycloneDX collector with a pinned pnpm
runtime inventory. All 193 installed package instances have assembled original text;
four missing-root cases retain named provenance rather than being silently waived.
The entities source manifest says 2.2.0 while the installed package says 3.0.0;
matching retained code hashes do not resolve that discrepancy. Complete distribution
clearance remains false. Next: independent review, portable inventory regeneration,
release packaging and bundle/vendor/asset coverage. Do not substitute template
license text or relabel this as a complete SBOM.

## How to contribute without duplicating work

Propose one substantial deliverable from the table and obtain maintainer assignment
before editing overlapping files. State the published base commit, exact scope,
dependencies, tests and remaining uncertainty. UI acceptance, notice tooling review,
and source-policy work can be prepared independently; protocol/security/database
contracts and final integration remain maintainer-owned. No shared live checkout.

Prefer the selected upstream implementation behind a small adapter. Explain any
new custom infrastructure. Preserve upstream licenses, original notices and pins.
Use disposable fixtures; real credentials, native qualification, listeners,
production database operations and deployment need their own explicit approval.
Do not publish private infrastructure or copy private installation files.

## Local verification

Use SETUP.md and the pinned package manager. Normal component checks:

```sh
pnpm check:demo
pnpm test
pnpm test:components
node --test tests/runtime-license-report.test.mjs tests/license-exceptions.test.mjs tests/runtime-license-assembly.test.mjs tests/runtime-license-text.test.mjs
```

The retained license inventory is current-platform evidence; a differing prepared
graph must be reviewed and regenerated, not patched just to make a test pass.
Native fixture scripts are not included as permission to run them.

Run checks locally and attach concise evidence. GitHub Actions stays disabled:
no scheduled builds, automatic deployment or privileged runners. Batch meaningful
pushes and reviews; local commits do not consume Actions minutes. Report an
incomplete gate honestly rather than weakening it. See implementation progress for
which checks were actually run at each checkpoint, not just available commands.
