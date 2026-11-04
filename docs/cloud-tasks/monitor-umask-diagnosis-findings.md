# monitor-umask-diagnosis findings

Result: **hypothesis reproduced and fixed** with a fixture-only change.

## Bases

- Published base / starting HEAD: `dca33ff3c13ac02f0ae61ebfef6deecdfd13a509` (parent `2e91e867c20cb5a0ab8b8ddff41402f75c9f4041`, verified).
- Output branch: `cloud/monitor-umask-diagnosis`.

## Changed files

- `tests/improve-control-room-loop-monitoring.test.tsx`: in "B3b dynamic file digest and path refusal", the final public-mode fixture now runs `chmod(f.file, 0o644)` after `writeFile(..., {mode:0o644})` and asserts `stat(f.file).mode & 0o777 === 0o644` before `assert.throws(() => f.monitor.assertAvailability())`. `chmod` and `stat` were already imported. No refusal assertion was removed or weakened. The test does not set the process umask, and production code is unchanged.
- `docs/cloud-tasks/monitor-umask-diagnosis-findings.md`: this file.

## Environment and setup deviations

- Node v22.23.4. User `builder` already existed.
- Dependencies: the repo has `pnpm-lock.yaml` and no `package-lock.json`, so `npm ci` exited 1 (EUSAGE). I used `pnpm install --frozen-lockfile` (pnpm 11.19.0, the repo's `packageManager`), which exited 0.
- **PostgreSQL 16.15 was used instead of 17.** `/usr/lib/postgresql/17` was missing. `apt-get install -y postgresql-17` exited 100 (package not found). Adding the PGDG apt repository failed because the key download returned HTTP 403 through the egress proxy, so I removed that apt source again. Every test run used `PG_BIN=/usr/lib/postgresql/16/bin`. All other parts of each command were unchanged from the task file.
- The test runs used `chown -hR builder:builder` on the checkout, and `chown -hR root:root` restored root ownership afterwards.

## Mode experiment (task-owned synthetic files in `.test-tmp/umask-probe`, as builder)

| umask | `writeFile(p, ..., {mode:0o644})` lstat | after `chmod(p, 0o644)` |
|---|---|---|
| 022 | 0644 | 0644 |
| 077 | **0600** | 0644 |

## Before fix (named test)

| umask | exit | tests/pass/fail/skipped/cancelled | notes |
|---|---|---|---|
| 022 | 0 | 1/1/0/0/0 | ~8 s |
| 077 | 1 | 1/0/1/0/0 | `AssertionError: Missing expected exception.` at test.tsx:168:84 (the final 0644 `assert.throws`). This is the expected control failure. |

The failure is on the predicted assertion and the fixture file is 0600, so the 077 failure is proven to come from the fixture inheriting the umask. The fixture never actually exercises the public-mode refusal under 077, which is why no exception is thrown. It is not a production regression.

## After fix

| run | umask | exit | tests/pass/fail/skipped/cancelled | secs |
|---|---|---|---|---|
| named test | 022 | 0 | 1/1/0/0/0 | 4 |
| named test | 077 | 0 | 1/1/0/0/0 | 4 |
| full monitoring file | 022 | 0 | 27/26/0/1/0 | 72 |
| full monitoring file | 077 | 0 | 27/26/0/1/0 | 68 |
| `tsc --project tsconfig.vps.json` | n/a | 0 | n/a | 34 |

The single skip in the full file is the existing "B3b reviewed A2 monitoring contract" skip: `Requires reviewed A2 monitoring pins in R; integration unproven.` It has nothing to do with this task.

## Cleanup

- The probe directory was removed and `.test-tmp/` is empty.
- No `builder` processes were left running.
- Fixture teardown was handled by the existing `t.after` hooks.

## Unrun steps and limits

- The full suite was not run under umask 077 before the fix. The named test already isolates the failure.
- The historical collection-tick flake was not investigated, as the task scope requires.
- All runs used PostgreSQL 16, not 17.
- Privacy: the private-name check ran without a list and is a SKIP, not a full pass. The lead must run the configured CI privacy checks.

## Scans (after restoring root ownership)

- `scanTrackedSecrets` on the 2 changed files: findings=0, exit 0.
- `check-private-names.mjs` with no list: SKIP ("no list configured"), exit 0.
- `git diff --check`: exit 0.
