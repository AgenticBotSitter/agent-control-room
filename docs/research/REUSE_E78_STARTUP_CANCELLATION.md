# E78 — cancellation through existing startup ownership

2026-09-06. Local code and simulated-resource tests only; no physical startup.

The task bootstrap accepts an optional explicit AbortSignal. Pre-cancellation refuses
before resource acquisition. Checks between prerequisite stages prevent opening later
pools, preparing producers, starting workers or returning ready after cancellation.
Resources are owned before checking cancellation so a pool returned during cancellation
is still closed. The existing abandonment flag and worker delivery abort signal are
set immediately; late producer/worker handles follow the existing once-only cleanup.
Installation is checked again before returning a ready application.

The host passes the captured signal into bootstrap and observes it through native and
browser listener setup. Cancellation invokes existing close paths; late bind success
cannot turn an aborted start into a successful host return. The existing listener
close path aborts its bind controller. All newly installed cancellation listeners are
removed when startup settles, whether successful or failed. E77 handles subsequent
runtime stop signals separately.

## Limits

No new supervisor, process signal registration, polling loop or forceful termination
is introduced. This is cooperative startup cancellation: an in-flight prerequisite
query/factory may continue until it returns or reaches its existing deadline. It is
not evidence of instant provider/SQL cancellation or undo. Uncertain cleanup stays
uncertain; startup is not retried. The eventual executable must register real stop
signals before startup and transfer lifetime ownership to runtime shutdown afterward.

## Tests

New cases cover cancellation before open, during first resource acquisition, at
installation after both pools exist, and during compiled listener bind. They assert
no ready result, no later pool acquisition where applicable, and once-only closure.
Existing prerequisite, role separation, cleanup deadline, private serving and task
journey checks remain. Final verification counts are recorded in BUILD_STATUS.md.
Final run: 14 startup tests, 42 compiled tests and four queue journeys pass, along with
TypeScript, targeted lint and VPS build. No full default lifecycle rerun claimed.
