# b8-named-presets evidence — PLAN

Phase: PLAN. No product code was written or run; product tests are not required in PLAN.

## Environment and setup (scheduled worker step 4)

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 1 | EUSAGE: no package-lock.json; the repository's lockfile is `pnpm-lock.yaml` (`packageManager: pnpm@11.19.0`) |
| `pnpm install --frozen-lockfile` | 0 | installed from the repository's own lockfile |
| `apt-get update` | 0 | |
| `apt-get install -y postgresql-17` | 100 | package not in distribution repositories |
| fetch apt.postgresql.org signing key / add PGDG repo / `apt-get install -y postgresql-17` | 22 / — / 100 | proxy returned 403 for www.postgresql.org; PGDG list removed afterwards |
| list https://ftp.postgresql.org/pub/source/ (source build route) | 56 | proxy CONNECT 403 (network policy) |
| `/usr/lib/postgresql/16/bin/postgres --version` | 0 | `postgres (PostgreSQL) 16.15` — fallback only; no DB checks were run in PLAN |
| `useradd -m builder` | n/a | user already existed |
| `chown -R builder <checkout>` | 0 | |

Node: v22.23.4. PostgreSQL 17 was NOT obtained; all DB qualification in the spec (§9 P1–P12) is pending and labelled PG17-later for any machine without PG17.

## Base verification

| Command | Exit | Output |
|---|---|---|
| `git rev-parse HEAD origin/cloud-base/b8-named-presets` | 0 | both `1828b4474a6caa5a90b22ff09f849e26c633ed99` |
| `git merge-base --is-ancestor 412d0c149fe8e272c491900d7a9164f80ecb612a HEAD` | 0 | source is ancestor |
| `git log --oneline -2` | 0 | `1828b44 docs: plan B8 named presets chunk`, `412d0c1 test(b7): P71 consumers remove 0309 …` |
| `git status --short` (before writing) | 0 | clean |

## Interface/path lookups (all exist on base unless marked)

- `src/web/v1/loop-policy-compose.ts` (`parseLoopSettingsV1`, `composeLoopSettingsV1` exported; `encode` NOT exported, line 36).
- `src/web/v1/loop-policy-service.ts`, `loop-policy-http.ts`, `loop-provider-service.ts`, `loop-provider-http.ts`, `loop-roster-service.ts`, `loop-roster-check.ts`, `session-authority.ts`, `private-request-budgets.ts` (`default: 8192`).
- `src/web/v1/private-node-handler.ts:80-87` `editPut`; factories at 239/254/262/299; `macLocalMode.allowDelete: true` (68).
- `db/migrations/0305…0309`, `db/down/0305…0309`, `db/roles/private_web_roles.sql:322-334`, `db/roles/production_table_grants.sql:212-222`.
- `deploy/postgres/migration-ledger.json`, `deploy/postgres/desired-grants.json`, `src/web/v1/private-database-preflight.ts:93` pin, `src/updater/v1/policy/release-schema-digest.json`.
- Catalog counts `tests/improve-control-room-desk-postgres.test.ts:402,630` (264), `tests/improve-control-room-desk.test.ts:722` (255).
- package.json scripts verified present (node script lookup, all OK): `test:improve-control-room`, `test:improve-control-room-postgres`, `test:postgres-production`, `test:private-postgres-production-boundary`, `check`, `check:demo`, `build`, `check:migrations`, `check:test-loaders`, `test:test-loaders`, `check:test-quarantine`, `test:loop-policy:real`, `test:improve-control-room-loop-providers-browser`. `scripts/run-tests-with-quarantine.mjs` and `scripts/check-private-names.mjs` exist.
- NOT on base: `src/web/v1/loop-selection-*`; any `loop_selection` / `loop-selection` text in src, db, private-app, tests (U81/U82 predecessors missing).

## Helpers

| Role | Scope | Findings | Disposition |
|---|---|---|---|
| Spec helper (Explore, read-only) | transport, migration/grant/pin/count files, scripts, browser callers | facts; noted outer `editPut` lacks a loop-roster PUT alternative (existing roster panel PUT likely 405 through Node transport — not run; outside D01a scope, reported to lead) | cited lines re-opened and confirmed by the mini-lead |
| Claude plan reviewer (read-only, spec r1) | spec vs task and code | HIGH 2, MEDIUM 5, LOW 3 | all 10 accepted and applied in r2 (below) |

Plan-review findings (r1 → r2):
- F1 HIGH `last_result`/`selection_text` CHECK passes on missing keys (NULL) → added `?&` required keys and `(...) IS TRUE`.
- F2 HIGH envelope arithmetic assumed short roster names; roster has no length bound → explicit per-field byte bounds and recomputed worst case; boundary tests.
- F3 MEDIUM identity row `FOR UPDATE` serializes same-identity writers (session-authority.ts, confirmed) → P11 uses ≥4 owner identities and a post-preflight barrier; G2b added.
- F4 MEDIUM G2 non-deciding with two version guards → G2 disables both.
- F5 MEDIUM Mac-local allows DELETE at transport (confirmed line 68) → N2 expectation split by factory.
- F6 MEDIUM family rule is eligibility → D9 revised: save + stale `final_shares_builder_family`.
- F7 MEDIUM catalog lacked direct project FK → added.
- F8 LOW G4 expectation 409 not 404 → fixed.
- F9 LOW code points vs UTF-16; read-path name/hash integrity → fixed, P3 widened.
- F10 LOW compose export is a shared-writer file; precommit line reference → listed; reference corrected.

Open findings: none (HIGH 0 / MEDIUM 0 / LOW 0 open).

## Document checks

| Command | Exit | Result |
|---|---|---|
| `node scripts/check-private-names.mjs <five result docs>` | 0 | SKIPPED: "no list configured (not a GitHub Actions run)"; no denylist available in this environment |
| bounded public-text grep over result docs for home/workstation paths, email addresses, session URLs, token prefixes, private-key headers, `password=`/`token=` | 1 | no matches |
| `git diff --check` | 0 | clean |
| `git status --short` | 0 | only `docs/cloud-tasks/results/` untracked (allowed files) |
| direct inspection of all five results | — | spec §0–§12 present; every task item 1–8 mapped (§1, §2, §3, §4, §5–6, §7, §8–9, §9/§11); status last line checked |

The lead retains full privacy qualification before publication.
