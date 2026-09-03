# CR13A-LIVE-060 bounded transport admission acceptance

**Status:** exact effect-free product `cee64a8197a011a91c06e6085d5f4d11e978ddbc` rejected by independent review;
Medium M-001 and Low L-001 require remediation and a different re-review before publication or integration
**Integration base:** `5a94bfd7f28d336274f6b29ad50575eb5a90a9b1`
**Effect boundary:** repository code and PGlite tests only; no listener, socket, SSH session, Hermes/provider call,
credential access, native process, production PostgreSQL/VPS contact, deployment, DNS, or network effect

## Delivered boundary

`ConnectionEnrollmentTransportAdmissionV1` is the effect-free server handoff between one future already-decoded
transport frame and the independently accepted LIVE-050 enrollment ingress. Its public request contains exactly one
string `rawFrame` and one untrusted `deliveryId` routing hint. It accepts no caller time, authentication result, tenant,
node, connection, host, route, profile, key, credential, approval, or authority label.

The immutable configuration accepts only:

- `transport: "ssh_tunnel"`;
- `listenerVisibility: "private_loopback"`;
- one opaque channel-identity digest;
- one integer UTF-8 frame ceiling from 4,096 bytes through `NODE_PROTOCOL_MAX_FRAME_BYTES`; and
- one bounded admission-policy identifier.

The class validates the exact input and UTF-8 byte length before consulting time or ingress. A synchronous server-owned
clock supplies canonical UTC chronology. The transport identity sent to ingress is derived from the frozen admission
policy and channel-identity digests, never the frame, routing hint, or another request field. LIVE-050 still authenticates
the outer node frame, binds the routing hint to protected delivery evidence, and invokes the independent inner enrollment
signature check. This admission contract cannot replace any of those proofs.

`private_loopback` is a frozen policy assertion, not evidence that a physical listener is private. This block opens no
listener and performs no network I/O. A later separately authorized listener qualification must prove its real bind
address and tunnel configuration.

## Asynchronous and failure boundary

Ingress must return an exact intrinsic native Promise. The admission rejects a Proxy, foreign thenable, Promise
subclass, own string properties, or drift in the captured intrinsic Promise prototype `constructor` or `then` before
Promise assimilation. Node test-runner symbol metadata is inert and does not invalidate an otherwise exact native
Promise. Post-clock and post-ingress runtime custody checks prevent selected ambient behavior from changing across those
seams.

Synchronous and asynchronous ingress failures are classified without `instanceof`, inherited property reads, accessors,
serialization, or rethrowing the unknown value. Only the explicit LIVE-050 safe-code allowlist survives. Everything else
becomes a fresh bounded `integrity_failed` result. Clock failure is a separate bounded `time_unavailable` result.

## Safe receipt and negative authority

The strict receipt records only the frozen admission policy, opaque channel digest, protected ingress/evidence digests,
registry revision, canonical ingress time, and accepted/duplicate dispositions. Exact response-loss replay remains
byte-stable because the receipt uses LIVE-050's original durable `receivedAt` rather than the retry clock value.

The receipt explicitly records:

- `opensListener: false`;
- `performsNetworkIo: false`;
- `grantsApproval: false`;
- `grantsNetworkAuthority: false`;
- `grantsCommandAuthority: false`;
- `grantsLeaseAuthority: false`; and
- `grantsExecutionAuthority: false`.

It contains no secret, raw host identity, credential, key, signature, tenant, node, connection, delivery ID, enrollment
envelope, route, profile, or provider output. It is evidence only and does not acknowledge a transport message, establish
freshness, open a connector, or authorize work or effects.

## Disabled composition

`createLocalPilotRuntimeV1` exposes only `DisabledConnectionEnrollmentTransportAdmissionV1`. No application API route,
browser mutation, socket, server bind, SSH command, or live connector is added. Constructing the enabled effect-free
class requires explicit server-side ingress, policy, and clock dependencies; construction alone still performs no I/O.

## Deterministic evidence

- macOS stage zero: `ready_for_runtime_check`, no native attempt;
- TypeScript: pass;
- full ESLint: pass;
- admission plus ingress: 22/22 pass;
- complete connection slice: 50/50 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two intentional platform skips, and 302/302
  posttests;
- production build: pass, including 4/4 rendered-page checks;
- migrations `0001` through `0036`: pass, 119 PostgreSQL tables;
- exact product whitespace gate: pass.

The focused suite covers stable response-loss replay, exact configuration/input shapes, multibyte UTF-8 limits before
clock or ingress use, server time, config-only transport identity, clock/ingress containment, nonnative thenables with
zero getter/trap execution, native Promise prototype custody, receipt drift/Proxy rejection, a 20-operation ambient
runtime replacement matrix, the disabled local default, absence of an application listener, and a full database-backed
delivery/intake/registry path.

## Review and next boundary

The zero-repair packet is `docs/reviews/CR13A_LIVE_060_INDEPENDENT_REVIEW_PACKET.md`, SHA-256
`0aa34793dff6ffd56d5cef026a250a170e5af12119d3ab7fe91ed199d6cb762f`. A different reviewer must attack the exact
base-to-product diff and return one durable report. A rejection or uncertainty cannot be upgraded to acceptance;
remediation requires a new immutable product and another different review.

The first independent report rejected the target with Medium M-001: a rejected intrinsic Promise that failed the
own-string shape rule was not observed, allowing its raw rejection to escape through Node's process-wide unhandled
rejection channel. Low L-001 records that the connection-suite total is 51/51, not 50/50. The negative report is
preserved at `docs/reviews/CR13A_LIVE_060_INDEPENDENT_REVIEW.md`. No publication or integration is permitted.
The rejected report SHA-256 is `d53bd172753ee77feb445bedaa0616080a8a74cf302ea12df1058de8454c7342`.

After independent acceptance and owner-approved integration, the next block may define a disabled private-loopback
listener adapter or a refreshed owner-attended connector rehearsal packet. It must not bind a socket, open SSH, retrieve
credentials, contact Hermes/provider/production PostgreSQL, deploy, or perform another external effect without a new
exact contract, readiness gate, and scoped owner authorization.
