# CR14C native channel evidence

Date: 2026-09-05. Independently accepted product:
`03d1e66f7deaac00e8cfc8fac050f31541025c96`.
Tree: `94254e56bf66d2dce26c72d17e2086fd247811a6`.
Base: `36f752e615141d62258dd4f8241eadad50482558` (PR #317).

The portable bridge now supplies negotiated, reconciled, generation-fenced native delivery channel
evidence. It snapshots configuration and preserves the actual authenticated feature/frame-size contract.
It does not advertise native delivery, implement a receiver/sender or grant permission to execute.

Independent final review accepted with no remaining blocking findings. This command exited zero:

```sh
node --import tsx --test tests/node-bridge.test.ts tests/native-delivery-protocol.test.ts tests/native-delivery-preparation.test.ts
```

41 passed, zero failed/skipped. Cases include absent/unfinished negotiation, feature omission, mutable
caller configuration, copied status, disconnect/reused connection ID, protocol failure, delayed
authentication after close, early/delayed resume, and blocked signing plus already-queued acknowledgements
across reconnect. Real disposable SQLite and synthetic cryptographic keys/transports are used.

Review history is retained:

- Initial `c71e8a0` passed38 review checks but permitted resume to bypass reconciliation and lacked
  a post-handler generation fence. Private reconciliation provenance and post-await fences corrected it.
- `9520294` passed40 checks but captured the send generation too late, after leaving the queue.
  Enqueue-time fencing plus a queued-ack regression corrected this at the accepted product.
- Initial producer fixtures reused every outbound message ID, then used a global wire sequence for a
  new connection. A subsequent fixture used `reason` instead of `reasonCode` and omitted initial
  connection acceptance. These failed tests were corrected to the real protocol, without relaxing it.
- Two broad runs overlapped these corrections and failed on the respective unfinished fixtures.
  Those runs are not final-product acceptance evidence; the frozen-product rerun below supersedes them.

Final frozen-product lifecycle wrapper exited zero: CR14C457, preparation769, main1041 with two
existing platform skips, post-suite392. Both builds passed, with18 private compiled checks and four
rendered-page checks. TypeScript, full ESLint, stage zero, whitespace and migrations0001–0049
(135 tables) passed. No product changes followed independent acceptance or this final verification.

No live credentials/provider/native calls, listener, production database, deployment or merge.
Remaining work: server session negotiation and current keys, durable signed sending/receipt tracking,
actual node intake/admission, owner signing/custody and bounded revision submission.

Published as [PR #318](https://github.com/MarvinAi5/control-room/pull/318), stacked on #317.
Current-head GitHub CI remains required before dependency-order integration; no merge is claimed.
