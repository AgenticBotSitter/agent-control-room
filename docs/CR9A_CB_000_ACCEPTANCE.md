# CR9A-CB-000 Content Blooms contract acceptance

**Status:** Complete for the exact local effect-free repository snapshot
**Date:** 2026-08-29
**Authority:** `CR9A_CONTENT_BLOOMS_ADAPTER_CONTRACT.md`, Founding Contract, ADR-041, ADR-042, ADR-044, ADR-055

## Accepted implementation

The versioned implementation is under `src/project-adapters/content-blooms/v1` and exports:

- strict sanitized operational record schemas and digest builders;
- an independently reviewed, read-only source-scheduled release record;
- digest-bound read request, page, and receipt builders;
- exact replay enforcement;
- disabled/enabled control state;
- expected-state enable, disable, upgrade, and rollback transitions;
- cursor and receipt high-water preservation; and
- safe exact-host errors.

## Proved behavior

The focused acceptance proves:

- the release has exactly seven reads, zero commands, and zero network/lease/execution authority;
- Content Blooms retains eligibility, lease, and domain-transition ownership;
- release evidence binds conformance and producer-independent Completion Gate acceptance;
- records are strict, sanitized, source-versioned, checksum-bound, and digest-bound;
- leased source work requires complete source-owned lease evidence;
- a read receipt binds exact scope, release, control state, request, page, cursor digest, and ordered records;
- exact replay is idempotent while changed same-page truth fails closed;
- cross-tenant records, wrong read kinds, unsafe paths, secret-shaped values, and stuck cursors fail closed;
- disable immediately prevents new receipt creation and preserves cursor/receipt high-water;
- upgrade and rollback preserve source truth;
- rollback cannot be disguised as enable and cannot re-enable a disabled adapter;
- stale state, unknown or future releases, and time rollback fail closed; and
- Proxies and accessors are rejected without invoking their behavior.

## Verification evidence

| Gate | Result |
|---|---|
| Stage zero | `ready_for_runtime_check` |
| Focused CR9A-CB-000 test | 10 passed, 0 failed |
| TypeScript | Passed |
| Full lint | Passed |
| Repository pretest | 172 passed, 0 failed |
| Main test suite | 416 total: 414 passed, 0 failed, 2 intentional platform skips |
| Production build/render | Passed; 2 rendered-route tests passed |
| Migration verification | Passed through migration 0024; 82 PostgreSQL tables verified |
| Diff validation | Passed |

The ordinary `pnpm run db:verify` wrapper was denied only its temporary `tsx` IPC socket by the local sandbox before migration work began. The same repository verifier passed through Node's installed `tsx` loader.

## Live-authority disposition

No Content Blooms account, endpoint, credential, source record, database, network, bot, provider, native process, deployment, schedule, source mutation, or external effect was accessed. Synthetic local objects only were used. The repository control state cannot grant the missing live connector authority.
