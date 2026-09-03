# CR13A-LIVE-100 default-disabled native-listener adapter acceptance

**Status:** repository implementation candidate frozen at `8ba1057450414015c05f6e6ddfb94cd5abd7b99c`;
fresh independent zero-repair review required before integration
**Integration base:** owner-approved LIVE-090 merge `65ea851c123993d7760d6492966845f74ca1d665`
**Effect boundary:** repository code and deterministic tests only; no native driver, socket, listener, port, SSH,
credential, Hermes/provider, native process, production PostgreSQL/VPS, deployment, DNS, hosting, or network effect

## Delivered boundary

`ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1` is the exact bridge between the accepted listener plan
and a future physical adapter. It carries only the listener ID, accepted plan digest, fixed transport/capacity policy,
and twelve explicit missing gates. The record is public-safe and digest-bound, but its digest proves consistency only.
It grants no authenticity, approval, activation, or effect authority.

`DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1` implements the established listener port,
owns no driver, accepts no activation material, reports the plan-bound blocked readiness, and always returns the bounded
`disabled` result from `start()`. Repeated `close()` calls are harmless. The adapter records zero listener attempts and
zero network-I/O observations because it has no code path capable of attempting either.

The new module is exported for later composition but is not wired into the local pilot, browser, HTTP routes, worker
runtimes, Hermes, or any platform service. The local pilot continues to construct the older unconditional disabled
listener. The module imports no `node:net`, TLS, HTTP, datagram, child-process, or SSH implementation and contains no
listen, connect, spawn, fetch, or route call.

## Exact activation blockers

The readiness record remains `blocked_before_native_listener` until a separately reviewed future block supplies and
proves every one of these independent facts:

1. an accepted native driver;
2. exact fresh owner activation;
3. accepted platform qualification;
4. exclusive private-port ownership;
5. authenticated SSH-tunnel peer identity;
6. accepted SSH host-key custody;
7. enforced total connection deadline;
8. enforced idle deadline;
9. enforced admission deadline;
10. enforced backpressure;
11. bounded shutdown plus cleanup evidence; and
12. process-exit/restart recovery evidence.

The current parser accepts only the complete ordered blocker set and exact false values for every native, activation,
effect, retry, and authority claim. Removing or reordering blockers, adding fields, changing identity bounds, presenting
behavioral input, or setting an activation field true fails even if the caller recomputes the public digest.

## Safety and truth boundary

The plan permits one active connection, zero queued connections, one frame per connection, literal IPv4 loopback only,
a private unpublished port, and no automatic restart. Those are future adapter requirements, not evidence that a bind
or connection happened. The readiness record deliberately omits endpoint, owner, tunnel-peer, host-key, channel,
address, and port values. It retains only the accepted listener-plan digest and a bounded listener ID.

Proxy, accessor, added-field, nested-array, and nonordinary input is rejected before supplied behavior executes. The
adapter reuses the accepted node-ingress runtime-custody boundary. It does not make fake/native evidence equivalent and
does not introduce a way for an application caller to mint an enabled adapter.

## Deterministic evidence

Producer evidence for implementation `8ba1057450414015c05f6e6ddfb94cd5abd7b99c`:

- macOS stage zero: `ready_for_runtime_check`, with no native attempt;
- TypeScript and full ESLint: pass;
- focused LIVE-060/070/080/090/100 listener suite: 53/53 pass;
- complete connection slice: 95/95 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  346/346 posttests;
- production build and 4/4 rendered-route checks: pass;
- the ordinary `pnpm db:verify` wrapper was blocked before migration work by the known sandbox denial of its `tsx` IPC
  listener; the listener-free verifier passed migrations `0001` through `0036` and 119 PostgreSQL tables; and
- whitespace validation: pass.

The owner-approved LIVE-090 merge is `65ea851c123993d7760d6492966845f74ca1d665`. Its post-merge GitHub run is tracked
separately and does not substitute for LIVE-100 review.

## Review and next boundary

Because this contract defines the facts that will eventually stand immediately before a network listener, a different
independent reviewer must inspect the immutable base-to-product diff, reproduce the deterministic gates, and attack
forged/recomputed activation, incomplete/reordered blockers, listener identity bounds, behavioral and nested input,
runtime drift, disabled-start stability, repeat cleanup, local-pilot non-wiring, and the absence of any native/effect
path. The reviewer performs zero repair. Any High, Medium, or Low finding blocks integration and must be preserved.

Acceptance would permit ordinary owner-controlled integration only. It would not authorize adding `node:net`, opening
a listener, selecting or exposing a port, starting SSH, reading a credential, contacting Hermes, running a native
qualification, touching production, or deploying. The following block may define the separately gated native driver
and activation-evidence verifier, still default-disabled and tested only through injected fakes. Any real bind remains a
new owner-attended effect with a fresh exact packet and authorization.
