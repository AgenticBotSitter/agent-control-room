# Local release assembly

**Status:** build-time release preparation only. This does not publish, sign,
install, configure, start or activate Agent Control Room.

The local release builder turns an already compiled checkout into one
deterministic archive, one external copy of its manifest and one `SHA256SUMS`
file. The archive is the common input for the later **This computer** and
**Several computers** installers. Placement changes do not create a second
runtime, database, scheduler or permission system.

## Reuse decision

The staging, versioned archive name, external checksum and smoke-test approach
are adapted as concepts from T3 Code's MIT-licensed installer at revision
`6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`, specifically
`scripts/install.sh`, `scripts/install.ps1`, `scripts/install.test.ts`,
`scripts/release-smoke.ts` and the layout notes in
`scripts/build-npm-platform-packages.ts`. No T3 runtime, connection authority,
profile/provider system or source code is copied into the release builder.
Because this implementation is original code using only those packaging
concepts, no new bundled third-party source or notice is added here.

## Included material

The allowlist contains:

- the built server and browser output;
- the standalone local preparation check and private launcher;
- the PostgreSQL migration ledger, every ledger input, database roles and
  backup/restore tools;
- the project license, notice, third-party texts and reviewed runtime-license
  evidence;
- the package manifest and frozen lockfile used by the later dependency
  preparation step.

Before any file is copied, assembly reruns the existing license inventory and
undisclosed-bundle checks against the current package manifest, lockfile,
vendored sources and retained notice tree. Their fresh result must exactly
match the saved reviewed inventory, scan, notice and release manifest. Stale,
changed or incomplete evidence refuses the archive.

Nothing else in a developer checkout can enter the archive. Every included
directory is walked recursively and any symbolic link, device, missing file,
empty required directory or path escape refuses assembly.

## Reproducibility and verification

Every manifest row records a sorted relative path, byte length, SHA-256 and
normalized file mode. Tar ownership, mode and timestamps are normalized, gzip
uses a zero timestamp, and no current time or host path enters the output.
Building the same input twice therefore produces the same archive bytes.
The manifest also declares the portable Node artifact boundary explicitly:
Node 22.13 or later on supported macOS or Linux, for arm64 or x64. That is
release metadata, not permission to start a service on the build computer.

Before the archive is written, the builder copies only manifest-listed files
to an isolated staging tree and verifies that tree. Missing, changed or extra
files and extra directories are refused. The exact manifest is also stored
inside the archive as `RELEASE_MANIFEST.json` and beside it for pre-extraction
inspection. `SHA256SUMS` binds the final archive bytes.

The archive deliberately contains no credential, operator configuration
values, database contents or private agent state. It also does not include a
prepared dependency directory. The later installer must perform the recorded
frozen production dependency preparation before activation and then rerun the
standalone preparation check. That remaining installation step is not hidden
or presented as complete by this package.

## Build command

After the normal production build and license checks, a maintainer can assemble
into a new empty directory outside the checkout:

```sh
node scripts/assemble-local-release.mjs \
  --release-root /absolute/path/to/agent-control-room \
  --output-directory /absolute/path/to/new-output-directory
```

Successful output explicitly reports `publishes: false`, `signs: false` and
`installs: false`. Publication, signature, installation, database setup,
background service setup and agent activation are later separately reviewed
operations.
