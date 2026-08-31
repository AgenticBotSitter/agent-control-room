# CR-5Q security and recovery review

**Date:** 2026-08-26  
**Scope:** CR-5D synthetic execution, node-local durability, signed lifecycle delivery, central evidence/lifecycle projection, and acknowledgement retirement  
**Verdict:** Passed after remediation for the effect-free local vertical slice

## Review result

The reviewed path fails closed unless a currently trusted node sends a valid signed frame on a replay-checked connection for the exact tenant, node, attempt, job, lease, and lease epoch. Central job success, attempt success, artifact manifest, producer claim, lineage record, transition events, outbox records, and audit entry commit in one database transaction. The node retains its completed lifecycle record until it receives a server-signed acknowledgement naming the exact outbound message.

Producer claims remain claims. Central intake records independent verification as `not_run`; neither the protocol nor the UI upgrades that state to verified or approved.

## Findings and remediation

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| Q-H1 | High | The lower-level method whose contract assumed prior authentication was exported from the public node-control barrel, making accidental authentication bypass possible for a future adapter. | Removed the service from the public barrel. The supported ingress now constructs the internal service from a database client and always authenticates raw frames first. |
| Q-H2 | High | A newly received event was bound to lease identity and epoch but did not explicitly require the central lease row to remain active. | New events now require an active exact lease. Exact already-committed replays remain acknowledgeable after later state changes. |
| Q-M1 | Medium | Wire validation allowed event sequence zero and did not enforce progress, checkpoint, safe-reason, or artifact field ownership as strictly as the node-local journal. | Runtime and generated JSON Schemas now require positive event sequence and exact event-specific fields. |
| Q-M2 | Medium | Non-projecting events could carry a timestamp earlier than the previous accepted event, and an event could claim an occurrence after its signed send time. | Central intake now enforces monotonic event time and `occurredAt <= sentAt` before committing any truth. |

All four findings were fixed and covered by executable tests. No unresolved high or medium finding remains inside the effect-free CR-5D boundary.

## Attack and recovery evidence

- Forged signatures, revoked keys, quarantined nodes, wrong direction, expiry, unsupported protocol, replay conflicts, nonce reuse, and rate-limit exhaustion fail closed in the node-protocol suite.
- Wrong lease identity or epoch, inactive leases, out-of-order sequence, backwards time, future occurrence claims, malformed event-specific fields, and conflicting artifact evidence cannot create a node event, lifecycle transition, audit success, or acknowledgement.
- Exact duplicates converge without a second lifecycle transition or evidence record.
- Abrupt node-process exit preserves execution, lineage, and outbound delivery; restart reconciliation resends unacknowledged work.
- A completed node record remains staged until central authentication, transactional persistence, and a server-signed exact-message acknowledgement complete.
- Secret canaries remain rejected by the shared redaction guard; fixtures and evidence contain references and digests, not credentials.

## Explicit residual gates

This pass does not claim production deployment readiness. Real multi-session PostgreSQL lock behavior, central process-kill/WAL recovery, native service start/restart/sleep/reboot behavior, live DNS/TLS rebinding, native filesystem race primitives, credential brokers, or consequential external effects remain assigned to CR-6 through CR-10. The unresolved macOS key-provider qualification remains visible and is not converted into a pass by this review.

