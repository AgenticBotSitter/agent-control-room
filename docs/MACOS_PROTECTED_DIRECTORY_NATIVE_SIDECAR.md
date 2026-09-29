# macOS protected-directory native sidecar

## Purpose

The descriptor-relative protected-directory helper is a macOS-only executable.
It cannot be placed in the ordinary portable Node release because that release
intentionally normalizes all members to mode `0644`. This sidecar keeps the
native helper separate while binding it to the macOS launcher asset.

The sidecar contains only the already-built archive, its original native
manifest, `SHA256SUMS`, and a versioned sidecar manifest. It includes the
native `LICENSE` and `NOTICE` inside the verified archive. It does not contain
an updater, downloader, compiler, installer, service manager, credential, or
owner path.

## Required identity

`MACOS_PROTECTED_DIRECTORY_SIDECAR.json` records and the verifier requires:

- `darwin`, exactly one of `arm64` or `x64`, and macOS 13.0 or later;
- protocol `ACRDIR1`;
- source SHA-256, compiler identity, SDK version and fixed toolchain flags;
- exact `LICENSE`, `NOTICE` and `protected-directory-v1` names, modes, sizes
  and SHA-256 digests;
- the archive and original-manifest SHA-256 digests; and
- the release version that carries the sidecar.

The archive parser accepts only regular files and directories with exact modes.
It rejects symbolic links, hard-to-interpret tar types, traversal, duplicate
paths, extras, missing records, malformed headers and altered content before it
writes a staged file.

## Runtime boundary

Bundle verification is read-only and happens before the launcher creates its
private installation root. It refuses an unsupported CPU or macOS version.
The native factory input is produced only by explicitly extracting verified
bytes into a fresh exclusive `0700` staging directory. The returned factory
input is compatible with the existing protected-root native factory:

```text
{ executablePath, executableSha256 }
```

Construction and verification are inert. Staging does not compile, download,
install, start a service, create protected data, or claim qualification. A
separate owner-attended native qualification remains mandatory before a live
protected-root operation can be accepted.
