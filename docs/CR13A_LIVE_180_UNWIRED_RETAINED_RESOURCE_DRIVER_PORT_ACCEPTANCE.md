# CR13A-LIVE-180 unwired retained-resource driver-port acceptance

**Status:** independently accepted; ordinary owner-controlled integration ready
**Product target/tree:** `052afc3b4a61f1c6f1957a567f5305f3a2c5bca0` /
`2e3a8bd1a1b0c49019630f83e78764a2236ec3d8`
**Design parent:** `47e58d34095be4d7a390534df92d84ef7fe1e9d0`
**Main base:** `4f0970bfc1c453934f5b860f0057c8c5db79bb0a`
**Accepted LIVE-170 product:** `7e76e1980541075f9a1fa45479d20f06a823ef29`
**Accepted LIVE-170 review SHA-256:**
`3581dcf33774e730614346d57594738236acf0932fa581214af7931af67c1381`
**Model/effort:** `gpt-5.6-sol`, `xhigh`

## Outcome

The immutable product implements a repository-only driver-port state machine for the future retained-resource handoff.
Its resource is a module-private branded fake that never crosses the module boundary. Four fixed scenarios prove exact
same-fake identity, one handoff spend, serialized promise settlement, distinct pre-acceptance rejection and
post-acceptance ambiguity, mandatory close, cleanup failure, and one no-reopen recovery path.

The public implementation and status records are exact-provenance, frozen, digest-bound, and authority-negative. They
contain no address, port, locator, resource, server, socket, file descriptor, handle, or capability. Exact replay returns
the original operation promise without a second attempt. Copies, accessors, symbols, Proxies, borrowed receivers,
ambient intrinsic replacement, illegal order, and invalid scenarios fail closed with fixed safe errors.

This is not the real native driver seam. `realDriverPortImplemented`, `realCustodyProviderImplemented`,
`clearsExclusivePortCustodyBlocker`, and `activationEligible` remain false. The driver-reservation handoff gap and
exclusive-port-custody blocker remain present.

## Producer verification

Exact product `052afc3b4a61f1c6f1957a567f5305f3a2c5bca0` passed macOS stage zero, TypeScript, full lint,
10/10 dedicated tests, 176/176 connection tests, and 192/192 CR13A tests. The complete registered lifecycle passed
769/769 pretests, 419 core passes plus two established Windows-only skips, and 392/392 posttests. Production build
passed all five phases; 4/4 rendered routes passed; migrations 0001-0036 verified 119 PostgreSQL tables; whitespace
validation passed.

The package-level `npm run db:verify` wrapper is not used inside the restricted review environment because the `tsx`
CLI attempts to create a private IPC pipe. The deterministic repository verifier passed through the accepted listener-
free Node loader command `node --import tsx scripts/verify-migrations.ts`. This is an execution-environment constraint,
not a database failure.

Every actual host observation, port selection/reservation, native-resource creation/retention, handoff capability
issue/spend, driver handoff, native-backend construction, listener/IPC/socket/timer attempt, network observation,
protected read, authority grant, runtime wiring, and external effect remained zero or false.

## Independent review and limits

The first different reviewer passed all twelve required product commands with no product finding, but invalidated the
review by running one extra inspection command against the wrong commit after the fixed sequence. The reviewer stopped
without retry or repair and removed the disposable checkout. Preserve the procedurally rejected report at
`docs/reviews/CR13A_LIVE_180_INDEPENDENT_REVIEW.md`; SHA-256
`8e7dc95989a493bcbdec514751d5a5912da7be9794faa01d44f79253285a1568`.

A second different report-only, zero-repair reviewer then passed all twelve fixed commands and all twelve review groups
against the unchanged immutable product. The review found 0 High, 0 Medium, and 0 Low defects. Twelve committed hostile
attempts and six ambient replacement attempts executed zero caller or replacement behavior. All forbidden effects and
authority totals remained zero or false, both Git statuses were clean, and disposable cleanup plus exact absence
verification passed. Preserve `docs/reviews/CR13A_LIVE_180_INDEPENDENT_REREVIEW.md`; SHA-256
`05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76`.

Even a clean review permits ordinary owner-controlled integration only. It does not create or receive a real native
resource, change the physical driver, observe or select a locator/port, create a custody provider, issue a capability,
clear a blocker, assemble a candidate, make a physical attempt, wire a runtime, contact a provider, or grant production
authority.
