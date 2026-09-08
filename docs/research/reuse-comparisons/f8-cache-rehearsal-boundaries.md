# Remaining JWT caller boundaries: cache and rehearsal

Local research; application baseline `af6bcb4`. No application/dependency edits,
downloads, credentials, network, database, native providers or live login involved.

## Key-cache baseline: 13 cases passed

Executed actual `createAccessKeyCache` with the actual synchronous current verifier
factory. Nine invalid key sets cover empty/oversized/duplicate-ID/empty-ID sets,
wrong key type, private material, wrong algorithm/use and malformed modulus. Each
rejects, suppresses immediate reload, then permits a valid refresh after backoff.
Four held-load cases cover expiry at the freshness boundary, backward clock, close
while loading and valid coalesced refresh. Invalid held loads reject both consumers;
valid output copies the loader-owned key array and does not track its later mutation.

Command: `node --import tsx --test research/reuse-comparisons/f8-key-cache-boundary.test.ts`.
Result: 13 passed, zero failed/skipped/cancelled; total harness duration150.163791ms.
Focused ESLint passed. Stage-zero preparation check passed; its suggested native
readiness command was not executed. Synthetic RSA key material stayed in memory.

This is a current-factory regression target, not an execution of either candidate
library inside the cache. The reviewed candidate adapter preserves synchronous
factory construction and only changes returned verification functions; changing
factory construction to async would require new tests and invalidate that premise.
The matrix is not exhaustive for all malformed JWK fields or key sizes.

## Awaited rehearsal: seven actual-control-flow cases passed

Executed hash-pinned `private-database-rehearsal.ts` with exactly one in-memory
source adaptation: await the verifier result. The injected verifier delays the
actual current Node verifier behind a manually released gate. No jose/jsonwebtoken
package executes in this experiment. All other source imports use current modules.

The existing `openPool()` invokes `checkpoint()` before resource acquisition, so
the new await does not require a duplicate pre-open clock/cancellation mechanism for
the tested boundaries. While verification was held, pool/probe calls stayed zero.
After release:

| Case | Result | Pool-open sentinel calls |
| --- | --- | --- |
| Valid token/time | stopped at deliberate fail-on-open sentinel | 1 |
| Wrong owner | setup_incomplete | 0 |
| Expired token | setup_incomplete | 0 |
| Cancelled during verification | stopped | 0 |
| Monotonic elapsed at50-second safety boundary | stopped | 0 |
| Wall clock at packet expiry | stopped | 0 |
| Wall clock below original start | stopped | 0 |

All seven reject another invocation as already_attempted; probe calls remain zero.
The positive control deliberately never returns a pool: no database connection or
SQL occurred. None reports realPostgresAccepted. Imported code emitted the Node
experimental SQLite warning; this harness opened no SQLite store.

Command: `node --import tsx research/reuse-comparisons/f8-rehearsal-await-fit.mjs`.
Exit0. Source SHA256:
`d74c3f2bfdaea0840acf20a63e584fd8406ee0398b00e99f765b776fbf988bbe`.
Cache source SHA256:
`957522108a0c0f8b0bb6d9e363dbd071e16a5a7159133e84a54b8ae7d9fbf0e9`.

## Decision consequence and remaining gap

The earlier caller audit's request to add/recheck post-await preflight must account
for this existing checkpoint: do not add redundant custom infrastructure without
showing a missing behavior. This does not prove all freshness invariants: finite
monotonic input, regression relative to an intermediate high-water observation,
token expiry during unusual diverging wall/monotonic clocks, or stalled verification
that never settles were not exercised. The rehearsal's timer starts after preflight;
this experiment's manually released gate is not a bounded verification deadline.
Those distinctions belong in the final async contract and cost decision.

Owner bootstrap still has its separate Promise/precommit/high-water requirements.
Actual-candidate rehearsal mapping remains open. Independent
[source review](f8-cache-rehearsal-review.md) found no blocker for these bounded
claims; it did not independently rerun the tests. Existing actual-library policy/bootstrap/dispatch evidence should be
reused, not replaced by these current-verifier tests. No JWT winner is declared.

## Owner-bootstrap high-water experiment

The existing research harness now accepts `--high-water-only`. Four actual-bootstrap
control-flow cases compare its earlier illustrative freshness check to a narrow
adaptation that records the post-await observation in the existing high-water state
and uses that checked time for the returned `now` value.

Both monotonic controls commit once. In the discriminating case the first verification
observes start+100ms, then transaction entry observes start+50ms. The earlier research
`fresh` variant commits because its high-water still records the earlier pre-await
time. The adapted variant rejects on transaction entry: one verification, one
transaction entry, zero synthetic writes/commits. This is a defect in the illustrative
async migration, not evidence of a vulnerability in today's synchronous application.

Command: `node --import tsx research/reuse-comparisons/f8-bootstrap-async-contract.mjs --high-water-only`.
Exit0, four expected outcomes. No real persistence or candidate library executes.
The adaptation reuses the existing high-water variable rather than introducing a
new clock service. Other clock/deadline scenarios and actual-candidate execution
remain separate; a four-case result is not a complete production-ready async patch.
The updated `now` flows to `verifiedAt` by source inspection only; the counter stub
does not assert those arguments. The existing30-case current-verifier branch was
rerun after the harness edit and exited0 with count30; console output was truncated,
so this recheck is not a replacement for its earlier retained complete receipt.
