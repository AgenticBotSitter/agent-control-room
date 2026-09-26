# Private installed-configuration preparation

**Status:** source-only and inert. This package does not install Control Room,
write the protected Mac folder, inspect credentials, connect to PostgreSQL,
use the network, start a service, or contact a worker.

## Outcome

`private-installed-configuration-preparation.ts` prepares the existing
`control-room.private-installed-local-hermes-configuration/v1` data for the
existing `control-room.private-installed-configuration-custody/v2` reader. It
does not introduce a second configuration format.

The redacted plan binds:

- the standard Mac protected placement under the owner's Library/Application
  Support directory, represented publicly only by fingerprints and fixed file
  names;
- canonical configuration and manifest byte counts and SHA-256 fingerprints;
- the release and installation identities;
- one PostgreSQL 17 `control_room` authority on an independently reviewed
  private route;
- the authority, target, private endpoint, owner-held credential reference and
  private-route evidence by fingerprints only.

The current owner deployment may satisfy that private route with Tailscale.
The contract deliberately records `private_network`, not a vendor-specific
database or a new tunnel service, so the same installation contract can later
use another reviewed private route.

This is preparation evidence only. The application PostgreSQL runtime accepts
exact loopback (`127.0.0.1`) or the narrow private TLS endpoint defined in
[Private PostgreSQL endpoint contract](PRIVATE_POSTGRES_ENDPOINT_CONTRACT.md).
When a `privateEndpoint` policy is supplied, preparation binds its reviewed
private-route evidence to this same authority declaration. A legacy plan with
only a hostname is still preparation data and cannot load as runtime
configuration. This package does not claim database load, connection, startup,
certificate readiness, or a verified live route, and creates no forwarding
service. Privileged PostgreSQL setup tools remain VPS-loopback-only.

The plan is data-only. It rejects functions, callbacks, accessors, proxies,
cycles, raw connection URLs, common credential values, command-shaped fields,
foreign installation/release/database bindings, non-standard Mac placement,
and an authority that is not identified as private. Configuration remains
subject to the deeper existing installed-runtime checks when custody loads it.

## Owner-held handoff

The exact protected path and canonical bytes remain in a process-local opaque
record. A later reviewed owner wrapper supplies only the existing native
protected-path verifier. Consuming the record returns:

- the canonical configuration and v2 manifest bytes for a future bounded
  publication operation;
- the fixed protected configuration, manifest and journal locations; and
- the exact existing `PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V2` input.

That composition is still inert: it invokes no native verifier and performs no
file operation. Supplying its custody input to the existing owner-host
preflight clears `installed_configuration_custody_input_missing` and reaches
the next real blocker. It does not claim the files exist or that custody has
been verified.

## Future owner inputs

The minimum later private inputs are:

1. the already reviewed native protected-path verifier for the Mac owner;
2. a bounded publication operation that creates the standard protected root,
   journal directory, configuration and manifest with the required ownership,
   access controls and modes; and
3. owner-held resolution of the recorded PostgreSQL endpoint and credential
   reference. Credential values never enter the plan, manifest, setup evidence
   or repository.

Those effectful operations remain separate owner-attended stages. This package
does not authorize them.
