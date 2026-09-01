# CR12B-IDEA-110D — independent bridge-remediation re-review packet

## Frozen target

- Product commit: `bb1faf989486bb3b16226d9a4cbec2223ef4e5f2`.
- Rejected predecessor: `0a736ad16e1ea7ffef37e434eba5bd46f483f95d`.
- Immutable negative report integration commit: `d0875a7f80d887c6bcf7528346b1fe5aafc88c61`.
- Immutable negative report SHA-256:
  `d5695fb5d52bbcf90cfa7440ae3ec46a3a46e8628ee7866ec90a291b4129b87f`.
- Review mode: report only, zero repair, zero native or external effects.

The reviewer must be different from the reviewer who authored REV-003 and must not have authored, advised, or repaired
the remediation. Producer tests are inputs, not acceptance evidence.

## Required attacks

### CR12B-REV003-001 — receiver integrity

- Compose the real filtered driver, enrolled gateway, fixed bridge, and durable spend-store class boundaries or an
  equivalent ECMAScript-private receiver probe.
- Exercise execute, claim, settle, fixed execution, cleanup, and close through the captured-method seams.
- Reject the remediation if any method loses its original receiver or if a test-only receiver-independent fake can hide
  a production composition failure.

### CR12B-REV003-002 — cleanup race

- Pause route open and at least one fixed operation independently.
- Begin cleanup while execution is paused; prove cleanup cannot resolve or submit completed evidence before execution
  settles.
- Release the paused call and prove no later execution operation is dispatched after cleanup began.
- Verify execution ambiguity is durably ordered before cleanup completion/uncertainty and that ignored abort signals
  cannot create false cleanup success.

### CR12B-REV003-003 — signed operation scope

- Recompute the enrollment and permit operation-set digest from source.
- Prove the only authorized names are create, prompt, event replay, status, usage, interrupt, and close.
- Re-sign enrollment-shaped input containing `session.steer`, `session.resume`, a reordered set, an omitted operation, or
  an extra operation and prove each is rejected before bridge use.
- Confirm the fixed bridge cannot dispatch a method outside the shared set.

### CR12B-REV003-004 — expiry after claim

- Delay a successful durable claim until the trusted clock reaches exact expiry and then crosses it.
- Prove both cases make zero native-bridge calls, retain a terminal non-execution outcome, and cannot be retried.
- Test clock rollback and cancellation during claim with the same zero-dispatch requirement.

## Whole-boundary checks

Attack locator and protected-value leakage, replay gaps/truncation, gateway epoch drift, malformed terminal output, usage
drift, duplicate execution/cleanup, uncertain open, connector error, hostile Proxy/accessor values, and method-set drift.
Confirm all default compositions remain disabled and no report claim implies real enrollment, connector acceptance,
native qualification, live-panel authority, production readiness, or deployment.

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

If the prepared checkout is not stage-zero ready, stop without installing or repairing anything. No Hermes/native/SSH,
credential, provider, production database, deployment, DNS, hosting, or other external effect is authorized.

## Disposition

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Every finding must include a stable ID, severity, exact source location, reproducible attack,
observed result, violated invariant, missing regression, and smallest safe remediation. Acceptance must explicitly close
all four REV-003 findings and retain every later real-enrollment and native-effect gate.
