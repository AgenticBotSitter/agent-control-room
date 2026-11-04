# linux-b5-lanes-verification status

DONE (with PostgreSQL 16 caveat)

Reason: seven-file B5 lane green in 3/3 serial rounds (335 tests, 321 pass, 0 fail, 0 cancelled, 14 gated skips each); mutation partitions 1 and 2 each exit 0 with `selected=13/13 total=26 overlap=0 complete=true` and all 26 probes baseline/mutant/restored green. Cluster bodies ran on PostgreSQL 16.15, not 17 — a PG17 rerun is still needed. Details: docs/cloud-tasks/linux-b5-lanes-verification-findings.md.

Setup used:

- `npm ci` → exit 1 (no package-lock.json; repo uses pnpm-lock.yaml)
- `pnpm install --frozen-lockfile` → exit 0
- `apt-get update` → 0; `apt-get install -y postgresql-17` → 100 (not in distro repos)
- PostgreSQL apt repository key fetch → 403 from network policy (exit 2); repository entry removed; install retry → 100
- Used `PG_BIN=/usr/lib/postgresql/16/bin` (PostgreSQL 16.15)
- `builder` account already existed; `chown -hR builder:builder` checkout → 0; tests run via `runuser -u builder --`
- `node scripts/build-vps.mjs` → 0
- ownership restored with `chown -hR root:root` → 0
