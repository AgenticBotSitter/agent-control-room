# Quiet, bounded owner notifications

`src/notifications/v1` is a policy and presentation module over canonical records.
It reads only what the product already records — owner-attention items from the
operator surfaces (`ActionInboxItemV1`), job outcomes from the canonical job
states, and redacted service incidents — and decides whether that saved state is
worth one in-product notification. It adds no storage, no scheduler, no provider
call and no new authority.

## What a notification is, and what it is not

A notification is a description of a saved record. The envelope a sink receives
carries the record id, project, need, severity, text and an `authority: "none"`
literal with an empty `actions` list; it parses only against a strict schema that
has no field for a response, a command or an approval. The response options that
exist on the underlying attention item are deliberately dropped when the envelope
is built, and a test asserts the envelope cannot carry them. Nothing in this
module approves, retries, cancels, dispatches, reserves capacity or starts work.

Email, push and SMS are declared as channel *availability* only. The planner can
report them unavailable, the delivery function refuses any decision whose channel
is not `in_app` (`external_channel_not_permitted`), and no provider, credential
or external message is created anywhere in this module.

## What produces a notification

| Saved record | Need | Severity |
|---|---|---|
| Attention item `approval`/`question`/`review`/`authority_expiry`, state `open` | `owner_decision` | `urgent` |
| Attention item `failure`/`incident`, state `open` | `failure` | `notable` |
| Attention item `ambiguity`, state `open` | `uncertainty` | `urgent` |
| Job state `waiting_approval` | `owner_decision` | `urgent` |
| Job state `succeeded` | `completion` | `notable` |
| Job state `failed` | `failure` | `notable` |
| Job state `orphaned` | `uncertainty` | `urgent` |
| Open service incident | `failure` | `urgent` when critical, otherwise `notable` |
| A canonical source that could not be read | — | `unavailable`, reason `missing_observation` |

Everything else stays quiet: `proposed`, `ready`, `leased`, `running` and
`cancelled` jobs, rejected proposals, resolved attention items, resolved
incidents and native-session items produce a `suppressed` decision with reason
`unchanged_healthy_state`. Silence here means "nothing changed that needs the
owner", never "everything is healthy".

Missing data is reported as `unavailable` with reason `missing_observation` and
text that says the state is unavailable rather than healthy. An unavailable
in-product channel is `unavailable` with reason `channel_unavailable`, not
silence.

## Deduplication, restart and lost acknowledgement

The dedupe key is derived from canonical record identity and recorded state only —
`owner-notification:<kind>:<record id>:<state>` — never from a timestamp, so a
repeated read, a restart and a reconnect all reproduce the same key.

- A record that appears twice in one read yields one `notify` plus one
  `deduplicated` entry with reason `duplicate_record`.
- A key already delivered yields `deduplicated` with reason `restart_replay`, and
  the delivery function refuses to send it again.
- Delivery is reserve-then-send-then-confirm: the reservation is written *before*
  the sink is called. A crash or a lost acknowledgement leaves the key `reserved`,
  the next plan reports `delivery_attempt_unknown`, and the saved record stays
  available in the product. No second message is produced.

## Saved policy

`OwnerNotificationSettingsV1` makes each input explicit: per-project scope with an
enable flag and a severity floor, one quiet-hours window with an IANA timezone and
the severities it suppresses, and per-channel availability with a safe reason for
every unavailable channel. Quiet hours are evaluated in the saved timezone with
`Intl.DateTimeFormat`; a window whose end precedes its start crosses midnight; an
unusable timezone is treated as no quiet hours and is rejected by
`ownerNotificationSettingsSchemaV1` rather than passing silently. `urgent`
notifications are only quiet-hour-suppressed when `urgent` is listed in
`appliesTo`, and a missing-observation report is never quiet-hour suppressed.

## The settings surface

`private-app/app/notification-settings.tsx` renders the policy with labelled
native form controls: the two clock fields each have a keyboard-editable picker
and an adjacent `HH:MM` text field with the same value, the severity floor is a
radio group of words, project scope is a checkbox list, and channel availability
is a checkbox with its reason in text. The policy summary paragraph repeats every
saved value in a sentence, and the decision table names each record, need,
severity, outcome and reason in text — no state is carried by colour, icon,
drag or pointer interaction. The component is a pure function of its props
(`settings`, `decisions`, optional `onChange`/`onSave`), so it is exercised by
`renderToStaticMarkup` in the product-shell lane; with no callbacks it renders
read-only and says so.

### Mounted read-only composition

Settings now mounts `private-app/app/owner-notifications-workspace.tsx`. It reads
`/api/v1/operator-surface` through the existing authenticated
`fetchOperatorSurfaceSnapshotV1` reader and
`src/web/v1/owner-notifications-browser-client.ts`. The reader preserves same-origin
credentials, no-store caching and source schema validation; no tenant identifier
is sent by the browser.

Only `actionInbox` and `serviceIncidents` become notification records. Attention
uses the canonical id, project, requested action and created time. Incidents use
the canonical id, service id and last-observed time, with no guessed project
(the incident projection has none). Active jobs and portfolio outcome counts
are not job-outcome history and do not become notification records.
Completion/failure job-outcome notifications are **not shown** by this panel.

The existing planner and `NotificationSettingsSurface` are unmodified. Each read
uses a fixed presentation default: all projects, routine severity and above,
no quiet hours, in-app available and external channels unavailable. Project scopes
include every portfolio project and every project named by an attention record;
incident records remain tenant-wide. Revision zero denotes this unsaved default,
not a persisted policy. The planner receives no acknowledgements, and nothing
calls a sink or delivery ledger: rows preview policy decisions, not delivery.

No change/save callbacks are supplied. Unauthenticated, unavailable, invalid or
failed reads produce the planner's `unavailable` / `missing_observation` decision,
including before the first read completes. A successful empty snapshot instead
shows the existing empty-record message. Unmounting ignores a pending read.
No policy persistence, endpoint, schema, authority or external message is added.

The reused surface still contains its original standalone “not yet mounted”
status wording because that file is outside this packet's owned paths. The
composition explicitly clarifies immediately above it that the panel is mounted
here in Settings and no owner policy endpoint is called. A future separately
scoped wording cleanup can retire the inherited sentence.

## Tests

`tests/task-state-guidance.test.tsx` (product-shell lane) covers: one
deduplicated notification per meaningful state, quiet on healthy and idle states,
identical keys across a repeat read with exactly one delivery, a simulated crash
between reserve and confirm producing no second message, quiet hours in the saved
timezone with `urgent` unaffected, project scope and severity floors, missing data
as `unavailable`, an unavailable in-product channel, refusal of an external
channel, an envelope that cannot carry authority (including a rejection of an
envelope with a smuggled `legalResponses` field), settings validation refusals,
and the rendered surface's labelled controls, text alternatives and read-only
state. The sink is injected; no provider or external message is involved.

Not claimed by these tests: a live notification store, a mounted settings page,
provider delivery of any kind, browser/mobile visual layout, or a live owner
policy endpoint.

## Validation

- `pnpm run test:product-shell` — 45/45 pass.
- `node scripts/check-test-lane-coverage.mjs` — all 210 test files reachable.
- `pnpm run check:demo` — see the pull request for the exact run.