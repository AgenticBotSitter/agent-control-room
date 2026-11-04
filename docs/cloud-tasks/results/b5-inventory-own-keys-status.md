# b5-inventory-own-keys status: DONE

Refusal inventory counters now use Maps with own-key normalized output. The `__proto__` vector was red before the fix
(`Missing expected exception: helper __proto__ literal`), all 30 prototype-name/ordinary-control vectors across
helper/controller/host are green after it, and restoring only the old counters in a task-owned copied graph reproduces the
same assertion. Focused run 2/2 pass, broader run 4/4 pass, `tsc -p tsconfig.vps.json` exit 0.
Details: docs/cloud-tasks/b5-inventory-own-keys-findings.md.

- Base: bcaad43dd3f1415f768acc7e8424366b3d35cba2 (parent 5a891a6083a7a125cf7afbe51265d22554df2a07). Implementation commit: 8811d15.

## Setup used

| Command | Exit |
|---|---|
| `npm ci` | 1 (no npm lockfile; repo uses pnpm) |
| `CI=1 pnpm install --frozen-lockfile` (repo's pnpm-lock.yaml) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not found) |
| fetch PostgreSQL apt repository key | 22 (proxy 403); repository not added |
| `id builder` | 0 (user already present) |

PostgreSQL 16 is the newest available; not used, since this task requires no native PostgreSQL. The checkout was not
chowned to `builder`: there was no PostgreSQL work, and the task requires running as the current worker uid without
ownership handoff. Node v22.23.4. Private-name guard ran without a list (explicit SKIP).
