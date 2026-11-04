# b5-closed-interval-oracle status

DONE

The reversed-interval case 5b is replaced by the dedicated test "B5 defective build end bound
refuses independently". It uses a schema-valid before/equal/after matrix, and no later interval
can cover the build through the latest-owner-action rule.

- The end-clause mutant fails exactly the intended refusal assertion, while the equality and after
  siblings stay green.
- Full file: 153/153 pass. tsc exit 0.
- Implementation commit: 0d1f11c (base 1e12d9d, parent 2e91e86).
- Details: docs/cloud-tasks/b5-closed-interval-oracle-findings.md

## Setup used

- `npm ci`: exit 1 (no package-lock.json). `pnpm install --frozen-lockfile` (repo lockfile): exit 0.
- PostgreSQL 17 was unavailable:
  - `apt-get install postgresql-17`: exit 100.
  - The PostgreSQL apt repository key was blocked by the proxy (exit 22).
  - PG_BIN=/usr/lib/postgresql/16/bin was used (PostgreSQL 16).
- The builder account already existed. The checkout was chowned to builder for the tests, then
  restored to root.
- Node v22.23.4.

## Scans

- Secret scan on the 2 changed files: 0 findings.
- Private-name guard: SKIP (no list configured). The lead must run CI's privacy checks.
