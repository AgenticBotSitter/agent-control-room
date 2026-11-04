# b5-device-file-custody status

**DONE**

The two new readB5DeviceFileV1 tests pass. Mutant results: removing both size checks fails the 33-byte assertion, and removing only `s.nlink === 1` fails the hard-link assertion. Removing only the stat-size guard is not caught, because the post-read size check still refuses the file. This was an expected defence control, not a kill. Full device file: 75/75 pass. tsc: exit 0. Implementation commit: d59fb54c0b7784c430d2028108a3c505e3f8ae58 on base 31a7553ff5dd3a270889e6716ace2ec043964efd (parent 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041). Details: docs/cloud-tasks/b5-device-file-custody-findings.md.

## Setup used

| Command | Exit |
|---|---|
| `npm ci` | 1 (no npm lockfile; repo uses pnpm-lock.yaml) |
| `pnpm install --frozen-lockfile` (pnpm 11.19.0) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not found) |
| add PGDG apt repo key via curl | 22 (403 from proxy); repo entry removed again |
| `apt-get install -y postgresql-17` (retry) | 100 |
| `id builder` (already existed, no useradd) | 0 |
| `chown -hR builder:builder` checkout / later `chown -hR root:root` | 0 / 0 |

- PostgreSQL used: **16** (`PG_BIN=/usr/lib/postgresql/16/bin`). The device test file starts no cluster.
- Node v22.23.4.
- Secret scan: files=2, findings=0. Private-name check: SKIP (no list configured locally). CI privacy checks are still required.
