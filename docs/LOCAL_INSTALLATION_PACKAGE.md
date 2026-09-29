# Local installation package

**Status:** source-only preparation foundation. It does not install or start
Agent Control Room.

The supported single-computer installation is intended to be a downloaded,
versioned release bundle followed by one owner setup flow. It is not a list of
hand-edited terminal commands. The local and multi-computer choices use the
same application, PostgreSQL authority database, scheduler, project records,
tasks, results, reviews and corrections. Adding another computer later changes
worker delivery; it does not migrate to a different product.

## What exists now

After downloading an extracted release, this standalone Node command checks
its required structure and creates a deterministic fingerprint. It needs no
source toolchain, `tsx` loader or `node_modules` directory:

```sh
node scripts/prepare-local-installation.mjs
```

The command is always a dry run, whether or not `--dry-run` is written. It:

- checks the required server, browser, launcher, configuration-template,
  package and lock files;
- refuses linked, missing or oversized content and an unexpected package/tool
  baseline;
- creates one aggregate release fingerprint without printing file names or
  private paths, and binds the declared release version into the report;
- reports that private setup, database, backup and supervisor checks remain;
- never installs a service, starts a process, creates a database, writes a
  credential, changes DNS or opens a listener.

The first result says `fingerprinted`, not `validated` or `trusted`. The
fingerprint is a preparation identity, not proof that the download came
from the project and not a permanent trust decision. The finished release
process must publish a signed checksum separately. A published expected digest
can already be compared with:

```sh
node scripts/prepare-local-installation.mjs \
  --expected-digest "sha256:THE_PUBLISHED_VALUE"
```

A match says `matched_expected_digest` while `authenticityVerified` remains
false until the separate signed-checksum work is complete. Activation must
validate that signature and re-read the exact prepared bundle immediately
before it starts anything; it must not rely on an older dry-run report after
files could have changed.

The public fingerprint command never reads a private service definition. After
the future owner setup flow generates one, its explicit owner-attended step
will call the existing macOS service preflight and retain only
`validated_not_installed`. Private paths and settings stay outside this public
command and its report.

## Intended finished owner experience

The final downloadable release will wrap this validator in one installer/setup
experience:

1. Download and verify a signed/versioned release.
2. Choose **This computer** or **Several computers**.
3. Choose the protected data location and connect one empty PostgreSQL
   database.
4. Complete owner authentication, backup/restore and service-readiness checks.
5. Enroll local agents; each remains unavailable until its own qualification
   passes.
6. Review one final summary and explicitly activate the installation.

Uninstall and upgrade procedures must preserve the protected database and
result evidence by default. Activation, upgrade, rollback and removal remain
separate owner-authorized operations; this preparation command cannot perform
them.

## Still required before a public installer is complete

- A release archive assembly step and signed checksum publication.
- A setup interface that writes private settings without exposing them to the
  browser, logs, tasks or GitHub.
- PostgreSQL provisioning/migration and independently verified backup/restore.
- Installation and lifecycle control for the unprivileged background service.
- Upgrade, rollback, diagnostics and data-preserving uninstall.
- Platform packages for Windows and Linux that feed the same shared readiness
  and activation contracts.

This foundation intentionally reuses `dist-vps`,
`macos-local-service-package`, and `macos-local-service-preflight`. It does not
introduce another scheduler, database, permission system or agent framework.
