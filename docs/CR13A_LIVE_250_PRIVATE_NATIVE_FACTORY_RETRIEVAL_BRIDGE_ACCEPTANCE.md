# CR13A-LIVE-250 private native-factory retrieval bridge acceptance

**Status:** independently accepted for ordinary integration of the inert repository-only contract
**Product/tree:** `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f` /
`b9829f61fc9b10c5566f3871c8db3ce603df6ac2`
**Architecture commit:** `fa76bad664269de8eb35debca30f65786e5c1c51`
**Accepted LIVE-250 review SHA-256:**
`2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6`
**Model/effort:** `gpt-5.6-sol`, `xhigh`

## Outcome

The product freezes the one-use bridge required before the quarantined LIVE-220 native factory can ever meet a real
composition. It binds both accepted upstream products and reviews, requires durable claim/spend/uncertainty evidence,
consumes before lookup, permits one private lookup and direct handoff, and forbids return, serialization, logging,
digesting, public getters, caller-supplied capabilities, retry, or restart retrieval.

It does not implement the bridge, import or change LIVE-220/LIVE-240, retrieve or invoke a factory, import a new native
module, expose a retrieval callable, wire runtime use, or make any native, persistence, network, or protected read.

## Producer verification

Exact product `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f` passed macOS stage zero, TypeScript, lint, 8/8
dedicated tests, 263/263 CR13A tests, and the complete lifecycle: 769/769 pretests, the core suite with only the two
established Windows-only skips, and 392/392 posttests. All five build phases, 4/4 rendered routes, migrations
0001-0036/119 PostgreSQL tables, whitespace, and clean status passed.

## Independent review

A different report-only reviewer ran all twelve fixed commands exactly once against the immutable product in a fresh
local-only detached clone. The reviewer verified exact provenance, all fixed sets and ceilings, consume-before-lookup
ordering, failure and restart truth, same-module privacy, hostile and ambient non-execution, safe exports, zero-effect
status, and false authority. Findings were High 0, Medium 0, Low 0. The exact disposable review root was removed and its
absence verified.

Preserve `docs/reviews/CR13A_LIVE_250_INDEPENDENT_REVIEW.md` unchanged; SHA-256
`2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6`.

Acceptance permits ordinary integration of this exact inert contract only. It grants no authority to implement or
invoke the bridge, retrieve the factory, create a native resource, observe a locator, wire runtime use, qualify a native
path, contact a provider, deploy, clear a blocker, or exercise production authority.
