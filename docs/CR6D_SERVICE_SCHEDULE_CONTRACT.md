# CR-6D service, schedule, incident, and reconciliation contract

**Status:** Active, effect-free implementation contract.

## Scheduling rules

1. A schedule only creates a durable occurrence proposal. It never starts a process, sends a request, or grants execution authority.
2. Each occurrence has a stable key made from the schedule identifier and its intended local wall-clock time (cron) or UTC instant (interval/once). Persistence must use that key to make retries and restarts idempotent.
3. Cron is five fields: minute, hour, day of month, month, day of week. Numeric values, lists, ranges, and steps are supported. When both day-of-month and day-of-week are constrained, either may match; a wildcard field does not independently match.
4. Cron uses an IANA timezone. A spring-forward local time that does not exist creates no occurrence. A repeated fall-back local time creates one occurrence using the earlier UTC instant. The calculator retains the local wall-clock key so persistence can deduplicate across calls and restarts.
5. Interval schedules are anchored to a canonical UTC instant and use a positive number of seconds. Once schedules use a canonical UTC instant. All calculations are bounded to 31 days per call.
6. Paused and disabled schedules produce no occurrences. Malformed schedules, invalid timezones, ambiguous malformed windows, or oversized calculation ranges fail closed with a stable safe reason.

## Service and incident rules

1. Desired service state is an operator/project intent; observed service state is time-bounded evidence. One never silently overwrites the other.
2. Reconciliation compares declared desired state with observed evidence and creates a safe proposal or incident projection. It does not start, stop, or repair a service.
3. An incident is keyed by the tenant, source type, source identity, and correlation key. Repeated evidence updates one open incident; recovery evidence resolves it only after the contract-defined recovery condition.
   A later recurrence creates a new generation, preserving the resolved record. Opening and resolving an incident each write a tenant-bound idempotent outbox proposal.
4. All persistence and dispatch work is transactional and idempotent. An outbox message names the exact occurrence or incident projection and is retried through existing delivery boundaries.

## Effect boundary

No component in this block installs or starts a service, calls a provider, dispatches a real job, or performs a consequential external effect without separate exact authority.
