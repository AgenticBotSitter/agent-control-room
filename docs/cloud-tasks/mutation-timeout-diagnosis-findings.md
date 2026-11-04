# mutation-timeout-diagnosis findings

Result: **no reproduction** in 20/20 serial rounds plus one full-file run. No kill EPERM and no 50ms-baseline failure were seen. This is a counted non-reproduction on one Linux clone; it does not prove either failure is permanently fixed.

## Bases

- Starting HEAD (published base, task-doc commit): `134a04c9d89115441f76c5bb2a605177f4f7539f`
- Parent / source SHA (cook/b5-first-website): `2e91e867c20cb5a0ab8b8ddff41402f75c9f4041` (checked: `git rev-parse HEAD^` matches)
- Changed files: this findings file and the worker status file only. No implementation, test, package, lockfile or workflow changes.

## Setup and deviations

| Command | Exit | Note |
|---|---|---|
| `node --version` | 0 | v22.23.4 |
| `npm ci` | 1 | EUSAGE: the repo has no package-lock.json; its lockfile is pnpm-lock.yaml (`packageManager: pnpm@11.19.0`) |
| `pnpm install --frozen-lockfile` | 0 | installed from the repo's own lockfile; `node_modules/.bin/tsx` present |
| `apt-get update && apt-get install -y postgresql-17` | 0 / 100 | package not in the distro archive |
| adding the PGDG apt repo, then `apt-get update` / `install` | 0 / 100 | the network proxy returned 403 for apt.postgresql.org; repo entry removed afterwards |
| PostgreSQL used | n/a | **16** (`PG_BIN=/usr/lib/postgresql/16/bin`, the newest installed). The selected tests and this test file do not start PostgreSQL, so the version has no effect here |
| `id builder` | 0 | the account already existed (uid/gid 30033) |
| `mkdir -p .test-tmp && chown -hR builder:builder "$PWD"` | 0 | |
| `chown -hR root:root "$PWD"` after the tests | 0 | |

The only change to the task's commands was `PG_BIN=/usr/lib/postgresql/16/bin` in place of the 17 path. After each loop round the worker also printed the number of processes owned by builder and the number of `/tmp/mutation-checks-*` fixture directories. These are extra observations; the test commands were not changed. The builder account is used only by this task, so every process it owns belongs to the task.

## 20-round selected loop

Command: the task's loop, run unchanged apart from PG_BIN; `--test-name-pattern` selects the three named tests.

| Rounds | Exit | tests | pass | fail | skipped | cancelled | ms/round |
|---|---|---|---|---|---|---|---|
| 1–20 (each) | 0 | 3 | 3 | 0 | 0 | 0 | 1399–1583 |

- Wall time for all 20 rounds was about 36s. The loop never stopped early.
- Each round selected all three bodies (`tests 3`), so this was not a zero-match pass.
- The timeout test asserts `timed out after 50ms` and that the restored file and git status are clean. It passed every round, so the intended timeout output appeared each time and the baseline never ran past 50ms.
- `EPERM` matches across all logs: 0.
- Fixture directories left in /tmp after each round: 0.

## Cleanup evidence

About 0.3s after each round ended, `ps -u builder` counted 9–11 entries. One extra diagnostic run (run 21: same command, exit 0, 3/3 pass) took snapshots after it exited:

- At +0s and +0.3s: only `[sh] <defunct>` and `[sleep] <defunct>` entries, all in state Z. Their parent was PID 1 and each process group was task-owned.
- At about +1.3s: 7 entries, all still Z.
- At about +3.3s: none.

These entries were zombies, not live processes. The process-group kill had already ended the shells and their background `sleep` children. They were reparented to the container's PID 1, which collected their exit status within about 3s. No task process kept running and no marker file appeared: the `orphan.txt` and `background.txt` assertions passed. 3s after the full run: builder processes 0, fixture directories 0. No signal was sent to any PID by hand.

## Full file

Command: the task's final command (PG_BIN set to 16). Exit 0, elapsed 33s.

`tests 52, suites 0, pass 52, fail 0, cancelled 0, skipped 0, todo 0`. All TypeScript-dependent bodies ran (0 skipped). The three target tests were `ok 30`–`ok 32`.

## Classification

- kill EPERM during termination: **not reproduced** (0 in 21 selected runs plus 1 full run).
- baseline startup over 50ms: **not reproduced**; the timeout always hit the mutated command.
- Arbitrary nonzero exit: none.

## Limitations

- One container on a Linux 6.x kernel, running as an unprivileged builder through `runuser`, with PostgreSQL 16 instead of 17 (not used by these tests).
- Zombies wait briefly for PID 1 to reap them. Whether a different init or subreaper setup changes signal delivery to a group that only holds zombies (the possible EPERM/ESRCH path) was not tested.
- Private-name guard: no list is loaded, so the result is SKIP, not a full privacy pass. CI must run the configured privacy check.
