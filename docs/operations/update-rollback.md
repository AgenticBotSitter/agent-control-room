# Update and rollback (operator guide)

Every release records `revision` and `previousRevision` in its manifest, so the
rollback target is always explicit. Keep the previous release's checkout (or at
least its manifest) until the new one passes its own preflight + smoke test.

## Update

```sh
cd control-room
git fetch origin && git checkout <new-exact-sha>
CI=true pnpm install --frozen-lockfile
node scripts/build-vps.mjs
node scripts/release/build-release.mjs --revision <new-sha> \
  --previous-manifest <path-to-previous-dist-release/manifest.json> \
  --out dist-release-<new-short-sha> --overwrite
node scripts/release/verify-artifact.mjs --artifact dist-release-<new-short-sha>
node scripts/release/preflight.mjs --configuration /home/operator/control-room-config.mjs \
  --port <port> --artifact dist-release-<new-short-sha>
# stop the service, point it at the new tree, start, smoke-test (below)
```

Smoke test after start: owner login works, one project page renders, no error
in the first 60 seconds of logs. Any failure → roll back immediately, do not
debug forward on the live host.

## Rollback

1. Stop the service (`systemctl --user stop control-room`, or SIGTERM the
   supervised process and confirm exit).
2. Point the service/start command back at the previous checkout + artifact
   (the `previousRevision` recorded in the new manifest).
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
