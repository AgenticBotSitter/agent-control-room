# CR13A-LIVE-290 unreachable native target-runtime observer acceptance

**Status:** independently accepted for ordinary integration of unreachable source only
**Product/tree:** `3d09b2b9287b1174a3e7ebe931bc2860a5ce2bba` /
`5d0e48abc4ee2489d13e9478e8e87f7cde532c1e`
**Architecture parent:** `3dbd68ac40e8cd4fa508d70cedd3d7f472bfacc2`
**Accepted review:** `docs/reviews/CR13A_LIVE_290_INDEPENDENT_REVIEW.md`
**Model/effort:** `gpt-5.6-sol`, `xhigh`

## Outcome

The product adds the minimum real Mac target-runtime observation source without making that source usable. One frozen
no-input observer is stored in a private WeakMap outside the safe barrel. There is no lookup operation, consumer,
callback, capability, invocation path, raw-value output, or runtime wiring.

The observer body names only four `node:os` calls and four process fields. It executed zero times. Initialization,
tests, and public parsing read no host, process, environment, or path values. Public evidence exposes only fixed
implementation-presence and zero-use facts: all 22 actual totals are zero and all eight authority grants are false.

## Verification

Producer verification passed macOS stage zero, TypeScript, lint, 10/10 dedicated tests, 296/296 CR13A tests, the
complete 769/392/392 lifecycle, all five build phases, 4/4 rendered routes, migrations 0001-0036/119 PostgreSQL tables,
whitespace, and clean status.

A different report-only reviewer passed all twelve inspection groups and the fixed fourteen commands once with High
0, Medium 0, and Low 0. The reviewer confirmed exact identities, private custody, zero lookups/invocations, zero
hostile execution, zero observations/effects, clean status/diffs, and verified disposable cleanup. Preserve
`docs/reviews/CR13A_LIVE_290_INDEPENDENT_REVIEW.md` unchanged; SHA-256
`df2f3fb2fd414d595f020395dfc69fde2857c413e82d8d206383e66c6555c9b6`.

## Retained boundary

Direct process-field reads are permitted only inside the presently unreachable body. Before any retrieval or
invocation, the next block must freeze a fail-closed trust boundary against ambient `globalThis.process` replacement,
getters, and proxies. It must also keep trusted clock, nonce, signer, candidate/attempt binding, replay checkpoint, raw
observation privacy, and owner authorization separate and disabled.

Acceptance grants ordinary integration of this exact unreachable source only. It grants no observer retrieval or
invocation, host read, attestation, signer, candidate, owner window, native action, physical qualification, runtime,
provider, blocker-clearance, deployment, or production authority.
