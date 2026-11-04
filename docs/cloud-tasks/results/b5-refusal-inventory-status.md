# b5-refusal-inventory status

DONE

The refusal-detail drift test now uses a TypeScript AST inventory over the helper, controller and host modules, with
pinned literal, nonliteral and no-detail expectations. The new regression `B5 refusal producer inventory rejects
uncovered details` was red against the old extractor (it missed the host literal and the helper bare identifier) and is
green now. 11 memory-only mutations each fail their intended assertion. The selected command passes 4/4, the full
module 153/153, and `tsc -p tsconfig.vps.json` exits 0. Runtime files are unchanged.
Details: `docs/cloud-tasks/b5-refusal-inventory-findings.md`.

Setup: Node v22.23.4. `npm ci` exit 1 (repo has only pnpm-lock.yaml), so `pnpm install --frozen-lockfile` exit 0.
PostgreSQL 17 not installable (apt exit 100, PGDG key 403), so the fallback was PG_BIN=/usr/lib/postgresql/16/bin
(16.15), which this task did not use. `builder` already existed. The checkout was chowned to builder for tests and back
to root for Git. The private-name guard was a SKIP because no list was configured.
