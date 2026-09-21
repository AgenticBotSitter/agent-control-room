# Local production dependency preparation

**Status:** owner-attended source package with injected-runner tests. No real
package download or package-manager execution was performed while accepting
this package.

This is the inert dependency-preparation part of installation package I6. It
operates only on a version already placed by the accepted local-release
stager. It binds the stager's publication record, release manifest,
`package.json`, `pnpm-lock.yaml`, Node version, operating system and processor
architecture before it can ask the pinned package manager to run.

## Reuse decision

- **Adapt:** T3 Code's MIT-licensed isolated temporary workspace, versioned
  release directory and atomic publication concepts, pinned at
  `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`. The source references were
  `scripts/install.sh`, `scripts/install.ps1` and `scripts/install.test.ts`.
- **Retain:** Control Room's release manifest, checksum-verified stager,
  package-manager pin and release-tree verification.
- **Do not adopt:** T3's downloader, executable bundle, service activation,
  current-version link, runtime, profiles or provider control. This package
  adds no second package manager or downloader.

## Fixed operation

The executor first verifies that `pnpm --version` is exactly `11.19.0`. It
then invokes only:

```text
pnpm install --prod --frozen-lockfile --ignore-scripts \
  --store-dir <owned temporary store> \
  --virtual-store-dir <owned temporary node_modules/.pnpm>
```

The temporary HOME, pnpm store and configuration directories are new,
owner-private directories. npm/pnpm lifecycle scripts are disabled, and the
executor does not pass registry tokens or other credential environment
variables. It checks that every declared production dependency—and no declared
development dependency—appears at the exact package version, bounds and
fingerprints the complete dependency tree, then flushes the bounded files and
directories before atomically moving only the verified `node_modules`
directory into the inert staged release. After the move it rechecks every
top-level production package and recomputes the fingerprint from the final
version path before writing the receipt. A link that becomes unsafe or broken
after relocation is therefore left visibly uncertain rather than accepted.

A content-bound receipt makes an exact retry read-only. If a crash happens
after that receipt is durable but before its exact lock is removed, the next
retry verifies both and finishes only that cleanup. A changed manifest,
package, lockfile, runtime or dependency tree is refused. A known failed tool
exit removes only this attempt's temporary files and permits an explicit
retry. An interrupted tool call, an existing preparation lock, or a crash
after dependency publication remains visibly uncertain; it is never guessed
safe to rerun.

## Boundaries

This step does not switch the current release, write an install-complete
marker, configure or start a service, touch PostgreSQL, read or write
credentials, or start any agent. It performs no download during tests. The
real owner-attended command may contact the public package registry through
pnpm and therefore remains a separately authorized installation effect.

The standalone command is:

```sh
node scripts/prepare-local-production-dependencies.mjs \
  --owner-attended \
  --install-root /absolute/private/agent-control-room-root \
  --version 0.1.0 \
  --expected-manifest-digest sha256:THE_STAGED_MANIFEST_DIGEST
```

The release assembler must include this script and its standalone module before
the public launcher can call it from a downloaded release. The module does not
import the developer-only release assembler or its license-build helpers;
runtime dependency closure is therefore limited to the shipped Node standard
library plus these two files. Current switching and service startup remain
separate later stages.
