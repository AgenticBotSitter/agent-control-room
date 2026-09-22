# Private first-owner ceremony adapter

This source-only adapter fills the narrow production seam beneath the accepted
private first-owner runner. It wraps one already-retained
`OwnerBootstrapCeremonyV1`; it does not construct a second owner, identity,
authentication, listener, credential, or receipt system.

The caller keeps ownership of the existing bootstrap-only host, database
connection, ceremony configuration, and reviewed owner-attended control
attempt. The adapter captures their callable identities when it is created.
Its `route()` method is mounted in the existing host and delegates to the same
ceremony route. Neither a gateway assertion nor the one-time code is read,
returned, logged, or hashed by this adapter.

## Terminal evidence

The ceremony port accepts only the existing exact arm response, then waits for
the same retained route to emit the exact bounded 201 completion response. Arm,
HTML preparation, errors, extra response fields, replay, abort, or malformed
completion cannot become terminal evidence.

After completion, one fixed parameterized query observes the configured
database, tenant, workspace, identity, and owner grant. It requires exactly one
identity and one unrevoked owner grant for the pinned subject, with the exact
bootstrap-selected IDs and names, active human state, wildcard owner scope,
critical ceiling, external-effect authority, and no expiry or revocation. The
adapter returns only a SHA-256 proof bound to the installation, release, plan
revision, passed database outcome, request, subject, ceremony outcome, and
normalized authoritative row. It never returns the row itself.

## Failure and cleanup

The accepted runner marks every adapter failure after ceremony invocation as
uncertain. Adapter errors have one fixed redacted message and no stack. Close
is limited to the same captured ceremony and has an independent deadline, so a
hung close cannot strand the caller. No cleanup deletes, repairs, revokes, or
modifies owner or database state.

This package does not mount a listener, acquire a database connection, create a
browser request, or obtain a native control peer. Those remain injected and
owner-attended. No live ceremony or native qualification was performed.

Focused disposable proof:

```sh
node --import tsx --test tests/private-first-owner-ceremony-adapter.test.ts
```
