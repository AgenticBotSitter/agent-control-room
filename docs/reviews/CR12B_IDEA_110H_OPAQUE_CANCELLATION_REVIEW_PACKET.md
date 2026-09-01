# CR12B-IDEA-110H — independent opaque-cancellation connector review packet

## Frozen target

- Opaque-cancellation implementation: `d22c76444b80f8dd469380aab52ec457f5d76fad`.
- First connector candidate: `70f5890b3be5162896a585dae458a9a9c02e8036`.
- Rejected IDEA-110G implementation: `3e72cce7b7b91fd8f36bd5ebfe559984b30a2f68`.
- First connector review report SHA-256:
  `d9a1acb60b3a272a71469fc07574db2d504100f7a382fb33a702a50c585b5808`.
- Accepted fixed-bridge report SHA-256:
  `6ed834e8b5c3418bc0bc932e56ae991a9c33f4699b81860f78be194a34a5b9c8`.
- Review mode: source-code correctness review, report only, zero repair, zero native or external effects.

The reviewer must be different from every IDEA-110F/110G/110H contributor, the first connector reviewer, every prior
fixed-bridge reviewer, and the two reviewers whose IDEA-110G attempts ended `blocked_incomplete_review`. Producer tests
are inputs, not acceptance evidence. Acceptance covers only the unconfigured, provider-disabled connector snapshot.

## Mandatory cancellation-boundary review

### CR12B-110G-REJECTED-001 — poisoned native signal

- Reproduce the rejected IDEA-110G case without contacting a native port: start with a genuine AbortSignal that retains
  its expected own-key shape, replace a built-in event-map data value with a Proxy, and establish that the old observer
  could execute a Proxy trap when an intrinsic EventTarget method consumed that value.
- Prove the IDEA-110H driver, gateway, bridge, and connector repository seams reject that native AbortSignal before any
  observer, trap, getter, listener method, private-port dispatch, or other caller behavior runs.
- Repeat with own getters, setters, symbols, descriptor changes, subclasses, custom/null/drifted prototypes, Proxies,
  lookalikes, post-capture mutation, and mutation during every await. Behavior and private dispatch must remain zero.

### CR12B-110H-REV001-001 — opaque capability exactness

- Establish that only `createHostCancellationControllerV1` can mint an accepted capability, its signal has the private
  repository prototype, is frozen, has zero own keys, and keeps state exclusively in module-private storage.
- Try forged prototypes, copied descriptors, ordinary objects, null-prototype objects, subclasses, wrappers, Proxies,
  revoked Proxies, receiver loss, cross-realm-like lookalikes, and mutation before and after capture. Each must fail
  closed without observable caller behavior.
- Verify the controller can abort once, listeners run at most once, unsubscription is idempotent, listeners added after
  abort receive the terminal state exactly once, listener failure cannot block peer listeners, and no listener identity
  or private error crosses a repository boundary.
- Review captured-intrinsic and module-initialization assumptions. Report any path through which mutable global,
  prototype, array, WeakMap, function-call, or iterator behavior could run after an accepted capability is created.

### CR12B-110H-REV001-002 — propagation and native conversion

- Pre-cancel open, every ordinary operation, every cleanup operation, and route close. Open/ordinary/close must reject
  before private dispatch; mandatory cleanup must retain its bounded cleanup authority.
- Cancel before subscription, immediately after subscription, immediately before private dispatch, during the private
  await, after collector submission, and after return. Confirm one operation attempt, one settlement, and no retry.
- Prove driver-to-gateway, gateway-to-bridge, and bridge-to-connector carry only the opaque capability. Only the final
  Mac-private connector boundary may create a fresh connector-owned native AbortSignal.
- Give the private-port test double access to that final native signal and mutate, abort, retain, or observe it during
  every await. Prove connector settlement depends on connector-owned state, does not re-read port-mutatable native
  internals, and cannot be changed after settlement.
- Race caller cancellation, driver timeout, cleanup timeout, bridge close, connector close, and late native completion.
  Verify deterministic first settlement, listener removal, no unhandled rejection, bounded cleanup, and no duplicate
  private dispatch.

## Mandatory original-finding closure

### CR12B-110F-REV001-001 — possible-session cleanup

- Reproduce paused `session.create`: begin route close, observe cancellation, then return a valid late-created receipt.
  Route close must not dispatch before at least one native session cleanup attempt.
- Repeat late success, late throw, no collector value, double submission, malformed receipt, aliased session/epoch, and
  an operation that remains pending until the bounded test probe ends.
- Race close and cancellation at open and every ordinary/cleanup await. Prove active settlement precedes close, no
  operation retries, and a possible create cannot be downgraded to “no session.”
- Verify late-created cleanup can bind interrupt/status/close while the bridge never receives the canceled create
  receipt. A failed route close or malformed proof must never become completed cleanup.

### CR12B-110F-REV001-003 — private error replacement

- Throw unique sentinel Errors, primitives, Proxies, accessor-bearing errors, causes, locator/credential-shaped
  messages, and custom subclasses from open, operation, cleanup, and route-close private calls.
- Prove rejection is always a new bounded safe error and never retains, wraps, concatenates, logs, returns, or rethrows
  private identity, message, stack, cause, property, or behavior.
- Repeat incomplete/conflicting collectors, malformed receipts, and post-return validation failures. No private
  diagnostic may cross the connector boundary.

### CR12B-110F-REV001-004 — authority-domain separation

- Pairwise alias connection identity, route, permit, profile, and conversation digests before open. Reject each before
  private dispatch.
- Alias returned route lease against every accepted authority digest. Alias session and epoch against each other and
  every connection/route/permit/profile/conversation/lease domain. Each receipt must fail closed.
- Repeat omitted, malformed, overlong, re-digested, cross-attempt, swapped-field, and post-capture mutation cases.
  Confirm normal binding still holds and no equality check becomes vacuous through aliasing.

### CR12B-110F-REV001-005 — locator-free connection identity

- Prove the fixed bridge derives exactly one domain-separated `connectionIdentityDigest` and connector/private-port
  input has no connection ID, hostname, username, port, key path, gateway, profile path, native session ID, or arbitrary
  locator.
- Put host:port, URL, filesystem path, SSH target, gateway, and human-readable labels into every connector-accepted
  field. Locator-shaped values must not enter connector state, private calls, receipts, or errors.
- Confirm local and SSH modes use the same digest-only connector seam; locator mapping remains a future Mac-private-port
  responsibility.

## Whole-boundary regression

- Repeat every exact-host, receiver, lifecycle permutation, binding drift, uncertain open/operation, duplicate call,
  after-close, receipt sanitation, mutation, disabled composition, client absence, and upgrade case in the frozen
  IDEA-110F and IDEA-110G packets.
- Confirm the shipped record still has zero configured port, signer, route, connection attempt, SSH connection, native
  attempt, provider call, live-panel eligibility, or execution authority.
- Confirm production source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, gateway, provider, deployment, or generic-shell client and does not modify Hermes.
- Confirm readiness preserves the first negative report, rejected IDEA-110G state, two interrupted review attempts,
  exact IDEA-110H commit and packet hash, pending fresh review, seven remaining blockers, zero effects, and non-reusable
  old authorization.
- Any connector, bridge, cancellation capability, native-signal conversion, identity derivation, private-port protocol,
  source manifest, runtime, signer, route, or readiness-security-field change invalidates the report.

## Required verification

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
npm run check
npm run lint
npm run test:cr12b
npm test
CI=true npm run test:build
npm run db:verify
git diff --check <review-integration-base>...HEAD
```

If the prepared checkout is not stage-zero ready, stop without installing or repairing. No Hermes/native/SSH,
credential, protected-value, provider, production database, deployment, DNS, hosting, or external effect is authorized.

## Report and disposition

The report must separate observed, documented, inferred, blocked, and unsupported claims. Every finding needs a stable
ID, severity, exact source line, reproducible input, observed result, violated invariant, affected boundary, missing
regression, and smallest safe remediation. Passing producer tests never overrides a reproduced defect.

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Acceptance removes only the connector-review blocker. Trusted signer enrollment, signed
route enrollment, effect-free preflight, packet refresh, fresh owner authorization, native qualification, live-panel
authority, production database, hosting, and deployment remain blocked.
