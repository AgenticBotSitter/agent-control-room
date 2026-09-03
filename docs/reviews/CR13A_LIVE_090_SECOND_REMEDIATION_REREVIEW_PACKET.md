# CR13A-LIVE-090 second remediation independent re-review packet

**Mode:** third independent re-review, report only
**Immutable integration base:** `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
**Original rejected target:** `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
**First remediation target:** `89be9d7fb486a3fb5855402073466108a19a75ec`
**First remediation implementation:** `28a1c0833e8e2b2b3368644536b7442c96bbadcb`
**Exact second remediation implementation:** `de840c9aef259db18da3c45e1d4e0549bc0f0d85`
**Immutable second remediation review target:** `f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3`
**Original negative report SHA-256:** `0f3db267c28605f0687d18f831c303c9c1055a6b4e9f64be65b9b50dd3e716bd`
**Second negative report SHA-256:** `ca1b7ef365cd6a9b4fe79e22eade3d48667a8ccc1d8befc2f09bcb6f469803f2`
**Previous re-review packet SHA-256:** `5be8352094f95217c35ff171181d5a3494ed5fff67d4cf11e9dc82d67dbdcc36`
**Reviewer:** must differ from the producer, first reviewer, and second reviewer
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact target `f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3` closes M-002, keeps M-001 closed,
and preserves every accepted listener-session, transport-admission, cleanup, safe-output, and no-effect boundary. Reject
for any open High, Medium, or Low defect, incomplete attack, failed required command, or material uncertainty.

Read both preserved negative reports before review. Inspect the complete product and both remediation increments:

```text
git diff 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3
git diff 5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe..28a1c0833e8e2b2b3368644536b7442c96bbadcb
git diff 89be9d7fb486a3fb5855402073466108a19a75ec..f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3
```

Principal second-remediation paths are `src/connection-registry/v1/private-loopback-listener-session.ts`,
`src/connection-registry/v1/transport-admission.ts`, their two test files, the LIVE-090 acceptance contract,
BUILD_STATUS, build plan, ADR-158, and both negative reports. Treat every test and document as a claim to attack.

## Mandatory review questions

1. Is M-001 still closed for both externally pending and synchronously reentrant `finish()`, with no state/evidence
   mutation, exactly one admission call, successful settlement, ordered cleanup, and exactly one receipt?
2. Does the malformed native-Promise observer read only captured intrinsics and own property descriptors, with no
   supplied getter, Proxy trap, constructor, species, `then`, rejection value, or arbitrary behavior execution?
3. When the own `constructor` is absent, an ordinary data descriptor selecting the captured native constructor, or an
   ordinary data descriptor selecting the native default, does attaching the captured observer safely own a preexisting
   rejection under strict Node policy while the decorated Promise remains invalid?
4. Do accessor constructors, foreign constructor selections, Proxies, Promise subclasses, and foreign thenables remain
   unassimilated and unexecuted? Does review distinguish shapes whose settlement can be safely observed from arbitrary
   in-process behavior that this port does not authorize or execute?
5. Does the same M-002 remediation hold at both LIVE-090 listener-session admission and LIVE-060 transport admission,
   with no inconsistent duplicate helper or bypass?
6. Are malformed, rejected, fulfilled, pending, and policy-mismatched results bounded to local safe failures, with no
   raw rejection disclosure, unhandled rejection, strict-process termination, retry, second call, or session revival?
7. After pending contention or a safely observed malformed settlement, are state transitions and evidence release still
   terminal, exact, and free of raw frame, delivery ID, signature, locator, credential, tunnel, or arbitrary downstream
   material?
8. Does the receipt remain strict, frozen, digest-correlated, and fixed negative for every native/effect/authority fact?
   Can public recomputation, constructor decoration, or runtime drift authorize or forge anything?
9. Is there still no listener/socket, `node:net`, SSH, timer, route, credential operation, Hermes/provider call,
   production PostgreSQL/VPS contact, deployment, DNS, hosting, install/download, or external effect?
10. Do all exact gates, strict subprocesses, hostile probes, diff checks, and disposable cleanup reproduce with no new
    High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable second-remediation target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-listener-session
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3
git diff --check 89be9d7fb486a3fb5855402073466108a19a75ec..f0a64ae4fab6b0a7d926fca573c9ce324c6b9ee3
```

Expected counts are 46/46 focused LIVE-060/070/080/090 tests, 88/88 connection tests, 769/769 pretests, 419/421 core
tests with two established platform skips, 339/339 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL
tables.

If `pnpm run db:verify` alone is denied because `tsx` cannot create its local IPC pipe in the review sandbox, preserve
that exact negative command result and run `node --import tsx scripts/verify-migrations.ts` as the listener-free
equivalent. Do not relabel the wrapper failure as a passing command.

Add disposable read-only probes outside the product tree for M-001's two race forms; rejected and fulfilled exact
native Promises; own constructor data descriptors selecting the captured constructor, undefined/default, and foreign
values; constructor accessors; unusual flags and symbols; Promise subclasses; foreign thenables and Proxies; decorated
rejections under strict process policy; method receiver/count; runtime drift; policy mismatch; late cleanup failure;
evidence release; receipt recomputation; unsafe output; and absence of listener/runtime wiring. Never execute supplied
constructor/accessor/then behavior. Bound every subprocess so it cannot hang.

Do not mutate the shared checkout, start the app, bind or probe a port, open SSH, read credentials or Keychain, contact
Hermes/provider/production PostgreSQL, install or download anything, deploy, publish, or perform any external effect.
Clean up only the exact disposable review directory you created and confirm its absence.

## Required report

Return concise report text for architect placement at
`docs/reviews/CR13A_LIVE_090_SECOND_REMEDIATION_INDEPENDENT_REREVIEW.md`. Include all exact hashes above, reviewer
independence, command outcomes and exact counts, explicit M-001 and M-002 closure/non-closure, findings ordered
High/Medium/Low with file/line evidence and required remediation, explicit answers to all ten questions, sanitized
probe summary, product/effect/cleanup confirmation, and exactly one disposition. Do not include reproduction code,
step-by-step abuse instructions, raw protected values, or sensitive host details.

`accepted` requires M-001 and M-002 closed and no High, Medium, or Low finding. Any failure, uncertainty, incomplete
attack, or cleanup uncertainty is `rejected`. The report grants no integration, listener, connection, SSH, credential,
native, provider, production, deployment, DNS, public-hosting, or network authority.
