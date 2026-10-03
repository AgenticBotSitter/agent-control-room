# Idea Lab runner limits

Live panels remain disabled. These contracts prepare the runner for a gateway
that can enforce billing limits; they do not qualify a native provider.

Before every call, the coordinator reserves a conservative maximum in
`IdeaLabPanelBudgetV1`. The default maximum is the entire remaining allowance.
A trusted driver may supply a smaller conservative `maximumCallCostUsd`.
Reservations are synchronous and shared by coordinator callers using the same
ledger object and run. Integer nanodollar accounting rounds reservations and
charges up and the panel ceiling down. A missing bill makes the allowance
unavailable. Settlement cannot be repeated.

A live driver must declare `costBounded`. The filtered Hermes driver derives
that flag only from an own data property `enforcesMaximumCostUsd: true` on its
trusted gateway port. The gateway must enforce the request's `maximumCostUsd`
*before* charging, including cancellation, retries, partial failures and all
provider fees. Returning an over-limit bill is a contract breach, not a way to
undo a charge. The existing enrolled native gateway declares no such guarantee
and is refused. Do not add the flag until its native bridge actually implements
and qualifies the limit.

The coordinator computes one absolute deadline from the retained run start and
session duration, bounded by the owner window. It passes
`panelDeadlineMilliseconds` to every call. The filtered driver races execution
against the smaller of the time remaining and its configured call timeout, and
rechecks expiry at dispatch. The gateway must enforce that deadline even when a
local cancellation signal is delayed or ignored. Calls ending after the deadline
cannot publish a contribution. The filtered driver retains the time it observed
the terminal reply before starting cleanup, so cleanup does not consume the
provider's reply allowance.

Cleanup has a separate maximum of 5,000 milliseconds (configurable downwards).
The gateway receives `cleanupTimeoutMilliseconds`. Its exact, bound cleanup
receipt must prove that the process stopped and disposable resources were
removed. A rejected, missing, late or invalid proof yields terminal ambiguity
with `stop_unconfirmed`. Late collectors are sealed and automatic retry stays
disabled. Returning from this driver does not prove a noncooperative native call
ended; responsibility for that call stays with the gateway. Cancellation remains
between calls, as required by the existing admission policy.

Validated usage and cost survive failed, ambiguous, late, invalid-output and
cleanup-failure outcomes. Bills are independent of accepted contributions.
`usage: null` means unknown usage. `costUsd: null` means an unknown bill, including
an unknown aggregate when any attempt is unknown. Existing known costs remain in
the individual attempts. The owner view displays unknown rather than zero.
Signed historical records are not rewritten and previously discarded bills
cannot be reconstructed by these changes.

## Durable store work required before enabling live panels

The local reservation port does not coordinate separate ledger objects,
processes or restarts, and is not an ownership fence. R6S-04 recovery behavior is
unchanged. The database owner must implement and verify an atomic reservation
port under the production login:

- Bind each reservation to the logical panel, run, attempt, conservative maximum,
  absolute deadline and a durable owner/fence. Store reserved, settled and unknown
  states and distinguish charged amounts from accepted contributions.
- Atomically refuse when known charges plus every outstanding maximum would
  exceed the panel ceiling, across independent connections and processes.
- Commit the reservation and pre-call marker before invoking a gateway. Exact
  retries must reuse the reservation without a new provider effect.
- Settle every validated bill on every terminal outcome. Preserve unknown holds;
  never release them merely because a local timer expired or a caller restarted.
- Recovery must prove that the previous owner and provider call ended before
  releasing authority or a hold. Fence publication and settlement as well.
- Verify concurrent budget-edge calls, failed billing, dropped connections,
  cancellation, abandoned ownership and exact retries through real production
  logins. No migration, grant or SQL change is supplied by this work.
