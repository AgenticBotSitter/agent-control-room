# CR13A-LIVE-340 private one-use native-observation invocation acceptance

**Disposition:** accepted for ordinary integration of the exact inert repository contract
**Product:** `3108a8759863c4692ade2d5532e88cd28f259779`
**Product tree:** `b9a077fa9f4ffa9a53740f236a68a8631f70100c`
**Design parent:** `7856adc8ab8e5e46c346e11755c999fb2bd295be`
**Independent review SHA-256:**
`bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af`

## Accepted result

LIVE-340 freezes the only acceptable future path for invoking the accepted LIVE-330 native-observation source. One
authenticated authorization must bind the exact source, complete tenant/project/connection/node/platform/runtime/
candidate/attempt lineage, one operation, a fresh nonce, and trusted issued/not-before/expiry time. It must pass an
independent replay check and be atomically consumed before one private lookup can occur. Time is rechecked after the
transaction, and uncertainty at or after commit is terminal with no retry, replacement, fallback, or inference.

The integrated product remains contract-only. It adds no authorization store, key, token, clock, nonce, replay
checkpoint, spend, source import, lookup, invocation, native read, observation, attestation, candidate, persistence,
listener, or runtime consumer. Its exact immutable truth contains one operation, 15 bindings, 15 rules, 16 stages, 15
blockers, five outcomes, 39 zero actual totals, eight false authority grants, and sanitized negative state.

## Verification

Producer verification passed:

- macOS stage zero: `ready_for_runtime_check`;
- TypeScript and full lint;
- 11/11 focused LIVE-340 tests;
- 350/350 CR13A tests;
- complete lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips and zero failures,
  and 392/392 posttests;
- all five production build phases and 4/4 rendered-route tests;
- migrations 0001-0036 with 119 PGlite tables; and
- clean range whitespace and repository status.

A fresh different reviewer inspected all twelve required groups and ran all fourteen fixed commands once in a
disposable clone. Exact identities, four changed paths, evidence binding, set counts, atomic ordering, terminal
ambiguity, privacy, singleton provenance, captured intrinsics, safe barrel boundary, and zero-effect truth matched. The
report records 0 High, 0 Medium, and 0 Low findings. The reviewer removed
`/private/tmp/cr13a-live340-review.0l5Mf0` and verified its absence.

## Authority retained

Acceptance permits ordinary integration of exact product `3108a8759863c4692ade2d5532e88cd28f259779` only. It does
not authorize issuing or consuming an authorization, clock/nonce/replay use, source lookup/invocation, native reads,
observation, attestation, candidate assembly, owner authorization, listener, physical qualification, runtime
activation, provider contact, deployment, blocker clearance, or production use.

The next block is CR13A-LIVE-350: implement the authenticated invocation-authorization store and durable replay
reservation without adding consumption, source lookup, source invocation, or a native read.
