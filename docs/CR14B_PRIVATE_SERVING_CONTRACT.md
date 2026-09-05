# CR14B private Node serving

Date: 2026-09-05. Scope: repository code, in-memory Node streams, injected server and compiled tests.
This is not listener, ingress, browser, database or deployment evidence.

## Composition and ownership

The separate VPS build exports `server/serving.js`, alongside handler/runtime/bootstrap. Import is inert.
Trusted operator composition first loads the immutable release's `dist-vps/client` snapshot, then explicitly
starts the already-reviewed database bootstrap, then supplies that application, fixed HTTPS origin, compiled
handler and explicit port to `createPrivateNodeService`. Only explicit `start()` can construct/bind a server.
No environment/credential loading, migration, IdP configuration, signal handler, service installation, provider
call or deployment is included. The rehearsal's exact reviewed entry and scope must authorize that effect.
Calling `start()` transfers application ownership, including cleanup after failed startup; a rejected factory
configuration has not transferred ownership. Failed/closed lifecycles never restart themselves.

The first serving profile is HTTP/1.1 on literal `127.0.0.1`, behind the separately configured same-host private
Access ingress. The proxy must preserve the configured HTTPS Host; forwarded host/protocol headers cannot
select an origin. Local socket membership is not identity: pages/APIs still verify the Access assertion and
current SQL permissions/session tombstone. All non-allowlisted headers, including cookies and Authorization,
are discarded. The app does not interpret a forwarded assertion as proof without signature verification.
No public bind, TLS termination, arbitrary proxy, work alias, HTTP/2, WebSocket or CONNECT support is implied.
Ingress/TLS/Access configuration must be proved later. Do not point the existing `vinext start` command at
this profile; it is not this reviewed composition.

## Bounded requests and delivery

The server uses strict Node HTTP parsing, 24 KiB headers, 64 headers/connections, 5-second header/body receipt,
one request per connection and fixed loopback peer checks. The bridge accepts GET/HEAD/POST, exact Host,
unambiguous origin-form targets and at most 8 KiB bodies. Duplicate headers, unsupported encodings/trailers,
expectations, mixed framing, oversized/mismatched bodies and cross-site requests are rejected before dispatch.
The supplied assertion, origin, request key and reviewed router headers reach the existing application.

Each admitted request occupies one of 64 slots through response completion, including backpressure. Whole
request delivery is bounded to 30 seconds/4 MiB. Headers and bytes stream through Node's backpressure-aware
pipeline; HEAD cancels body production. Disconnect/deadline aborts production and disposes late response
bytes. Errors never send raw details. The transport closes every response connection; no browser refresh or
command retry is automatic. A command already dispatched may still finish under its database deadlines:
disconnection does not prove rollback. Its existing idempotency key/receipt is the reconciliation authority.
Finite project snapshots are supported; this is not an indefinitely open event subscription.

Readiness drops synchronously on close/error; HTTP admission stops before application drain. The bridge
waits up to 30 seconds for admitted delivery, then aborts remaining transfers and closes the app once. The
service gives network/app cleanup up to 35 seconds, forces owned sockets closed on uncertainty and reports
a fixed uncertain outcome. The existing pool has its independent bounded termination. Neither forcing a
socket nor an injected callback proves real OS resource absence; the later rehearsal verifies that.

## Browser assets, not an arbitrary file server

Startup reads only `_next/static` and `favicon.svg` from an explicitly named, canonical `dist-vps/client`.
It refuses symlinks/nonregular files, caps traversal/depth/count and snapshots approved JS/CSS/font/image
types into at most 32 MiB (4 MiB/file). Maps, JSON manifests, HTML and arbitrary public files are excluded;
the server tree is never traversed. The content digest binds ordered paths/types/lengths/byte hashes. The
operator must keep release files immutable during loading; same-UID/administrator replacement is excluded.

HTTP performs exact in-memory lookup, never filesystem reads, normalization, range serving, directory lists
or fallback. Assets contain no records/credentials and require private ingress/peer/Host but not a database
session lookup; protected application records never use this path. All responses remain no-store/noindex
with MIME sniffing disabled. No public CDN cache or discoverability guarantee is claimed.

## Evidence and remaining gates

Tests use synthetic headers, in-memory Node streams, injected server callbacks and disposable PGlite. The
compiled path exercises the actual built handler plus restricted SQL bootstrap; its documented single-field
PGlite TEMP metadata injection is unchanged. No physical server/listener, real PostgreSQL, credentials,
browser interaction or deployment is run by these tests. Real request parsing/port lifetime/reverse-proxy
configuration, TLS/MFA, DB concurrency and restart/cleanup still need the scoped CR14B rehearsal.

Implementation references: [Node 22 HTTP](https://nodejs.org/docs/latest-v22.x/api/http.html),
[Node streams](https://nodejs.org/docs/latest-v22.x/api/stream.html),
[Node filesystem](https://nodejs.org/docs/latest-v22.x/api/fs.html). Installed Node/type declarations were
also inspected; these documents are API guidance, not observed live service evidence.
