# Authenticated server node sessions

The single server process explicitly owns a bounded session registry and supplies the transport,
current database-backed node authenticator, server signer/public key and clock. No listener, credential
loader, route or deployment bootstrap is installed. Expected tenant/node/key and transport identity
come from trusted configuration, never from unchecked hello fields. Registry replacement is an explicit
host operation; do not let unauthenticated peers choose which existing node session to replace.

Each session authenticates a fresh sequence-one node hello and verifies expected identity, protocol
support and replay disposition. It selects the intersection of configured/offered features and smaller
frame limit, sends a verified exact server-signed acceptance and reconciliation request, then requires
an authenticated report covering that handshake. The actual portable node bridge participates in the
integration tests, with real disposable database replay/key checks and SQLite journaling.

Only after reconciliation and send completion may an explicitly negotiated native delivery channel
be read. Its frozen metadata and assertion describe this session, not physical liveness, current key
or lease availability, owner approval, local policy, profile qualification or permission to execute.
Those checks remain required at dispatch/admission. A session expires at the initial hello deadline,
capped at five minutes, and closes permanently on clock rollback. Heartbeat-based renewal is not yet
implemented; do not treat this bounded handshake as an operational long-lived fleet connection.

Operations are serialized by refusal of concurrent entry and bounded to at most five seconds.
Timeout/failure/uncertain send closes the session; late continuations must recheck before another send.
No retry of the handshake is provided. A host replacing a node session invalidates the old object;
releasing that old object cannot remove its replacement. Capacity is explicit and bounded, with no
automatic eviction of unrelated nodes. Transport closure remains the supplying host's responsibility.

Signed output must match the original envelope/body and verify under the separately supplied server
public key before entering the transport. The protocol's generic acknowledgement does not acknowledge
native task acceptance or execution. These sessions do not yet send durable task dispatch, receive
native task receipts, process ongoing heartbeats/progress, renew session authority, or restore state
after process restart. Durable delivery and reconnect reconciliation remain separate integration work.
