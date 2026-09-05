# CR14A acceptance — private-beta delivery rebaseline

**Date:** 2026-09-04

**Disposition:** accepted locally for architecture/planning and ordinary jobber tooling. Not connected-local,
live-validated or daily-use accepted. No GitHub push, PR, merge or worker dispatch occurred in this block.

**Baseline:** merged `17d8a14499d2bdd517bb3b632e3f2501bb4cee88`.

**Reviewed product:** `93118f9169d03c6fde68b70a5a2e53fba19fc5f4`.

**Reviewed tree:** `0a6145d2a0cfca75014e40b7ad4856f654e4281c`.

**Local branch:** `codex/cr14a-private-beta-rebaseline`.

## Delivered

- Replaced the stale completion sequence with R01-R16 traceability, eight private-daily-use phases,
  dependencies, named Codex integration work, model/effort settings and explicit user-visible exits.
  Preserved the old program as a marked historical archive.
- Recorded ADR-202 and the supported Hermes native-run / explicit VPS Node direction. One private
  PostgreSQL primary, existing node ceilings, honest ambiguity, separate effect approval, accepted pins
  and dormant code remain intact. No old native failure was relabelled as passed.
- Rechecked source-level reuse and licenses for the four comparison projects and the official Hermes
  interface. Recorded focused reuse decisions and caveats; copied no third-party implementation code.
- Froze four non-overlapping worker contracts: general project catalog/create UI, connection onboarding,
  result/revision review UI and deterministic ABS digest selection. Prepared their local draft wave.
- Fixed the issue renderer's ability to advertise a non-ready capsule as READY. Added separate draft
  structural validation that is explicitly not claimable; ordinary intake still quarantines draft results.
- Removed obsolete calibration-only admission language from the current worker system. Real-task
  prerequisites, bounded repairs and submit-then-continue behavior remain; native attempt limits are separate.

No application, adapter, database or hosting implementation changed: there is no diff in `app/`, `src/`,
`db/`, `.openai/`, `vite.config.ts` or `pnpm-lock.yaml`. The package script change only registers the new
draft tests; it does not install or upgrade a dependency.

## Producer verification actually run

| Check | Observed result |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Ready; dependency preparation only, no install or native attempt |
| `node --test tests/agent-intake.test.mjs tests/agent-jobber-queue.test.mjs tests/agent-build-drafts.test.mjs` | 23 tests passed, exit 0 |
| Exact registered `package.json` `scripts.test` command, invoked directly | 427 tests: 425 passed, 2 skipped, 0 failed; exit 0 |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed, exit 0 |
| `node node_modules/eslint/bin/eslint.js . --ignore-pattern dist --ignore-pattern .next` | Passed, exit 0 |
| Product whitespace and draft scope/reference inspection | Passed; four drafts, disjoint product paths and existing referenced contracts |

The focused tests are included in the registered main test command, not an additional count of unique tests.
The two skips are Windows-only native DPAPI tests on this Mac. No Windows evidence is inferred. The direct
main command did not invoke `pretest` or `posttest`; this is not a fresh full test-lifecycle acceptance.
Production build, standalone database verification, real PostgreSQL rehearsal, native/provider qualification
and deployment were not rerun. The change scope is documentation and local coordination tooling.

An earlier main-suite run's final output was not retained in the active context; the producer repeated the
same ordinary test command and observed the result recorded above. This was not a native-attempt retry.

## Independent review and handoff follow-up

Independent agent `remaining_gate_audit` accepted the exact reviewed product with no blocking finding.
Its report and checks are retained in `reviews/CR14A_INDEPENDENT_REVIEW.md`.

The subsequent documentation-only handoff addresses its nonblocking notes without changing the tested code:

1. The program now gives LANDING a named owner, deliverable and acceptance row, with publication separate
   from the private app and no invented public repository link.
2. Handoffs use exact model IDs: `gpt-6-astra` / `xhigh`, `gpt-5.6-sol` / `high`, `gpt-5.6-terra` / `high`.
3. Publication instructions explicitly require the integration branch to contain CR14A and wave/capsule
   lifecycle checks together. The validator does not independently enforce wave status. A later deliberate
   ready transition must update the draft-state snapshot tests while retaining draft rejection coverage.

This documentation follow-up is producer-checked, not retrospectively included in the independent review's
tree. It adds no runtime capability, changes no capsule status and clears no live prerequisite.

## Remaining work and authority

All four capsules remain **draft, local, unpublished and unclaimed**. The integration branch and frozen
contract must be reachable before publication; only the serialized queue controller can accept a claim.
No remote GitHub state was changed. Older open PRs/issues remain inventory, not permission to merge them.

The application remains the repository-fake local pilot described in `BUILD_STATUS.md`. General live project
creation, ordinary private login, mounted real task/review, multi-machine fleet, live Idea Lab/ABS, database
restore and fleet update acceptance remain CR14B-G work. CR14A did not touch credentials, invoke a provider,
start or deploy a service, change DNS or authorize an effect.

**Next:** CR14B B-RUNTIME + B-AUTH + B-PROJECT-API design and effect-free implementation, on
**Astra Xhigh (`gpt-6-astra`, `xhigh`)**. These are one integration batch, with the prepared controlled UI
work paired to its later mounted acceptance. No model change or owner response is needed for that scoped
repository implementation. Identity-provider selection, private hostname and actual host/database/deployment
work remain separately scoped decisions and effects.
