# CR13A-LIVE-270 unreachable native-composition shell implementation

**Status:** architecture frozen; implementation may begin only from accepted LIVE-260 integration
**Model/effort:** `gpt-5.6-sol`, `xhigh`
**Accepted LIVE-260 product:** `01bfa6540cc83dc6099564e4fc9043be4cafddc6`
**Accepted LIVE-260 review SHA-256:**
`41c55ae9437f8951e18f919ec1569bbebe1f795cafeaade51a41826fc3d0f9f1`

## Decision

LIVE-270 may implement the accepted LIVE-260 shell and one-use retrieval bridge only inside the LIVE-220 source module
that owns the quarantined factory WeakMap. The shell and bridge remain non-exported, have no caller input, have no
runtime consumer, and are not invoked by tests. The product may make the factory lexically reachable to that private
shell, but it must record zero actual retrievals and invocations and keep native invocation disabled in every public
status.

This block proves source custody and fail-closed reachability, not native behavior. The accepted LIVE-240 fake remains
the executable proof of call ordering, concurrency, custody, transfer, cleanup, and restart behavior. LIVE-270 may bind
that accepted evidence but must not import it into the native module or substitute its fake dependencies for real
authority.

## Required implementation boundary

- Preserve the existing captured native primitives and exact factory object unchanged.
- Add one module-private, single-consumption bridge whose only successful lookup is the existing WeakMap entry keyed by
  the exact module-owned implementation record.
- Add one module-private no-input shell in the same lexical scope. No function, callback, capability, token, factory,
  resource, locator, server, native method, or effect handle may cross the module boundary.
- Keep bridge consumption, factory lookup, factory receipt, and factory invocation as distinct states. Retrieval alone
  never proves invocation; invocation alone never proves resource creation.
- Keep the shell unreachable from exports, the safe barrel, application/API/worker/Idea Lab/Hermes/startup code, tests,
  and dynamic import paths.
- Fail closed before lookup unless all exact accepted evidence and module-owned identity conditions are satisfied.
  Because no live durable inputs exist in this block, the private entry must remain uncallable and zero-use.
- Freeze any new private records/functions at construction and capture all validation intrinsics before use.
- Update public status only to describe the private implementation honestly. It must not claim a retrieval, invocation,
  resource, locator, effect, qualification, candidate, activation, blocker clearance, or authority.

## Static and hostile verification

Tests may inspect exact source, exports, consumers, descriptors, frozen public records, and zero-effect status. They
must prove that only the LIVE-220 module imports `node:net`, that no source or test imports a private callable, and that
the namespace exports no shell, bridge, retrieval, factory, resource, locator, or native operation.

Tests must not invoke the private shell, retrieve or monkey-patch the factory, import the native module through a fresh
cache-bypass path, replace `node:net`, fabricate a native server, listen, inspect a locator, or exercise cleanup. Hostile
record, accessor, Proxy, prototype, ambient replacement, and exported-namespace attacks must execute zero caller
behavior and preserve exact zero-effect truth.

## Forbidden scope

LIVE-270 must not invoke `createServer`, `listen`, `close`, or native event registration; create, bind, listen on,
inspect, retain, transfer, or close a real server; observe, select, reserve, or expose a locator; accept caller input;
issue or spend live authority; write persistence; call LIVE-190 or the physical driver; wire an app, API, worker, Idea
Lab, Hermes, startup, or production consumer; assemble a candidate; perform a physical attempt; contact a provider;
deploy; or clear a blocker.

## Acceptance

Acceptance requires exact LIVE-220, LIVE-240, LIVE-250, and LIVE-260 product/review bindings; exact same-module source
custody; non-exported/no-input shell and bridge; one-use private state; no native invocation or behavioral test; no new
native importer or runtime consumer; safe immutable public evidence; hostile and ambient zero execution; exact zero
actual effects and false authority; the full producer gate; and a different independent report-only zero-repair review
with no High, Medium, or Low finding.

Acceptance permits ordinary integration of unreachable source only. The first invocation or physical qualification
requires a new exact packet, fresh owner-attended authorization, bounded cleanup, and no retry.
