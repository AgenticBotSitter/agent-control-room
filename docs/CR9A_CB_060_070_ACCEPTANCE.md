# CR9A-CB-060 and CB-070 acceptance

**Status:** Complete for the exact local synthetic repository snapshot
**Date:** 2026-08-29
**Authority:** `CR9A_CONTENT_BLOOMS_PLACEMENT_CONTRACT.md`, `CR9A_CONTENT_BLOOMS_COMMAND_RUNTIME.md`, CR-5C final security contract, ADR-037, ADR-052, ADR-056, ADR-057

## Accepted implementation

The accepted slice adds:

- migration `0026_cr9a_content_blooms_placement.sql` with eight protected placement-ledger tables;
- exact signed node-attestation verification evidence;
- durable request, authorization, claim, pre-effect marker, outcome, and tombstone storage;
- a fake-only placement command adapter with no endpoint, credential, or production source constructor;
- deterministic accepted, already-applied, rejected, and ambiguous source outcomes;
- restart recovery that distinguishes an unmarked claim from a marked unknown effect; and
- independently reviewed research, transcription, and article procedure/knowledge packages plus a safe operator projection.

## Proved behavior

The focused acceptance proves:

- the separate node attestation is Ed25519-verified and exactly binds node, tenant, project, job, attempt, operation, risk, time, nonce, and key identity;
- the declaration, request, central strong-factor records, node evidence, claim, marker, outcome, and tombstone survive store reconstruction;
- an accepted preference crosses the fake boundary once, persists one outcome, and exact replay never invokes the source again;
- the source may report `already_applied` under the same stable idempotency key;
- a bounded source rejection is terminal and is not retried;
- stale synchronized work-item version/checksum/digest fails before a claim, marker, or source call;
- a changed request ID cannot alias the same semantic effect;
- a claim without a marker is safe to re-evaluate after restart;
- a marker without terminal truth becomes ambiguity after restart;
- a fake source that applies then loses its result becomes ambiguity, creates no automatic retry, and retains source reconciliation requirements;
- HMAC-authenticated mutable claim drift fails closed, effect claims reject deletion, immutable rows reject mutation, and all placement tables reject truncation;
- a permanent tombstone preserves the outcome, idempotency key, operation, and no-redispatch rule without deleting full evidence;
- the project pack covers research, transcription, and article review using the real package registry and independent reviews; and
- the pack and operator projection cannot approve, dispatch, execute, lease, run live research/transcription, read bodies, or publish.

## Verification evidence

| Gate | Result |
|---|---|
| Stage zero | `ready_for_runtime_check` |
| Focused combined CR9A test | 40 passed, 0 failed |
| TypeScript | Passed |
| Full lint | Passed |
| Repository pretest | 202 passed, 0 failed |
| Main test suite | 416 total: 414 passed, 0 failed, 2 intentional platform skips |
| Production build/render | Passed; 2 rendered-route tests passed |
| Migration verification | Passed through `0026`; 96 PostgreSQL tables verified |
| Diff validation | Passed |

The sandbox denied only the ordinary `tsx` wrapper's temporary IPC socket; the same repository verifier passed through Node's installed `tsx` loader. The immutable accepted CR8Q subview re-review and packet retained SHA-256 hashes `5f014603d25e259009500a3a1ab457752e5c9af9bfb9ac0e55cf723b68808113` and `2a16b59c5469e50559977db55678e4ba6205261f7fb63a5dccc0c035937d58cc`.

## Authority disposition

No Content Blooms account, endpoint, credential, source database, production source record, network, bot, provider, native process, deployment, schedule, live placement, research request, transcription, article material, publication, mutation, or external effect was accessed. The database, signing key, source, command, records, and transport evidence are disposable local test objects.

CB-080/090 remains owner-controlled. It may prepare and review one exact authenticated read rehearsal and rollback packet, but this acceptance does not authorize an account, credential, connector, live read, live command, source mutation, native process, or deployment.
