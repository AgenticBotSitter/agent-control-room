# CR9A-CB-010 through CB-040 acceptance

**Status:** Complete for the exact local effect-free repository snapshot
**Date:** 2026-08-29
**Authority:** `CR9A_CONTENT_BLOOMS_ADAPTER_CONTRACT.md`, Founding Contract, ADR-041, ADR-042, ADR-044, ADR-055

## Accepted implementation

The accepted slice adds:

- 13 sanitized Content Blooms fixture records covering project, work, execution, blocker, worker-route, and attention facts;
- an injected fake-source read adapter for all seven frozen read operations;
- migration `0025_cr9a_content_blooms_sync.sql` with releases, control state, read receipts, per-operation streams, immutable record history, and reconstructable current projections;
- an atomic synchronization store that commits the exact page, opaque cursor, receipt, history, current records, and control high-water together; and
- deterministic Mac, Windows, and Linux transcription route comparison that remains a source preference observation.

## Proved behavior

The focused acceptance proves:

- fixtures contain no transcript body, draft body, raw media, signed URL, credential, or secret-shaped material;
- Proxy fixture arrays and Proxy source results fail closed without invoking traps;
- a disabled, wrong-scope, or wrong-release adapter fails before its injected source can run;
- all seven reads return strict pages and digest-only receipts with no command, network, lease, or execution authority;
- two-page synchronization advances the exact operation cursor and control high-water atomically;
- reconstruction from the same database preserves current projection, cursor, history, and state;
- exact replay adds no receipt, history, or projection mutation;
- independently re-digested receipts cannot detach request, page, release, operation, snapshot, chronology, or record truth;
- same source identity/version drift rolls back the entire database transaction;
- accepted releases, read receipts, and record history reject update and deletion;
- route results are deterministic regardless of input order and reject cross-tenant, expired, mismatched-runtime, unverified, or non-transcription inputs; and
- no eligible route is represented honestly and never becomes an implicit assignment.

## Verification evidence

| Gate | Result |
|---|---|
| Stage zero | `ready_for_runtime_check` |
| Focused CR9A test | 23 passed, 0 failed |
| TypeScript | Passed |
| Full lint | Passed |
| Repository pretest | 185 passed, 0 failed |
| Main test suite | 416 total: 414 passed, 0 failed, 2 intentional platform skips |
| Production build/render | Passed; 2 rendered-route tests passed |
| Migration verification | Passed through migration 0025; 88 PostgreSQL tables verified |
| Diff validation | Passed |

The ordinary `pnpm run db:verify` wrapper was denied only its temporary `tsx` IPC socket by the local sandbox before migration work began. The same repository verifier passed through Node's installed `tsx` loader.

The immutable accepted CR8Q subview re-review and its packet retained SHA-256 hashes `5f014603d25e259009500a3a1ab457752e5c9af9bfb9ac0e55cf723b68808113` and `2a16b59c5469e50559977db55678e4ba6205261f7fb63a5dccc0c035937d58cc` after this integration.

## Authority disposition

No Content Blooms account, endpoint, credential, source database, source record, network, bot, provider, native process, deployment, schedule, source mutation, placement command, or external effect was accessed. The fake source and database are local test objects. Content Blooms remains authoritative for eligibility, leases, placement, and domain transitions.

The next phase, CR9A-CB-050, is a contract-only security phase. It must define exact placement-request authorization, versioning, idempotency, and source receipt rules before any bounded command implementation can begin. It does not itself authorize a live source or command.
