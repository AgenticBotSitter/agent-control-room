# CR-4D audit and operations core

CR-4D makes Control Room’s operational history independently verifiable without making it a distributed ledger. It remains a single-authority PostgreSQL system with a durable, per-tenant hash chain.

## Audit chain

Every new audit event is normalized to an ISO UTC timestamp, canonicalized, and assigned an `event_digest`. Within a monthly tenant partition, the event is chained to the previous event:

```text
event_hash = SHA-256({ chainVersion, partition, sequence, previousHash, eventDigest })
```

`control_audit_chain_heads` is locked and advanced in the same transaction as the event insert. Replaying an event ID with identical content returns its prior result; reusing the ID with different content is rejected. Event rows, heads, and anchors are protected by database constraints and the existing append-only audit trigger.

`AuditStore.verify` recomputes each canonical event digest, checks every link and sequence, and compares the final result with the durable head. `AuditStore.recordAnchor` supplies a provider-neutral external-anchor interface. A future publisher may export a verified head to an immutable object store, signed transparency log, or an owner-controlled repository. Anchor references must be safe metadata, never credentials or signed URLs.

The chain detects accidental and ordinary unauthorized alteration. External anchors are needed to make historical replacement detectable after a database-superuser compromise; CR-4D intentionally defines the interface but does not select or operate an anchoring provider.

## Safe operations behavior

`SafeOperationalError` is the only error type intended to carry a user-safe message. `safeErrorResponse` maps unknown failures to a fixed non-sensitive response and may include only a correlation ID. Raw database errors, URLs, secrets, request payloads, and stack traces must remain server-side.

`loadRuntimeConfig` validates configuration before a future server starts. Production fails closed unless it has a PostgreSQL connection string, a clean HTTPS public origin, and a 32-character-or-longer session secret. `safeConfigSummary` deliberately reports presence flags rather than secret values or database locations.

## Operational limits retained for CR-5

- PGlite confirms schema behavior but not real PostgreSQL roles, true lock contention, crash boundaries, backup/restore, or external-anchor durability.
- A production deployment must run migrations with the dedicated migration owner, then apply `db/roles/production_roles.sql` on disposable real PostgreSQL before any live use.
- This block stores no live credentials and adds no network listener, agent adapter, Telegram action, or project command.
