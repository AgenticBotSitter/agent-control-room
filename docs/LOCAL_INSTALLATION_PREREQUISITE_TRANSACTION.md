# Local installation prerequisite transaction

**Status:** accepted source-only setup bridge. It performs no download,
database operation, dependency installation, service start, credential access,
browser operation, or agent run.

`completeLocalInstallationPrerequisitesV1` connects the existing verified
release stager and read-only package preflight to the existing append-only
installation plan. It records only these two stages, in order:

1. `release_preflight`
2. `private_placement`

Both producer reports now carry a SHA-256 digest calculated from the exact
`RELEASE_MANIFEST.json` bytes they inspected. The transaction requires both
digests to equal the release digest already bound into the installation plan.
Matching version numbers alone are not accepted.

Every journal append is followed by a fresh read of the current plan. The
transaction rechecks the installation identity, topology, release, and both
stage inputs before it can continue or report completion. A simultaneous
change, historical replay, failed or uncertain stage, mismatched report, or
changed release is refused instead of being repaired or silently normalized.

The transaction reuses the installation-plan journal as its only receipt
store. An exact restart replays the same two receipts; it creates no second
database, queue, state machine, or retry system. Its successful result makes
the existing `database_authority` stage reachable but does not start that
stage or authorize a PostgreSQL operation.

This is the thin Control Room-specific connection described by the
[installation reuse implementation map](INSTALLATION_REUSE_IMPLEMENTATION_MAP.md).
The release archive, stager, preflight, plan, and journal remain the retained
implementations. No donor source was copied or distributed by this package.
