# CR-8I disposable completion-flow acceptance

**Status:** Complete for the exact local effect-free repository snapshot
**Date:** 2026-08-29
**Authority:** `CR8I_INTEGRATION_CONTRACT.md`, ADR-041, ADR-042, ADR-044, ADR-053

## Accepted implementation

CR-8I adds the versioned completion-flow receipt under `src/completion-flow/v1` and the deterministic acceptance in `tests/cr8-integration-acceptance.test.ts`.

The acceptance uses the real repository components:

- PostgreSQL-compatible Action Inbox persistence;
- authenticated rollback-pinned Telegram recipient, callback, update, and response-proposal records;
- authenticated rollback-pinned Completion Gate preference, approval, target, review, finding, revision, verification, and snapshot records;
- the real security identity/grant/strong-factor policy decision path;
- a rollback-pinned disposable SQLite secret ledger with the synthetic-only provider and fixed consumer;
- the deterministic synthetic executor; and
- the artifact manifest, producer claim, exact-byte hash, and lineage builder.

No integration component is replaced with a permissive workflow mock.

## Proved flow

The test records one question and one digest-bound Telegram choice. The resulting Telegram record is a proposal only. An independent policy record materializes that choice as a non-authoritative preference and resolves the question projection.

A separate human strong-factor path approves one exact consequential operation. The canonical effect remains `proposed`, no node approval attestation exists, and no effect claim or external execution occurs.

The test then resolves one synthetic scratch value through the node-local broker. The fixed consumer receives the value once, the consumer buffer is zeroed, the provider releases once, the terminal receipt is replay-safe, and the durable ledger does not contain the canary.

The initial synthetic artifact enters the Completion Gate. A producer-separated reviewer requests one explicit authority-statement repair. A second credential-free synthetic execution creates a different manifest, one immutable revision resolves the complete finding set, both named scenarios pass, and a different fully separated reviewer accepts the corrected target. The final Completion Gate snapshot is `ready` while every approval/execution flag remains false.

## Negative acceptance

The same test proves:

- altered artifact bytes cannot produce an execution observation;
- a receipt cannot be changed to claim the approved operation executed;
- the approved external operation digest cannot equal either executed local-operation digest;
- the Telegram callback token is absent from durable update storage;
- the scratch canary is absent from the durable secret ledger and final receipt;
- a Proxy receipt input is rejected without executing any Proxy trap; and
- malformed credential-catalog integrity is converted to the completion flow's safe `invalid_input` result.

## Verification evidence

| Gate | Result |
|---|---|
| Stage zero | `ready_for_runtime_check` |
| CR-8I focused test | 1 passed, 0 failed |
| TypeScript | Passed |
| Full lint | Passed |
| CR-8Q regression | 116 passed, 0 failed |
| Repository pretest | 162 passed, 0 failed |
| Main test suite | 416 total: 414 passed, 0 failed, 2 intentional platform skips |
| Production build/render | Passed; 2 rendered-route tests passed |
| Migration verification | Passed through migration 0024; 82 PostgreSQL tables verified |
| Diff validation | Passed |

The ordinary `pnpm run db:verify` wrapper was denied only its temporary `tsx` IPC socket by the local sandbox before migration work began. The same repository verifier passed through Node's installed `tsx` loader. The immutable CR-8Q accepted report and packet retained their expected SHA-256 hashes.

## Live-authority disposition

No account, bot, chat, webhook, network, provider, credential store, native process, deployment, production checkpoint, or external effect was used. The only credential value was a disposable synthetic test canary in memory. The approved consequential effect was deliberately left unexecuted.
