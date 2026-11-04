# b5-transport-digest-binding status

DONE

New test "B5 transport file digest binds exact private bytes" covers matching/omitted pin acceptance, wrong and stale pin refusal (B5_DEVICE_QUALIFICATION_CHANGED) and digest-before-JSON precedence. Comparison-removal mutant failed at the wrong-pin assertion; restored selected 1/1, full device module 74/74, tsc exit 0. Implementation commit 549c034 on base d33ffca (parent 2e91e86). Details: docs/cloud-tasks/b5-transport-digest-binding-findings.md.

## Setup used
- Node v22.23.4.
- `npm ci` exit 1 (no package-lock.json; repo pins pnpm) → `pnpm install --frozen-lockfile` exit 0.
- `apt-get install -y postgresql-17` exit 100; adding PGDG repo failed (key fetch HTTP 403). Used PostgreSQL 16 (`PG_BIN=/usr/lib/postgresql/16/bin`); these tests use no native PostgreSQL.
- `builder` user already existed; tests ran via `runuser -u builder --`; ownership restored to root before Git.
- Secret scan 0 findings; private-name guard SKIP (no list).
