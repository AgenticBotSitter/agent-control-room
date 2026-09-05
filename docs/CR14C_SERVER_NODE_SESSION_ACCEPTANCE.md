# CR14C server node session evidence

Date: 2026-09-05. Accepted product: `6e7124336416d9f7c3ec63cdd9ec79f33ce55e05`.
Tree: `c0ee4930ff9684e9b493b488c4aad0bebecbe3c1`.
Base: `a1a3bda1238cf0dd54b9cb5bf1f101e830ac4cad` (PR #318).

The new explicitly supplied server session exchanges actual signed protocol messages with the portable
node bridge in tests. Node signatures/current database key records/replay state, server signatures,
feature/frame-size negotiation and handshake-covering reconciliation all participate. A bounded
single-process registry invalidates replaced sessions without allowing stale release to remove a new one.
This supplies connection-state evidence only, not task dispatch or permission to execute.

Independent re-review accepted the corrected product with no remaining actionable findings.

```sh
node --import tsx --test tests/server-node-session.test.ts tests/node-bridge.test.ts tests/native-delivery-protocol.test.ts
```

Exit zero:39 passed, no failures/skips. Tests cover real two-sided negotiation, feature omission,
configuration snapshot, expiry/clock rollback, mismatched node/revoked key, altered signer output,
uncertain signing/late completion, bounded registry replacement and a disconnect at the final handshake
await boundary. The server tests are registered in the main and CR14C suites.

Negative evidence retained:

- Initial producer run passed six and failed one fixture update because a revoked database key lacked
  its required revoked_at timestamp. The fixture was corrected without relaxing the schema.
- Initial independent review passed38 tests at `d17e450` but found an asynchronous disconnect could
  be overwritten by the late reconciling transition. Caller-side checks immediately after authentication
  and before post-send state changes, plus a deterministic microtask regression, fixed the finding.
- Earlier builds passed before correction but do not stand in for corrected-product final checks.

No credentials, native/provider calls, physical listener, production database, deployment or merge.
The registry must be owned by the single server process and replaced only from trusted host orchestration.
Session renewal/ongoing frame routing, durable task sending/receipts, owner signing and actual node
admission remain incomplete. Transport resources remain the supplying host's responsibility.

Final corrected-product verification exited zero: CR14C466, preparation769, main1050 with two existing
platform skips, post-suite392. Both builds,18 private compiled checks,four rendered-page checks,
TypeScript, full ESLint, stage zero, whitespace and migrations0001–0049/135 tables passed.
Only documentation changed after product acceptance and during this final verification.
