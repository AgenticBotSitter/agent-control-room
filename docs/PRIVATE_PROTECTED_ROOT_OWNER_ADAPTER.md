# Private protected-root owner adapter

**Status:** accepted source boundary; real creation remains blocked pending one
separately reviewed native syscall implementation. This package has not touched
an owner's directory and does not make the local installation operational.

## Reuse decision

Decision: **retain and adapt narrowly** the existing Control Room components.

- `src/installer/v1/private-protected-root-owner-runner.ts` remains the sole
  owner-action transaction. The adapter does not add another state machine or
  receipt store.
- `src/artifacts/v1/persistent-local-storage.ts` remains the sole protected
  storage preflight. The adapter calls its production factory exactly once and
  converts success into the runner's existing redacted receipt.
- `src/web/v1/private-artifact-storage.ts` remains the configuration capture
  and namespace authority.
- The existing filesystem hardening in persistent artifact storage and the
  first-owner lifecycle was inspected. It provides useful no-follow file opens,
  identity rechecks and fail-closed inventory handling, but it does not expose
  descriptor-relative directory creation.

No external filesystem framework was adopted. The already evaluated installer
donors do not supply a smaller compatible seam, and importing their runtime,
credential, session or authority systems would conflict with Control Room.
The remaining missing code is uniquely the operating-system boundary described
below, so the reuse-before-build search stops here. No third-party source or
notice is retained by this package.

## What the adapter proves

`src/installer/v1/private-protected-root-owner-adapter.ts`:

1. derives the effective user ID from the running POSIX process; callers cannot
   supply or override it;
2. binds one canonical configured root to its exact canonical parent;
3. lets the accepted runner verify private ownership, mode and identity before
   and after the creation window;
4. binds confirmation to an injected attached-terminal port and the exact
   request digest;
5. calls `PersistentLocalArtifactStorageV1.create` exactly once for the real
   storage preflight;
6. returns only the runner's digest-based observation—never a private path,
   secret, native request or raw filesystem error; and
7. exposes no repair, recursive creation, deletion or retry operation.

Abort or deadline after entry into the creation port is uncertainty. Any
malformed native receipt, parent substitution, changed identity, symlink,
wrong permissions or ambiguous preflight fails closed. A created directory is
preserved for owner inspection; the adapter never guesses that it is safe to
remove or retry it.

## Exact production blocker

Node.js 22 does not expose the POSIX operations required to prove atomic custody
for this step: opening the parent directory without following links, holding
that descriptor, calling `mkdirat(2)` for one basename, and inspecting the new
child with `fstatat(2)` plus `AT_SYMLINK_NOFOLLOW` through the same descriptor.
Using `mkdir(path)` after `lstat`/`realpath` would leave a parent rename or
substitution race and is therefore not a production implementation.

The adapter consequently requires a branded native port whose single operation
must perform exactly that sequence and return a path-free receipt containing
the unchanged parent identity, new child identity, effective owner, `0700`
mode, directory type and no-follow facts. There is intentionally no default
implementation and no path-based fallback. Until a separately reviewed macOS
and supported-POSIX native binding supplies this port, owner-root creation is a
strict blocker contract rather than a production-safe live capability.

## Disposable evidence

The focused adapter tests use only temporary directories. They cover successful
composition and exact preflight, symlinks, parent and root permissions, foreign
content preservation, parent rename/substitution, forged no-follow evidence,
abort before and after native entry, deadline uncertainty, redaction, and the
absence of an unbranded/path-based fallback. They are contract evidence, not a
native syscall qualification and not an owner-attended rehearsal.
