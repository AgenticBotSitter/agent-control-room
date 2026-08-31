# CR-8D durable Telegram ingress and delivery contract

**Status:** Frozen for effect-free repository implementation
**Version:** `control-room-telegram/v1`
**Production transport:** Absent and disabled

## Boundary

The durable layer records authenticated Telegram callback observations, response proposals, recipient-policy history, and outgoing presentation attempts. It does not create a bot, hold a Telegram token, resolve a raw chat ID, call Telegram, approve work, dispatch work, or grant execution authority. The only transport coordinator in the repository accepts an injected synthetic transport and is test-only.

Raw chat IDs, callback tokens, webhook secrets, provider message IDs, credentials, provider payloads, and message bodies outside the strict presentation schema must never be persisted. Central records use logical IDs and SHA-256 digests. Every callback proposal, presentation, delivery, and receipt explicitly grants neither approval nor execution authority.

## Authenticated durable records

Migration `0023_cr8d_telegram_delivery.sql` creates tenant-scoped records for:

- the current verified recipient policy plus append-only policy replacement events;
- immutable callback records;
- immutable sanitized update observations;
- immutable callback proposal receipts; and
- mutable delivery state authenticated by an HMAC over its complete canonical state; and
- one serialized per-tenant authenticated state head over every recipient, policy event, callback, update, proposal receipt, and delivery row. Migration `0024` adds its monotonic checkpoint revision.

The current recipient row can change only through an expected-digest policy replacement. Replacement preserves the chat digest, cannot move verification time backwards, appends an authenticated history event, and updates the current policy atomically. Recipient deletion is forbidden. Append-only rows reject updates and deletes. Reads verify canonical schema, stored digest, tenant and key-bound HMAC, duplicated indexed columns, and the complete tenant state head before returning a record.

Tenant/module initialization is explicit and one-time. Normal open never recreates a missing head. Each head revision is compare-and-swap pinned through `RollbackCheckpointStoreV1` outside the protected PostgreSQL deletion/rollback domain. Removing all module rows and the head, or restoring an older otherwise-valid complete snapshot, fails against that owner-controlled checkpoint. The in-memory implementation is test-only; real checkpoint custody, atomicity/recovery operations, and availability remain deployment blockers.

## Ingress and callback consumption

The ingress service verifies the configured webhook-secret digest in constant time before opening the durable callback transaction. Successful transport authentication grants no sender authority. The ingress service supplies its own trusted clock; callers cannot backdate callback consumption. A new observation must not be future-dated or more than five minutes stale.

Callback registration requires the exact strict message plan whose digest appears in the callback record. Tenant, project, recipient, attention lineage, message class, risk, response kind, optional answer-choice digest, issue time, and expiry must all be contained by that plan. High- and critical-risk plans cannot register callbacks. Current recipient project, message-class, risk-ceiling, verification-lower-bound, and expiry policy must also contain the record. The durable store captures the callback verification key when it is constructed; no callback-consumption caller can select or replace the key.

Callback consumption locks the current recipient and callback, rechecks enabled, verification lower bound, expiry, tenant, project, message class, risk ceiling, chat digest, callback expiry, and full-record MAC, then enforces both replay dimensions atomically:

1. a Telegram update number binds one exact sanitized observation;
2. a callback ID binds one exact response proposal;
3. an identical retry returns the original proposal as `replayed`;
4. changed content under the update number fails as a replay conflict; and
5. a callback reused by another update or query fails as consumed.

Only a digest of the callback token is retained in the sanitized observation. The proposal is append-only and negative-authority.

## Delivery state machine

The only legal states are:

```text
queued ──claim──> sending ──delivered──────────> delivered
   │                 ├──────definite failure──> retry_wait ──claim──> sending
   │                 └──────unknown outcome────> ambiguous
   └────expired or recipient revoked───────────> dead_letter

sending ──claim lease expires──> ambiguous
third definite failure─────────> dead_letter
```

Enqueue is exact-idempotent by tenant and idempotency key. A quiet-hours deferral must supply a future `notBefore` earlier than presentation expiry. Enqueue checks the current allowlisted recipient, project, message classes, maximum risk, verification lower bound, and policy expiry.

Claiming is atomic and deterministic. It first identifies the oldest due candidate, locks its recipient policy, then re-locks and rechecks the candidate. That lock order serializes policy replacement against dispatch: a disabled, expired, narrowed, or otherwise disallowed recipient is dead-lettered before transport. Two concurrent claimers cannot receive the same delivery.

Only a transport result proven to be a definite failure may retry. Retry delay is bounded, and at most three attempts are allowed. A timeout, thrown transport call, process interruption after claim, or any outcome whose send status is unknown becomes terminal `ambiguous`; it must never auto-retry because that could duplicate a Telegram message. Settlement accepts only an exact ordinary-data input shape and binds the claim ID, outcome, provider receipt, safe reason, and effective retry delay. Exact semantic replay may carry a later observation time but must reproduce every outcome field; drift fails closed instead of receiving the prior receipt.

## Key and deployment boundary

The repository test keys and in-memory rollback checkpoint prove behavior only. Production integrity-key, callback-key, webhook-secret, bot-token, and rollback-resistant checkpoint custody belongs to later node-local and deployment gates. A production Telegram transport, public webhook, recipient enrollment ceremony, external checkpoint implementation, checkpoint recovery runbook, monitoring, and owner-attended live callback remain disabled pending separate authorization and acceptance.
