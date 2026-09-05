# CR14C saved approval revalidation evidence

Date: 2026-09-05. Accepted product: `07285197290ba24823ccd0faa26639a76353d5b2`.
Tree: `29412703f93db7ddcf2ac5145e6023c105d95db1`.
Base: `50a24df52279bf2d83a2cdc0ccee74981f62c0c9` (PR #313).

Independent review accepted the exact product without actionable findings. Its command exited zero,
38 passed with no failures or skips:

```sh
node --import tsx --test tests/saved-approval-revalidation.test.ts tests/canonical-approval-storage.test.ts tests/canonical-approval-preparation.test.ts tests/hermes-native-isolation.test.ts
```

Producer focused checks passed13, then15 after adding changed-enrollment/retired-key and restricted-role
snapshot-isolation cases. Both builds passed, with 18 private compiled checks, four rendered routes,
TypeScript, full ESLint and disposable migrations0001–0047/133 tables. Stage zero and whitespace passed.
The retained full lifecycle wrapper exited zero: CR14C427, preparation769, main1006 passed with two
existing platform skips, and post-suite392. No failed product verification occurred in this block.
Only documentation changed after the independently reviewed product.

The current canonical owner/session/project/reservation/node/key checks precede exact saved-packet
integrity and both signature checks. Commit-time cancellation/trust/expiry fences still apply. Historical
readback remains possible after expiry or closed pins, while this preparation refuses. The returned
private signed snapshot is not web-visible, does not carry a deferred freshness callback and does not
authorize execution after its transaction. No delivery queue insertion or server signing occurs.

The future writer must atomically revalidate and enqueue in one canonical transaction, then use current
node admission and claim/marker checks at the physical effect boundary. Merely sending the snapshot later
is forbidden. Owner signing/custody, durable queue/signing/delivery, node consumption and revisions remain.

No native/provider call, real credentials, physical listener, database provisioning, deployment or merge
occurred. Tests use synthetic signing keys and disposable SQL. PR #313 was still running CI33990318798
at the start of this block; no prerequisite completion or merge is inferred from that running state.
