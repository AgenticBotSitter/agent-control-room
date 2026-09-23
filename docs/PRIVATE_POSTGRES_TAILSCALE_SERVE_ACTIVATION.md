# Private PostgreSQL through Tailscale Serve

**Status:** reviewed activation design only. This document does not create a
route, certificate, database role, secret, firewall rule, service, or database
connection.

## Decision

For a controller computer using the single authoritative PostgreSQL database
on a Tailscale-connected VPS that runs Tailscale in userspace mode:

- PostgreSQL remains bound to loopback on the VPS.
- Persistent Tailscale **raw TCP** Serve forwards the private tailnet database
  port to VPS loopback.
- PostgreSQL performs its own TLS negotiation and SCRAM authentication end to
  end. Tailscale must not terminate or downgrade PostgreSQL TLS.
- The controller dials the exact protected Tailscale IPv4 address and validates
  the separately saved PostgreSQL TLS server name, normal trust chain, and exact
  certificate fingerprint through `private-postgres-endpoint.ts`.
- One restricted application role can use only the Control Room database. It
  cannot administer PostgreSQL or access unrelated databases.

This reuses the existing `tailscale` private-endpoint contract. It adds no SSH
tunnel, alternate authority store, second scheduler, database replication, DNS
routing fallback, public listener, or plaintext fallback.

## Why direct binding and SSH are not selected

Userspace Tailscale does not place the tailnet address on a kernel network
interface, so PostgreSQL cannot bind directly to that address. A persistent SSH
tunnel would add another Mac process lifecycle, would be interrupted by
Tailscale restarts, would currently require interactive reauthentication, and
would make the application see loopback rather than the reviewed Tailscale
endpoint.

## Protected installation inputs

The public repository must retain only schemas and digests. The installation's
protected configuration supplies:

- the exact Tailscale IPv4 address;
- the TLS server name;
- the exact server-certificate fingerprint;
- the private-route evidence digest;
- the protected CA reference, when the system trust store is insufficient;
- the restricted application login and its protected SCRAM secret; and
- the one Control Room database name and PostgreSQL major version.

There is no alternate endpoint or public/DNS fallback. Certificate rotation is
a reviewed protected-configuration transition because the endpoint contract
pins the exact certificate.

## One owner-attended activation transaction

The later VPS activation tool must perform one preflight and one bounded,
reversible transaction. Before any effect it must capture and hash the current
PostgreSQL configuration, client-authentication rules, certificate paths,
Tailscale Serve state, and tailnet policy evidence.

The transaction must then:

1. install a normally trusted PostgreSQL server certificate for the saved TLS
   identity, with protected key permissions, supervised renewal, expiry
   warning, atomic replacement, and verified PostgreSQL reload;
2. preserve PostgreSQL loopback-only listening;
3. add a tailnet rule that permits only the selected controller device to the
   VPS database port;
4. add only the persistent raw-TCP Serve mapping from the tailnet database port
   to VPS loopback PostgreSQL, without changing the existing HTTPS Serve route;
5. require TLS plus SCRAM for the restricted Control Room login and explicitly
   reject plaintext or access by that login to other databases;
6. add Control Room to the existing semantic PostgreSQL watchdog; and
7. record sanitized receipts and protected rollback material without returning
   addresses, names, certificates, secrets, or unrelated service state.

Because Tailscale Serve proxies from loopback, PostgreSQL observes the proxy as
loopback. Device admission and remote attribution therefore remain Tailscale
policy/audit responsibilities. Generic local PostgreSQL authentication rules
must eventually be replaced by explicit role/database rules after all local
consumers are inventoried.

## Required proof before Control Room may use the route

Use a disposable or explicitly owner-authorized target to prove:

- the controller connects to the exact numeric private address while validating
  the separate TLS name and pinned certificate;
- expired, substituted, untrusted, wrong-name, or wrong-fingerprint
  certificates refuse with no plaintext retry;
- the application role can perform only its expected bounded operations;
- other databases, administrative operations, schema changes, and prohibited
  update/delete operations refuse;
- sleep/wake, route loss/recovery, PostgreSQL restart, Tailscale restart, and
  certificate rotation recover without selecting another endpoint;
- a complete VPS/container restart retains the intended route and database
  state; and
- public database access remains unreachable.

The existing website route must continue to pass its health checks before and
after the proof.

## Bounded rollback

Rollback must:

1. disable only the raw database Serve mapping—never reset all Tailscale Serve
   state;
2. remove the controller-to-database tailnet grant;
3. restore the captured PostgreSQL authentication and certificate-path files,
   then perform a verified safe reload;
4. rotate the application secret that was exposed to the controller; and
5. prove PostgreSQL is again loopback-only and both tailnet and public database
   connection attempts fail.

Rollback does not delete the database or alter unrelated sites and services.

