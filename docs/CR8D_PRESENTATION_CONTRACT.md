# CR-8D Telegram presentation contract

**Status:** Complete locally for CR-8D-002/005
**Transport:** Disabled
**Authority:** Presentation and unsigned response intent only

## Boundary

The presentation layer receives strict message plans from CR-8D-001 and produces plain-text message previews plus transport-neutral intents. It does not know a bot token, webhook secret, callback signing key, raw chat ID, Telegram API shape, delivery endpoint, or live message identifier.

Presentation output always declares no approval and no execution authority. Callback-looking items are unsigned response intents. The later protected delivery service must create and persist the exact callback record before signing its compact token. Dashboard-looking items are relative protected routes and require authentication.

## Preferences

One strict, expiring preference record binds a tenant and logical recipient. It controls only:

- compact or standard text;
- whether the project ID is shown;
- evidence display as none, count, or shortened digests;
- compact or descriptive fixed button wording; and
- a maximum group size from one through five.

Preferences cannot change recipient scope, routing eligibility, risk, quiet-hour policy, approval requirements, callback lifetime, authentication, or execution authority. Future or expired preferences fail closed.

## Rendering

Messages use `parseMode: none`; hostile markup remains plain text. Titles, summaries, evidence, project metadata, urgency, expiry, and the negative-authority statement are bounded by strict schemas and the existing secret detector. Summaries are deterministically shortened for Telegram size control. Complete output is capped at 4,096 characters.

Low/medium single-item plans may create fixed callback intents for acknowledge, choice, review, retry, or decline. Choice labels bind opaque option digests. High/critical plans are protected-dashboard only. Grouped plans are dashboard-only because one group button must not ambiguously answer several attention records.

## Grouping

Plans group only when tenant, recipient, project, grouping key, and delivery disposition match; their creation times fit the caller's validated zero-to-3,600-second window; and the recipient maximum is not exceeded. Ordering uses creation time and message-plan ID. Different projects, recipients, grouping keys, or quiet-hour dispositions form separate groups.

The group function does not enqueue or send anything. Delivery grouping and retry remain durable CR-8D-003/004 responsibilities.

## Safe preview

The dashboard fixture covers a low-risk question with digest-bound choices, high-risk protected approval, medium-risk quiet-hour deferral, and grouped informational items. It renders intent labels as non-interactive facts—no link or button elements—so synthetic presentation cannot be mistaken for a working bot or approval control.

Desktop and 390-pixel mobile browser checks prove two-column and one-column layouts, no horizontal overflow, hidden mobile sidebar behavior, four visible fixture cards, no active controls inside the preview, and a clean client load without server-only cryptography.
