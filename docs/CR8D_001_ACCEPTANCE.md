# CR-8D-001 acceptance

**Disposition:** Complete locally for the effect-free Telegram security contract.
**Date:** 2026-08-28
**External effects:** None.

## Delivered

- strict `control-room-telegram/v1` recipient, attention, message-plan, deep-link, callback, webhook-observation, proposal, and receipt schemas;
- tenant/project/message-class allowlists, verified/expiry checks, deterministic risk floors, recipient risk ceilings, IANA quiet hours, critical bypass policy, and deterministic grouping metadata;
- high/critical deep-link-only enforcement and explicit approval/execution denial on every authority-adjacent record;
- secret-safe bounded presentation with digest-only evidence and no raw chat identifiers;
- query-free relative protected-dashboard links that cannot carry approval or bearer material;
- constant-time webhook-secret digest verification with the raw secret discarded;
- canonical compact HMAC callback tokens within Telegram's 64-byte limit, exact recipient/attention/message binding, opaque choice digests, and a 15-minute maximum lifetime;
- exact-retry replay receipts plus conflict rejection for changed updates or callback reuse; and
- 12 adversarial contract tests registered in `pretest` and `test:cr8d`.

## Acceptance evidence

The focused suite proves strict recipient shape and scope, future/expiry rejection, risk non-downgrade, maximum-risk enforcement, deep-link restrictions, quiet-hour behavior, secret detection, webhook-secret rejection, compact-token integrity, option binding, recipient mismatch, issue/expiry windows, exact replay, changed-content conflict, callback reuse rejection, and negative-authority field binding.

Repository validation is recorded in `docs/BUILD_STATUS.md`. The contract does not claim network, Telegram, durable-store, credential, or deployment qualification.

## Security disposition

Telegram remains presentation and response-proposal only. A callback never becomes a review acceptance, preference unless independently materialized under its own policy, consequential approval, dispatch, credential grant, node attestation, or execution authority. High- and critical-risk operations stay in the authenticated dashboard and retain strong-factor and node-local enforcement.

## Remaining CR-8D work

1. CR-8D-002/005: sanitized message rendering, preferences, and callback/presentation fixtures.
2. CR-8D-003/004: protected durable webhook/update/callback/delivery stores, allowlist resolution, idempotent delivery/retry/grouping, and safe receipts.
3. CR-8D-006: separately authorized owner-attended disposable live bot/chat callback and cleanup.
