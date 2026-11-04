# b5-restart-outcome-matrix status

DONE

Reason: added 11 `B5 restart outcome matrix` tests (first command 399/400/401/403/409/422/499/500/throw; prior accepted Confirm then 400/409). Focused run 16/16 pass (baseline 5/5); whole device module 84/84 pass, 0 skipped; `tsc --project tsconfig.vps.json --noEmit` exit 0. All three copied-graph mutants (`< 500` -> `<= 500`, `>= 400` -> `> 400`, drop `!alreadyActed`) failed exactly their intended named assertions; restored copy 16/16 green; real source unchanged. Implementation commit: 6c98225. Details: docs/cloud-tasks/b5-restart-outcome-matrix-findings.md.

Scans: secret scan files=2 findings=0; private-name guard SKIP (no list configured; configured=0/scanned=0); `git diff --check` clean; only allowlisted paths changed.

## Setup used

| Command | Exit |
| --- | --- |
| `npm ci` | 1 (EUSAGE: repo has `pnpm-lock.yaml`, no `package-lock.json`) |
| `pnpm install --frozen-lockfile` (pnpm 11.19.0, pinned packageManager; repo's own lockfile) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (not available) |
| PGDG apt key fetch | 22 (HTTP 403 from network policy); repo entry removed again |
| `apt-get install -y postgresql-17` (retry) | 100 |
| `id builder` | 0 (already existed; no useradd needed) |

- Node v22.23.4. PostgreSQL: newest installed 16 (`/usr/lib/postgresql/16/bin`); not used — this task needs no native PostgreSQL and none was started.
- Checkout not chowned to `builder`: the task requires running as the current worker uid with no ownership handoff, and there was no PostgreSQL work to run via `runuser`.
