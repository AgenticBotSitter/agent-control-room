# E18 — joint lifecycle and the remaining delivery authority gap

2026-09-06. Local source/test work only.

## Completed composition

`composePrivateTaskWorkerApplication` supplies a host-installable view over an
already-created private application and queue worker. Closing immediately refuses new
browser requests, drains/stops the worker first, then closes application services.
Each component close has a bounded wait; failed or stalled worker cleanup still attempts
application cleanup and remains uncertain. Repeated close returns the same outcome.
Readiness requires both components and fails closed on a throwing health probe.

The five new tests cover order, request gating, timeout, either component failing,
readiness failures and captured methods. They are included in the default test command.
36 combined joint/runtime/coordinator lifecycle checks pass; typecheck and targeted
lint pass. These are component/fake lifecycle tests, not a live host or provider trial.

Custom-code reason: pg-boss manages its worker, but cannot determine when Control Room's
HTTP surface, canonical coordinator and authenticated sessions can close. This small
host composition orders existing resources; it does not implement a process supervisor,
queue or updater. OS supervision and pg-boss mechanisms remain selected.

## Verified delivery gap — do not paper over it

TaskAssignmentCoordinator.stageQueuedNativeDelivery/transmitQueuedNativeDelivery enter
withNativeApproval, which currently uses WebSessionAuthority.authenticated. This requires
a genuine VerifiedWebIdentity and current browser session. Current package fixtures
supply a synthetic verified identity; they do not prove unattended production delivery.

NativeApprovalPacketStore persists queuedBy, signed approval bindings and the bounded
operation deadline. None permits constructing a fake browser identity, extending an
approval's expiry, or treating a queue claim as permission. ManagedNativeSessions already
has generation-bound stage/transmit handles, but host routing to the current assigned
node still needs composition.

## Next implementation contract to settle

1. Keep browser enqueue authorization unchanged. Add a separate server delivery entry
   point, not fabricated WebSessionAuthority input or serialized browser credentials.
2. Authenticate persisted queue/approval evidence before trusting queuedBy or attempt
   locators. Recheck current owner/grants, ordinary-project state, node/lease/route and
   exact signed operation deadline. Do not reinterpret queuedBy alone as authorization.
3. Reuse the canonical preparation/transmission transaction fences and signed session
   delivery. Route to the currently assigned node and current session generation; no
   queue-selected endpoint or fallback agent.
4. Preserve uncertain-start reconciliation and no automatic re-execution. Tests must
   cover revoked owner/project/node, expired packet, changed attempt, replaced session
   and missing receipt. Distinguish browser-session expiry from signed execution authority
   deliberately in the contract rather than silently changing existing semantics.

This gap is a next architecture/build task, not a request to activate native services.
The joint wrapper is not installed by production startup. Real PostgreSQL, complete
queue-schema acceptance, production package adoption and the owner browser task journey
remain open. No downloads, GitHub publication, credentials or native effects.
