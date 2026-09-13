# Read-only project schedule status

Project Automations reads `/api/v1/projects/:projectId/schedules` through the existing
authenticated project/session path. The caller cannot choose a tenant or workspace.
Each read rechecks project access; missing permission or storage is unavailable,
not an empty schedule list. No schedule editor, occurrence producer, outbox consumer,
task dispatch, worker pickup, retry, cancellation command or background timer is added.

The view reads at most ten schedules and twenty recent occurrences per schedule,
with explicit omitted-record notices. Its forecast covers seven days, using the
existing recurrence/cron/timezone code. The pure projection refuses windows beyond
31 days. A sparse schedule with no occurrence in that window is not disabled or
finished. Paused/disabled schedules have no forecast. Interval records currently have
no explicit anchor, so their next occurrence is unavailable; `createdAt`, `updatedAt`
and the stored `nextRunAt` are never repurposed as an anchor.

Forecasts are calculations, not task admissions. Retained occurrence timestamps and
states are preserved, including records from previous definitions. Pending past its
scheduled time means execution is unknown, not that work definitely ran or was missed.
`dispatched` is shown as delivery recorded, execution unverified. A cancelled
occurrence does not cancel the schedule or authorize repeating it. Repeated reads
are read-only and stable for the same clock and saved records.

The lead authorized SELECT on `control_schedules` and
`control_schedule_occurrences` for the existing restricted web role, with matching
preflight expectations. No mutation privilege or new role is added. Existing
installations need the operator's separately reviewed read-grant update; the role
template is fresh-setup SQL and must not be rerun blindly. No live database change
was performed. The migration/schema fingerprint is unchanged.

Focused tests cover the actual authenticated route with disposable SQL and the
restricted role, forecast/DST boundaries, cancellation/replay, unavailable storage,
cross-project response refusal and component rendering. They do not qualify automatic
scheduling, browser visual/mobile layout, native workers or production deployment.
