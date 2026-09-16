# Release and update

How the Control Room release path builds one versioned archive, verifies it, and
updates or rolls back a host safely. This document ships inside the archive, so it
is readable by an operator who has the archive and nothing else.

## What the archive contains

One self-contained, versioned `.tar.gz` whose root holds:

| Member | Contents |
| --- | --- |
| `runtime/` | The compiled Node runtime (`dist-vps` output) |
| `examples/` | Operator configuration and environment examples, plus the service unit |
| `migrations/` | Accepted database migrations |
| `notices/` | Accepted notice and licence outputs (`NOTICE`, `THIRD_PARTY.md`, `third_party/`) |
| `tooling/` | The release, verification and update scripts |
| `manifest.json` | Integrity metadata for every member |

Nothing in the archive references the source checkout. The runtime, the
migrations and the tooling are all present, so the archive verifies and operates
on its own.

## Integrity metadata

`manifest.json` records, for every member: its relative path, exact byte size and
SHA-256. It also records the archive's own name, size and SHA-256.

Two consequences worth understanding:

- **The archive is self-verifying.** An inner copy of the manifest travels inside
  the archive, so an unpacked tree can verify itself with no access to the build
  checkout. The inner copy cannot contain the digest of the archive that carries
  it, so the archive's own digest lives only in the outer manifest written
  alongside it.
- **The manifest never lists itself.** It cannot record its own digest, so it is
  metadata rather than a member.

## Build

```bash
pnpm build                      # compiles the runtime into dist-vps/
node scripts/release/build-release.mjs --revision "$(git rev-parse HEAD)"
```

The revision must be **this checkout's clean HEAD**. The builder refuses a
revision label that does not match, and refuses a dirty worktree, because the
manifest is meant to prove *built* provenance rather than a caller's claim.

The build is refusal-first: every precondition is checked before anything is
created, so a failed build leaves no partial archive behind.

## Verify

```bash
node scripts/release/verify-artifact.mjs --archive dist-release/control-room-<version>.tar.gz
```

Verification happens in three stages and exits non-zero if any disagrees:

1. **archive** — the archive's size and SHA-256 match the manifest
2. **unpack** — the archive extracts into a throwaway directory
3. **unpacked** — every listed member is present, byte-identical, and nothing
   listed is missing; nothing present is unlisted

A changed member, a missing member, an extra file, a substituted archive or a
renamed archive are each refused.

## Layout on the host

```
~/control-room/
  releases/<version>/     unpacked, verified releases
  current                 symlink -> releases/<version>   (the live one)
  state/                  durable operator state — never written by the release path
  uncertain/              one marker per interrupted unit of work
  resolved/               resolved markers, kept as an audit record
  history.json            activation order, used by rollback
  update.log              bounded append-only log
```

Everything lives under the operator's home. No privileged paths, no root, no
system-wide install.

## Staged update

```bash
node scripts/release/update.mjs update --root ~/control-room \
  --archive dist-release/control-room-<version>.tar.gz
```

Update is staged, never in-place: the new release is unpacked and fully verified
into `releases/<version>` **before** `current` is repointed. Any failure before
the switch leaves the running release exactly as it was.

## Uncertain work

A marker in `uncertain/` means a unit of work was interrupted with no recorded
outcome. Update and rollback **refuse** while any marker exists, naming every one,
rather than deciding on the operator's behalf. Losing an interrupted unit by
overwriting it is worse than delaying an update.

Resolving a marker is an explicit operator act:

```bash
node scripts/release/update.mjs resolve-uncertain --root ~/control-room \
  --marker run-7.json --resolution accepted
```

The resolution is recorded under `resolved/`, so the decision stays auditable.

## Rollback

```bash
node scripts/release/update.mjs rollback --root ~/control-room          # previous release
node scripts/release/update.mjs rollback --root ~/control-room --to 1.0.0
```

Rollback **verifies the target release before activating it**. A target whose
tree no longer matches its own integrity metadata is refused as unsafe, so a
rollback can never install unverifiable bytes.

Rollback refuses when: uncertain work exists, no previous release is recorded, the
target is absent, or the target does not verify.

## Durable state

The release path never writes inside `state/`. Staged update, activation and
rollback all leave it untouched, so accepted work survives both directions. This
is asserted in the release tests, not merely intended.

## What is verified where

| Claim | Verified by |
| --- | --- |
| Archive builds and carries every required member | `tests/release/release-path.test.mjs` |
| Clean unpack; archive needs no checkout | release tests (verifies in an unrelated directory) |
| Integrity refusal: changed / missing / unlisted | release tests (real tampering, real re-hash) |
| Refusals happen before any effect | release tests (asserts no partial archive) |
| Staged update, durable state preserved | release tests |
| Update refused while uncertain work exists | release tests |
| Rollback and unsafe-target refusal | release tests |
| Real start/stop/restart/drain under systemd | **not run here — Linux integration check**, see `supervisor.md` |

The last row is the one honest gap. See `supervisor.md`.