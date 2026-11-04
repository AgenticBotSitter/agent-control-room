# selfcheck-split-selector status

DONE

The mutation-lane self-check now enforces the same selection and enabling-flag rules for the split `--test-name-pattern VALUE` spelling as for the equals form, including repeated occurrences (union, as Node does). The new regression failed before the fix (split-form zero match exited green) and fails again against the old equals-only extraction in a scratch copy; final runs are green (selected 1/1, full file 13/13, lane-coverage guard and tsc exit 0).

- Base: e6b4a137e494a286af7d56797d8e3e8c0d73e46f (implementation base 5416f85b632b7654f3201b4e99413393fa99091b)
- Implementation commit: aa661adc7b3130b4928a9f718b516d580da93cd3
- Findings: docs/cloud-tasks/selfcheck-split-selector-findings.md

## Setup used

- Node v22.23.4; dependencies via `pnpm install --frozen-lockfile` (exit 0) because `npm ci` exits 1 without a package-lock.json.
- PostgreSQL 17 could not be installed (distro: no package, exit 100; PostgreSQL apt repository blocked by egress policy). Used PostgreSQL 16.15, PG_BIN=/usr/lib/postgresql/16/bin. No cluster was started by this task.
- Existing `builder` account; tests ran via `runuser -u builder --`; checkout ownership restored to root before Git.
- Private-name check: SKIP (no list available).
