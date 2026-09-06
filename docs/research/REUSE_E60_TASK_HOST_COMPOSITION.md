# E60 — application and serving composition

2026-09-06. Compiled local tests with fake server methods only; no listener attempt.

`createPrivateTaskHost` connects the existing verified task bootstrap and existing
loopback serving lifecycle. `createInstalledPrivateTaskHost` supplies real PostgreSQL
pool construction and the already-pinned pg-boss factories. It has no PGlite production
fallback and does not force optional worker/recovery configuration on.

Import/construction is inert. An explicit `start` receives trusted configuration, the
compiled request handler, immutable loaded assets and port. It validates basic serving
inputs before opening pools, waits for existing application checks, and starts the
existing service. Returned readiness combines application/listener readiness. Existing
narrow task runtime handles remain available to trusted host composition.

The service owns normal shutdown. A memoized application close also handles construction
and bind failure without closing pools twice. Cleanup failure remains uncertainty, not
success; the host does not retry startup. Existing startup and service implementations
retain their own wait/cleanup bounds. No new HTTP server, queue engine, credential store
or process supervisor was implemented.

Compiled evidence uses actual restricted two-role PGlite startup, installed compiled
routes and fake EventEmitter listen/close methods. It proves creation/assignment/page
rendering, the large task transport path, loopback options and once-only normal closure.
Additional cases prove invalid port opens no pools, failed bind closes both pools once,
and failed pool cleanup reports uncertainty. These are not six physical PostgreSQL
connections, real socket binding or real agent execution.

The production build, TypeScript and targeted lint pass. The initial complete compiled
suite passed 35 checks; the expanded task-host file passes all six checks including
three failure subtests. Full expanded compiled results are recorded in BUILD_STATUS.md.

Remaining: trusted executable configuration and its actual checkpoint/key/trust sources,
owner request delivery/consent/custody, process signal integration and an authorized
real rehearsal. Calling `start` can open databases, pick up already-approved work and
bind a listener; this document and successful tests do not authorize that operation.
The compiled entry is a callable composition, not an installed/running service.
