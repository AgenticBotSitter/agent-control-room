# candidate-null-down status

BLOCKED (partial)

Reason: the PGlite regression `B4 retained null sections refuse 0305 down atomically` passes on the real 0305 down. It fails as intended (expected `23514`, got none) on the scratch NOT VALID-only control, and passes again after restoration. The full PGlite candidate suite passes 53/53, and `tsc --project tsconfig.vps.json` exits 0.

The native test `B4 native retained null sections refuse 0305 down atomically` is written but could not run. Only PostgreSQL 16 was available, and production session qualification requires PostgreSQL 17. The existing native baseline test fails the same way. A PostgreSQL 17 rerun is needed.

Setup used:
- `npm ci` exited 1, because the repository has no npm lockfile.
- `pnpm install --frozen-lockfile` exited 0.
- `apt-get install postgresql-17` exited 100.
- Adding the PostgreSQL apt repository exited 22 (proxy 403).
- PostgreSQL 16.15 was used, with `PG_BIN=/usr/lib/postgresql/16/bin`.
- The `builder` user already existed.
- Node v22.23.4.

Details: `docs/cloud-tasks/candidate-null-down-findings.md`.
