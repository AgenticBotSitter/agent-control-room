# Recorded native reconnect acceptance

Date: 2026-09-06. Base: `1f62ec0`. Production: `4fa5d9c`.
Contract: `CR14C_RECORDED_NATIVE_RECONNECT_CONTRACT.md`.

## Result and independent review

Managed sessions can explicitly restore observation for an exact existing run using
authenticated historical delivery records. The observation-only state is separate
from every send/start state. No database privileges, migration, listener, credential
source, deployment or native provider call was added.

Independent read-only production review accepted `4fa5d9c` with no blocking finding.
Independent test review accepted `9cccc93` plus the final root ACK/title/manifest
corrections. Review was static; root performed runtime verification separately.
Two isolated source-only workers authored success and denial tests. Stage zero in
their worktrees returned `setup_required`; they did not install dependencies or run
native operations. One worker could not write protected Git metadata; root committed
the reviewed stopped delta, without changing its environment or dependency setup.

## Observed checks

- Root stage zero: `ready_for_runtime_check`. No native readiness/qualification was run.
- Final combined reconnect, denial, revised-child and compiled-session suite: **28 passed**.
  This includes five success/authority tests, nineteen denial entries including nested
  cases, one revised-child test and three compiled checks.
- Original managed-session, managed-startup and compiled suite after interface fixes:
  **30 passed**. Earlier broader regressions are retained below rather than counted
  as wholly passing runs.
- TypeScript and full ESLint passed after integration. Eight current test-inventory
  checks passed after registering both new source files. Native adapter isolation
  passed separately. The private VPS Node artifact compiled successfully.
- Prerequisite PR #338, head `cb32295`, passed all nine GitHub checks in run
  `34015701952`. PR #339, head `1f62ec0`, passed all nine in run `34016224656`.
  Both remain open; this block still requires its own current-head CI and integration.

Success tests use actual signed portable-bridge handshakes and restricted session,
evidence and result SQL roles over disposable PGlite. A saved completed observation
reaches pending review after reconnect; lost-ACK recovery and fresh-envelope replay
preserve one result. Expired historical leases remain expired. Revised-child replay
preserves its exact v2 target lineage and original execution evidence. Tests compare
canonical/delivery/outbox/transition records and fake native-call counts to prove no
redispatch or restart. Canonical setup and deliberate lease expiry remain privileged
synthetic fixture work, not production provisioning evidence.

Denials cover missing/tampered proof, wrong task/input, old-connection frames,
revoked keys before fresh reporting, and cancellation/replacement at proof precommit.
Recovery itself is read-only; subsequent progress independently authenticates current
node/key status. It does not support key rotation by inference.

Compiled success is **not** claimed for a full reconnect-to-result journey. The compiled
tests verify protected five-role composition, actual proof reads under the evidence
role, refusal without complete matching historical proof, and browser isolation.
Their fixture already has historical delivery but no registered run. Only the first
case installs the process-global application; the second tests the compiled factory
with a supplied installation observer because real installation is intentionally one-shot.

## Retained failures and corrections

1. First 34-entry backend regression run: 33 passed, one failed because the exact
   handle-method list omitted new `recover`. The analogous 55-entry startup/regression
   run had 54 pass and the same omission in a separate list. Both lists were corrected;
   the final overlapping 30-entry suite passed. No production guard was weakened.
2. The first expanded compiled run had two pass and one fail on a second process-global
   installation. The second test now uses an explicit supplied installation observer;
   final three compiled checks passed. This is not evidence of process reinstallation.
3. All six initial reconnect/revised runtime tests passed, but TypeScript reported six
   possibly-undefined fixture accesses. The worker added explicit existence assertions;
   the final type check passed.
4. Independent review found a vacuous server-dispatch assertion against node-sent
   history. Root replaced it with an assertion on the actual server outbound queue:
   exactly one ACK for the recovered progress message, checked before consuming it.
   Review also corrected the compiled test label from missing delivery to incomplete
   matching proof. Final corrected tests passed.
5. The initial package-manager invocation emitted a failed update-metadata request;
   no dependency change was made. Subsequent checks invoked the existing local binaries.

## Still required

Node-owned saved-observation reporting across replacement, runtime activation and
owner signing custody; scoped physical PostgreSQL/host preparation; first real useful
task and multi-machine qualification. PR #329's upstream workflow gate is separate and
unresolved. No live task, automatic reconnect service, quality approval, GitHub merge
or deployment is claimed by this acceptance.
