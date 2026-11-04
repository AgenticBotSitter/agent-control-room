# release-fixture-cleanup status

DONE

Reason: both release fixture consumers register cleanup immediately after root allocation. Selected regression red (2 tests, 0 pass, 2 fail: `outside/assembly: exactly one cleanup registered`, 0 !== 1) then green (2/2); full two-file run 13/13; `tsc --project tsconfig.vps.json` exit 0; zero leftover fixture roots. Base `53f883da0f81725248116c53087ef13f1ee27085` (HEAD^ `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`); implementation commit `a2ba739fa9b025b24e513a3c5e41bee67d143d04`. Details: `docs/cloud-tasks/release-fixture-cleanup-findings.md`.

Setup used:

- `npm ci`: exit 1 (no npm lockfile); `pnpm install --frozen-lockfile` with the repo's `pnpm-lock.yaml`: exit 0.
- `apt-get update`: 0; `apt-get install -y postgresql-17`: 100; PostgreSQL apt repository key download: 22 (HTTP 403). Fallback `PG_BIN=/usr/lib/postgresql/16/bin` (PostgreSQL 16.15); no PostgreSQL used by this task.
- `builder` user already present; checkout chowned to builder for tests (exit 0) and back to root before Git (exit 0).
- `node scripts/build-vps.mjs` as builder: 0 (real assembly needs generated `dist-vps/`).
- Node v22.23.4. Private-name guard: SKIP (no list in public clone).
