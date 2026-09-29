# Private protected-root owner runner

## What this package is

This source-only runner defines the reviewed boundary for creating, verifying,
and binding the installation's one protected local artifact directory. It
reuses the existing private-artifact configuration and persistent-storage
preflight. It does not create a second store, database, scheduler, permission
system, or recovery format.

## Reuse decision

The package **reuses**:

- `src/web/v1/private-artifact-storage.ts` for the captured installation-owned
  configuration;
- `src/artifacts/v1/persistent-local-storage.ts` for existing storage
  verification; and
- the protected-data preparation and installation-plan stages already in this
  repository.

An external filesystem framework is not adopted. Exact owner attendance,
installation evidence, uncertainty, and protected-data binding are Control
Room authority boundaries, so the remaining code is a small connector around
those retained components.

## Safety behavior

- The root must be the exact canonical child of the selected private parent.
- The effective operating-system user is derived by the private runtime rather
  than accepted as caller input.
- Create and verify operations require an attached-owner confirmation bound to
  the exact redacted request.
- Parent and root device/inode identities are checked before and after creation
  and storage preflight.
- Storage preflight must return one exact redacted receipt bound to the request,
  prior protected-data evidence, storage configuration, namespace, and root
  identity.
- Symlinks, broad permissions, foreign files, stale locks, linked artifacts,
  path substitution, and malformed receipts fail closed without repair or
  deletion.
- Once directory creation may have happened, cancellation, timeout, identity
  change, or later failure is **uncertain** and cannot be retried automatically.

## Deliberate remaining boundary

The real operating-system implementation of identity-bound, no-follow
directory creation is not part of this package. The injected port and
adversarial tests define what it must prove. Until that production adapter is
separately implemented and reviewed, this runner is source-ready but not safe
to invoke against an owner's real directory.
