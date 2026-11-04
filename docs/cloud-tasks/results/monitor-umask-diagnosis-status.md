# monitor-umask-diagnosis status

**DONE**

The umask 077 failure was reproduced. Under 077, `writeFile(..., {mode:0o644})` creates a 0600 file, so the named test failed with `Missing expected exception` on its final public-mode assertion. The fix is fixture-only: an explicit `chmod(0o644)` followed by a mode assertion. After the fix, the named test and the full monitoring file both pass under umask 022 and 077 (27 tests: 26 pass, 1 skip that was already there). `tsc` exits 0. Details are in `docs/cloud-tasks/monitor-umask-diagnosis-findings.md`.

Base `dca33ff`, fix commit `2e7d8a6`.

## Setup used

| step | exit | note |
|---|---|---|
| `npm ci` | 1 | No `package-lock.json`; the repo uses a pnpm lockfile. |
| `pnpm install --frozen-lockfile` | 0 | pnpm 11.19.0 |
| `apt-get update` | 0 | |
| `apt-get install -y postgresql-17` | 100 | Package not found. |
| PGDG repository key download | 22 | HTTP 403 through the proxy. The apt source was removed again. |
| `apt-get install -y postgresql-17` (retry) | 100 | |

- **Fallback: PostgreSQL 16.15**, using `PG_BIN=/usr/lib/postgresql/16/bin`.
- User `builder` already existed (`id builder` exit 0).
- `chown -hR builder:builder` and later `chown -hR root:root` both exited 0.
- Node v22.23.4.
