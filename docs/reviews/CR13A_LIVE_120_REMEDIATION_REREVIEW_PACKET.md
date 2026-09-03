# CR13A-LIVE-120 remediation independent zero-repair re-review packet

**Integration base:** `1ee5409c0b66afbd802582459af864ec0d198f5c`  
**Rejected product:** `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`  
**Preserved negative-review commit:** `c50ea2173210ae2d0326c3f67d6a90b747e3af76`  
**Immutable remediation target:** `5a579342b7a03bb013de21663c69a3a6118e11c6`  
**Required reviewer:** different from the producer and the reviewer that rejected LIVE-120  
**Review mode:** independent review, report only, zero repair

## Objective

Reproduce all four High and five Medium findings in the preserved negative report, attack the exact remediation, and
decide whether every finding is closed without weakening the original LIVE-120 boundary. The module must remain
unwired, incapable of receiving a valid native capability, and incapable of making a listener or network attempt in
repository tests.

A pass permits only ordinary owner-controlled integration review. It does not authorize a native construction,
physical listener attempt, socket or port action, runtime wiring, SSH, credentials, provider access, production use,
or deployment.

## Immutable evidence

- Original implementation packet: `docs/reviews/CR13A_LIVE_120_IMPLEMENTATION_INDEPENDENT_REVIEW_PACKET.md`
- Original packet SHA-256: `e42cde8b401117e8bb71971315fff0219a5e8f17827e7df7a480a42ca967c9b5`
- Preserved negative report: `docs/reviews/CR13A_LIVE_120_INDEPENDENT_REVIEW.md`
- Preserved negative-report SHA-256: `baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66`
- Design: `docs/CR13A_LIVE_120_PHYSICAL_NATIVE_DRIVER_DESIGN.md`
- Acceptance: `docs/CR13A_LIVE_120_UNWIRED_PHYSICAL_NATIVE_DRIVER_ACCEPTANCE.md`

## Remediation claims to attack

1. **H-001:** the first loopback connection is paused and rejected before data handlers or decoding unless the exact
   socket has a private, unspent, one-use admission record bound to the exact attempt, connection ordinal, admission
   deadline, tunnel-peer proof, and host-key proof. The admission registry and every prerequisite proof registry have
   no insertion path, so this target cannot admit a physical connection.
2. **H-002:** the decoder constructor and `push`, `finish`, and `close` methods are captured at import, frozen with the
   prototype, and invoked only through captured `Reflect.apply`/`Reflect.construct`. Dynamic decoder dispatch is gone.
3. **H-003:** volatile callbacks and local variables can never produce `closed_verified`. Because this block has no
   signer, durable attempt ledger, independent high-water checkpoint, or native-resource observer, every post-marker
   native cleanup remains `cleanup_failed`; recovery cannot promote it.
4. **H-004:** every post-marker error, deadline, extra connection, malformed frame, successful frame completion, and
   explicit close converges on one idempotent cleanup promise. Cleanup immediately enters terminal state, clears owned
   timers, removes admission/data callbacks, pauses and destroys the socket, closes/wipes and releases the decoder,
   requests server close under a drain deadline, releases the private capability under a distinct shutdown deadline,
   and never rewrites missing physical proof as success.
5. **M-001:** pending buffered bytes increase before synchronous decoding and decrease only after successful
   consumption. Pause occurs at the high watermark; resume occurs only after the tracked pending value is observed at
   or below the low watermark. The hard ceiling uses the pending value.
6. **M-002:** the error class, its prototype, and all five exported functions are frozen and non-extensible. The fake
   driver, its prototype, and all five driver methods remain frozen.
7. **M-003:** status and implementation validation uses captured `Number`/`Number.isSafeInteger` and exact private
   digest custody, so a post-import ambient `Number` getter is neither resolved nor leaked.
8. **M-004:** the native factory parses the exact branded contract and implementation, verifies their private
   relationship, and requires the capability to retain those exact objects. Equal public digests cannot substitute
   provenance.
9. **M-005:** bind/start, admission, connection, idle, frame, total-attempt, drain, and final shutdown deadlines are
   represented separately. Drain and shutdown limits are independently validated and together cannot exceed the
   accepted shutdown grace.

## Required deterministic reproduction

Run in a fresh disposable detached checkout at exact target
`5a579342b7a03bb013de21663c69a3a6118e11c6`, with no install, download, repair, network, or external effect:

1. Confirm exact HEAD and an empty tracked status, and verify both evidence hashes above.
2. Run macOS stage zero; expected `ready_for_runtime_check` after reusing only already-prepared local dependencies.
3. Run `pnpm run check` and `pnpm run lint`.
4. Run `pnpm run test:cr13a-physical-native-driver`; expected 34/34.
5. Run `pnpm run test:cr13a-connections`; expected 123/123.
6. Run `pnpm run test:cr13a`; expected 139/139.
7. Run `pnpm test`; expected 769/769 pretests, 372/372 core tests, and 374/374 posttests.
8. Run `pnpm run posttest` explicitly; expected 374/374.
9. Run `pnpm run test:build`; expected production build and 4/4 rendered routes.
10. Run `pnpm run db:verify`; only if the sandbox denies the temporary `tsx` IPC listener before migration work,
    preserve that exact limitation and run `node --import tsx scripts/verify-migrations.ts`; expected migrations
    `0001` through `0036` and 119 PostgreSQL tables.
11. Run `git diff --check 959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38..5a579342b7a03bb013de21663c69a3a6118e11c6`.

## Mandatory hostile re-review

Re-run every original attack group and explicitly add effect-free or static cases for:

1. first-arrival, unauthenticated, stale, copied, equal-digest, cross-attempt, wrong-ordinal, wrong-deadline,
   wrong-tunnel, wrong-host-key, reused, late, accessor, Proxy, and decorated socket admission;
2. proof-registry and native-capability insertion searches, construction/export searches, and exact
   contract/implementation identity substitution;
3. decoder constructor, prototype, method, receiver, own `call`/`apply`/`bind`, function property, and post-import
   replacement, requiring zero hostile decoder executions and no protected-byte exposure;
4. exported error class/function decoration and prototype replacement, requiring zero hostile executions;
5. ambient `Number`, timer, reflection, Node server/socket method, typed-array, digest, and framing-boundary replacement,
   requiring zero raw sentinel leakage and either captured execution or safe failure before composition;
6. pause/high-water, pending-byte decrement, low-water observation, hard-ceiling overflow, multi-chunk input, decoder
   rejection, second frame, and source behavior after pause;
7. skipped close, partial frame, success, extra socket, start/admission/connection/idle/frame/total timeout, reentrant
   error, close during input, repeated close, server-close timeout, drain timeout, shutdown timeout, late callback, and
   restart recovery;
8. decoder byte wiping, timer/callback clearing, socket destruction, capability release, server-reference retention,
   and every path that could claim cleanup success without independent signed durable evidence;
9. any native path to `closed_verified`, state promotion during recovery, automatic retry, or second start;
10. public/error sanitation for raw locator, port, host/user identity, owner, tunnel peer, host key, credential,
    command, protected frame, provider value, native diagnostic, and stack text;
11. the complete producer concurrency, copy, accessor, symbol, Proxy, receiver, state-order, provenance, sanitation,
    import-allowlist, and fixed-set matrix; and
12. static absence from every barrel, app, API, browser, worker, scheduler, Hermes, service, startup, deployment, DNS,
    hosting, and production composition path.

Do not obtain or synthesize a bind capability or connection admission, call the unexported factory, mock or patch
`node:net` into a listener, or make any physical/native attempt. Static inspection and repository-fake tests are the
entire authorized boundary.

## Mandatory questions

1. Does exact private connection admission now precede handler installation and frame decoding?
2. Can any untrusted local process, first-arrival race, copied proof, or equal-digest substitute pass admission?
3. Are all decoder calls captured, receiver-bound, immutable, and protected from post-import replacement?
4. Does every terminal path converge on mandatory cleanup and wipe/release all protected in-memory material?
5. Can any volatile callback, local variable, graceful close, or recovery path claim `closed_verified`?
6. Is backpressure tied to observed pending bytes and the configured low/high/hard limits?
7. Are every exported callable and relevant prototype frozen and non-extensible?
8. Can ambient `Number` or timer replacement execute or leak a raw sentinel through a public boundary?
9. Does exact object provenance bind contract, implementation, capability, attempt, socket admission, peer, and host key?
10. Are drain and final shutdown separately bounded and incapable of widening the accepted total grace?
11. Is the implementation still unexported, unwired, issuer-free, runtime-disabled, and effect-free?
12. Do all original and new tests reproduce without target repair, and does any High, Medium, or Low finding remain?

## Disposition and cleanup rules

- Any High, Medium, or Low finding rejects the target.
- Report exact reproduction and affected invariant; preserve negative evidence.
- Report only: do not edit, repair, commit, push, open or merge a PR, or perform an external effect.
- A pass must explicitly close all nine original findings and say that none remains.
- Remove the disposable checkout and confirm its absence.
- Report exact counts for native constructions, bind capabilities, admissions, listener/socket/port attempts, network
  observations, SSH, credential/Keychain, Hermes/provider, production, deployment, DNS/hosting, repository changes,
  and external effects. Every effect count must be zero.
