# First-owner ceremony

The first-owner ceremony is an inert, bootstrap-only application gate. Before an
owner exists, normal application and static routes return unavailable. An attached
local operator may arm one five-minute code through a separately supplied Unix-domain
control attempt. The browser then submits only that code after the configured gateway
assertion and same-origin checks succeed. Owner identity comes solely from the signed
assertion, and the existing owner bootstrap and security store create the existing
identity and owner grant.

The process retains only a digest of the code. A separately injected durable lifecycle
store atomically records the first arm before code delivery; a claimed marker without
an owner makes every restarted lifecycle refuse replacement. The raw code is written only through
the attached-operator callback and is absent from returned evidence, database rows and
logs. One process lifecycle permits one arm attempt. Expiry, concurrent consumption,
database uncertainty, control timeout, abort or cleanup uncertainty permanently
disable that lifecycle. A restart queries the existing identity table before arming;
an existing identity of any state permanently disables the ceremony under the
no-second-identity invariant, while normal application routes become available.
Closing is a permanent monotonic fence: it aborts in-flight work, and late inspection,
delivery, transaction or marker returns cannot reopen bootstrap or normal routes.

This change does not open a socket or write the marker itself. The injected Linux proof requires an absolute
socket beneath a mode `0700` runtime directory, a mode `0600` socket, single links,
matching service/operator ownership, a physically valid directory link count of at least two,
and an exact `SO_PEERCRED` user identity. The
actual native adapter that gathers `stat` and `SO_PEERCRED`, atomically creates and syncs
the lifecycle marker, socket creation/removal,
terminal attachment, macOS peer credentials, and real gateway/MFA/direct-origin
acceptance remain physical qualification work. A platform adapter must fail closed;
it must not substitute TCP, browser headers, command-line values, environment values,
configuration files, ordinary standard input or log output for this boundary.

All current evidence is disposable: injected control attempts, synthetic gateway
keys/assertions and an ephemeral PostgreSQL-compatible fixture. It makes no real
identity, listener, credential, provider, network, service or production claim.
