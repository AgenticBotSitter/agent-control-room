# CR14C native delivery protocol evidence

Date: 2026-09-05. Accepted product: `a3dcb5a546f122d02ecead18f89a21bece92af21`.
Tree: `a63a39f1d87960dc510c1e3146e59c80a7e8cbee`.
Base: `a3cf7ebb2c43d414a0a3d634724b869b69f2743c` (PR #315).

The shared signed node protocol gains exact native dispatch and receipt schemas, with a local-enrollment
binding handoff to the existing paired owner-signature intake. Server signature authenticity is not owner
approval or local admission. Receipts match exact dispatch/task/packet/binding and remain evidence only.
No sender, bridge handler, feature advertisement, durable receipt store or execution path is activated.

Initial focused delivery tests passed six; after adding actual local intake and invalid-owner tests,
the three-file suite passed21 and failed one committed-JSON-schema comparison. The installed generator
regenerated the protocol artifact; the unchanged comparison then passed with22 total tests. TypeScript
also caught an operation field-name error, a missing synthetic resolver algorithm and an overly broad
fixture literal type; these were corrected without weakening runtime checks or using type assertions.

Initial independent review of `51cce9d65634de2a09a23d81bf00eff43d73e940` passed34 tests but requested
changes: inputDigest was format-checked without comparison to exact prompt/instructions. The approved
execution payload binding was intact, but canonical input provenance could be contradictory. The final
correction recomputes that digest and tests a newly server-signed inconsistent message, not merely a
body modified under an old signature. Independent re-review accepted this exact corrected head and tree
without remaining blocking findings. Its command passed35 tests, zero failures/skips, exit zero:

```sh
node --import tsx --test tests/native-delivery-protocol.test.ts tests/node-protocol.test.ts tests/native-approval-intake.test.ts tests/hermes-native-isolation.test.ts
```

An earlier full wrapper and build run started before that correction. Its results are retained but cannot
serve as final-head acceptance because the worktree changed during the run. Final exact-head runs must
complete independently. The initial compiled builds,18 private checks,four rendered routes, migrations
0048/134 tables,TypeScript and full ESLint passed. The exact corrected head also passed both builds,
18 private checks,four rendered routes,migrations0048/134 tables,TypeScript and full ESLint. The exact-head
full lifecycle wrapper exited zero: CR14C446, preparation769, main1025 passed with two existing platform
skips, and post-suite392. Stage zero and whitespace passed. No product changes followed final re-review;
only this documentation handoff changed. No live effect was consumed or attempted.

The earlier mixed-head lifecycle also exited zero (CR14C445, preparation769, main1025 with two skips,
post-suite392); it is retained as chronology, not substituted for the exact-head rerun above.

The reserved native-delivery feature must be mutually negotiated before runtime activation. Older nodes
must reject unsupported native work; no generic-message fallback is authorized. Current queue signing,
durable delivery/receipt processing, node admission wiring and owner signing/custody remain incomplete.

Published as [PR #316](https://github.com/MarvinAi5/control-room/pull/316), stacked on PR #315.
Current-head GitHub checks remain required before dependency-order integration; no merge is claimed.
