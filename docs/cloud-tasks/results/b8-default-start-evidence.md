# b8-default-start evidence (PLAN)

Phase: PLAN.
Base: `cloud-base/b8-default-start` `174c5da122c2d9bf8ee470e95cb6c5b4dce302b9`. Source: `cook/b7-providers` `412d0c149fe8e272c491900d7a9164f80ecb612a`, which is also the current head on origin.
Environment: Ubuntu 24.04 throwaway cloud container, Node v22.23.4.
No product tests were run, because PLAN needs none.

## 1. Setup (scheduled-worker step 4)

| Command | Exit | Note |
|---|---|---|
| `npm ci` | 1 | EUSAGE: no npm lockfile. The repo pins `packageManager: pnpm@11.19.0` with `pnpm-lock.yaml`. |
| `pnpm install --frozen-lockfile` | 0 | Installed from the repo's own lockfile. |
| `apt-get update` | 0 | |
| `apt-get install -y postgresql-17` | 100 | Package not in the Ubuntu archive. |
| `apt-get install -y curl ca-certificates postgresql-common` | 0 | |
| `/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh` | 0 | The script succeeded, but the index fetch was refused by the proxy (HTTP 403). |
| `apt-get install -y postgresql-17` (after adding the PGDG repository) | 100 | Unable to locate the package. The temporary PGDG source was removed afterwards. |
| `curl https://ftp.postgresql.org/pub/source/` | 56 | Proxy CONNECT 403. Plain HTTP to both hosts also failed (DNS, exit 6). |
| `useradd -m builder` (user already present) / `chown -R builder <checkout>` | 0 / 0 | |

Result: PostgreSQL 17 was **not obtained**. Fallback (c) applies: the newest local version is `/usr/lib/postgresql/16/bin`, which reports `postgres (PostgreSQL) 16.15`. It was not used, because PLAN runs no DB checks. **No PG17 checks were run.** Every future DB check is **PG17-later** unless a BUILD machine has PG17.

## 2. PLAN checks

| Command | Exit | Output |
|---|---|---|
| `git status --short` (before writing) | 0 | clean |
| `git rev-parse HEAD` | 0 | `174c5da122c2d9bf8ee470e95cb6c5b4dce302b9` |
| `git merge-base --is-ancestor 412d0c149fe8… HEAD` | 0 | ancestor; `git rev-list --count 412d0c1..HEAD` = 1 |
| `git ls-remote origin cook/b7-providers` | 0 | `412d0c149fe8e272c491900d7a9164f80ecb612a` |
| existence check of the 27 cited paths (spec §1) | 0 | 27 OK |
| `ls src/web/v1/loop-selection-* private-app/app/loop-selection-panel.tsx private-app/app/loop-presets-panel.tsx` | 2 | absent, which confirms they are dependencies |
| `package.json` script lookups (spec §1 list) | 0 | all present |
| `git diff --check` | 0 | no whitespace errors |
| `node scripts/check-private-names.mjs` | 0 | **SKIPPED**: "no list configured". No denylist is available in this environment. |
| bounded public-text scan (`grep -nEi` for workstation paths, key and token prefixes, private-key headers, session URLs) over the result files | 1 | no matches |
| direct inspection of all five results and the progress file | — | required sections present; the status file's last line is checked before commit |

Predecessor result heads were read for interface alignment only, with nothing merged:
- `cloud/b8-selection-to-start` `43f09d589fcea359653a9d500f706bc61c999db3`
- `cloud/b8-saved-selections` `588c0b7b0d94b59c21d2e1ac2acb2333c85772de`
- `cloud/b8-named-presets` `67fcde7ae52c9a7c9c3f4570a63d1ae96c097a57`

## 3. Allowed writes

Only these files were written under `docs/cloud-tasks/results/`:
- `b8-default-start-spec.md`
- `b8-default-start-decisions.md`
- `b8-default-start-owner-questions.md`
- `b8-default-start-evidence.md`
- `b8-default-start-status.md`
- `b8-default-start-status.md.progress`

No executable code, `QUEUE.md` or other branch was touched.

## 4. Helper review

One Claude plan-review helper ran (read-only) on spec r1, commit `b9b09640992f40acc97d06a497bb31d47df3f2d6`. It found 1 HIGH, 6 MEDIUM and 4 LOW. Before applying fixes, the mini-lead checked the key claims: `loop_selection.` occurs 0 times in the U81 spec; the only status route is `/loop/:requestId/status`; `MIGRATION_NON_BLOCKING_SHAPES.md:75-80` requires `NOT VALID`/`VALIDATE`; demo mode is at `private-node-handler.ts:63`.

| ID | Finding | Disposition (r1.1) |
|---|---|---|
| H1 | Circular FK makes a version-0 save by name impossible as written; "one UPDATE" was wrong | Fixed: §4 explicit statement order, D9, P13, G10 |
| M1 | P7 at version 0 cannot use set or POST `presetId` | Fixed: P7 split by version |
| M2 | Delete versus PUT loser gets 409, not 404 | Fixed: P7 oracle |
| M3 | Replay after a later delete contradicts latest-key semantics | Fixed: §4 idempotency, T6 |
| M4 | `loop_selection.*` actions are not defined by U81 | Fixed: recorded as an unresolved prerequisite that blocks BUILD if absent (§4) |
| M5 | Lookup of an uncertain command by key was invented | Fixed: identical-action resend (§6.8, D10) |
| M6 | String concatenation of edits | Fixed: canonical deep merge (§6.6) |
| L1 | CHECK validation shape and placeholder predicate | Fixed: concrete predicate, `NOT VALID` + `VALIDATE`, generated name |
| L2 | Down lock order | Fixed: both tables locked |
| L3 | Contributor demo mode omitted | Fixed: N2b |
| L4 | Real lane env and skip enforcement | Fixed: §10 |

Open findings: none. This is a helper review only. The Sol spec gate is still pending.

## 5. Cleanup

No processes, clusters or listeners were started. The temporary PGDG apt source was removed. `node_modules` came from the pnpm install and is ignored by git.
