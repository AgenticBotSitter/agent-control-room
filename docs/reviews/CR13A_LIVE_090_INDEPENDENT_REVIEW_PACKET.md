# CR13A-LIVE-090 listener-session admission composition independent review packet

**Mode:** independent review, report only
**Immutable integration base:** `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
**Immutable review target:** `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
**Frozen implementation code:** `5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`
**Reviewer:** must be different from the producer and all earlier CR13A reviewers
**Required model / effort:** `gpt-5.6-sol` / `xhigh`
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether exact target `dbdb297aa04ea7465ab636c94ccf1084003cdf27` safely composes one accepted LIVE-070
protected frame and the remediated LIVE-080 repository-fake lifecycle into exactly one LIVE-060 authenticated
transport-admission call, ordered cleanup, and a public-safe correlation receipt without opening a listener or
overstating native truth. Reject the target for any High, Medium, or Low defect, incomplete attack, failed command, or
material uncertainty.

Review exactly:

```text
git diff 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..dbdb297aa04ea7465ab636c94ccf1084003cdf27
```

Principal paths are `src/connection-registry/v1/private-loopback-listener-session.ts`,
`tests/connection-enrollment-private-loopback-listener-session.test.ts`, `src/connection-registry/v1/index.ts`,
`package.json`, `CR13A_LIVE_090_PRIVATE_LOOPBACK_LISTENER_SESSION_ACCEPTANCE.md`, BUILD_STATUS, build plan, and ADR-158.
Treat every test and document as a claim to attack.

## Mandatory review questions

1. Are session configuration, lifecycle observations, admission results, and receipt boundaries exact ordinary-data
   boundaries that reject extra keys, symbols, missing fields, accessors, Proxies, aliases, unusual prototypes,
   over-limit values, and stale digest drift without invoking supplied behavior?
2. Does the session itself construct the protected-frame observation from the decoder result, count only successful
   decoder chunk pushes, and require the lifecycle observation's chunk count to match that actual count? Can a caller
   inject a protected frame, a false chunk count, another listener's frame, a clone, or a recomputed record?
3. Does exactly one fully decoded frame reduce to exactly `{ rawFrame, deliveryId }` for exactly one LIVE-060 admission
   call? Is the exact raw input confined to that call while session state retains only its digest? Is the admission
   method captured and called with its original receiver without executing accessors or accepting a changed method?
4. Is admission truly single-flight across synchronous reentry and asynchronous settlement? After a native Promise is
   accepted, can concurrent completion, close, finish, abort, or another frame interrupt the first attempt, dispatch a
   second attempt, clear evidence prematurely, revive a terminal session, or permit the first attempt to resurrect a
   failed session?
5. Are foreign thenables and Proxies rejected without assimilation? Are malformed same-realm intrinsic Promise
   rejections safely observed without an `unhandledRejection`/strict-process escape, supplied handler execution, raw
   rejection disclosure, or a changed admission outcome? Is runtime custody rechecked at every required post-await
   boundary?
6. Must the safe admission receipt match the listener plan's SSH-tunnel transport, private-loopback visibility,
   channel-identity digest, and maximum frame bytes before cleanup can continue? Are accepted and duplicate downstream
   outcomes preserved honestly without turning idempotent replay into an automatic retry?
7. Is the only success order bind, open, chunks, decode/admit, connection close, drain, listener close, and finish? Do
   wrong order, truncated/trailing/multiple frames, admission rejection, receipt mismatch, cleanup failure, incomplete
   finish, abort, repeated finish, or use after terminal result fail closed with no second receipt?
8. On every terminal failure, are decoder bytes, lifecycle evidence, admission-input digest, protected-frame digest,
   chunk count, and parsed admission receipt released? If admission persisted before a later close or cleanup failure,
   do the code and documents avoid claiming rollback, cancellation, retry, or a passing session receipt?
9. Is the public session receipt strict, frozen, and correlated to plan, lifecycle, protected frame, exact admission
   input, admission/ingress/protocol/delivery/enrollment evidence, registry revision, ledger outcomes, and server time?
   Does it exclude raw frame, delivery ID, signature, address, host, username, credential, tunnel material, or arbitrary
   downstream text? Can recomputing its public digest change any fixed fake/native/effect/authority claim?
10. Does the target honestly defer wall-clock admission timeout, backpressure, cancellation, process-kill recovery,
    physical bind, port ownership, tunnel/host-key authentication, and native cleanup? Is there no socket/listener,
    `node:net`, SSH, network/process import, timer, credential operation, app/local-pilot route, Hermes/provider call,
    production PostgreSQL contact, deployment, DNS, public hosting, or external effect?
11. Do all deterministic counts reproduce as 42/42 focused, 84/84 connection, 769/769 pretests, 419/421 core tests
    with the two established platform skips, 335/335 posttests, 4/4 rendered checks, and 36 migrations/119 PostgreSQL
    tables? Is the base-to-target diff whitespace clean, with no new High, Medium, or Low defect?

## Required reproduction

Run from a clean disposable checkout at the immutable review target with prepared dependencies:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
pnpm run check
pnpm run lint
pnpm run test:cr13a-listener-session
pnpm run test:cr13a-connections
pnpm test
pnpm run test:build
pnpm run db:verify
git diff --check 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..dbdb297aa04ea7465ab636c94ccf1084003cdf27
```

If `pnpm run db:verify` alone is denied because `tsx` cannot create its local IPC pipe in the review sandbox, preserve
that exact negative command result and run `node --import tsx scripts/verify-migrations.ts` as the listener-free
equivalent. Do not relabel the wrapper failure as a passing command.

Add private disposable read-only probes outside the product tree for caller-made or cross-listener protected frames,
actual-versus-reported chunk-count drift, admission receiver/method drift, synchronous and asynchronous reentry,
concurrent abort/close/finish, pending settlement, foreign thenables, decorated and rejected intrinsic Promises under
strict process policy, post-await runtime replacement, downstream policy mismatch, accepted-versus-duplicate outcomes,
late cleanup failure after downstream persistence, terminal evidence release, receipt recomputation, unsafe output, and
the absence of listener/runtime wiring.

Do not mutate the shared checkout, start the app, bind or probe a port, open SSH, read credentials or Keychain, contact
Hermes/provider/production PostgreSQL, install or download anything, deploy, publish, or perform any external effect.
Clean up only the exact disposable review directory you created and confirm its absence.

## Required report

Return report text for architect placement at `docs/reviews/CR13A_LIVE_090_INDEPENDENT_REVIEW.md`. Include exact base,
target, and implementation hash; reviewer independence; command outcomes and exact counts; findings ordered
High/Medium/Low with file/line evidence and required remediation; explicit answers to all eleven questions; disposable
probe summary; product/effect/cleanup confirmation; and exactly one disposition.

`accepted` requires no High, Medium, or Low finding. Any failure, uncertainty, incomplete attack, or cleanup uncertainty
is `rejected`. The report grants no integration, listener, connection, SSH, credential, native, provider, production,
deployment, DNS, public-hosting, or network authority.
