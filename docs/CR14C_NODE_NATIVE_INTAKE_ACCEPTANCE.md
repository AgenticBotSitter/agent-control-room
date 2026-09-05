# CR14C node-native intake evidence

Date: 2026-09-05. Accepted product: `6c1fe4aec56b20b62f0af71e8e80c532b6b28c47`.
Tree: `196498fe564fed608582b0e00cd7e405e85d0d55`.
Base: `9b729cf7ddef1b5e5444047754fa55eb0af135e8` (PR #322).

Independent re-review accepted the corrected product with no remaining blocking findings. Command:

```sh
node --import tsx --test tests/node-native-intake.test.ts tests/node-bridge.test.ts tests/native-task-bridge.test.ts tests/native-delivery-receipt.test.ts
```

Exit zero: 64 passed, no failures/skips. Actual canonical task/approval storage and signed transmission
feed the real bridge's authenticated owner-verified intake. The resulting real signed node receipt is
accepted by the actual canonical receipt store. All keys, payloads and transports are synthetic;
SQLite/PGlite stores are disposable. There are zero native/provider calls or physical connections.

Coverage includes absent handler, closed/expired owner authority, generation changes, concurrent intake,
caller-input mutation, pre-commit rollback, uncertain receipt send, append-only SQLite reopen/history,
duplicate refusal and a full signed replacement-handshake regression. No generic command-queue entry
or execution grant is created by intake. Private node storage remains a host prerequisite.

Negative evidence retained: initial product `6525914` passed 63 independent checks but review found
that an old native-dispatch failure unconditionally invalidated a replacement connection. The corrected
catch checks generation. The added full bridge test also uses connection-scoped reconciliation counters,
so a prior connection's higher sequence cannot prevent the new handshake. The earlier handler-only
test did not exercise this failure path. Initial broad verification overlapped this correction and is
not final frozen-product evidence.

See `CR14C_NODE_NATIVE_INTAKE_CONTRACT.md` for closed-handler ownership, protected payload storage,
receipt uncertainty and remaining execution/acknowledgement/recovery work. This is in-process
integration, not a live worker or private-beta acceptance. No merge, deployment, credential access,
real database service, provider call or physical listener was performed.

Final corrected-product verification exited zero: CR14C 527, preparation 769, main 1,111 with two
existing platform skips, post-suite 392. Both builds, private compiled 18, rendered 4, migrations0052/138
tables, TypeScript and full ESLint passed. Current-head GitHub CI is required before dependency-order
integration; local verification does not imply a merge or live acceptance.
Published as [PR #323](https://github.com/MarvinAi5/control-room/pull/323), stacked on #322.
