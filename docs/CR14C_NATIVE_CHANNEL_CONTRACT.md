# Native delivery channel evidence

The actual portable node bridge exposes a frozen, non-executing channel snapshot only after its
authenticated handshake negotiated `harness.native.dispatch.v1` and this connection completed
reconciliation. It carries the snapshotted tenant/node, connection ID and negotiated frame limit.
It never grants execution authority, proves physical liveness, or substitutes for current owner
signatures, key state, lease, local policy, profile qualification or durable admission.

Identity and advertised features are copied at construction. Returned status arrays cannot mutate
negotiation. The channel's `assertCurrent()` checks private reconciliation provenance, current transport,
generation, online state and absence of protocol error. Close, disconnect, transport failure and applied
node control changes invalidate prior snapshots; reconnect cannot revive one by reusing a connection ID.
Consumers must recheck across asynchronous work and immediately before their own bounded operation.

An authenticated resume does not replace reconciliation. Delayed authentication, reconciliation and
node-control completions cannot update a replacement generation. Control-frame signing captures its
transport and refuses to stage/send through a replacement connection after the signer yields. This is
not a general proof of all legacy transport race behavior or an execution transaction.

No feature is advertised automatically, native dispatch receiver is installed, listener is opened, or
owner/server signing key is loaded. The server-side negotiated session registry, actual sender,
durable authenticated receipt tracking and node intake/admission integration remain unimplemented.
Existing generic protocol acknowledgement is not a native task acceptance receipt.
