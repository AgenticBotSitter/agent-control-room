# CR13A-LIVE-260 private same-module native-composition shell contract

**Status:** architecture frozen; repository-only contract implementation pending independent review
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Accepted LIVE-250 product:** `9b855d4193837fdf6d0d0fce1dcfd65a94cce49f`
**Accepted LIVE-250 review SHA-256:**
`2dcb825f522345c214064ded31134e00fecbfee9aa2121a65d507398081eaca6`

## Decision

LIVE-260 freezes an inert contract for a future native-composition shell that must share the same source module and
lexical scope as the LIVE-220 private factory WeakMap. Co-location is required so the accepted LIVE-250 bridge can hand
the exact factory directly into native composition without exporting, returning, serializing, logging, or accepting a
caller-supplied capability. This block does not implement the shell or bridge and does not modify LIVE-220 or LIVE-240.

The future shell is not a public API. It accepts no caller implementation, composition, bridge, permit, factory,
resource, locator, adapter, persistence client, clock, callback, event, or native input. Its implementation identity,
attempt binding, durable prerequisite evidence, adapter, persistence boundary, and independent cleanup observer must be
closed over exact repository-owned private values.

## Required private call graph

The future same-module path must:

1. enter through one non-exported, no-input native-composition entry;
2. verify exact accepted LIVE-250 product and review identity;
3. verify the exact module-owned implementation, composition, attempt, epoch, owner window, and expiry;
4. verify the durable attempt claim, locator spend, custody spend, and effect-uncertainty marker;
5. enter the LIVE-250 synchronous private bridge section;
6. consume the bridge once before one private WeakMap lookup;
7. hand the exact factory directly into the shell's lexical scope;
8. record private receipt without returning, serializing, logging, or digesting the factory;
9. invoke the exact factory once, separately from retrieval;
10. classify definite pre-construction failure or post-construction ambiguity without retry;
11. retain continuous issuer custody over any exact created resource;
12. privately observe one locator and offer the same object to the exact private adapter once;
13. transfer custody atomically only after exact acceptance, then close once by the current owner; and
14. durably reconcile cleanup, independent absence, tombstone, and external high-water checkpoint without reopen.

Bridge consumption, factory lookup, factory receipt, factory invocation, native construction, listener attempt, locator
observation, adapter acceptance, custody transfer, close, independent observation, tombstone, and checkpoint each have
a ceiling of one. Retrieval and invocation are separate one-use events; no code may infer that successful lookup means
the factory was invoked or that invocation means a resource exists.

## Failure, custody, and restart truth

- Rejection before bridge consumption is definite and makes no native attempt.
- Missing or mismatched private identity after bridge consumption is terminal and cannot be retried.
- Any throw, rejection, disconnect, cancellation, timeout, restart, or unknown settlement after factory lookup is
  ambiguous even if invocation cannot be proven.
- A definite factory outcome before native construction records no resource and permits no retry.
- Any created resource remains in issuer custody until the exact adapter atomically accepts that same object.
- Adapter rejection retains issuer custody; uncertain acceptance records unresolved ownership and forbids guessed
  cleanup ownership.
- Cleanup failure remains blocked until one independent no-reopen observation proves absence. Recovery can inspect and
  close only the same retained object; it cannot retrieve a factory, construct, bind, listen, select, retry, substitute,
  reconnect, or reopen.
- Restart resumes durable reconciliation only. It cannot re-enter the bridge, look up or invoke the factory, or create a
  replacement resource.

## Safe evidence

Public evidence may contain only fixed schema identifiers, accepted product/review digests, fixed policy names, bounded
counts, fixed status codes, booleans, and review references. It must never contain a factory, callable, server, socket,
listener, resource, descriptor, handle, callback, host, address, port, interface, locator, capability, protected value,
identity material, credential, native diagnostic, path, command, prompt, or provider content.

Repository status must say that the shell and bridge are unimplemented; the factory remains unreachable, unretrieved,
and uninvoked; no native effect is reachable; every actual call/effect count is zero; and all runtime wiring,
qualification, eligibility, blocker-clearance, external-effect, and authority values are false.

## Forbidden scope

LIVE-260 must not modify, import, or consume LIVE-220/LIVE-240; implement or exercise the shell or bridge; expose,
retrieve, return, invoke, copy, serialize, log, digest, or test the real factory; add a public getter or capability;
accept caller-owned dependencies; import `node:net` or another new native/effect module; create, listen on, inspect,
transfer, or close a real resource; observe or expose a locator; issue or spend live authority; write live persistence;
install handlers or timers; call LIVE-190 or a physical driver; wire an app, API, worker, Idea Lab, Hermes, startup, or
production consumer; clear a blocker; assemble a candidate; contact a provider; deploy; or make a physical attempt.

## Acceptance

Acceptance requires exact LIVE-250 product/review binding; complete immutable call-graph, ceiling, failure, custody,
restart, privacy, and blocker sets; explicit retrieval/invocation separation; exact parser identity; hostile input,
accessor/Proxy, ignored-argument, and ambient replacement non-execution; no shell/bridge/retrieval/invocation callable
export; no LIVE-220/LIVE-240 or native/effect import; no runtime consumer; exact zero-effect and false-authority truth;
the full producer gate; and a different independent report-only zero-repair review with no High, Medium, or Low finding.

Acceptance permits ordinary integration of an inert repository contract only. Modifying LIVE-220, implementing the
private shell or bridge, making the factory reachable, retrieving or invoking it, creating a native resource, observing
a locator, wiring runtime use, or making a physical qualification attempt requires another separately frozen and
reviewed block.
