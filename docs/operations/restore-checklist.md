# Restore checklist (PostgreSQL authoritative, R2 files/backups)

State split (accepted): PostgreSQL holds transactional coordination (projects,
tasks, queue, approvals, results). R2 holds files and backups. This checklist
is a procedure, not evidence — initial each step in your install log as you
complete it against YOUR host.

## Before first live start

- [ ] PostgreSQL 17 reachable; role from the operator config exists with the
      least privilege the config requires. (Role/migration commands are
      Codex-reviewed before use — do not invent them here.)
- [ ] `tests/private-pg-driver.test.ts` and `test-pg17-restore.ts` reviewed so
      you know what driver/restore behavior the release expects.
- [ ] R2 bucket reachable with the backup prefix your config names; a test
      object round-trips (write → read → delete).
- [ ] `preflight.mjs --configuration … --port … --artifact …` exits 0.

## After any restore (database restore, host move, rollback with data work)

- [ ] `verify-artifact.mjs` passes on the artifact you are starting.
- [ ] Service starts; owner login succeeds; one project page renders.
- [ ] Queue depth sane (`pg-boss` tables, not guesses) and recent completions
      match pre-stop state; no duplicate worker pickup after restart.
- [ ] A file uploaded before the stop downloads byte-identical after.
- [ ] First new task completes end-to-end (propose → simulate → revise) before
      the host is accepted back into use.

## Never

- Never restore PostgreSQL and R2 from different points in time without
  reconciling (result rows point at R2 keys — a split-brain restore orphans
  files or references).
- Never delete the live data directory or bucket to "make a restore cleaner".
- Never run a restore against the live host without a verified backup taken
  immediately before (manifest revision + timestamp logged).
