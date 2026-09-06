# E77 — explicit host shutdown bridge

2026-09-06. Source/fake-signal verification only; no real process handler installed.

`bindPrivateHostShutdown`, exported by the compiled task-host entry, connects an
explicitly supplied SIGINT/SIGTERM source to an already running host's existing close
method. It invokes cleanup once, bounds the wait, removes only its own listeners and
reports closed or cleanup_uncertain without exposing raw error details. Duplicate
signals do not retry cleanup. Late cleanup does not erase a recorded timeout.

This reuses Node events and host cleanup; the OS service manager owns termination and
restart policy. Import is inert. Binding is explicit; tests supply only EventEmitter.
No process exit, signal sending, restart mechanism or service installation is added.
The eventual service-manager stop timeout must account for the host cleanup budget.

Three unit tests pass: duplicate-signal once-only cleanup preserving other listeners;
rejection/never-resolving cleanup; invalid configuration. TypeScript, targeted lint and
VPS build pass. All 41 compiled tests pass, including the full task-host journey using
the bridge after task/page/assets/logout checks and verifying listener/two database
resources close once, readiness stops and later application requests are unavailable.

This is not startup cancellation: binding occurs only after a running host exists.
Trusted executable configuration, signals during asynchronous startup, supervisor
installation, real PostgreSQL/TLS and owner key setup remain open. No live fleet drain
or physical listener evidence is claimed. Full default test lifecycle was not rerun.
