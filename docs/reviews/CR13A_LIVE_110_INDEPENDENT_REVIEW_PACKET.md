# CR13A-LIVE-110 independent zero-repair review packet

**Integration base:** `d1d2b8723797cd2d09efc70384fa98403223a8ec`
**Implementation commit:** `8d0e7aebf379b0898a0fbbedb11cafc94159d2ab`
**Immutable review target:** `3c756154744a1b933093771a878ab6b64f243f2e`
**Required reviewer:** a different owner-authorized reviewer that did not produce LIVE-110
**Review mode:** independent review, report only, zero repair

## Objective

Attack the first fake-only native-listener driver and activation-evidence contract. Determine whether the exact target
preserves the LIVE-100 disabled boundary while providing a useful, immutable contract for a future physical driver.
The central gate is not whether the fake rehearsal passes. The gate is whether every route from repository-fake truth
to native, activation, listener, network, approval, or execution truth remains impossible.

## Changed product paths

- `src/connection-registry/v1/private-loopback-native-driver-contract.ts`
- `src/connection-registry/v1/index.ts`
- `tests/connection-enrollment-private-loopback-native-driver-contract.test.ts`
- `package.json`

## Changed authority and status paths

- `docs/CR13A_LIVE_100_DEFAULT_DISABLED_NATIVE_LISTENER_ADAPTER_ACCEPTANCE.md`
- `docs/CR13A_LIVE_110_NATIVE_DRIVER_ACTIVATION_EVIDENCE_ACCEPTANCE.md`
- `docs/BUILD_STATUS.md`
- `docs/CR3_BUILD_PLAN.md`
- `docs/CR3_DECISION_LOG.md`

## Required deterministic reproduction

Run against the exact target in a disposable local checkout with no network or external effects:

1. `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos`
2. `pnpm run check`
3. `pnpm run lint`
4. `pnpm run test:cr13a-native-driver-contract` — expected 65/65
5. `pnpm run test:cr13a-connections` — expected 107/107
6. `pnpm run test:cr13a` — expected 123/123
7. `pnpm test` — expected 769/769 pretests, 419/421 core tests with two established platform skips, and 358/358
   posttests
8. `pnpm run test:build` — expected production build and 4/4 rendered routes
9. `pnpm run db:verify`; if and only if the disposable sandbox denies the temporary `tsx` IPC listener before
   migration work, preserve that exact failure and run `node --import tsx scripts/verify-migrations.ts` — expected
   migrations 0001–0036 and 119 PostgreSQL tables
10. `git diff --check d1d2b8723797cd2d09efc70384fa98403223a8ec..3c756154744a1b933093771a878ab6b64f243f2e`

The standard database wrapper fallback is evidence handling only. It authorizes no listener or other effect.

## Mandatory hostile matrix

Attack at least these families without modifying product files:

1. Copies, serializations, descriptor copies, decorated records, extra keys, symbols, accessors, Proxies, null or
   unusual prototypes, sparse arrays, reordered arrays, and re-digested contract/rehearsal/evidence claims.
2. Cross-plan, cross-readiness, cross-listener, cross-contract, cross-driver, and cross-rehearsal substitution,
   including pairs whose public fields are individually valid.
3. Replacement of native-driver, owner, platform, port, tunnel-peer, host-key, deadline, backpressure, cleanup,
   recovery, eligibility, attempt, network, retry, or authority values.
4. Contract operation removal, addition, reordering, duplication, mutation, or replacement; bounds below and above the
   accepted frame, chunk, connection, idle, and shutdown limits.
5. Fake event removal, addition, reordering, duplication, mutation, or replacement and any attempt to relabel fake
   evidence as native, accepted, qualified, enabled, or activation-eligible.
6. Driver subclass, instance, prototype, method, receiver, lookalike, own-`call`, own-`apply`, own-`bind`, function
   property, function prototype, and extracted-operation attacks. Replacement code must execute zero times.
7. Locator-shaped raw listener IDs, IPv4/IPv6 addresses, ports, paths, endpoint identities, owner identities,
   tunnel-peer identities, host-key identities, channel identities, protected frames, credentials, commands, and
   provider values across public objects, serialization, and bounded errors.
8. Selected ambient-runtime changes after import. No hostile getter, Proxy trap, replacement digest, array, reflection,
   regular-expression, number, or driver behavior may execute.
9. Static and behavioral searches for `node:net`, TLS, HTTP, datagram, child process, SSH, fetch, WebSocket, listener,
   connect, server, route, runtime wiring, provider, credential, deployment, or other external-effect paths.
10. Repeated fake rehearsal, repeated close, parse-after-close, and concurrent caller access. All returned records must
    remain stable, frozen, bounded, and effect-free.

## Mandatory questions

1. Is the driver contract bound to the exact module-created LIVE-100 readiness and matching plan, with no raw locator
   or protected identity retained?
2. Are the five operations, all numeric limits, and every required future proof exact, complete, ordered, immutable,
   and non-authorizing?
3. Can any caller-supplied object, callback, method, subclass, receiver, prototype, accessor, Proxy, or ambient
   replacement redirect driver execution or cross the fake boundary?
4. Does the repository fake execute no native, listener, network, SSH, credential, provider, route, runtime, or
   deployment operation and accept no executable input?
5. Does a perfect fake rehearsal retain zero real attempts/effects and remain distinguishable from native evidence in
   every public and internal path?
6. Does activation evidence retain all twelve LIVE-100 blockers in exact order and keep every native, activation,
   eligibility, retry, effect, and authority claim false?
7. Can copies, re-digested objects, cross-plan records, cross-driver records, or individually valid but mismatched
   records pass any contract, rehearsal, driver, or evidence boundary?
8. Are records and nested operation/event/blocker arrays recursively immutable, with captured operation dispatch that
   cannot be replaced?
9. Do public data, serialization, and errors omit raw listener identity, address, port, protected identities, paths,
   credentials, commands, frames, and provider values?
10. Is the module absent from local-pilot, browser, HTTP, worker, Hermes, service, and deployment composition, and does
    it import or call no external-effect implementation?
11. Do all required commands and hostile cases reproduce on the immutable target without product repair?

## Disposition rules

- Report every finding as High, Medium, or Low with an exact reproduction and affected invariant.
- Any High, Medium, or Low finding rejects the target.
- Do not edit, commit, push, open a pull request, or repair product or documentation files.
- A passing report must answer every mandatory question and explicitly state that no finding remains.
- Preserve negative evidence. A later remediation never erases this review.

## Effect and cleanup boundary

No listener, socket, port, connection, SSH, credential, Keychain, protected-value read, Hermes/provider call, native
process, production database, deployment, DNS, hosting, publication, or external network action is authorized. The
review may read repository files, run deterministic local tests, and create one disposable checkout. It must remove
that checkout and report the absence check. Do not include personal paths, host identity, secrets, or raw diagnostics
in the report.
