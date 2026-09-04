# CR13A-LIVE-180 unwired retained-resource driver-port acceptance

**Status:** immutable product awaiting different independent zero-repair review
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

## Independent review requirement and limits

A different report-only reviewer must execute the immutable packet at
`docs/reviews/CR13A_LIVE_180_INDEPENDENT_REVIEW_PACKET.md` exactly once in a fresh local-only detached clone. Any command
failure, uncertainty, High/Medium/Low finding, hostile behavior execution, forbidden effect, dirty final status, or
cleanup doubt rejects the product. The reviewer may not repair or retry it.

Even a clean review permits ordinary owner-controlled integration only. It does not create or receive a real native
resource, change the physical driver, observe or select a locator/port, create a custody provider, issue a capability,
clear a blocker, assemble a candidate, make a physical attempt, wire a runtime, contact a provider, or grant production
authority.

