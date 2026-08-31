# CR9A-CB-050 placement-request contract acceptance

**Status:** Complete for the exact local effect-free repository snapshot
**Date:** 2026-08-29
**Authority:** `CR9A_CONTENT_BLOOMS_PLACEMENT_CONTRACT.md`, CR-5C final security contract, ADR-009, ADR-030, ADR-037, ADR-041, ADR-055, ADR-056

## Accepted implementation

The accepted contract layer adds:

- an independently reviewed placement declaration for the core `setWorkerPreference` command;
- exact transcription work-item, source-version, route-comparison, route-observation, lifecycle, job, attempt, and effect-intent binding;
- stable deterministic source idempotency and operation digests;
- a separate adapter lifecycle revision that changes on lifecycle operations but not read high-water;
- exact CR-8 strong-factor approval request and human decision binding;
- an effect-free pre-dispatch contract gate;
- accepted, already-applied, and rejected authenticated source-receipt shapes; and
- terminal non-retryable ambiguity with authoritative source reconciliation requirements.

## Proved behavior

The focused acceptance proves:

- the reviewed declaration itself grants no approval, network, command, lease, or execution authority;
- producer and reviewer identity must be different;
- a request binds the exact active read release, source work-item version/checksum/digest, eligible route, route validity, lifecycle, and effect identity;
- the same semantic effect receives one stable idempotency key even if a caller changes the request ID;
- changed replay under that key fails closed;
- busy/ineligible routes, route-expiry widening, stale lifecycle fields, scope drift, and digest drift fail closed;
- authorization requires the exact approved medium-risk strong-factor Completion Gate records;
- a denied or differently bound approval cannot authorize placement;
- read high-water does not invalidate placement, while disable and re-enable do;
- expiry equality denies pre-dispatch;
- the pre-dispatch result still grants no command or execution authority;
- source accepted, already-applied, and rejected receipts echo the exact idempotency key and preserve source lease ownership;
- a detached but internally re-digested source receipt is rejected when resolved against its authoritative request and authorization;
- ambiguity prohibits automatic retry and requires source reconciliation; and
- Proxies are rejected without executing traps.

## Verification evidence

| Gate | Result |
|---|---|
| Stage zero | `ready_for_runtime_check` |
| Focused combined CR9A test | 32 passed, 0 failed |
| TypeScript | Passed |
| Full lint | Passed |
| Repository pretest | 194 passed, 0 failed |
| Main test suite | 416 total: 414 passed, 0 failed, 2 intentional platform skips |
| Production build/render | Passed; 2 rendered-route tests passed |
| Migration verification | Passed through `0025`; 88 PostgreSQL tables verified |
| Diff validation | Passed |

The sandbox denied only the ordinary `tsx` wrapper's temporary IPC socket; the same repository verifier passed through Node's installed `tsx` loader. The immutable accepted CR8Q subview re-review and packet retained SHA-256 hashes `5f014603d25e259009500a3a1ab457752e5c9af9bfb9ac0e55cf723b68808113` and `2a16b59c5469e50559977db55678e4ba6205261f7fb63a5dccc0c035937d58cc`.

## Authority disposition

No Content Blooms account, endpoint, credential, source database, source record, network, command, bot, provider, native process, deployment, schedule, placement, mutation, or external effect was accessed. No placement command adapter or durable command dispatcher exists in this phase. All tests use sanitized in-memory objects.

CB-060 may implement the durable bounded command path only against injected fakes and protected stores. It must not weaken any negative-authority, lifecycle, approval, idempotency, claim, marker, source-receipt, or ambiguity rule frozen here.
