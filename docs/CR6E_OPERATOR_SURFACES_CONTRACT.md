# CR-6E operator-surfaces contract

**Status:** Active, effect-free contract and durable projection foundation.

## Shared operator truth

The portfolio, project, worker, service, schedule, incident, bottleneck, Action Inbox, and Owner Focus surfaces consume one versioned operator-surface snapshot. It contains only tenant-bound, bounded, redacted projections. It never includes credentials, raw host identity, raw transcripts, private locators, or an implied right to act.

## Action Inbox

Every open, resolved, or expired attention item names the requested action, stable reason code, work blocked by that item, legal response choices, evidence references, age/expiry, and delivery state. A response option is only a constrained presentation of a legal next step; it does not state that the step occurred. An exact-operation approval always requires confirmation. Unavailable responses give a safe reason instead of disappearing.

## Owner Focus

An Owner Focus pin records an owner priority signal (`p0` or `today`) for a project, with a bounded reason and optional expiry. It is neither execution authority nor a scheduler override: it cannot create a reservation, waive a policy gate, select a worker, spend a budget, or dispatch work. The scheduler remains the only component that evaluates fairness and feasibility.

## Effect boundary

This contract exposes read models and command shapes only. It does not send a notification, change an external system, approve an operation, start a service, or dispatch work. Persisting or applying a command remains a separately authorized later step.

The initial durable store keeps Action Inbox projections tenant-bound and replay-safe. Owner Focus requests are accepted only after the caller's authentication and authorization boundary, are idempotent, and produce no outbox event or scheduler change.

Read models use stable ordering and explicit filters. Expired items stay auditable and can be included deliberately; a delivery failure never makes an unresolved item disappear. Scheduler-facing Owner Focus metadata contains explicit `false` flags for fairness, authority, and capacity overrides, so it cannot be mistaken for a reservation or permission.

The read service receives a tenant scope only from the authenticated server boundary. It binds every durable store and fleet/bottleneck source query to that scope, validates/redacts the assembled snapshot again before returning it, and performs no write or command. A browser query parameter is never an authority source.

The protected HTTP route requires the deployment-provided authenticated actor header and uses server-only tenant/database configuration. It accepts only bounded display filters; it never accepts a tenant identifier. Missing private configuration fails unavailable rather than returning fixture or cross-tenant data.

The dashboard browser reader calls that protected route with same-site credentials and no tenant parameter. It validates the complete response again before rendering it. If authentication, private configuration, transport, or validation is unavailable, the dashboard may display its clearly labelled synthetic fixture; it never presents that fixture as protected operator truth.

The protected fleet table renders only the projection's observed state, platform, capability and telemetry status, and declared capacity. Missing capacity is displayed as unavailable; neither an online state nor a positive slot count is presented as dispatch authority.

Service incidents are included inside the same validated snapshot, using only the durable incident identifier, service identifier, severity, state, safe reason/remedy codes, and timing. The tenant and correlation key stay server-side; a remedy code is never a repair operation.

Saving Owner Focus uses a separate protected route. The server assigns the tenant and recorded time, requires an authenticated platform identity and a durable low-risk policy decision scoped to the project, and rejects client-supplied tenant or scheduler fields. A successful save records only Owner Focus intent; it creates no outbox event, reservation, scheduling preference, dispatch, or external operation.

The protected Bottleneck surface renders declared resource pressure, bounded work-item identifiers, and a redacted explanation. It is a read-only capacity projection: it never offers a capacity release, reservation, or dispatch action.
