# CR14C native-run adapter — component acceptance

**Date:** 2026-09-05. **Disposition:** independently accepted, unwired repository component.
**Accepted product:** `4b5fb69d8386cdf859ba22079aef3e7771f45f18`.
**Tree:** `1fa5287e551e418015e61d8e38911f5213c04eca`.
**Base:** `dfc1f3609271ace0adc504ec0c9ebbf2e7005ea7` (preparation handoff / PR #287).
Branch: `codex/cr14c-hermes-native-run-adapter`; private PR publication is tracked in `BUILD_STATUS.md`.
No merge, live setup or deployment is authorized or claimed by this acceptance.

## Delivered

- Exact pinned native capability/profile/session/task mapping; current trusted authority checks and the
  existing pre-effect-marker port. No generic RPC, personal profile cloning or implicit tool inheritance.
- Node-private restart-safe SQLite run journal, unique attempt/claim reservation, bounded results and
  one-use stream/stop intent. Unknown submission or storage outcome never causes another automatic start.
- Outbound-only HTTPS transport with connect-time address/certificate identity checks, bounded requests,
  no redirects/fallback/retries and private callback-supplied authentication. It has no application consumer.
- Status-based reconnect/final-result handling; fixed-category progress; truthful nullable reported usage;
  cancellation-priority observation handoff; concurrent status/stop reconciliation and terminal-result preservation.
- A single `test:cr14c` command, also registered in the ordinary test lifecycle. No dependencies, migrations,
  runtime enablement lists, existing qualification pins, live credentials or hosting metadata changed.

Full behavior, supported subset, bounds and missing native guarantees are in
`CR14C_NATIVE_RUN_ADAPTER_CONTRACT.md`. PostgreSQL remains the sole global write authority. The local journal
is execution/recovery state, not a parallel task queue.

## Independent review

Initial `32a6238` was rejected for two P2/Medium timing defects: progress observation blocked cancellation,
and concurrent status could discard a stop acknowledgement. The initial report is retained in
`reviews/CR14C_NATIVE_RUN_ADAPTER_REVIEW.md`. Corrections add cancellation-priority handoff and bounded local
observation reconciliation; native effects/unknown commits are never retried. Four additional deterministic
tests cover the actual interleavings. Re-review accepted with no remaining findings; see
`reviews/CR14C_NATIVE_RUN_ADAPTER_REREVIEW.md`.

## Final verification

All commands used installed dependencies and returned exit 0:

| Check | Result |
|---|---|
| Stage zero, macOS | Ready; Node meets baseline, pnpm 11.19.0; no installation |
| Focused `test:cr14c` | 47 passed; also independently run |
| Existing `test:cr14b` | 152 passed |
| Registered pretest | 769 passed |
| Registered main test | 626 tests: 624 passed, two existing Windows-only skips |
| Registered posttest | 392 passed |
| TypeScript / full ESLint / cumulative whitespace | Passed |
| Private Node build / compiled checks | Passed / 9 passed |
| Preserved Sites build / rendered checks | Passed / 4 passed |
| Disposable migration verification | 0001–0040 / 127 tables passed; unchanged migration files |

The full registered lifecycle was invoked directly with Node/tsx, preserving pre/main/post separation.
The migration check preceded the correction; no SQL or migration input changed. Both builds and all listed
test/type/lint checks were rerun after correction. There was no browser/UI change requiring a new click test.

## What remains unproved or unwired

No real DNS/TLS connection, listener, Hermes/provider call, credential read, process launch, profile change,
database provisioning, production service, browser, deploy or PR merge occurred. HTTPS tests use injected
socket/request objects. Journal persistence uses a test-owned disposable POSIX directory, removed afterward.
Source inspection is not installed-runtime evidence, and the source candidate is not enabled for dispatch.

Next C-WORK connects canonical project tasks/attempts, existing admission/effect authority and result/review
services, including explicit handling of native lifecycle/usage differences. The service profile/supervisor
must later earn isolation and hard deadline guarantees. A private HTTPS topology needs separate review/setup;
the existing resolver still rejects private DNS answers and introduces no plaintext exception. A hard dollar
cap is unsupported, cancellation is reported native state rather than OS-absence proof, and each host needs
its own qualification. The real task -> result -> review journey and full CR14C exit are not complete.

Continue authorized repository work on **Astra Xhigh**. Private PR publication is permitted by the overnight
goal; merge and live-effect approvals remain separate.
