# Non-import inputs for the public contributor candidate

## Follow-up: preview assertions separated and test closure traced

The hosting-metadata and preview-delegation assertions now live in
`tests/sites-preview-build-profile.test.ts`, registered alongside the standalone profile
in both the default `test` and `test:cr14b` scripts. They were moved, not waived.
Standalone profile checks no longer read `.openai/hosting.json` or `vite.config.ts`.

The inventory's optional `--with-compiled-tests` mode reads (does not execute) the
explicit test paths in `test:build:vps`, adds standalone-profile/launcher tests and
traces their imports. At this follow-up it covers 23 test seeds and 377 tracked paths.
All unresolved static paths are nine distinct expected generated server outputs; no
unexpected missing source path was observed. SQL/CSS/runtime reads still need the
manual accounting below. Two inventory diagnostics and seven focused profile/script
checks pass, as does targeted lint. The baseline JSON snapshot remains unchanged.

2026-09-06. Local review findings, not license clearance or a deployment recipe.

## Required files and data boundaries

| Consumer | Input | Public candidate decision |
|---|---|---|
| `src/web/v1/private-assets.ts` | Built `dist-vps/client/_next/static` and `dist-vps/client/favicon.svg` | Both required at startup. Review favicon rights/source; import-only traversal missed it. Do not weaken loader to hide missing assets. |
| `tests/helpers/web-foundation.ts` | Every sorted `.sql` under `db/migrations/` | Preserve migration sequence with test candidate, rather than copying only SQL referenced by imports. |
| `tests/helpers/task-startup.ts` | `db/roles/private_web_roles.sql`, `db/roles/task_coordinator_roles.sql` | Required for two-role compiled task tests. |
| `tests/helpers/managed-native-session.ts` and `managed-startup.ts` | Native session, evidence and result role SQL | Required for synthetic managed-result journeys; no actual operator passwords. |
| `scripts/research/pg-boss-worker-integration.test.mjs` | Native queue producer, recovery and worker role SQL | Required for installed-package queue evidence; uses PGlite, not a server. |
| `scripts/run-private-vps.mjs` | Three compiled server imports and operator `.mjs` module | Build supplies server files. Real operator module stays private; contributor tests inject synthetic resources. |
| `src/persistence/database.ts` | Dynamic `@electric-sql/pglite` package import | Retain pinned development dependency; do not mistake dynamic loading for an arbitrary unneeded import. |
| `src/node-executor/artifact-storage.ts` | Configured artifact root and retained bytes | Include implementation only after review; actual roots/content are runtime data, never source exports. |
| Ready-frontier durable/ready/standing policy stores | Explicit local SQLite paths | Review implementations; do not export pre-existing databases or initialize operator stores as part of contributor setup. |

There are 67 tracked files across the migrations and roles directories at the inspected
baseline. This count does not mean all 67 are production requirements or reviewed safe.
The test helper applies migrations; production fixture preparation explicitly reports
that it does not provision the database, migrate schema or modify roles. Do not turn a
test's setup steps into automatic production startup.

## Contributor verification path versus demo launch

The existing `test:build:vps` command builds and runs compiled tests using disposable
resources. It is a useful starting point for public verification, not an interactive
demo command and not evidence of PostgreSQL or live agent compatibility.

Before publishing contributor setup:

1. Preserve frozen package installation and the required Node version, with no private
   registry or absolute maintainer checkout paths.
2. Include the selected tests' transitive helpers, SQL and fixtures, not just application
   imports. Do not delete regression coverage simply because it needs another helper.
3. Adapt the check scope deliberately: root tsconfig currently includes historical source
   and tests outside the proposed slice. Keep application coverage intact.
4. Separate preview-specific checks: `tests/vps-build-profile.test.ts` still checks the
   original hosting metadata/preview configuration as well as the standalone build.
   Those preview assertions belong in private-preview verification, not a public test
   that forces contributors to recreate excluded hosting files.
5. Supply a documented disposable interactive demo separately. Existing launcher tests
   use in-process injection; they are not a distributable operator configuration template.
6. Rehearse the actual candidate from a clean checkout before publishing any command as
   a verified public setup path.

## Review limits and next batch

This targeted filesystem-call search is not exhaustive detection of every runtime path.
It located a real asset requirement and concrete SQL/test dependencies; aliased calls,
framework-discovered files and complete asset provenance still need review.

The inventory generator now flags the favicon as a required asset with rights pending.
The original inventory snapshot remains historical rather than silently rewritten.
An opt-in research test verifies current tracked-path coverage, hashes, counts, pending
reviews and expected generated/dynamic imports. It does not scan for secrets or grant
publication authority. Next separate the preview-only verification assertions and
collect the contributor test closure before assembling files.
