# CR13A-LIVE-090 listener-session remediation independent re-review packet

**Mode:** different independent re-review, report only
**Immutable integration base:** `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
**Rejected review target:** `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
**Rejected implementation code:** `5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`
**Exact remediation implementation:** `28a1c0833e8e2b2b3368644536b7442c96bbadcb`
**Immutable remediation review target:** `89be9d7fb486a3fb5855402073466108a19a75ec`
**Original packet SHA-256:** `88dc35513f595fc08b75b0136bb20c7addb46bbcc8f837a265cd5df25c81d97f`
**Negative report SHA-256:** `0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`
**Reviewer:** must differ from the producer and the reviewer who issued the preserved negative report
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact remediation target `89be9d7fb486a3fb5855402073466108a19a75ec` closes M-001 without
weakening any previously reviewed listener-session, admission, cleanup, evidence-release, or no-effect boundary. Reject
for any open High, Medium, or Low defect, incomplete attack, failed required command, or material uncertainty.

Review the preserved negative report first. Then review both the complete base-to-remediation product and the narrow
remediation:

```text
git diff 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..89be9d7fb486a3fb5855402073466108a19a75ec
git diff 5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe..28a1c0833e8e2b2b3368644536b7442c96bbadcb
```

Principal remediation paths are `src/connection-registry/v1/private-loopback-listener-session.ts`,
`tests/connection-enrollment-private-loopback-listener-session.test.ts`, the LIVE-090 acceptance contract,
BUILD_STATUS, build plan, ADR-158, and the preserved negative report. Treat every test and document as a claim to
attack.

## Mandatory remediation questions

1. Does `finish()` during `admitting` reject with `state_conflict` before runtime-custody assertion or any mutation of
   state, decoder, lifecycle evidence, input/frame digests, chunk count, admission receipt, or failure cause?
2. Can an admission method synchronously call `finish()` before returning its intrinsic Promise without failing or
   corrupting the outer admission? Is receiver binding preserved and is the admission method still called exactly once?
3. While an ordinary intrinsic Promise remains pending, can `finish()`, abort, close, cleanup, another frame, or another
   completion interrupt, clear, replace, duplicate, revive, or otherwise change the sole attempt? Are all rejected
   concurrent calls non-mutating?
4. After either synchronous reentry or asynchronous pending contention, can the first admission settle, pass the same
   receipt-policy checks, complete exact connection-close/drain/listener-close ordering, and emit exactly one correlated
   public-safe receipt?
5. If runtime custody drifts while admission is pending, does the accepted post-await check fail terminally and clear
   retained evidence? Does the new early `finish()` guard avoid executing a changed runtime primitive while preserving
   that post-await fail-closed behavior?
6. Are rejected intrinsic Promises, malformed native Promise outcomes, foreign thenables, policy mismatch, late cleanup
   failure after persistence, repeated finish, and all other terminal paths still safe, bounded, non-retrying, and free
   of unhandled rejection or strict subprocess escape?
7. Are raw frame, delivery ID, signatures, host/address/username/credential/tunnel material, and arbitrary downstream
   text still absent from retained state, errors, receipts, tests, documents, and command output?
8. Does the public receipt still bind plan, lifecycle, protected-frame and exact admission-input digests, downstream
   references and outcomes, registry revision, and server time while fixing every fake/native/effect/authority fact to
   its negative literal? Can public digest recomputation authorize anything?
9. Is there still no socket/listener, `node:net`, SSH, timer, network/process import, credential operation, app route,
   local-pilot wiring, Hermes/provider call, production PostgreSQL/VPS contact, deployment, DNS, public hosting, or
   external effect?
10. Do all exact gates and hostile probes reproduce, including the two M-001 regressions, with a clean product diff and
    clean disposal of the review workspace? Is there any new High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable remediation target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-listener-session
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..89be9d7fb486a3fb5855402073466108a19a75ec
```

Expected counts are 43/43 focused LIVE-060/070/080/090 tests, 85/85 connection tests, 769/769 pretests, 419/421 core
tests with the two established platform skips, 336/336 posttests, 4/4 rendered checks, and 36 migrations/119
PostgreSQL tables.

If `pnpm run db:verify` alone is denied because `tsx` cannot create its local IPC pipe in the review sandbox, preserve
that exact negative command result and run `node --import tsx scripts/verify-migrations.ts` as the listener-free
equivalent. Do not relabel the wrapper failure as a passing command.

Add private disposable read-only probes outside the product tree for externally pending `finish()`, synchronous
admission-method reentry, receiver and call count, each concurrent session method during admission, settlement and
ordered completion after rejected contention, post-await runtime drift, rejection under strict process policy,
foreign thenables, policy mismatch, late cleanup failure, terminal evidence release, receipt recomputation, unsafe
output, and absence of listener/runtime wiring. Promise-subprocess probes must be bounded and must not hang.

Do not mutate the shared checkout, start the app, bind or probe a port, open SSH, read credentials or Keychain, contact
Hermes/provider/production PostgreSQL, install or download anything, deploy, publish, or perform any external effect.
Clean up only the exact disposable review directory you created and confirm its absence.

## Required report

Return report text for architect placement at
`docs/reviews/CR13A_LIVE_090_REMEDIATION_INDEPENDENT_REREVIEW.md`. Include all exact hashes above, reviewer independence,
command outcomes and exact counts, explicit closure or non-closure of M-001, findings ordered High/Medium/Low with
file/line evidence and required remediation, explicit answers to all ten questions, hostile-probe summary,
product/effect/cleanup confirmation, and exactly one disposition.

`accepted` requires M-001 closed and no High, Medium, or Low finding. Any failure, uncertainty, incomplete attack, or
cleanup uncertainty is `rejected`. The report grants no integration, listener, connection, SSH, credential, native,
provider, production, deployment, DNS, public-hosting, or network authority.
