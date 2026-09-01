# CR12B-IDEA-110E — second independent bridge-remediation re-review packet

## Frozen target

- Product commit: `2bc80a20c7e4e1753b014395866972622c134fd3`.
- Rejected first remediation: `bb1faf989486bb3b16226d9a4cbec2223ef4e5f2`.
- Rejected predecessor: `0a736ad16e1ea7ffef37e434eba5bd46f483f95d`.
- REV-003 report SHA-256: `d5695fb5d52bbcf90cfa7440ae3ec46a3a46e8628ee7866ec90a291b4129b87f`.
- REV-001 report SHA-256: `7f9e3f73142a3af120218f3df51f9e47fbc71d5764bb586346da7c87ee75bd62`.
- Review mode: report only, zero repair, zero native or external effects.

The reviewer must be different from REV-003, REV-001, and every agent that authored, advised, or repaired either
remediation. Producer tests are inputs, not acceptance evidence.

## Required prior-finding attacks

The reviewer must independently repeat and explicitly close or reproduce all four `CR12B-REV003-*` attacks in
`CR12B_IDEA_110D_REMEDIATION_REREVIEW_PACKET.md`: concrete private-field receivers, paused-open and paused-operation
cleanup races, exact seven-operation signed authority, and expiry/rollback/cancellation during durable claim.

## CR12B-RR001-001 — post-claim clock exception

- Use a valid permit and a durable store whose claim succeeds.
- Make the trusted clock return one valid pre-claim time and throw on the post-claim sample.
- Prove exactly one claim and one `terminal_ambiguity` settlement use the last valid claimed time.
- Prove zero native bridge calls, no second execution, and no later clock call.
- Repeat with the settlement store failing and classify the outcome honestly without inventing durable success.

## CR12B-RR001-002 — top-level constructor wrapper

- Put an enumerable getter independently on every required and optional constructor field.
- Prove every wrapper rejects with zero getter calls and zero collaborator calls.
- Repeat with a setter, non-enumerable property, symbol, unknown property, inherited property, null-prototype wrapper,
  Proxy wrapper, and proxied optional clock.
- Confirm valid concrete private-field spend-store and native-bridge classes still compose on their original receivers.

## Whole-boundary checks

Repeat locator and protected-value leakage, replay gaps/truncation, gateway epoch drift, malformed terminal output, usage
drift, duplicate execution/cleanup, uncertain open, connector error, hostile nested Proxy/accessor values, method-set
drift, cleanup ordering, post-await cancellation, and upgrade-boundary attacks. Confirm every default composition remains
disabled and no report claim implies real enrollment, connector acceptance, native qualification, a live panel,
production readiness, or deployment.

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
credential, protected-value, provider, production database, deployment, DNS, hosting, or other external effect is
authorized.

## Disposition

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Every finding must include a stable ID, severity, exact source location, reproducible attack,
observed result, violated invariant, missing regression, and smallest safe remediation. Acceptance must explicitly close
all six prior findings and retain every later connector, signer, enrollment, owner, native-effect, and deployment gate.
