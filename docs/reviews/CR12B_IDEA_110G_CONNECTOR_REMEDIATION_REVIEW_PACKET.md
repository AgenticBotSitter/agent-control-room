# CR12B-IDEA-110G — independent connector remediation re-review packet

## Frozen target

- Connector remediation implementation: `3e72cce7b7b91fd8f36bd5ebfe559984b30a2f68`.
- First connector candidate: `70f5890b3be5162896a585dae458a9a9c02e8036`.
- First connector review report SHA-256:
  `d9a1acb60b3a272a71469fc07574db2d504100f7a382fb33a702a50c585b5808`.
- Accepted fixed-bridge report SHA-256:
  `6ed834e8b5c3418bc0bc932e56ae991a9c33f4699b81860f78be194a34a5b9c8`.
- Runtime revision: `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`.
- Review mode: report only, zero repair, zero native or external effects.

The reviewer must be different from every IDEA-110F/110G contributor, the first connector reviewer, and all prior fixed-
bridge reviewers. Producer tests are inputs, not acceptance evidence. Acceptance covers only the unconfigured,
provider-disabled connector remediation.

## Mandatory original-finding closure

### CR12B-110F-REV001-001 — possible-session cleanup

- Reproduce the original paused `session.create` race: start route close, observe abort, then return a valid late-created
  receipt. Route close must not dispatch before at least one native session cleanup attempt.
- Repeat with create returning late success, throwing late, returning no collector value, double-submitting, returning a
  malformed receipt, returning an aliased session/epoch, and ignoring abort indefinitely until the bounded probe ends.
- Race close and caller abort at open and every ordinary/cleanup await. Prove active settlement precedes any close
  decision, no operation retries, and a possible create cannot be downgraded to “no session.”
- Verify cleanup can bind a late-created session through interrupt/status/close while the bridge never receives the
  canceled create receipt. Verify route close failure or malformed proof never becomes completed cleanup.

### CR12B-110F-REV001-002 — exact cancellation

- Put own getters, setters, data properties, symbols, and changed descriptors on genuine AbortSignals. Repeat with
  subclasses, custom/null/drifted prototypes, Proxies, lookalikes, and mutation after capture and during each await.
- Verify caller behavior and Proxy traps remain zero. Verify the connector uses no dynamic `aborted`,
  `addEventListener`, or `removeEventListener` property access on caller values.
- Pre-abort open, every ordinary operation, every cleanup operation, and route close. Open/ordinary/close must make zero
  private calls before rejection. Cancellation must never permit mandatory cleanup to be bypassed by a later route close.
- Abort before listener installation, immediately after installation, immediately before private dispatch, during the
  private await, after collector submission, and after return. Confirm one attempt and no retry on every path.

### CR12B-110F-REV001-003 — private error replacement

- Throw unique sentinel Error objects, primitives, Proxies, accessor-bearing errors, causes, locator/credential-shaped
  messages, and custom subclasses independently from open, operation, cleanup, and route-close private calls.
- Prove connector rejection is always a new bounded safe error and never retains, wraps, concatenates, logs, returns, or
  rethrows private identity, message, stack, cause, property, or behavior.
- Repeat collector-incomplete, collector-conflict, malformed-receipt, and post-return validation errors and prove no
  private diagnostics cross the boundary.

### CR12B-110F-REV001-004 — authority domain separation

- Pairwise alias connection identity, route, permit, profile, and conversation digests before open. Each must reject
  before private dispatch.
- Alias returned route lease against every accepted authority digest. Alias session and epoch against each other and
  every connection/route/permit/profile/conversation/lease domain. Each receipt must fail closed.
- Repeat omitted, malformed, overlong, re-digested, cross-attempt, swapped-field, and post-capture mutation cases.
- Confirm normal binding still holds across every operation and no equality check becomes vacuous through aliasing.

### CR12B-110F-REV001-005 — locator-free connection identity

- Prove fixed bridge derives exactly one domain-separated `connectionIdentityDigest` and connector/private-port input has
  no `connectionId`, hostname, username, port, key path, gateway, profile path, native session ID, or arbitrary locator.
- Put host:port, URL, filesystem path, SSH target, gateway, and human-readable labels into every connector-accepted field.
  Locator-shaped values must not enter connector state, private calls, receipts, or errors.
- Confirm both local and SSH modes use the same digest-only connector seam and the private mapping remains a future
  Mac-private-port responsibility.

## Whole-boundary regression

- Repeat every exact-host, receiver, lifecycle permutation, binding-drift, uncertain-open, uncertain-operation,
  duplicate-call, after-close, receipt-sanitation, mutation, disabled-composition, client-absence, and upgrade attack in
  the frozen IDEA-110F packet.
- Confirm the shipped record still has zero configured port, signer, route, connection attempt, SSH connection, native
  attempt, provider call, live-panel eligibility, or execution authority.
- Confirm production source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, gateway, provider, deployment, or generic-shell client and does not modify Hermes.
- Confirm the readiness record preserves the first negative report, exact remediation commit, pending re-review, seven
  remaining blockers, zero effects, and non-reusable old authorization.
- Any connector, fixed bridge, signal observer, identity derivation, private-port protocol, source manifest, runtime,
  signer, or route change invalidates the report.

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

## Disposition

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Every finding must include stable ID, severity, exact source, reproducible attack, observed
result, violated invariant, missing regression, and smallest safe remediation. Acceptance removes only the connector
review blocker. Trusted signer enrollment, signed route enrollment, effect-free preflight, packet refresh, fresh owner
authorization, native qualification, live-panel authority, production database, hosting, and deployment remain blocked.
