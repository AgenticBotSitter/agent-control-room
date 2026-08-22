# Control Room founding contract

**Contract version:** `control-room-project-adapter/v1`
**Milestone:** CR-0

## Platform role

Control Room is the project-agnostic portfolio, resource, projection, and operator-command layer. It is independent from Wayfarer Studio and Content Blooms. Source products keep authority over private domain state.

## Scheduler authority modes

Every adapter declares one mode:

1. `control_room_native` — Control Room may create and lease jobs through an installed project pack. Wayfarer is expected to use this mode when its scheduler is ready.
2. `source_scheduled` — the source owns eligibility and leases. Control Room projects sanitized status and may send supported, versioned requests. Content Blooms uses this mode.
3. `advisory` — Control Room can observe and recommend only. This lets older or future projects integrate incrementally.

The mode is per adapter/project, not a global compromise. Cross-project allocation can therefore compare every route while respecting the authority that actually performs a change.

## Identity boundaries

- A physical machine is a machine identity.
- A deterministic worker runtime is a separate worker identity.
- A Hermes/human/manager is a separate agent identity.
- Project credentials, worker credentials, and Hermes credentials are never reused.
- Editable display names never replace immutable IDs.

## Projection rules

Every source record carries source system, adapter, workspace, project, record type, record ID, source version/checksum, and observed timestamp. The normalized state is intentionally small; the domain state remains separate.

Control Room stores operational metadata only. It rejects fixture, sync, and logging payloads containing transcript text, prompt bodies, generated draft bodies, raw media, signed URLs, voice examples, knowledge facts, secrets, credentials, or full exception bodies.

## Sync rules

- Cursors are opaque to Control Room.
- A page is applied transactionally.
- `(adapter_id, stream, source_record_id, source_version)` is idempotent.
- Repeating the same page changes no durable projection twice.
- Advancing the cursor and recording its audit event are part of the same transaction.
- An offline or one-version-behind adapter never blocks another project.

## Command rules

CR-0 defines command request and receipt shapes, but CR-0 through CR-2 do not call live project commands. Every future command is scoped, permission-checked, expected-version checked, idempotent, and independently audited by Control Room and the source.

An accepted receipt may mean “scheduled for the next safe boundary.” It never implies that Control Room seized a source lease.

## Cross-project placement

Allocation modes are `exclusive`, `preferred`, `shared`, `opportunistic`, and `manual`. A work item may also specify pinned/avoided workers, allowed capability routes, deadline, cost limit, provider permission, and quality-fallback permission.

The deterministic broker first filters hard eligibility, then applies project share/priority, then scores jobs by critical-path impact, age, downstream unlocks, locality, route performance, and explicit operator policy. Its output always includes an explanation and one of:

- `assign` for Control Room-native work;
- `request_source_command` for source-scheduled work;
- `recommend_only` for advisory work.

## Audit rules

Audit events are append-only. They record actor, source, scope, action, target, safe metadata, correlation/idempotency keys, and timestamp. Database rules prevent update or deletion through the application role.
