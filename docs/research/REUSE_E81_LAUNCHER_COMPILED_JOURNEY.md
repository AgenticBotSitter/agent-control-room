# E81 — launcher success and failure through compiled composition

2026-09-06. Offline supplied-dependency tests; no real service, credentials or network.

The launcher now has explicit in-process dependency injection for its module loaders,
signal source and reporting. Direct CLI execution always uses the fixed installed
runtime. There is no CLI test flag, environment switch or request-controlled factory.
The filesystem configuration-path check runs in both cases; it was not bypassed.

The new compiled journey invokes the same runPrivateVps function with actual compiled
renderer, asset loader, host and lifecycle. Only the resource factory is substituted
with the existing restricted-role PGlite fixture and fake EventEmitter server; operator
configuration and signals are supplied in-process. It verifies ready reporting, two
role resources opened, private bind options, signal shutdown, once-only listener/pool
closure and removal of signal handlers. No extra server or renderer was implemented.

A separate operator-error case confirms zero host creation, no ready message, a fixed
sanitized error, exit code 1 and signal-listener removal. Temporary synthetic config
path files are removed after tests. No credentials are stored in those files and their
contents are not imported in the injected tests.

This does not prove a successful direct CLI launch with its real PostgreSQL factory,
actual operator module import or physical listener. E80's actual subprocess help/refusal
checks remain separate. Production operator configuration, resource setup, native TLS,
checkpoint custody and real-agent trial remain outstanding. No default application
dependency or compiled source changed; an application rebuild was not needed.

Final verification: all 47 combined compiled/launcher tests pass, zero failures,
cancellations or skips; targeted lint and whitespace checks pass. Full default test
lifecycle was not rerun for this launcher-only dependency separation.
