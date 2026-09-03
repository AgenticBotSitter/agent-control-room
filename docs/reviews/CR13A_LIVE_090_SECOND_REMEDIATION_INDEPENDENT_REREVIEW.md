# CR13A-LIVE-090 second remediation independent re-review

## Scope and identity

- Reviewer: `/root/cr13a_live090_second_remediation_rereview`, independent of the producer and both earlier reviewers.
- Model/effort: `gpt-5.6-sol` / `xhigh`.
- Integration base: `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
- Original rejected target: `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
- Original implementation comparison point: `5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`
- First remediation target: `89be9d7fb486a3fb5855402073466108a19a75ec`
- First remediation implementation: `28a1c0833e8e2b2b3368644536b7442c96bbadcb`
- Second remediation implementation: `de840c9aef259db18da3c45e1d4e0549bc0f0d85`
- Immutable review target: `f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3`
- Original negative report SHA-256: `0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`
- Second negative report SHA-256: `ca1b7ef365cd6a9b4fe79e22eade3d48667a8ccc1d8befc2f09bcb6f469803f2`
- Previous re-review packet SHA-256: `5be8352094f95217c35ff171181d5a3494ed5fff67d4cf11e9dc82d67dbdcc36`

Review used a detached disposable local clone with exact merge-base verification and no network.

## Command and probe results

The prepared packet run comprised exactly 10 required commands: 9 exited successfully; `pnpm run db:verify` alone exited 1 because sandbox policy denied the local `tsx` IPC listener. The authorized listener-free fallback passed separately, verifying migrations `0001`–`0036` and 119 PostgreSQL tables. The wrapper failure is not relabelled as a pass.

Counts reproduced:

- Focused listener-session tests: 46/46.
- Connection tests: 88/88.
- Full suite: 769/769 pretests, 419/421 core tests with two established platform skips, and 339/339 posttests.
- Rendered build checks: 4/4.
- Both required diff checks passed.
- Independent hostile matrix: 14/14.
- Strict safe-constructor matrix: 4/4.
- The new strict-process defect reproduced at both listener and transport boundaries, 2/2, without timeout.

One preliminary preparation-only `check` invocation stopped before compilation because disposable dependency metadata still named the source checkout. Only disposable metadata was corrected; the final literal command passed. Two preliminary probe-harness-only failures were corrected solely in disposable probes before the complete bounded matrix ran.

## Closure

- **M-001: closed.** Externally pending and synchronously reentrant `finish()` cases preserve state and evidence, call admission exactly once, settle successfully, perform ordered cleanup, and emit one receipt.
- **M-002: closed for the preserved reported case.** Malformed rejected native Promises with absent, captured-native, or undefined/default own constructor data are safely observed under strict policy while remaining invalid. Behavioral and foreign constructor selections remain untouched.
- A distinct related Medium defect remains open.

## Findings

High: none.

Medium:

- **M-003 — safe Promise runtime drift can strand a malformed rejection.** Both observer implementations require the entire captured Promise runtime to remain exact before using the already-captured intrinsic observer. If `Promise.prototype.then` drifts after import while the effective constructor/species path remains safely native, the malformed result is rejected locally but its pre-existing rejection is left unobserved. Strict Node policy terminates the process. No replacement method or rejection value was executed or disclosed.
  - Evidence: `src/connection-registry/v1/private-loopback-listener-session.ts:95-126,341-343`
  - Evidence: `src/connection-registry/v1/transport-admission.ts:87-127,348-350`
  - Required remediation: separate result-acceptance runtime integrity from observer-safety. When the captured intrinsic observer and effective native constructor/species path remain demonstrably safe, own the rejection before returning `integrity_failed`, while continuing to leave accessors, foreign selections, Proxies, subclasses, thenables, and supplied behavior untouched. Add strict subprocess regressions at both seams.

Low: none.

## Mandatory answers

1. Yes. M-001 remains closed for both race forms with one admission, stable state/evidence, ordered cleanup, and one receipt.
2. Yes for paths the observer accepts: only captured reflection/intrinsics and own descriptors are used. M-003 exposes an overly narrow observer-safety predicate.
3. Yes. Absent, captured-native, and undefined/default constructor-data cases were bounded under strict policy.
4. Yes. Accessors, foreign selections, Proxies, subclasses, and foreign thenables remained unassimilated and unexecuted.
5. No overall. The remediation is consistent at both seams, but M-003 affects both.
6. No. M-003 permits an unhandled rejection and strict-process termination under the bounded runtime-drift case.
7. Yes for pending contention and safely observed malformed settlement; terminal state and evidence release remained exact and sanitized.
8. Yes. Receipts remained strict, frozen, digest-correlated, and fixed negative; recomputation and decoration did not authorize effects.
9. Yes. No listener, socket, port, SSH, credential, provider, production database, deployment, DNS, hosting, installation, download, or other external effect occurred.
10. No. Gates and probes reproduced, but the new Medium defect prevents a clean result.

The shared checkout remained clean and unmodified. My sandbox denied deletion of the exact disposable directory; the architect then removed only that directory, and I independently confirmed its absence.

**Disposition: rejected**
