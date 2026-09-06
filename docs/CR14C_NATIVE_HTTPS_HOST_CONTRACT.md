# Native HTTPS host composition

Status: architect implementation contract; not live acceptance. Local-only work applies.

## Selected mechanics

One private HTTPS machine endpoint, separate from human Access routes, carries bounded
short POST exchanges. The node opens a generation, submits at most one opaque wire packet
per exchange and receives queued server packets. Sends enqueue bounded bytes immediately;
they never await remote application processing or an ACK. This prevents cyclic waits
through the existing ordered protocol owners. Idle exchanges retrieve owner-staged work;
they do not claim jobs or start native execution. Reconnect explicitly selects recovery
over retained journals; uncertain requests are not retried automatically.

The server selects the node from an authorized TLS client certificate's exact configured
SHA-256 fingerprint, not from headers, URL, body or browser identity. Client certificates
are a machine transport credential separate from node protocol signing and owner approvals.
The operator must configure private ingress, certificate custody/trust and revocation;
this is not evidence those exist. Existing signed protocol/current canonical checks still
authorize every operation. A transport credential cannot widen a local ceiling.

The client uses an exact configured HTTPS destination with existing DNS/address/TLS
guards and a privately supplied client certificate credential. No redirects, pooled
sockets, fallback address, environment credential lookup or automatic network retry.
Credential material is not returned, logged or stored in repository/evidence. Construction
is inert; only an explicitly invoked host operation can reach the supplied network ports.

## Ownership and limits

The server pins one trusted task registration per configured node. Opening a connection
returns a fresh server-generated opaque generation ID; exchange/close must match that
node and current generation. Unknown peers/generations cannot close another connection.
Both client and server capture configuration/callbacks and refuse overlapping requests.
Existing attachWire/openWire own their underlying protocol state and cleanup.

Requests/responses have fixed version/path/method/content-type and bounded headers,
encoded bodies and decoded packet counts. Collect input with a deadline and size ceiling
before JSON parsing. No compressed bodies, ambiguous length/transfer framing, redirects,
upgrades, cookies or user-supplied proxy identity headers are accepted. Wire packet limits
remain enforced inside the HTTP envelope too. Server output is bounded, and any suffix
is retrieved by a subsequent exchange; a response loss requires journal reconciliation,
not blind HTTP replay. Outbox state is transient transport state, not a second scheduler.

Close first invalidates the generation and pending work, then drains boundedly. Track
underlying requests/handlers through actual settlement rather than declaring abort proof
of completion. Timeouts, peer revocation, stale generation, malformed packets, response
loss and unresolved shutdown remain unavailable/uncertain. No implicit native stop/start.
The host must not delete journals or close their stores while outstanding users remain.

## Integration and evidence

Mount the optional private machine ingress through the existing verified application
startup; do not widen or reuse the browser handler's authentication/body limits. An
explicit node host joins accepted runtime wire ports to the HTTPS client. Prove initial
intake, explicit native start, completed exact result, lost response/recovery, cancellation,
replacement and shutdown through injected HTTP/socket ports and real disposable journals.
Keep endpoint/peer/body denial and resource ownership tests independent of the happy path.

No physical DNS/TLS request, credential read, listener, certificate provisioning, service
installation, deployment or live qualification is authorized by this contract. PR #329
and owner signing remain separate. Implementation does not complete live C-WORK.
