# linux-loop-component-soak findings

Verification only. No source, test, script, package or lockfile changes. Only this file (and the worker status file) were added.

## Bases

- Starting HEAD (published base): b13a06ee37dba4c95b8e4484d1586d8e2d943164
- Parent (source branch cook/b5-first-website): 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041 (verified `HEAD^`)
- Output branch: cloud/linux-loop-component-soak
- Changed files: docs/cloud-tasks/linux-loop-component-soak-findings.md

## Environment / deviations from the task text

| Item | Task expectation | Actual |
|---|---|---|
| Node | 22 | v22.23.4 |
| Dependencies | pre-provisioned | not present; installed by the worker with `pnpm install --frozen-lockfile` (repo lockfile, pnpm 11.19.0), exit 0. `npm ci` first exited 1 (no package-lock.json). |
| PostgreSQL | 17 at /usr/lib/postgresql/17/bin | 17 unavailable (`apt-get install postgresql-17` exit 100; PGDG apt repository blocked by the sandbox network proxy, HTTP 403). Used **PostgreSQL 16.15**, `PG_BIN=/usr/lib/postgresql/16/bin`. The only change to the task command is that `PG_BIN` value. |
| builder user | exists | existed |
| Host | — | 4 vCPU, ~15 GiB RAM, memory-cgroup limited sandbox |

Build: `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/build-vps.mjs` → exit 0, 19 s.

## Soak result

Loop command: the task's exact 7-file loop under `umask 022`, `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1`, `--test-concurrency=1`, `--test-timeout=600000`, with only `PG_BIN` changed to 16.

| Round | Exit | Elapsed | tests | pass | fail | skipped | cancelled |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 1214 s (duration_ms 1214114) | 284 | 280 | 1 | 3 | 0 |
| 2–5 | not run | — | — | — | — | — | — |

Rounds 2, 3, 4 and 5 were **not run**: the loop stopped at the first failure as required.

The 3 skips are the existing qualification-dependent skips (not failures):
- `B3b reviewed A2 monitoring contract` (requires reviewed A2 monitoring pins)
- `B3a reviewed A2 recovery contract` (requires reviewed A2 pins and production ownership capability)
- `B5 tools intake contract consumes the product admission envelope and replays its receipt` (requires supplied tools contract path)

## First failure (regression candidate, not an injected/expected control failure)

- File: `tests/improve-control-room-loop-bridge.test.ts` (file-level `not ok 3`)
- Failure: `failureType: 'testCodeFailure'`, `signal: 'SIGKILL'`, `exitCode: ~`, file duration ≈ 303 s.
- Cause: **kernel memory-cgroup OOM kill** of the bridge test child process. Kernel log (bounded):

  ```
  oom-kill:constraint=CONSTRAINT_MEMCG ... task=node,uid=<builder>
  Memory cgroup out of memory: Killed process (node) total-vm:624933752kB, anon-rss:13908520kB
  ```

  i.e. the single bridge test process grew to ~13.9 GB anonymous RSS.
- Last passing bridge test reported: `B5 working branch: ENOBUFS-size untracked tree refuses as dirty before intake`.
- In-flight test (next registered test in file order, not reported): `B5 working branch: dirty refuses plainly before intake and survives reopen` (first iteration of the state loop near line 1530). The node runner gives no per-test result for a SIGKILLed child, so this attribution is by file order; the growth could also have begun at the end of the preceding ENOBUFS test (800 long-named untracked files, Git status output > 64 KiB).
- No JavaScript stack exists: the process was killed by the kernel, not by an assertion.
- Bridge tests reported `ok` before the kill: ~110 subtests (desk + bridge, as streamed); the remaining bridge tests after the in-flight one did not run in round 1. The other five files (attention, recovery, monitoring, finalization, candidate) then ran and passed.

Assessment: a real, reproducible-in-this-environment problem (unbounded memory growth in the bridge suite's B5 working-branch area), not a timing flake of the historical `5 !== 6` kind. The historical monitoring flake did not reproduce in 1 round (monitoring file passed). Only one round was observed, so neither the OOM rate nor the monitoring flake rate is quantified beyond 1/1 and 0/1 respectively.

## Cleanup evidence

- After the round: `pgrep postgres` → 0 processes (0 before the run); no remaining processes owned by builder.
- Shared memory segments (`ipcs -m`): 0.
- Because the OOM kill bypassed fixture teardown, one fixture directory was left: `.test-tmp/b5-working-branch-<random>` (a fixture Git repository, 184 KiB, 27 files). It was task-owned scratch and was removed manually; `.test-tmp` is now empty. This leftover is itself evidence that the in-flight test was a B5 working-branch test.
- `/tmp/tsx-<builder uid>` is the tsx compile cache, not a fixture; left in place in the disposable container.
- No raw log bundle retained in Git.

## Limitations

- PostgreSQL 16.15 instead of 17 (17 not installable here); PG-version sensitivity not ruled out, though the failure is a Node process OOM, not a database error.
- Dependencies were installed by the worker from the repo lockfile rather than pre-provisioned.
- Memory limit is the sandbox's cgroup (~15 GiB); the task forbade artificial pressure and none was added. A machine with more RAM might mask the growth rather than avoid it.
- Single round only; no repeated-run statistics.
- Private-name check run without a list (SKIP), as stated by the task.

## Suggested next step for the lead (not done here; no source changes allowed)

Run `tests/improve-control-room-loop-bridge.test.ts` alone with `--test-name-pattern` for the ENOBUFS test and then the `dirty` working-branch test, under `/usr/bin/time -v` or `--max-old-space-size`, to isolate which test grows memory (likely an unbounded Git output read or retry loop in the working-branch preflight).

## Scans (after restoring root ownership)

- Secret-pattern scan on the changed file: `secret-scan files=1 findings=0`, exit 0.
- Private-name guard without a list: SKIP ("no list configured"), exit 0. Not a full privacy pass; CI's configured check must run before integration.
- `git diff --check`: exit 0. `git status --short`: only this findings file.
