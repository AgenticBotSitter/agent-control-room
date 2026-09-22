# macOS installation-journal native sidecar

## Purpose

The installation-journal session helper is a macOS-only executable whose
executable mode cannot be preserved by the ordinary portable Node release.
This source package defines a separate, deterministic sidecar for the accepted
`native/installation-journal-session-v1.c`. The macOS launcher release now
packages and verifies the inert sidecar, but does not stage or execute the
helper in an installation or live operation.

The sidecar contains only the already-built archive, its original native
manifest, `SHA256SUMS`, and a versioned sidecar manifest. The verified archive
contains the repository's exact `LICENSE` and `NOTICE`. No function in this
package downloads a toolchain, installs an artifact, starts a service, chooses
an owner path, or claims owner qualification.

## Required identity

`MACOS_INSTALLATION_JOURNAL_SIDECAR.json` records and the verifier requires:

- platform `darwin`, exactly one of `arm64` or `x64`, and macOS 13.0 or later;
- protocol `ACRJNL1`;
- the exact journal source SHA-256, Apple compiler identity, SDK version, and
  fixed reviewed compiler flags;
- exact `LICENSE`, `NOTICE`, and `installation-journal-session-v1` names,
  modes, sizes, and SHA-256 digests;
- the archive and original-manifest SHA-256 digests; and
- the release version assigned when the sidecar is composed.

The archive is deterministic for a fixed source and toolchain. Its private
parser accepts only the expected regular files and directories with exact
modes. It rejects links, traversal, duplicate paths, extra or missing records,
malformed headers, unsafe filesystem modes, and digest drift.

## Private staging boundary

Verification is read-only. Staging is a separate explicit operation and is
restricted to a supported macOS host whose architecture matches the verified
sidecar and whose Darwin kernel maps to at least the manifest's minimum macOS
version. The staging call requires the exact expected release version plus the
outer sidecar-manifest, archive, artifact-manifest and executable digests. It
checks all five identities before creating a staging directory, then
materializes the already-captured, verified archive bytes into a fresh
exclusive `0700` directory and returns only the existing session factory's
private input shape:

```text
{ executablePath, executableSha256 }
```

Path substitution after verification cannot change the staged bytes. A release
or digest mismatch refuses before staging. Staging
does not compile, download, install, execute the helper, create or mutate an
installation journal, or grant broader runner authority. Installed-manifest
binding, operator composition, and owner-attended native qualification remain
separate work.
