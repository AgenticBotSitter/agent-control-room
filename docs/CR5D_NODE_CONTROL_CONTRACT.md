# CR-5D node control request contract

**Status:** Architect-frozen and implemented CR5D-CTRL-001
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

## Node-local application

The node initializes an exact local node/version/state projection. A signed request addressed to another node is rejected. An allowed request atomically advances the local version and state and stores a deterministic semantic acknowledgement before cancellation or transport occurs. Drain and quarantine immediately make both admission and renewal gates false. They also create a durable, idempotency-keyed cancellation obligation for running work.

If cancellation dispatch crashes, the safety gate remains closed and the obligation survives restart. Recovery reissues the typed cancellation under the original request identity. An exact command replay returns the original acknowledgement without advancing state or requesting cancellation twice. Stale or locally illegal commands return fixed rejections and do not alter local state.

The bridge sends the semantic `node.operation.ack` only after local persistence and cancellation dispatch succeed. That signed acknowledgement itself enters the durable bridge outbox before transport. CR5D-UI-004 exposes this boundary as separate requested and node-confirmed states; it never presents request acceptance as completed node application.
