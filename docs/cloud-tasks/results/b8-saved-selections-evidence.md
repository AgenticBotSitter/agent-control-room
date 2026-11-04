# b8-saved-selections — PLAN evidence

Environment:
- scheduled cloud worker, Linux, Node v22.23.4;
- branch `cloud/b8-saved-selections`;
- delivery base `cloud-base/b8-saved-selections` at `337cca3d24d589195f3e49f1db0b6bcbd3a7fc8c`.

Git ran with a per-command `-c safe.directory=<checkout>` because the checkout is owned by user `builder`. Global git config is unchanged.

## Setup (worker step 4)

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 1 | `EUSAGE`: there is no package-lock.json. The repository's own lockfile is `pnpm-lock.yaml` (`packageManager: pnpm@11.19.0`). |
| `pnpm install --frozen-lockfile` | 0 | Installed from the repository lockfile, "Done in 14.3s". |
| `ls /usr/lib/postgresql/` | 0 | `16` only; there is no 17 initdb. |
| `apt-get update` | 0 | |
| `apt-get install -y postgresql-17` | 100 | "Unable to locate package" in the distribution repositories. |
| `apt-get install -y curl ca-certificates gnupg` | 0 | |
| fetch the apt.postgresql.org signing key from www.postgresql.org | 22 | HTTP 403 from the egress proxy |
| fetch the key from apt.postgresql.org | 56 | CONNECT rejected by the egress proxy (host not allowed) |
| reach `https://ftp.postgresql.org/pub/source/` | 56 | CONNECT rejected by the egress proxy, so a source build was impossible |
| fallback (c): `/usr/lib/postgresql/16/bin/postgres --version` | 0 | `postgres (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)` |
| `id builder` | 0 | the user already exists |
| `chown -R builder <checkout>` | 0 | |

A pgdg apt source list was written while trying the official repository. It is unusable because the key was not fetched, and apt ignored it. No PG17 check was run. PLAN runs no database checks; every DB qualification is **PG17-later**.

## Base and inputs

| Command | Exit | Output |
|---|---|---|
| `git ls-remote --heads origin cloud/b8-selection-to-start` | 0 | empty at selection time; the claim push was then rejected ("reference already exists") because another worker claimed it first |
| `git checkout -B cloud/b8-saved-selections origin/cloud-base/b8-saved-selections && git push origin cloud/b8-saved-selections` | 0 | new branch |
| `git rev-parse HEAD origin/cloud-base/b8-saved-selections` | 0 | both `337cca3d24d589195f3e49f1db0b6bcbd3a7fc8c` |
| `git merge-base --is-ancestor 412d0c149fe8e272c491900d7a9164f80ecb612a HEAD` | 0 | ancestor |
| `git rev-list --count 412d0c1..HEAD` | 0 | `1` |
| `git diff --stat 412d0c1 HEAD` | 0 | only `docs/cloud-tasks/b8-saved-selections.md` and `docs/cloud-tasks/playbook/CLOUD-LEAD.md` changed |
| `git rev-parse origin/cook/b7-providers` | 0 | `412d0c149fe8e272c491900d7a9164f80ecb612a`, matching the task |
| `git status --short` (before edits) | 0 | empty |
| `git diff --stat origin/cloud-base/b8-selection-to-start origin/cloud/b8-selection-to-start` | 0 | empty. U81's branch holds only its task commit `fa673cc8f81c…`, so U81 is unreleased. |

## Cited path, interface and script lookups

Each item was opened or grepped directly. Line numbers are at the delivery base.

**P71 composition and policy**
- `src/web/v1/loop-policy-compose.ts`: `parseLoopSettingsV1` at 12, the layer `overrides` refusal at 15, `composeLoopSettingsV1` at 41.
- `src/web/v1/loop-policy-service.ts`: `snapshot` 117, `assertSnapshot` 120, `check` 124, `view` 129 (`loop_policy.read`), `put` 138 (`loop_policy.manage`, high), `recordInputSources` 184, `copyInputSources` 190.
- `src/web/v1/loop-policy-http.ts`: routes at 8 and 23.
- `db/migrations/0306_control_loop_policy.sql`: the three tables and the intake `settingsEdits` CHECK.

**Signed readers and the journal**
- `src/improve-control-room/v1/service.ts`: `#loopInput(tx, root, version?)` at 441, `loopBridgeTransaction` at 663, `loopBridgeLineage` at 682.
- `src/web/v1/improve-control-room-loop-service.ts`: binding at 643-650 with `localVersion` from the latest input, claim insert at 657-659, `settingsText: local.input.settings_text` at 660.
- `src/improve-control-room/v1/schemas.ts:180-183`: intake carries `settingsEdits`; Start is `{expectedVersion, expectedRevision, runLinkId}`.
- `db/migrations/0302_control_loop_improvement_commands.sql`: indexes at 95-103. There is no project/owner index.
- `db/migrations/0301_control_loop_improvement_lineage.sql:104`: the requests `(tenant_id, project_id, created_at DESC, id DESC)` index.

**Adapter, candidates and providers**
- `src/web/v1/improve-control-room-loop-adapter.ts`: `loopProviderRouteSchemaV1` 108, `resolveStartRoute` hook 701-727, `commandFile` and `invoke`, checker spawn. The last two are reported by the helper and spot-checked at 701-735.
- `src/improve-control-room/v1/loop-candidate-wire.ts:35`: `overrides: { allowSameFamilyReview, allowStandardFinal, … }`.
- `src/web/v1/loop-provider-service.ts:11,149`: the route schema consumer.

**Roster**
- `src/web/v1/loop-roster-service.ts`: row fields include `family`, `efforts`, `default_effort` and `on_off`.
- `src/web/v1/loop-roster-check.ts`: the external `cr models check`.

**The three limits**
- A repository-wide search for `max_questions_per_step`, `max_sendbacks`, `max_escalations`, the camelCase forms and `after_limit` found **NOT FOUND** outside the task file.
- `QUESTION_LIMIT` appears only as a gate or finalization code.
- No `cr.py`, `models.tsv` or settings defaults file is tracked in the repository.

**Selection modules and UI**
- `ls src/web/v1 | grep loop-selection` and `ls tests | grep loop-selection` both returned nothing.
- No `.tsx` consumes loop-policy.

**Required script names** (checked with `node -e` over `package.json`), all FOUND:
- `test:improve-control-room`, `test:improve-control-room-postgres`, `test:postgres-production`, `test:private-postgres-production-boundary`
- `check`, `check:demo`, `build`
- `test:loop-policy:real`, `test:improve-control-room-loop-browser`
- `test:improve-control-room-loop-bridge-mutations`, `test:improve-control-room-loop-lineage-mutations`
- `test:ci-component-shards`

Also FOUND: `scripts/run-tests-with-quarantine.mjs` and `scripts/check-private-names.mjs`.

## Helpers

| Role | Scope | Findings | Disposition |
|---|---|---|---|
| Spec helper A, read-only | Start, journal and signed-input readers | Factual inventory, no defects. Gaps: no accepted-Start-per-owner reader; existing verifiers require the latest version (`#candidateLineage`); result `created_at` is the append time. | Citations spot-checked at service.ts 441/663/682, loop-service 640-661, schemas 180-183, 0302 indexes. Built into spec 3.2 and D3/D5. |
| Spec helper B, read-only | The three limits | Limits absent from the repository; worker and checker external; counters are only in a synthetic test ledger. | Built into spec 1, 4 (item 6), prerequisite P-L and D8. |

HIGH/MEDIUM/LOW counts: none, because no review helper was run (D9). The Sol spec gate is pending.

## Documentation checks

| Command | Exit | Result |
|---|---|---|
| `git diff --check` (results staged intent-to-add) | 0 | |
| `node scripts/check-private-names.mjs` | 0 | "Private-name check skipped: no list configured". Recorded as **SKIPPED**: no denylist is supplied in this environment. |
| Bounded public-text scan over the result files: a case-insensitive `grep -E` for workstation home and root paths, API-key, secret and token assignments, private-key headers, session identifiers or URLs, and account-identifying terms. The pattern is not reproduced here so the scan does not match itself. | 1 | no matches |

Allowed writes: only the five result documents and the status `.progress` file under `docs/cloud-tasks/results/`. No executable code was written. `QUEUE.md` is untouched.

The five results were inspected directly. Required sections are present: spec items 1-8 mapped, dependencies, REQUIRED commands, and cloud versus withheld scope. Product tests were not run (PLAN).

## Cleanup

No processes were started apart from the installs. No database cluster was created. The checkout is clean after the commit.
