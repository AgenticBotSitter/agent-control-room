# Private protected-root native directory helper

**Status:** source-complete and independently reviewed with disposable macOS
evidence. It is not included in an installed release and has not touched an
owner's Control Room directory.

## Purpose

This is the narrow operating-system operation required by the existing
protected-data owner runner. Node cannot safely express the required
descriptor-relative `mkdirat` and no-follow `fstatat` sequence, so the release
build creates one small macOS helper from `native/protected-directory-v1.c`.
It is not a general command runner, installer, repair tool, or deletion tool.

The helper accepts one bounded private pipe frame. It opens every component of
the expected parent without following symbolic links, verifies the captured
parent identity, owner, `0700` mode and absence of extended ACLs, attempts one
`mkdirat`, and verifies the new child through both no-follow metadata and an
opened directory handle. Existing objects refuse and are preserved. Any lost
or malformed reply is uncertainty and is never retried automatically.

## Executable custody

The TypeScript wrapper reads and hashes the reviewed helper bytes, then closes
the source. It verifies the fixed root-owned macOS temporary hierarchy, creates
a fresh owner-only directory, removes and verifies inherited ACLs, writes the
captured bytes exclusively, rechecks identity and digest, and launches only
that private `0500` copy. The source path is never executed. Cleanup checks the
captured file and directory identities and removes them non-recursively; any
unexpected content or cleanup ambiguity prevents a success result.

Root and processes already running as the installation owner remain inside the
documented operating-system trust boundary. The package does not claim to
contain a malicious process with the same owner authority.

## Release and live boundary

`scripts/build-protected-directory-native.mjs` uses only the installed Apple
toolchain, downloads nothing, and produces one architecture-specific,
deterministic archive containing the executable, manifest, `LICENSE`, and
`NOTICE`. Runtime code never compiles the helper.

A later package must bind this native artifact into the verified local release
and launcher. The first real use also requires separate attached-owner native
qualification. Until both steps pass, this package grants no authority and the
installer must continue to report protected-directory setup as unavailable.

## Verification

`pnpm test:protected-root-native` covers the real disposable macOS primitive,
symlink and parent/child replacement races, ACL and mode failures, existing
objects, cancellation and deadlines, fragmented framing, bounded output,
source executable replacement, private staging, process reaping, uncertain
cleanup, deterministic artifact bytes, and the existing adapter/runner
contracts. Tests use temporary directories only.
