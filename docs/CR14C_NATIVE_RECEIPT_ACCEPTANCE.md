# CR14C authenticated native receipt acceptance

Date: 2026-09-05. Product: `dd38e24dcccb1df31557dd66334768d989a53035`.
Tree: `f36e4b51c845d6c359a9211d2500f32495b30341`.
Base: `34e8eef60524f2e7660f3b1c4c0d225f68d10331` (PR #321).

Independent read-only review accepted the exact product with no actionable findings. The authorized
command exited zero with 59 passing tests, no failures or skips:

```sh
node --import tsx --test tests/native-delivery-receipt.test.ts tests/native-transmission-intent.test.ts tests/server-node-session.test.ts tests/web-database-roles.test.ts
```

The actual negotiated server session authenticates a synthetic node-signed receipt, matches the saved
dispatch and passes it to the real canonical receipt transaction. Immutable receipt and chained audit
commit together. Current key locks, signature/HMAC checks, cancellation/time/session fences and exact
role denial are covered. History is current-owner scoped metadata, not payload or permission.

Tests cover genuine recorded and expired-task rejected receipts; mismatched packet, connection, key,
signature and timestamps; protocol acknowledgements mistaken for receipts; revocation between protocol
authentication and transaction; key expiry/cancellation/disconnect at commit; rollback and lost commit
acknowledgement; duplicate refusal; post-commit disconnect; immutable rows and corrupted HMAC history.
The retained signed receipt is evidence of the node's report, not independent verification of its local
storage or execution. There is no native agent receipt producer or intake/admission handler mounted yet.

Negative evidence retained:

- The first receipt fixture used an incorrect protocol literal: 17 failures, corrected to the existing
  protocol constant. An initial audit actor type was also rejected by TypeScript and corrected to worker.
- The next run had 11 passes and 6 failures because its sequence lookup selected another fixture
  connection. The query now matches tenant, node and exact connection. No replay check was relaxed.
- A one-millisecond expiry fixture failed before its intended commit boundary. The test now uses a
  one-second window and explicitly asserts that its commit hook was reached. The final targeted four
  checks passed. A concurrently started four-file run retained the older test and failed 2 of 59;
  the independent frozen-product run above passed all 59.

Migration0052 adds the 138th table, append-only guards, a transmission-intent foreign key and
coordinator SELECT/INSERT only. Schema digest:
`93d4767ea03998da6049b2e75c2b3cdf3b2c6da150dc024278a10786aa0dc6c3`.

See `CR14C_NATIVE_RECEIPT_CONTRACT.md` for host serialization, terminal session and replay uncertainty
limits. No automatic retry, cross-connection recovery, receipt acknowledgement, native start, credentials,
physical listener, real database service, deployment or merge is claimed.

Final frozen-product verification exited zero: CR14C 514, preparation 769, main 1,098 with two existing
platform skips, post-suite 392; private compiled 18 and rendered 4. Both application builds, migration
verification through0052/138 tables, TypeScript and full ESLint passed. Current-head GitHub CI is still
required before dependency-order integration; local acceptance is not a merge or live acceptance.
