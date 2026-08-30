# CR-8D-003/004 acceptance

**Disposition:** Complete locally for protected durable ingress and synthetic delivery.
**Date:** 2026-08-28
**Live Telegram effects:** None.

## Delivered

- migration 0023 with tenant-scoped recipient, policy-history, callback, update, proposal-receipt, and delivery records;
- HMAC-authenticated mutable state and authenticated immutable records with strict schema/digest verification;
- expected-digest recipient-policy replacement, append-only history, deletion guard, and dispatch-time revocation recheck;
- webhook authentication before any durable callback mutation;
- restart-safe, single-use callback consumption with exact update and proposal replay;
- callback-token digest retention without storing the token;
- exact idempotent delivery enqueue, quiet-hours release times, atomic claims, and exact settlement replay;
- at most three attempts for proven definite failures;
- terminal ambiguity for claim expiry, thrown transport calls, and all unknown send outcomes;
- safe negative-authority delivery receipts; and
- a test-only synthetic coordinator with no production transport or credential boundary.

## Adversarial evidence

The focused CR-8D gate passes 35/35. It covers restart replay, update drift, callback reuse, wrong chat and MAC, enqueue drift, wrong integrity keys, direct database tampering of both mutable and append-only records, concurrent claims, recipient revocation before dispatch, bounded retry and dead-lettering, quiet-hours timing, crash ambiguity, webhook-auth ordering, and synthetic success/unknown outcomes.

Type checking and focused lint pass. Migration verification applies through `0023_cr8d_telegram_delivery.sql` and reports 80 PostgreSQL tables. Complete repository validation is recorded in `docs/BUILD_STATUS.md`.

No bot, Telegram credential, raw chat ID, live callback, network request, webhook configuration, message send, deployment, or external effect was used. CR-8D-006 remains an owner-controlled live gate and is not satisfied by this acceptance.

## CR-8Q hardening addendum

The later independent CR-8Q review found complete-state erasure, callback current-policy, future-policy, and callback-ID grammar defects. Migration `0024`, explicit external checkpointing/provisioning, message-class/risk binding, current policy rechecks, verification-lower-bound checks, and one canonical callback grammar now supersede those affected claims. The historical counts above remain CR-8D slice evidence; current combined evidence and re-review status live in `BUILD_STATUS.md` and the CR-8Q review documents.

A later second remediation re-review found that settlement validation could execute traps on a Proxy input before rejecting it. Settlement now rejects Proxy values through captured host-level detection before reflection, takes one exact ordinary-data snapshot, and uses only that snapshot for every state change. Transparent, key-hiding, descriptor-fabricating, throwing, and nested Proxy regressions prove zero trap execution and zero delivery mutation on rejection while preserving ordinary delivered, definite-failure, and ambiguous settlement. CR-8Q acceptance remains pending another different independent review.

## Next

CR-8E-001/002/003 freezes the node-local reference-only secret contract, safe metadata catalog, invocation boundary, and cleanup behavior. It must remain effect-free and use synthetic providers; live secret-manager canaries remain owner-controlled.
