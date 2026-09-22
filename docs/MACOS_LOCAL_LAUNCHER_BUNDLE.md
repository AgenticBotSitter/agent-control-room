# macOS local launcher bundle

**Status:** deterministic, source-only outer launcher. It is not a completed
Control Room installer, activation path, signed/notarized application, or
clean-install acceptance result.

## User boundary

A release maintainer can package the three existing local-release files into
one macOS asset. After macOS Archive Utility extracts the downloaded
`.tar.gz`, a user opens `Open Agent Control Room.command`. The command explains
that Node.js 22.13 or later is required and does not download or alter Node.
It passes control to the Node launcher in the same extracted directory; there
is no command sequence for the user to copy.

The launcher accepts only macOS on Apple silicon or Intel. Before it writes an
installation directory, it verifies the exact outer manifest and refuses a
missing, changed, extra, linked, or wrongly permissioned member. It then
composes, rather than replaces, the accepted paths:

1. the checksum- and manifest-verifying local release stager;
2. the staged release's read-only platform/package preflight; and
3. the staged release's `scripts/launch-local-setup.mjs` entrypoint; and
4. the staged release's fixed loopback setup-host entrypoint.

Every manifest, runtime and release file must have exact mode `0644`; the
Finder command and directories must have exact mode `0755`. Broader write or
execute access and set-user-ID, set-group-ID or sticky bits are refused. Child
commands receive only `PATH`, the selected `HOME`, and present temp/locale/time
zone values; Node startup flags, shell startup files, package-manager settings
and unrelated credentials are not inherited. The read-only preflight has a
one-minute outer bound. The shipped setup entrypoint has a distinct twenty-
minute outer bound around its own fifteen-minute dependency-tool bound. A
timeout terminates the owned process group, including descendants, before the
launcher returns.

After those finite steps pass, a separate narrow supervisor starts the
long-lived setup host on fixed port `3210`. It accepts one exact readiness
record, opens only `/usr/bin/open http://127.0.0.1:3210/setup` after that
record, and keeps ownership of the host until the launcher is stopped. A
startup timeout, unexpected output, browser-opener failure, early exit, or
parent shutdown terminates and reaps the owned process group. This supervisor
does not reuse the finite-child timeout helper as if the host were a short
command.

The current shipped setup entrypoint is still the source-only rehearsal. It
may prepare production dependencies in an owner-run launch, which can use the
public package registry. It does not create or migrate PostgreSQL, install or
start a service, access credentials, activate a worker, or mark production
acceptance complete. The bundle reports those limits explicitly.

## Reuse decision and pin

This package uses the already accepted **reference / adapt concepts only** decision for T3 Code's
MIT-licensed release installer patterns, pinned exactly at
`6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`. The reused pattern is limited to
one versioned downloadable asset, a human-opened platform entrypoint,
checksum-first staging into a version directory, and a final smoke/preflight
handoff. The inspected donor files were `scripts/install.sh`,
`scripts/install.ps1`, `scripts/install.test.ts`, and
`scripts/release-smoke.ts`, with layout concepts from
`scripts/build-npm-platform-packages.ts`.

No donor source is copied or materially adapted. The launcher retains Control Room's existing
release verifier, stager, standalone preflight, and shipped setup entrypoint.
It does not import T3's downloader, runtime, service manager, connection
authority, profiles, providers, credentials, or update activation. T3 is not
listed in `THIRD_PARTY.md`, because this original-code wrapper adds
no retained third-party source. The MIT notice becomes required if later work
copies or materially adapts T3 source.

## Deterministic asset

The assembler first asks the existing stager to validate the three supplied
release files in a disposable directory. It then includes only those files,
the four required Control Room runtime modules, the `.command` file, and the
outer manifest. It reuses the ordinary local release's deterministic tar-gzip
writer, with normalized paths, hashes, byte lengths, Unix modes, ownership and
timestamps. Repeating assembly over identical inputs produces the same gzip
bytes and SHA-256; no second archive implementation is maintained.

Build the ordinary local release first, then run:

```sh
node scripts/assemble-macos-local-launcher.mjs \
  --source-root /absolute/path/to/control-room \
  --release-directory /absolute/path/to/local-release-output \
  --output-directory /absolute/path/to/new-macos-output
```

The output directory contains exactly one GitHub Release asset named
`agent-control-room-macos-<version>.tar.gz`. Assembly does not publish, sign,
notarize, install, or launch it.

## Remaining release limitations

- The archive and `.command` file are not yet code-signed or notarized, so
  macOS Gatekeeper behavior for a public download is not qualified.
- Archive Utility extraction and a real Finder double-click still require an
  owner-attended clean-Mac acceptance run.
- Node.js 22.13 or later and the pinned `pnpm` 11.19.0 command remain external
  prerequisites; this bundle downloads neither.
- The setup page is real but deliberately read-only. Database/protected-data/recovery actions,
  background service installation, activation, upgrade, rollback, and agent
  enablement remain separate unfinished packages.
- Automated tests use only disposable folders and injected process results.
  They perform no network, database, service, credential, agent, or persistent
  installation effect.
