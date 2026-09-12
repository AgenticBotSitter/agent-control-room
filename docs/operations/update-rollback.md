# Update and rollback (operator guide)

Every release records `revision` and `previousRevision` in its manifest, so the
rollback target is always explicit. Keep the **complete previous release tree** —
the checkout at the recorded `previousRevision`, its built `dist-vps/` and its
`dist-release/` artifact — until the new release passes its own preflight +
smoke test. A previous manifest alone cannot restore code or dependencies; the
rollback target is the whole prior tree, treated as immutable while it is the
rollback candidate.

## Update

The update procedure prepares a **separate versioned checkout** for the new
revision; the live checkout and its built `dist-vps/` are never overwritten by
the update. This keeps the prior release tree intact and addressable for
rollback until the new one is verified and switched over.

```sh
# 1. Prepare the new release in a sibling directory, never in the live checkout.
NEW_SHA="<new-exact-sha>"
NEW_DIR="control-room-${NEW_SHA:0:12}"
git clone https://github.com/AgenticBotSitter/agent-control-room.git "$NEW_DIR"
cd "$NEW_DIR"
git checkout "$NEW_SHA"
CI=true pnpm install --frozen-lockfile
node scripts/build-vps.mjs

# 2. Build and verify the new artifact in its own directory. The previous
#    manifest lives in the live checkout; point at it explicitly.
node scripts/release/build-release.mjs --revision "$NEW_SHA" \
  --previous-manifest "<path-to-live>/dist-release/manifest.json" \
  --out dist-release --overwrite
node scripts/release/verify-artifact.mjs --manifest dist-release/manifest.json
node scripts/release/preflight.mjs --configuration <path>/control-room-config.mjs \
  --manifest dist-release/manifest.json

# 3. Switch the service over only after the new tree passes preflight and the
#    smoke test below.
systemctl --user stop control-room
# (or SIGTERM the supervised process and confirm exit)
systemctl --user start control-room
# start command points at $NEW_DIR
```

Equivalent for a checkout-based installation:

```sh
# Add the new SHA as a worktree rather than replacing the current checkout:
cd control-room
git fetch origin
git worktree add ../control-room-<new-sha> <new-exact-sha>
(cd ../control-room-<new-sha> && CI=true pnpm install --frozen-lockfile)
(cd ../control-room-<new-sha> && node scripts/build-vps.mjs)
(cd ../control-room-<new-sha> && node scripts/release/build-release.mjs \
   --revision <new-sha> \
   --previous-manifest $(pwd)/dist-release/manifest.json \
   --out dist-release --overwrite)
(cd ../control-room-<new-sha> && node scripts/release/verify-artifact.mjs \
   --manifest dist-release/manifest.json)
```

After the new tree passes preflight and the smoke test, point the service at
`../control-room-<new-sha>` (or `control-room-<new-sha>` depending on layout)
and start. The previous checkout, its `dist-vps/` and its `dist-release/`
artifact are still on disk and untouched until the new release is confirmed.

Smoke test after start: owner login works, one project page renders, no error
in the first 60 seconds of logs. Any failure → roll back immediately, do not
debug forward on the live host.

## Rollback

1. Stop the service (`systemctl --user stop control-room`, or SIGTERM the
   supervised process and confirm exit).
2. Point the service/start command back at the complete previous release tree
   (the checkout at `previousRevision`, its built tree and its artifact).
   The `previousRevision` recorded in the new manifest names that tree; it is
   not itself restorable from the manifest.
3. Re-run preflight against the previous artifact, then start.
4. Confirm the smoke test, then record the rollback (revision, reason, time)
   in your install log.

## Build provenance

`build-release.mjs` refuses to run unless the revision you pass is exactly the
current clean Git `HEAD` of the checkout you are building from
(`release_revision_mismatch` / `release_worktree_unclean` otherwise), and refuses
outside a Git checkout entirely (`release_revision_unverified`). The manifest
proves the build was performed while the recorded checkout was clean and at
that SHA — i.e. that `build-release.mjs` was executed against a clean
worktree pinned to `revision`. It does **not** prove that a pre-existing
ignored `dist-vps/` left on disk by a prior build was itself produced by this
run from that SHA: ignored output is invisible to `git status` and the
provenance check cannot inspect it. Operators clear or relocate any stale
ignored build output before invoking `build-release.mjs` if they need that
property; the build script does not assume or claim it.

## In-flight work

Stopping the host does not delete queued work: the queue lives in PostgreSQL
(the `queue-recovery-fence` behavior is covered by `tests/queue-recovery-fence.test.ts`),
and uploaded files live in R2. After a restart the operator verifies queue
depth and recent completions before accepting new work — see
`restore-checklist.md`. Never delete the PostgreSQL data directory or the R2
bucket as part of a rollback.

Database schema rollback across incompatible migrations is NOT promised here.
A rollback restores the previous application code and artifact; if a migration
applied during the new release is incompatible with the previous version, the
operator restores from the verified backup per `restore-checklist.md` instead
of expecting the artifact rollback to undo migrations. Test the rollback path
into disposable storage before trusting it on the live host.
