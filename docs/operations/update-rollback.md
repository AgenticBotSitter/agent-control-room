# Update and rollback (operator guide)

Every release records `revision` and `previousRevision` in its manifest, so the
rollback target is always explicit. Keep the **complete previous release tree** —
the checkout at the recorded `previousRevision`, its built `dist-vps/` and its
`dist-release/` artifact — until the new release passes its own preflight +
smoke test. A previous manifest alone cannot restore code or dependencies; the
rollback target is the whole prior tree, treated as immutable while it is the
rollback candidate.

Build provenance: `build-release.mjs` refuses to run unless the revision you
pass is exactly the current clean Git `HEAD` of the checkout you are building
from (`release_revision_mismatch` / `release_worktree_unclean` otherwise), and
refuses outside a Git checkout entirely (`release_revision_unverified`). The
manifest proves the tree was built from that reviewed revision, not a label the
caller typed.

## Update

```sh
cd control-room
git fetch origin && git checkout <new-exact-sha>   # must be the clean HEAD you build from
CI=true pnpm install --frozen-lockfile
node scripts/build-vps.mjs
node scripts/release/build-release.mjs --revision <new-sha> \
  --previous-manifest <path-to-previous-dist-release/manifest.json> \
  --out dist-release-<new-short-sha> --overwrite
node scripts/release/verify-artifact.mjs --artifact dist-release-<new-short-sha>
node scripts/release/preflight.mjs --configuration /home/operator/control-room-config.mjs \
  --artifact dist-release-<new-short-sha>
# stop the service, point it at the new tree, start, smoke-test (below)
```

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
