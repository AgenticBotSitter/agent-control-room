# CR13A-LIVE-100 default-disabled native-listener adapter acceptance

**Status:** first remediation re-review rejected immutable target `ea81bf82ef4726aa230841420beaca6e96f162cc`;
remaining M-001 and new L-003 remediated in `fbfdda99c8063f043bee6166ab664ba494382c85`; fresh third
zero-repair re-review required before integration
**Integration base:** owner-approved LIVE-090 merge `65ea851c123993d7760d6492966845f74ca1d665`
**Effect boundary:** repository code and deterministic tests only; no native driver, socket, listener, port, SSH,
credential, Hermes/provider, native process, production PostgreSQL/VPS, deployment, DNS, hosting, or network effect

## Delivered boundary

`ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1` is the exact bridge between the accepted listener plan
and a future physical adapter. It carries only a derived non-locator listener reference, the accepted plan digest,
fixed transport/capacity policy, and twelve explicit missing gates. The record is public-safe and digest-bound, but
its digest proves consistency only. Module-private provenance binds the returned object to the exact plan used to mint
it; copied or re-digested lookalikes are rejected. The record grants no approval, activation, or effect authority.

`DefaultDisabledConnectionEnrollmentPrivateLoopbackNativeListenerAdapterV1` implements the established listener port,
owns no driver, accepts no activation material, reports the plan-bound blocked readiness, and always returns the bounded
`disabled` result from `start()`. It rejects subclass construction; its exact-branded instance and prototype are frozen;
receiver misuse returns a bounded integrity error; and its binder exposes only frozen closures over captured base
operations. Repeated `close()` calls are harmless. The adapter records zero listener attempts and zero network-I/O
observations because it has no code path capable of attempting either.

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
or connection happened. The readiness record deliberately omits the raw listener ID plus endpoint, owner, tunnel-peer,
host-key, channel, address, and port values. It retains only the accepted listener-plan digest and a derived bounded
non-locator reference.

Proxy, accessor, added-field, nested-array, and nonordinary input is rejected before supplied behavior executes.
Readiness parsing accepts only the frozen object minted inside this module, so public digest recomputation cannot change
the listener/plan pairing. The adapter reuses the accepted node-ingress runtime-custody boundary. It does not make
fake/native evidence equivalent and does not introduce a way for an application caller to mint an enabled adapter.

## Deterministic evidence

Producer evidence for second remediation `fbfdda99c8063f043bee6166ab664ba494382c85`:

- macOS stage zero: `ready_for_runtime_check`, with no native attempt;
- TypeScript and full ESLint: pass;
- focused LIVE-060/070/080/090/100 listener suite: 55/55 pass;
- complete connection slice: 97/97 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and
  348/348 posttests;
- production build and 4/4 rendered-route checks: pass;
- the ordinary `pnpm db:verify` wrapper was blocked before migration work by the known sandbox denial of its `tsx` IPC
  listener; the listener-free verifier passed migrations `0001` through `0036` and 119 PostgreSQL tables; and
- whitespace validation: pass.

The owner-approved LIVE-090 merge is `65ea851c123993d7760d6492966845f74ca1d665`. Its post-merge GitHub run is tracked
separately and does not substitute for LIVE-100 review.

## Review and next boundary

The first independent zero-repair review rejected target `5582d57247f38498efe3c587762257bababa7658` with M-001,
L-001, and L-002. The negative report is preserved at
`docs/reviews/CR13A_LIVE_100_INDEPENDENT_REVIEW.md`; SHA-256:
`8cf72b4cad7abe66705612421b642e56a7d1d5af3aebc7ab21ab5e7866fb3f6c`.

First remediation `915a5ed20bafe76367e0ae8ab06252dd05e54dac` addressed M-001 at the adapter-instance boundary
with exact provenance, subclass rejection, frozen instance/prototype surfaces, exact-receiver enforcement, and a
captured-operation binder; it closed L-001 by accepting only module-minted frozen readiness records and closed L-002 by
replacing the raw listener ID with a derived non-locator reference.

The different remediation reviewer closed L-001 and L-002 but rejected target
`ea81bf82ef4726aa230841420beaca6e96f162cc`. M-001 remained because the frozen binder contained three function objects
that were not themselves frozen. New L-003 recorded that exact-diff whitespace checks rejected Markdown hard-break
spaces retained in immutable evidence. That report is preserved at
`docs/reviews/CR13A_LIVE_100_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`bcf4a8aa173c4c898205adc7b6cb4c1431f6105a8cae7719e43e5d5202db708e`.

Second remediation `fbfdda99c8063f043bee6166ab664ba494382c85` freezes and makes non-extensible each bound
operation before the enclosing binder is frozen, with own-`call`, function-property, and prototype-chain mutation
regressions. A three-path `.gitattributes` rule disables only the trailing-space check for the exact immutable evidence
files that intentionally preserve Markdown hard breaks; every other whitespace rule and repository path remains
unchanged. All three exact diff checks now pass. A fresh third reviewer must reproduce every original and remediation
case with zero repair. Any High, Medium, or Low finding still blocks integration and must be preserved.

Acceptance would permit ordinary owner-controlled integration only. It would not authorize adding `node:net`, opening
a listener, selecting or exposing a port, starting SSH, reading a credential, contacting Hermes, running a native
qualification, touching production, or deploying. The following block may define the separately gated native driver
and activation-evidence verifier, still default-disabled and tested only through injected fakes. Any real bind remains a
new owner-attended effect with a fresh exact packet and authorization.
