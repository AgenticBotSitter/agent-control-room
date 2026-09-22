# Install from GitHub

**Status:** release-distribution instructions for the first single-computer
macOS product path. A downloadable public release is not available until an
owner has completed the release acceptance journey. This document does not
turn source checks or the manual GitHub workflow into a published product.

## What you will download

When a release is marked ready, download these two files from its GitHub
**Releases** page:

- `agent-control-room-macos-<version>.tar.gz`
- `SHA256SUMS`

The archive contains one double-click launcher, the verified release package,
and its internal manifest. It is for macOS on Apple silicon or Intel. It does
not include Node.js, PostgreSQL, a database, agent credentials, private data,
or an already-running service.

## Before you begin

You need macOS, an internet connection for the later controlled dependency
preparation, **Node.js 22.13 or later**, and the exact **pnpm 11.19.0** command
already installed. The launcher checks Node before it can continue, and the
shipped dependency-preparation step refuses any other pnpm version. It does
not install Node or pnpm for you.

The first public product path is deliberately narrow. A compiled, read-only
loopback setup page now exists and is tested from the built artifact, but the
launcher still reaches the source-only, owner-attended setup rehearsal and
does not yet start that host or open the browser. It does not activate a
database, background service, Hermes, Codex, or Claude.
Do not treat a successful download or launcher opening as a working Control
Room installation.

## Check the download

In Terminal, change to the folder containing both downloaded files and run:

```sh
shasum -a 256 -c SHA256SUMS
```

Continue only if the result says `OK` for the downloaded archive. A mismatch,
missing checksum file, or an unexpected extra filename means delete the
download and obtain a fresh copy from the release page. Do not bypass this
check by copying a checksum from a chat message or a source checkout.

The future public release contract requires a SHA-256 checksum sidecar beside
the archive. No public asset or checksum is published yet. The first release
also will not have a signing certificate or GitHub build attestation, so its
checksum will confirm file integrity against that future release page but will
not be a separate proof of publisher identity.

## Open the launcher

Double-click the archive to extract it, then double-click:

`Open Agent Control Room.command`

The launcher verifies its own contents and the inner release, places the
verified release in a private version directory, performs a read-only
compatibility check, and runs the shipped source-only setup entrypoint. The
next package will hand that launcher to the already-built loopback setup page;
the current launcher does not open it yet. It stops if the package is incomplete or
changed, if macOS/CPU is unsupported, if Node.js is too old, or if pnpm is not
exactly 11.19.0 when dependency preparation begins.

It does not silently create a PostgreSQL database, install or start a service,
write credentials, enable an agent, or start work. Those are separate,
owner-confirmed stages in the setup experience.

## If something goes wrong

Keep the archive and checksum together while checking the download. If macOS
says the launcher cannot open, re-download it and verify the checksum before
trying again. If the launcher reports that Node.js is missing or too old,
install a supported Node.js release from its official source and reopen the
same verified bundle. If dependency preparation refuses pnpm, install pnpm
11.19.0 from its official source; do not bypass the pinned-version check.

Do not clone this repository or run developer build commands as a workaround.
If the setup page identifies a database, backup, private-data, or agent
requirement, leave that stage incomplete until the owner who controls that
resource can review and approve it.

## What an owner publishes later

The repository's **Release distribution verification** workflow is manual and
read-only. It builds the portable release and the outer macOS launcher twice,
checks their bytes and checksum sidecar, and reports the resulting hash. It
does not upload a release asset, create a tag or GitHub Release, sign files,
or create an attestation.

After the clean-install acceptance journey is complete and a maintainer has
separate authority to publish, that maintainer must create the GitHub Release
and attach the exact outer macOS archive together with its matching
`SHA256SUMS`. They must not attach the inner portable archive as a substitute
for the macOS launcher bundle. Publishing remains a deliberate owner action;
this repository contains no automatic release publisher.
