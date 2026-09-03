# CR13A-LIVE-090 independent review

## Scope and independence

- Base: `04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d`
- Review target: `dbdb297aa04ea7465ab636c94ccf1084003cdf27`
- Frozen implementation: `5ff9d9bf8ce3096c50c0fab646f60cfb36a410fe`
- Packet SHA-256: `88dc35513f595fc08b75b0136bb20c7addb46bbcc8f837a265cd5df25c81d97f`
- Reviewer: fresh independent Codex reviewer `/root/cr13a_live090_review_retry`, neither the producer nor an earlier CR13A reviewer.
- Review lane: `gpt-5.6-sol` / `xhigh`.
- Mode: zero repair, report only.

The review used a detached disposable local clone at the exact target. The base was its merge base, and the base-to-target diff contained only the eight declared paths. No prior report was treated as authority.

## Findings

### High

None.

### Medium

#### M-001 — `finish()` can destructively interrupt an accepted in-flight admission

`ConnectionEnrollmentPrivateLoopbackListenerSessionV1.finish()` handles every state other than `closed` or `complete` by calling `#fail("incomplete_session")`:

- `src/connection-registry/v1/private-loopback-listener-session.ts:376-383`
- `src/connection-registry/v1/private-loopback-listener-session.ts:460-471`

When the state is `admitting`, `#fail()` closes the decoder, aborts the lifecycle, clears the admission-input digest and chunk count, and changes the session to `failed`. When the already accepted native Promise later settles, `completeFrameAndAdmit()` requires the state still to be `admitting`; it instead encounters `failed` and rejects with `state_conflict`:

- `src/connection-registry/v1/private-loopback-listener-session.ts:343-355`

Two independent probes reproduced this:

1. During asynchronous settlement, `finish()` returned `incomplete_session`; after the one downstream call settled successfully, the original admission attempt rejected with `state_conflict`, and the session could no longer close.
2. Calling `finish()` synchronously from inside `admit()` produced the same interruption while still making exactly one downstream call.

This contradicts the frozen claim that completion/cleanup cannot interrupt or change an in-flight admission:

- `docs/CR13A_LIVE_090_PRIVATE_LOOPBACK_LISTENER_SESSION_ACCEPTANCE.md:39-43`
- `docs/CR3_DECISION_LOG.md:3070-3074`

The existing pending-admission regression covers close, abort, drain, and second completion, but omits `finish()`:

- `tests/connection-enrollment-private-loopback-listener-session.test.ts:329-369`

Impact: an admission may persist downstream, yet a premature `finish()` destroys the session evidence and prevents ordered cleanup and the correlation receipt. This leaves a valid enrollment result without the session-level evidence the block promises.

Required remediation:

- Treat `finish()` during `admitting` as a non-mutating `state_conflict`, consistent with `abort()` and `#requireState()`.
- Add asynchronous and synchronous-reentrant `finish()` regressions proving the first admission can settle, close, drain, clean up, and emit exactly one receipt with exactly one downstream call.
- Re-run the complete gate and obtain a different zero-repair review.

### Low

None independent of M-001.

## Required reproduction

After preparing the copied dependency metadata for the disposable path, the literal packet commands produced:

| Command | Outcome |
|---|---|
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Pass: `ready_for_runtime_check`; `tsx` and `zod` resolved; no native attempt |
| `pnpm run check` | Pass |
| `pnpm run lint` | Pass |
| `pnpm run test:cr13a-listener-session` | Pass, 42/42 |
| `pnpm run test:cr13a-connections` | Pass, 84/84 |
| `pnpm test` | Pass: 769/769 pretests; 419/421 core with the two established platform skips; 335/335 posttests |
| `pnpm run test:build` | Pass: production build and 4/4 rendered checks |
| `pnpm run db:verify` | Failed only at the documented sandbox boundary: `tsx` received `listen EPERM` creating its local IPC pipe |
| `node --import tsx scripts/verify-migrations.ts` | Pass: migrations `0001`–`0036`; 119 PostgreSQL tables |
| `git diff --check 04dfd7958b7b030ff00cbcda0ba0d8329ea31e3d..dbdb297aa04ea7465ab636c94ccf1084003cdf27` | Pass |

The database wrapper failure is preserved as a failure and is not relabeled as a passing command; only the packet-authorized listener-free fallback passed.

## Disposable probes

Final probe results:

- General hostile matrix: 11/11 passed.
- Strict rejected/decorated intrinsic-Promise process probe: exited zero and printed `bounded`.
- Finish-race reproductions: 2/2 reproduced M-001.

The matrix covered ordinary-data boundaries, aliases, Proxies, accessors, unusual prototypes, attempted protected-frame injection, actual/reported chunk drift, receiver and method capture, synchronous/asynchronous reentry, concurrent frame/close/abort/finish, pending settlement, foreign thenables, decorated rejected intrinsic Promises, strict unhandled-rejection policy, post-await runtime replacement, policy mismatch, accepted/duplicate preservation, late cleanup failure after persistence, terminal evidence release, receipt recomputation, unsafe-output absence, and static absence of listener/runtime wiring.

## Answers to the eleven questions

1. **Yes.** The reviewed boundaries are strict ordinary-data boundaries and the hostile probes found no supplied behavior execution or stale/extra-field acceptance.
2. **Yes.** The session creates the protected-frame observation internally and binds lifecycle chunk count to successful decoder pushes. Caller-made, foreign, cloned, or appended frame evidence cannot enter.
3. **Yes.** Admission receives exactly `{ rawFrame, deliveryId }` once; the method and receiver are captured, and retained state contains only the digest.
4. **No.** M-001 proves synchronous and asynchronous `finish()` can interrupt and irreversibly corrupt the accepted in-flight attempt.
5. **Yes, for the frozen safely observable intrinsic-Promise class.** Foreign thenables and Proxies were not assimilated; decorated rejection remained bounded under strict process policy; post-await runtime drift failed before replacement behavior.
6. **Yes.** Transport, visibility, channel digest, and frame ceiling must match. Accepted and duplicate outcomes remain distinct and cause no retry.
7. **No overall.** The nominal success order and other wrong-order/terminal paths are enforced, but `finish()` during admission destroys an otherwise valid first attempt.
8. **Yes for legitimate terminal failures and late cleanup failure.** Retained decoder/lifecycle/digest/count/receipt evidence is cleared, and no rollback or retry is claimed. M-001 is premature terminalization rather than evidence retention.
9. **Yes.** The receipt is strict, frozen, digest-correlated, excludes unsafe material, and fixes fake/native/effect/authority truth to the required values.
10. **Yes.** Deferred native concerns remain explicit. Static and dynamic review found no socket, listener, SSH, timer, credential, route, provider, production-service, deployment, DNS, or external-effect wiring.
11. **No overall.** All deterministic counts and whitespace checks reproduced, with the documented database-wrapper sandbox exception and passing fallback, but M-001 is a new Medium defect.

## Product, effect, and cleanup confirmation

No product or shared-checkout file was edited. Only generated dependency metadata in the disposable copy and private probes outside the product tree were changed. Nothing was installed or downloaded; the application was not started; no port, listener, SSH, credential store, service, provider, production database, deployment, DNS, or external network was contacted.

Disposable directory `/private/tmp/cr13a-live-090-review.ir8MNJ` was removed, and its absence was confirmed. The shared checkout remained clean at `1b36fda4e7d554752564a7256e140c14da72dc55`.

This report grants no integration, listener, connection, SSH, credential, native, provider, production, deployment, DNS, public-hosting, or network authority.

**Disposition: rejected**
