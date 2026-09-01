# CR12B-IDEA-110I — independent cancellation-boundary remediation review packet

## Frozen target

- IDEA-110I product commit: `5c731e42bc54bc3dea88e079385b9616dd2042b4`.
- Rejected IDEA-110H product commit: `d22c76444b80f8dd469380aab52ec457f5d76fad`.
- IDEA-110H negative report SHA-256:
  `bd6a6560453a4ede8c32cbfc8c0f886e2accc99fa1fdee59087799fdb99f5b27`.
- IDEA-110H packet SHA-256:
  `4800d632123fc1d97a98ed4a3e887e7502520461ba3ce4533c718b1625acb4eb`.
- Review mode: source-code correctness review, report only, zero repair, zero native or external effects.

The reviewer must be fresh: different from every IDEA-110F through IDEA-110I contributor, every prior connector or
fixed-bridge reviewer, and every incomplete review attempt. Producer tests are inputs, not acceptance evidence. The
review may accept only the unconfigured, provider-disabled connector snapshot at the exact product commit above.

## Mandatory reproduction of the three IDEA-110H findings

### CR12B-110H-REV001-FINDING-001 — invalid cancellation crossing repository seams

- Reproduce the old behavior at `d22c764...`: a genuine native signal presented to gateway execute can consume the
  one-use permit before rejection; gateway cleanup and bridge cleanup can forward it to collaborators.
- Against `5c731e4...`, give gateway execute and cleanup and bridge execute and cleanup native, poisoned, accessor-bearing,
  Proxy, revoked-Proxy, forged, inherited, extra-key, pre-canceled, and post-capture-mutated signal inputs.
- Prove each rejects before lifecycle mutation, trusted time, permit spend or settlement, child-capability creation,
  collector behavior, bridge/connector dispatch, getter, trap, listener, or any other caller-controlled behavior.
- After each invalid cleanup, use a fresh valid opaque capability and prove the legitimate cleanup opportunity was not
  consumed. After invalid gateway execute, prove the same valid one-use permit can still execute exactly once.

### CR12B-110H-REV001-FINDING-002 — private native-signal mutation breaking cleanup

- Give a Mac-private-port double the connector-owned native signal during route open, session create, every ordinary
  operation, interrupt, status, session close, and route close.
- At each await boundary, mutate or retain the signal, poison its built-in event map with behavioral values, change
  reachable prototypes where the host permits it, dispatch private abort behavior, and return late success, late throw,
  no value, malformed value, or conflicting values.
- Race caller cancellation, route close, driver timeout, cleanup timeout, collector submission, and late completion.
- Prove connector-owned cancellation becomes terminal first; native abort failure cannot escape as a private object,
  wedge closing state, skip the active-settlement join, retry an operation, or bypass the mandatory fixed cleanup
  sequence. Route close requires exact cleanup proof and releases all retained native references.

### CR12B-110H-REV001-FINDING-003 — mutable ambient native conversion

- Import the connector, then replace `globalThis.AbortController`, `AbortController.prototype.signal`,
  `AbortController.prototype.abort`, and relevant ambient `Reflect` properties with counting and throwing behavior.
- Repeat substitutions before open and during every open/operation/cleanup/close await. Include unique Error, primitive,
  Proxy, accessor-bearing, cause-bearing, locator-shaped, credential-shaped, and custom-subclass sentinels.
- Prove the hostile constructor/getter/method executes zero times when substituted after import. Any captured native
  constructor/getter failure must become a new bounded `IdeaLabErrorV1`; native abort failure must be discarded while
  connector-owned settlement and cleanup continue. No sentinel identity, message, stack, cause, property, or behavior
  may cross the connector boundary.
- Inspect the private-new-target construction and captured callable assumptions. Report any remaining path that selects
  mutable ambient constructor, prototype, apply, iterator, event, or collection behavior after opaque acceptance.

## Opaque cancellation and complete inherited matrix

- Independently prove only `createHostCancellationControllerV1` mints an accepted frozen, zero-own-key signal with
  repository-private prototype and module-private state. Repeat forgery, receiver-loss, cross-realm-like, wrapper,
  subclass, Proxy, revoked-Proxy, prototype-drift, descriptor-copy, and mutation attacks with zero behavior.
- Verify one terminal abort, at-most-once listeners, idempotent unsubscribe, correct late subscription, isolation of
  throwing listeners, distinct execution and cleanup capabilities, timeout cancellation, and no unhandled rejection.
- Repeat the entire IDEA-110F/110G/110H review matrix: possible-session cleanup, private error replacement, pairwise
  authority-domain separation, locator-free connection identity, exact-host inputs and receipts, receiver preservation,
  lifecycle permutations, mutation during awaits, uncertain outcomes, no retry, disabled composition, client absence,
  pinned runtime/source/operation set, and upgrade invalidation.
- Prove the fixed bridge binds the exact connection identity across execute and cleanup and carries only repository
  opaque cancellation until the final Mac-private conversion.
- Confirm source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, provider, deployment, hosting, DNS, or generic-shell client and does not modify Hermes.
- Confirm shipped state still has zero configured port, signer, route, connection/native/SSH attempt, provider call,
  live-panel eligibility, production database contact, deployment, or execution authority.

Any change to connector, bridge, gateway, driver, cancellation capability, native conversion, private-port protocol,
identity derivation, runtime/source/operation pins, readiness security fields, signer, or route invalidates the report.

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

Build and rendered-route verification must run sequentially. If the prepared checkout is not stage-zero ready, stop
without installing or repairing. The reviewer may author a temporary out-of-tree, in-memory hostile probe but must
retain only sanitized evidence and remove it before reporting. No Hermes/native/SSH, credential, protected-value,
provider, production database, deployment, DNS, hosting, or external effect is authorized.

## Report and disposition

The immutable report must separate observed, documented, inferred, blocked, and unsupported claims. Every finding needs
a stable ID, severity, exact source line, reproducible input, sanitized observed result, violated invariant, affected
boundary, missing regression, and smallest safe remediation. Passing producer tests never overrides a reproduced defect.

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Acceptance removes only the connector implementation-review blocker. Trusted signer
enrollment, signed connection enrollment, effect-free preflight, packet refresh, fresh owner authorization,
owner-attended native qualification, live-panel authority, production PostgreSQL, hosting, and deployment remain
blocked.
