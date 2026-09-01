# CR12B-IDEA-110J — independent host-operation capture review packet

## Frozen target

- IDEA-110J product commit: `5707ecb05221e708beefa196fc0fa2e0c9d8515d`.
- Rejected IDEA-110I product commit: `5c731e42bc54bc3dea88e079385b9616dd2042b4`.
- IDEA-110I negative report SHA-256:
  `2ece553d298acaa0962c12b00b07558cbef4be9d0133b384f2f8d6d9e2950ab4`.
- IDEA-110I packet SHA-256:
  `1e16228a82d475941507213593c900ec94e0092054c53bdb9fcd18e97536e1ef`.
- Review mode: repository-only source correctness, report only, zero repair, zero native or external effects.

The reviewer must be new and different from the IDEA-110I reviewer, every IDEA-110F through IDEA-110J contributor,
every prior connector/fixed-bridge reviewer, and every incomplete attempt. Producer evidence is challenge material, not
acceptance. Only the exact unconfigured, provider-disabled snapshot above is reviewable.

## Mandatory IDEA-110I finding reproduction and closure

- Against `5c731e4...`, import and warm the connector, replace `globalThis.Set` with a counting constructor that throws a
  unique sentinel, then open an exact route with a repository-minted opaque cancellation signal. Reproduce one hostile
  execution, zero private calls, exact sentinel leakage, and absence of a bounded safe error.
- Against `5707ecb...`, repeat the exact input. Require zero hostile behavior, one normal private open, a sanitized exact
  receipt, and no sentinel identity/message/stack/cause/property retention.
- Inspect every distinctness call. Prove pairwise authority-domain rejection remains complete for connection, route,
  permit, profile, conversation, lease, session, and epoch without Set, Map, iterator, or dynamic helper selection.

## Complete post-import host-operation matrix

After module import and after preparing exact inputs, replace each relevant ambient binding independently and in safe
combinations with counting/throwing values:

- `Set`, `Map`, `WeakMap`, `Promise`, `Date`, `Date.parse`, `Date.prototype.toISOString`;
- `Number.isFinite`, `Number.isSafeInteger`, `JSON.parse`;
- `Object.freeze`, object prototype/descriptor/key/define helpers;
- `Reflect.apply`, `Reflect.construct`, `Reflect.ownKeys`;
- `Array.isArray`, array iterator, `at`, `map`, `some`, and other helpers previously selected on the path;
- `Function.prototype.call` and `bind`; and
- `AbortController`, its prototype, signal getter, abort method, and native-signal internal mutation.

Probe gateway execute and cleanup, shared exact snapshot, bridge execute and cleanup, connector open, every ordinary and
cleanup operation, and route close. Distinguish operations intentionally delegated to a reviewed dependency from direct
repository host selection. Require no post-import hostile global to execute through a repository-owned selection point,
no raw sentinel to cross, correct concrete collaborator receivers, and no changed permit-spend or cleanup ordering.

## Cancellation, settlement, and inherited matrix

- Reproduce all three IDEA-110H findings against `d22c764...` and prove their closure remains intact at `5707ecb...`.
- Reject native, poisoned, accessor-bearing, Proxy, revoked-Proxy, forged, inherited, extra-key, pre-canceled, and
  post-capture-mutated cancellation before gateway/bridge state, time, spend, settlement, child-capability creation,
  collector behavior, or collaborator dispatch. Invalid cleanup must not consume valid cleanup authority.
- Mutate and retain the final connector-owned native signal during open, create, every ordinary operation, interrupt,
  status, session close, and route close. Race cancellation, timeouts, collector submission, close, and late completion.
  Native abort failure must remain contained; settlement must join; mandatory cleanup must remain reachable.
- Repeat possible-session cleanup, private error replacement, authority-domain separation, locator-free connection
  identity, exact inputs/receipts, receiver preservation, lifecycle permutations, mutation during every await, uncertain
  outcomes, no retry, disabled composition, client absence, runtime/source/operation pins, and upgrade invalidation from
  every IDEA-110F/110G/110H/110I packet and report.
- Confirm source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, provider, deployment, hosting, DNS, or generic-shell client and does not modify Hermes.
- Confirm shipped state has zero configured port/signer/route, connection/native/SSH attempt, provider call, live-panel
  eligibility, production database contact, deployment, or execution authority.

Any gateway, exact snapshot, bridge, connector, cancellation, native-conversion, private-port, identity, runtime/source,
operation-set, readiness-security, signer, or route change invalidates the report.

## Required verification

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
npm run check
npm run lint
npm run test:cr12b
npm test
npm run build
node --test tests/rendered-html.test.mjs
npm run db:verify
git diff --check <review-integration-base>...HEAD
```

Build and rendered-route checks run sequentially. Use only a prepared checkout. Do not install, download, repair, contact
Hermes, launch a native process, use SSH, access credentials/protected values, contact a provider/production database,
deploy, host, change DNS, or make any external effect. A temporary out-of-tree in-memory probe is allowed only if removed
before reporting and only sanitized evidence is retained.

## Report and disposition

The immutable report separates observed, documented, inferred, blocked, and unsupported claims. Every finding includes
a stable ID, severity, exact source line, reproducible input, sanitized result, violated invariant, affected boundary,
missing regression, and smallest safe remediation. Passing producer tests never override a reproduced defect.

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Acceptance removes only the connector implementation-review blocker. Signer and route
enrollment, effect-free preflight, packet refresh, fresh owner authorization, owner-attended native qualification,
live-panel authority, production PostgreSQL, hosting, and deployment remain blocked.
