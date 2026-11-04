# b5-start-digest-schema status

DONE

The controller-start digest reader in the test file now validates all seven required pins at runtime (no cast) and keeps
extra digest-only commitments such as `transport`. The red run had 7 expected failures against the original reader. The focused
run passes 12/12, the broader run 16/16 and `tsc` VPS exits 0. The `settings`-optional mutation in a copied graph was killed by its
deletion vector. Details: `docs/cloud-tasks/b5-start-digest-schema-findings.md`.

## Setup

- Node v22.23.4 (preinstalled).
- `npm ci` -> exit 1 (EUSAGE: the repo has no package-lock.json; it ships `pnpm-lock.yaml` and pins pnpm 11.19.0).
- `pnpm install --frozen-lockfile` (preinstalled pnpm 11.19.0, repo lockfile) -> exit 0.
- PostgreSQL: not used. The task requires no native PostgreSQL, cluster or PG_BIN, and it forbids starting one. No PostgreSQL
  was installed or built, the `builder` user was not created and no PG17 checks were run.
- Tests ran as the worker's current uid, as the task file says.
