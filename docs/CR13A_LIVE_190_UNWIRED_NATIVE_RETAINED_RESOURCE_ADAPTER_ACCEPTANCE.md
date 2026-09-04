# CR13A-LIVE-190 unwired native retained-resource adapter acceptance

**Status:** immutable product awaiting different independent zero-repair review
**Product target/tree:** `7d45aae9db4c4012e2be3a072a85f7f4279f4874` /
`cd771b3b090e02a370a6ee2555c2377cf8f2e030`
**Design parent:** `b5f9675e8a6a1007a7fcb04875a384eeb59d8e69`
**Stacked LIVE-180 base:** `5225f0a57ee661d4a865a5ea91148afc6ede4273`
**Accepted LIVE-180 product:** `052afc3b4a61f1c6f1957a567f5305f3a2c5bca0`
**Accepted LIVE-180 review SHA-256:**
`05c4d57ad9f247916102acdc090c071b22a9b7a9623d1984779caf41d8acfd76`
**Model/effort:** `gpt-5.6-sol`, `xhigh`

## Outcome

The product adds the isolated native retained-resource adapter boundary that the physical driver will later use instead
of receiving a port number and binding a replacement server. The new module's only `node:net.Server` reference is a
type-only import that erases at runtime. Its private native-facing guard is not exported and always returns the fixed
`native_issuer_unavailable` error because no real issuer, resource, capability, or adapter exists in this block.

The repository fake proves exact same-fake-server identity, one acceptance spend, serialized promise settlement,
separate pre-acceptance rejection and post-acceptance uncertainty, mandatory cleanup, cleanup failure, and one no-reopen
recovery. Exact status provenance is bound to the originating adapter. No caller can provide, extract, copy, serialize,
or substitute a resource.

The previous LIVE-120 source-import assertion now distinguishes executable `node:net` imports from erased type-only
references. It proves the accepted physical driver remains the sole executable network importer and this adapter is the
sole type-only importer. The safe barrel is the adapter's only consumer.

## Producer verification

Exact product `7d45aae9db4c4012e2be3a072a85f7f4279f4874` passed macOS stage zero, TypeScript, full lint,
11/11 dedicated tests, 187/187 connection tests, and 203/203 CR13A tests. The complete registered lifecycle passed
769/769 pretests, 419 core passes plus two established Windows-only skips, and 392/392 posttests. Production build
passed all five phases; 4/4 rendered routes passed; migrations 0001-0036 verified 119 PostgreSQL tables; whitespace
validation passed.

Migration verification used the accepted listener-free command `node --import tsx scripts/verify-migrations.ts`
because the package-level `tsx` CLI wrapper cannot create its private IPC pipe in the restricted environment. This is
an execution-environment constraint, not a product or database failure.

Every actual host observation, port selection/reservation, native-server receipt, native-resource creation/retention,
handoff issue/spend, driver accept, native-backend construction, listener/IPC/socket/timer attempt, network observation,
protected read, runtime wiring, external effect, and authority grant remained zero or false.

## Independent review requirement and limits

A different report-only reviewer must execute
`docs/reviews/CR13A_LIVE_190_INDEPENDENT_REVIEW_PACKET.md` against the exact immutable product in a fresh local-only
detached clone. Any failure, uncertainty, finding, behavior execution, forbidden effect, dirty status, or cleanup doubt
rejects the product. The reviewer may not repair or retry it.

Even a clean review permits ordinary owner-controlled integration only. It does not add a real native issuer or
adapter, receive or touch a server, change the physical driver's backend, clear the handoff/custody gap, assemble a
candidate, make a physical attempt, wire runtime use, contact a provider, or grant production authority.

