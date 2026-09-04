# CR13A-LIVE-150 private locator broker boundary acceptance

**Status:** independently accepted; ordinary owner-controlled integration ready
**Product target:** `f089f896073fcc5aab24616a17fac592eba5146b`
**Product tree:** `b421964004d82f785ad8c8aff1338f865893eb41`
**Design parent:** `60f87d5031f5e292e0f69c010f345fedf7928f9e`
**Stacked base:** CR13A-LIVE-140 branch head `e8d498cb6ad3eb54720b400f662a43ce85d7a560`
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Effect boundary:** repository-only contract, fake, tests, build/render, and listener-free migrations; no address,
interface, DNS, port, reservation, capability, native, listener, socket, IPC, network, credential, or external effect

## Outcome

The product adds one exact private locator policy and one `repository_fake` result. It fixes a future private
IPv4-loopback/TCP locator capability to one target/candidate/attempt/epoch/reservation/spend, at most 30 seconds and
one spend, with terminal tombstoning and no automatic retry. Fourteen future private bindings are named without
including their values.

The fake keeps both `private_locator_broker_missing` and `exclusive_port_custody_missing`. It observes no address or
interface, resolves no DNS, selects/reserves no port, creates/issues/spends no capability, hands nothing to a driver,
and clears no blocker. Every present observation/effect count is zero and every authority grant is false.

Exact private provenance and digest custody ensure only the module's frozen singletons parse. Copies, accessors,
symbols, Proxies, decorated callables, ambient intrinsic replacement, or caller re-digests cannot become a real broker
or execute hostile behavior. Errors are fixed safe codes without stacks or caller/native text.

The module imports no host/network/native/effect subsystem, accepts no input or behavioral dependency, and is consumed
only by the safe connection-registry barrel. No app, API, UI, worker, scheduler, service, startup, Idea Lab, Hermes,
physical-driver, or deployment path consumes it.

## Producer verification

Exact product `f089f896073fcc5aab24616a17fac592eba5146b` passed:

- macOS stage zero: `ready_for_runtime_check`;
- TypeScript and full lint;
- 9/9 dedicated locator-broker tests;
- 149/149 combined connection tests;
- 166/166 combined CR13A tests;
- complete registered lifecycle: exit 0, including 769 pretests, 419 core passes with two established Windows-only
  skips, and 392 posttests;
- production build: 5/5 phases and 4/4 rendered routes;
- migrations `0001` through `0036`: 119 PostgreSQL tables; and
- whitespace: pass.

No address/port/host observation, physical-driver construction, listener, IPC, socket, timer, network I/O, protected
value read, or external effect occurred.

## Independent review

A different report-only, zero-repair reviewer accepted the unchanged product under packet SHA-256
`5ef8be99015c6f4820050e4d10601d05dec979aeb1037f95f91e648c27ce68ea`. All twelve fixed commands and twelve
hostile-review groups passed. Findings were 0 High, 0 Medium, and 0 Low. The dedicated gate passed 9/9, build 5/5,
render 4/4, and migrations 0001-0036/119 tables; initial and final status were clean.

Sixteen direct hostile cases and four ambient replacement attempts executed zero hostile behavior. Address/host
observations, interface enumerations, DNS resolutions, port selections/reservations, capability issuances/spends,
native constructions, physical-listener/IPC-listener/socket/timer attempts, network observations, protected reads,
driver handoffs, blocker clearances, and external effects were all zero.

Preserve `docs/reviews/CR13A_LIVE_150_INDEPENDENT_REVIEW.md`; SHA-256
`e7047c506fad1f969563d3bb1ae31df28083761b2470bc322a91c4aa733abd67`. Acceptance permits only ordinary
owner-controlled integration; it creates no real locator, port reservation, capability, blocker clearance, candidate,
physical attempt, or runtime behavior.

## Reevaluate

Reevaluate before any observer, locator/port operation, capability, ledger/checkpoint, resource observer, driver
handoff, candidate, owner window, native/listener/socket action, SSH/credential operation, provider/production contact,
or deployment.
