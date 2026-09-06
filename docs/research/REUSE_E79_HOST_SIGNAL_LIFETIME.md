# E79 — one explicit signal lifetime around host startup

2026-09-06. Local code and fake-event tests; no real process handlers or service.

`startPrivateHostLifecycle` registers supplied stop events before scheduling one
authorized startup callback. It supplies E78's AbortSignal and reuses E77's bounded
cleanup. Runtime stop events use the same registration: there is no remove/re-add gap
between startup and ready. Explicit stop and signal stop both abort first.

Pre-start cancellation prevents the callback altogether and is known clean. If an
attempted startup rejects without returning a host, cleanup remains uncertain at this
layer; it cannot infer disposition from arbitrary callback errors. A late host is
closed once and never returned as ready after cancellation. If it arrives after the
shutdown deadline, cleanup still runs, but the recorded uncertain outcome is preserved.
Failure text is sanitized and no retry or process-exit policy is added.

This is application lifetime glue around existing startup/shutdown, not a competing
supervisor. The exported factory has no import-time effects. The future executable
must supply actual trusted configuration and Node's process object under deployment
authority; tests use EventEmitter only. Unavailable resources, unknown cleanup and
service-manager hard termination remain distinct outcomes.

## Verification

Five lifecycle tests plus three shutdown tests cover success, pre-start stop, late
start, rejected start and post-deadline late cleanup. The full compiled task-host
journey now starts through the lifecycle and stops through simulated signals after
task/page/assets/logout checks. Existing once-only pool/listener closure assertions
remain. Initial lint/type checks found a const declaration and generic fixture type;
both were corrected without relaxing assertions. Final results are in BUILD_STATUS.md.
Final run: eight lifecycle/shutdown tests, 42 compiled checks and four queue journeys
pass, as do TypeScript, targeted lint and VPS build. No full default lifecycle rerun.

Executable configuration loading, resource provisioning, startup operator error
reporting and installed service policy remain unfinished. No live host acceptance
or complete unattended update/drain claim is made.
