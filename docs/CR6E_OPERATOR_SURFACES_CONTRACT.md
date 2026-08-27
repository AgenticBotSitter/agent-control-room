# CR-6E operator-surfaces contract

**Status:** Active, effect-free contract and foundation.

## Shared operator truth

The portfolio, project, worker, service, schedule, incident, bottleneck, Action Inbox, and Owner Focus surfaces consume one versioned operator-surface snapshot. It contains only tenant-bound, bounded, redacted projections. It never includes credentials, raw host identity, raw transcripts, private locators, or an implied right to act.

## Action Inbox

Every open, resolved, or expired attention item names the requested action, stable reason code, work blocked by that item, legal response choices, evidence references, age/expiry, and delivery state. A response option is only a constrained presentation of a legal next step; it does not state that the step occurred. An exact-operation approval always requires confirmation. Unavailable responses give a safe reason instead of disappearing.

## Owner Focus

An Owner Focus pin records an owner priority signal (`p0` or `today`) for a project, with a bounded reason and optional expiry. It is neither execution authority nor a scheduler override: it cannot create a reservation, waive a policy gate, select a worker, spend a budget, or dispatch work. The scheduler remains the only component that evaluates fairness and feasibility.

## Effect boundary

This contract exposes read models and command shapes only. It does not send a notification, change an external system, approve an operation, start a service, or dispatch work. Persisting or applying a command remains a separately authorized later step.
