# linux-loop-component-soak status

DONE

Reason: done criteria met via "exact first failure with unrun rounds stated". Round 1 exit 1 (284 tests: 280 pass, 1 fail, 3 existing skips, 1214 s). The bridge suite's test process was killed by the kernel memory-cgroup OOM killer (~13.9 GB RSS) during the B5 working-branch tests. Rounds 2-5 not run. Details: docs/cloud-tasks/linux-loop-component-soak-findings.md.

## Setup used

| Command | Exit |
|---|---|
| `npm ci` | 1 (no package-lock.json; repo uses pnpm-lock.yaml) |
| `pnpm install --frozen-lockfile` (pnpm 11.19.0) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not in distro repos) |
| add PGDG key/repository (curl the key) | 22 (HTTP 403 from sandbox proxy); repository entry removed again |
| `apt-get install -y postgresql-17` after repository attempt | 100 |
| `id builder` | 0 (already existed; no useradd needed) |
| `chown -hR builder:builder` checkout | 0 |
| `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/build-vps.mjs` | 0 |
| 5-round loop (stopped after round 1) | round 1: 1 |
| `chown -hR root:root` checkout | 0 |

PostgreSQL used: 16.15, PG_BIN=/usr/lib/postgresql/16/bin. Node v22.23.4.
