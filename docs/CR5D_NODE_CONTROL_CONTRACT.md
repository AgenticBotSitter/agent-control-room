# CR-5D node control request contract

**Status:** Architect-frozen control-plane half of CR5D-CTRL-001
**Decision date:** 2026-08-26
**Scope:** Authenticated drain, resume, and quarantine intents, durable delivery, and confirmed central state change
**Authority:** This contract does not authorize a live node, deployment, credential, or production effect.

## Request boundary

The HTTP API takes the tenant from trusted server configuration and the human actor from the authenticated proxy header. Tenant and actor identity are never accepted from the request body. Every request requires an idempotency key, exact expected node version, typed operation, and—only for quarantine—a fixed safe reason code.

Creating a request locks the exact node row and verifies that its current state and version allow the operation. One transaction then stores the request, appends the tamper-evident audit event, and creates the canonical `node.operation.request` outbox item. The node state does not change at request time, and the API response explicitly reports `applied: false`.

Only one unresolved request may exist for a node. An exact retry returns the original request. Reusing the key with different content, requesting against a stale version, or requesting an illegal transition fails closed.

## Confirmation boundary

The signed protocol defines separate `node.operation.request` and `node.operation.ack` bodies. An acknowledgement is bound to the request, node, operation, expected version, acknowledgement identity, disposition, and resulting version or fixed rejection code.

The central state changes only while consuming an exact authenticated acknowledgement. Applied acknowledgement updates the node state, payload mirror, and monotonic version together with the request and audit record. A rejection leaves the node unchanged. If central version changed while the command was in flight, an apparent applied acknowledgement is recorded as rejected with `stale_node_version`; it never overwrites newer truth.

## Remaining integration

The control-plane request, outbox, protocol, API, acknowledgement consumer, and tests are complete. The node-local handler still must persist local drain/quarantine state before acknowledgement, block new admission and renewal, request typed cancellation for running work, and connect its acknowledgement to the live bridge sender. UI wiring must show requested and confirmed states separately.
