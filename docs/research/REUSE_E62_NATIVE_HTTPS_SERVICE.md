# E62 — standard Node HTTPS service adapter

2026-09-06. Unwired local source; fake server methods and synthetic byte fixtures only.

Use Node's existing HTTPS/TLS implementation, not a custom handshake, reverse-proxy
certificate header, Hermes fork or new dependency. Official [Node 22 TLS documentation](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscreateserveroptions-secureconnectionlistener)
and installed Node type definitions were consulted. Server creation takes TLS options;
unlike client setup, a prebuilt `secureContext` is not a server-constructor option.

The service consumes supplied key/certificate/CA bytes, copies them, and only creates
the HTTPS server on explicit start. TLS requires a client certificate and successful
CA verification, TLS 1.2 or newer and HTTP/1.1. The existing native callback still checks
the actual request socket's peer certificate pin, current identity and task scope.
These are separate checks; chain validation does not grant task authority.

Binding requires an explicit private IPv4 literal (RFC1918, Tailscale CGNAT range or
127.0.0.1) and port. DNS, public/default binds and IPv6 are not accepted in this initial
profile. Private addressing is not authentication; firewall/interface setup remains
required. This restriction is configuration policy, not proof of host reachability.

The adapter limits sockets/headers and keeps existing native request limits. It rejects
upgrades, CONNECT and expectation handling; bind has a five-second deadline, cleanup a
ten-second deadline. Shutdown drops readiness, cancels binding, closes the native
application and owned connections, and clears its copied credential buffers. This is
not a guarantee that Node/OpenSSL or the caller erased their own copies. Cleanup
uncertainty remains a failure and the instance cannot restart.

Tests inject EventEmitter server methods and non-certificate bytes. They verify options,
immutable input capture, passing the actual supplied socket through existing intake,
normal once-only closure, constructor/bind failure, cleanup error, stalled bind/close
using mock timers, and prohibited bind addresses. The combined service/delivery/denial/
isolation suite passes 31 checks; TypeScript and targeted lint pass. No actual TLS handshake or cryptographic certificate
validation was performed; that remains a later authorized rehearsal.

Reason for this glue: the existing browser server enforces a different origin/header
policy and loopback-only HTTP. It cannot carry the native TLS socket. The new adapter
only connects standard Node HTTPS lifecycle to the already-built native callback.

Still required: compiled export and combined host ownership, reviewed certificate/key
sources and provisioning, operator configuration, real network/TLS/agent rehearsal,
rotation and supervised deployment. This module is not mounted or automatically started.
No new downloads, credential reads, provider calls, listener attempts or GitHub activity.
