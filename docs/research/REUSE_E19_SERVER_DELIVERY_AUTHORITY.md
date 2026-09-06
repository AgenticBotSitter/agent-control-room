# E19 — approval-bound server delivery

2026-09-06. ADR-251; local, explicit server entry points only.

NativeQueueAuthority verifies the canonical queue record HMAC and exact reference,
uses its original queuedBy actor, locks current active identity and owner grants,
and retains intent deadline/clock/policy fences through commit. It writes no browser
session and accepts no browser credential. Policy scope is the exact queued project.

TaskAssignmentCoordinator's new stageApprovedQueueDelivery/transmitApprovedQueueDelivery
require explicit submission composition and reuse the existing canonical and signed-packet
delivery implementation. Old browser methods remain unchanged and session-bound. The
new path does not treat persisted intent alone as execution permission: signature trust,
packet, current project/attempt/node/key/lease and channel checks still run before effects.

Browser logout does not cancel an already-approved task in this new explicit path; it
still blocks browser enqueue. Current actor/grant revocation and approval expiry deny
background delivery. No approval lifetime, recipient or effect scope is extended.

## Evidence

44 authority/browser-delivery/queue regression checks pass, along with 42 combined
actual-package checks and one additional focused post-commit grant-expiry package check.
Typecheck, targeted ESLint and whitespace validation pass. These are local checks,
not independent-review or native-provider acceptance.

The real-package synthetic delivery test now logs out the browser after approved enqueue,
stages/transmits without passing a browser identity, creates no session, and preserves
the missing-receipt unresolved outcome. The revoked-owner, expiry, trust closure, retired
key, completed-project and changed packet cases now use this server path too.

New default tests reject forged tenant/attempt/queue/packet references, changed queue
HMAC, inactive actor, revoked grants and added factor requirements before the callback.
Deadline expiry at precommit rolls back a synthetic write. Existing browser delivery
tests remain separate regression evidence.
The focused server grant-expiry test also preserves a committed transmission intent
while refusing transport after the current owner's grant expires; no second send occurs.

An initial revocation fixture used wall-clock now(), which predates this suite's future
synthetic grant creation and violated its timestamp constraint. It now revokes at the
fixture's recorded creation time; no production policy was weakened.

## Limits

Synthetic transport only; no real agent, provider, native database or new download.
No new browser endpoint or production worker mounting. Current managed-session routing,
joint lifecycle integration, independent review, full schema/real-PG acceptance and owner
journey remain open. This does not certify a whole unattended fleet or an unbounded grant.
