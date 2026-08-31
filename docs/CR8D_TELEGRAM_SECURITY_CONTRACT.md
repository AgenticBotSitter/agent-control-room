# CR-8D Telegram security contract

**Status:** Frozen for effect-free repository implementation
**Version:** `control-room-telegram/v1`
**Live state:** Disabled; no bot, credential, webhook, message, chat, or deployment was created or used.

## Purpose

Telegram is an optional notification and bounded-response surface for the Action Inbox. It is not an identity provider, approval authority, scheduler, executor, credential broker, or system of record. Canonical attention, review, preference, approval, job, and effect records remain in Control Room.

The contract covers recipient eligibility, message risk, quiet hours, presentation redaction, webhook authentication, callback integrity, replay, expiry, protected-dashboard links, and durable synthetic delivery. It deliberately stops before production transport or live integration.

## Non-negotiable authority boundary

Every message plan, callback record, deep link, and response proposal states:

- `grantsApproval: false`; and
- `grantsExecutionAuthority: false`.

A Telegram callback creates at most a response proposal that requires independent Control Room policy evaluation. It cannot create or satisfy a consequential approval, mint a node attestation, dispatch work, activate a package, issue a credential, or perform an effect. High- and critical-risk items have no callback response buttons and lead only to the authenticated dashboard. Consequential approval there still requires the existing strong-factor path and a separate signed node attestation.

## Recipient policy

The server resolves a strict, expiring recipient policy before rendering. It contains only a logical recipient ID and a digest of the verified chat ID; raw chat IDs never enter central presentation, audit, fixture, or receipt records.

A policy binds one tenant, an explicit sorted project allowlist, allowed message classes, a maximum risk, an optional IANA-zone quiet-hours interval, an explicit critical-urgency bypass setting, and a grouping window. Disabled, future, expired, wrong-tenant, wrong-project, disallowed-class, or over-ceiling policies fail closed.

Verification of chat ownership is a later owner-controlled live step. It cannot be inferred from a username, display name, forwarded message, or inbound chat alone.

## Risk and delivery

The deterministic risk floor and any higher assessed risk feed `effectiveRisk`. A supplied effective risk below either value is rejected; presentation or model output cannot downgrade it.

Low- and medium-risk messages may expose only the bounded response kinds `acknowledge`, `answer_choice`, `request_review`, `request_retry`, and `decline`. An answer choice binds an opaque option digest, never free-form callback text. High and critical risk are deep-link only.

Quiet hours are evaluated in the configured IANA time zone. Ordinary messages defer during the interval. Only critical urgency with an explicit policy opt-in may bypass it. A bypass changes delivery timing, never authority.

## Safe presentation

Titles are at most 120 characters and summaries at most 500. Both are single-line, strict values. Presentation is rejected if the shared redaction detector finds credential-shaped material. Evidence crosses this boundary only as sorted SHA-256 digests. No artifact body, transcript, locator, raw chat identifier, credential reference, secret, token, stack trace, or provider payload is allowed.

Grouping keys and message-plan IDs are deterministic digest-derived identifiers. They are routing metadata, not authority or authentication.

## Protected deep links

The only accepted link shape is a query-free, fragment-free relative route `/attention/<safe-id>`. External schemes, protocol-relative URLs, traversal, percent escapes, query strings, fragments, and bearer tokens are rejected.

Opening the route requires normal authenticated-dashboard access. The link itself proves neither identity nor intent and grants neither approval nor execution. A later deployment may add a one-time navigation capability only after a separate security review; it must remain non-authoritative and must not be stored in presentation evidence.

## Webhook authentication

Ingress must first verify Telegram's presented webhook secret against a configured SHA-256 digest using constant-time byte comparison. The raw secret exists only during that comparison and is never returned, logged, persisted, or included in an error. Missing, malformed, short, wrong, or unconfigured values fail with a generic authentication/configuration error.

Successful secret comparison authenticates the transport request, not the sender's authority. A sanitized webhook observation retains only the Telegram update number, raw-body digest, chat-ID digest, callback-query-ID digest, compact callback token, and server observation time.

## Callback integrity and expiry

Each callback is a server-side strict record bound to tenant, project, recipient, chat digest, attention ID and digest, message class, risk, response kind, optional choice digest, message-plan digest, issue time, expiry, and explicit negative-authority flags.

The Telegram `callback_data` value is `callbackId.tag`, at most 53 bytes. Callback IDs use only ASCII letters, digits, underscore, and hyphen, begin with an alphanumeric character, and contain 3–30 characters; dot is reserved as the single token separator. `tag` is a canonical 128-bit truncated HMAC-SHA-256 over the complete record, using a minimum 256-bit server key. One shared grammar is used by record validation, issue, webhook parsing, lookup, and authentication. Non-canonical base64url encodings are rejected. The callback lifetime is positive and at most 15 minutes. Verification uses the trusted current time, exact chat binding, complete-record MAC, and strict schema.

The signing key remains outside callback records and Telegram. The durable store captures the verification key at construction and never accepts it from a callback-consumption request. Callback registration proves that the record is an exact bounded subset of the named low- or medium-risk message plan and current recipient class/risk policy; a caller cannot attach a response to an unrelated plan, disallowed class, over-ceiling risk, or high-risk item. Consumption rechecks current project, class, risk, verification time, expiry, and chat policy before recording a proposal. The protected repository store is defined in `CR8D_DURABLE_DELIVERY_CONTRACT.md`; production key custody and rotation remain deployment work and may not weaken these checks.

## Replay and idempotency

Callback consumption is an atomic store operation in the durable implementation:

1. one Telegram update number binds one exact sanitized observation digest;
2. one callback ID binds one exact proposal receipt;
3. an identical retry returns the same proposal with `status: replayed`;
4. changed content under the same update number is a replay conflict;
5. reuse of a callback by a different update or callback-query digest fails closed; and
6. no retry repeats an approval, dispatch, effect, or external send because none is available at this boundary.

The included in-memory store remains deterministic unit evidence. The durable store adds authenticated PostgreSQL-compatible records and still grants no network authority.

## Failure behavior

Authentication, schema, scope, risk, expiry, recipient, MAC, and replay failures produce no proposal and no downstream command. Error text uses safe reason categories and must not echo secrets, raw identifiers, tokens, message bodies, or stored records. Delivery retry and grouping may retry only a separately idempotent send record; they never regenerate or widen authority.

## Explicitly deferred

- bot creation or token access;
- live chat verification or allowlist enrollment;
- webhook configuration, TLS, public ingress, or Telegram API calls;
- key custody and rotation;
- production Telegram transport and provider-specific response handling;
- a disposable owner-attended live callback and cleanup; and
- production monitoring, runbooks, and deployment.

All deferred operations require their own acceptance evidence. Live work requires explicit owner authority.
