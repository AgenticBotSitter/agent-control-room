# Private PostgreSQL endpoint contract

Status: source support with disposable tests. No live route, certificate,
database, grant, listener, tunnel or connection has been created or verified.

The application still uses one PostgreSQL 17 primary and the existing `pg`
driver. Its location can now be the controller computer or a privately reached
computer. The scheduler, task records, result receipts and permissions are
unchanged. No database synchronization or second writer is added.

## Accepted application endpoints

- Exact `127.0.0.1`, retaining the established local TCP configuration.
- An exact canonical IPv4 address in Tailscale's `100.64.0.0/10` range, excluding
  the range endpoints, with a bound `privateEndpoint` policy. Its required
  fields are the endpoint fingerprint, prior reviewed private-route evidence
  digest, TLS server name, and SHA-256 fingerprint of the exact server
  certificate. The policy schema is `control-room.private-postgres-endpoint/v1`.

The address is routing input; the name is TLS identity input only. The driver
connects to the literal address and never resolves the name. DNS changes cannot
redirect a pooled reconnect. Hostnames, public addresses, RFC1918 subnet routes,
alternate loopback spellings, wildcard/unspecified/multicast/link-local
addresses, mapped IPv6, URLs and ambiguous address spellings refuse. Other
private-route types can be added only with a separately reviewed contract.

Private input holds the exact endpoint and identity. Public preparation evidence
contains fingerprints only. The existing protected configuration manifest binds
the full private policy; all configured application roles must use the same
policy. The preparation also binds its route evidence to the installation's
database-authority declaration. Credentials continue to arrive through the
existing owner-held runtime inputs; they are never added to endpoint evidence.

## TLS behavior and reused code

This change reuses installed `pg` 8.23.0's existing SSL negotiation and Node's
built-in certificate-chain and hostname checks. The routing option remains the
numeric address. The TLS options require authenticated TLS 1.2 or later and
the declared server name, and additionally pin the exact peer certificate.
There is no permissive certificate mode, plaintext fallback or invented trust
store. The certificate must be trusted by the Node process's configured trust
roots and match the saved name and fingerprint. Certificate rotation therefore
requires a deliberate reviewed configuration update.

The source inspected for this reuse is `pg/lib/connection.js`, specifically its
`upgradeToSSL` forwarding of supplied TLS options and preservation of the
explicit TLS server name when the connection host is a numeric address. No
upstream code was copied or dependency added; the existing dependency license
and notices continue to apply.

The prior private-route evidence digest is a binding, not a live Tailscale
health check. A successful connection additionally proves the TLS identity and
the existing primary/version/session qualification. Loss of the private route,
identity mismatch or certificate expiry fails the existing connection path;
this contract does not reconnect through a public host or another authority.

## Separate privileged setup boundary

The database provisioning, migration and backup tools remain bound to VPS
loopback. Application connectivity from the Mac does not authorize privileged
setup from the Mac. Those reviewed tools should run on the database's own
computer through the existing owner-authorized setup procedure. This package
does not widen their connection permissions or add a forwarding service.

Before a real Mac-to-VPS application installation can use this endpoint, the
installation must have reviewed private-route evidence, restricted application
roles, a PostgreSQL private listener and a trusted matching server certificate.
No evidence in this package establishes those live prerequisites. If the VPS
currently has no qualifying TLS setup, installation is blocked on that concrete
prerequisite; setting `ssl:false` on a remote address is never an alternative.

For a userspace-mode Tailscale VPS that cannot bind PostgreSQL directly to its
tailnet address, the reviewed raw-forwarding activation and rollback design is
[`PRIVATE_POSTGRES_TAILSCALE_SERVE_ACTIVATION.md`](PRIVATE_POSTGRES_TAILSCALE_SERVE_ACTIVATION.md).
That document preserves this exact endpoint and TLS contract; it does not
authorize the live route.

## Evidence

The existing database option tests cover private address and identity binding,
public/ambiguous address refusal, proof and endpoint drift, hostname/certificate
failure, environment fallback resistance, and lazy construction without network
use. Installed-runtime tests prove all roles retain the same policy and reject
a role with different route evidence. Preparation tests reject mismatched route
evidence without exposing addresses or names in the public plan.
