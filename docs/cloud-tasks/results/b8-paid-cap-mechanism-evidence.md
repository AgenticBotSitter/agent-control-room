# b8-paid-cap-mechanism — evidence (PLAN)

## Environment

| Item | Value |
|---|---|
| Machine | Scheduled cloud worker (throwaway Linux container) |
| Node | `v22.23.4` |
| pnpm | `11.19.0` (the `packageManager` pin) |
| Phase / budget | PLAN, 2 h; start 2026-11-04T14:20Z, deadline 16:20Z |
| Base | `cloud-base/b8-paid-cap-mechanism` `d0a1c8a3895d5dc283c8fdf2b01ed41f14790d9b` |
| Source base | `cook/b7-providers` `412d0c149fe8e272c491900d7a9164f80ecb612a` |
| First result commit | `2538f57` (WIP docs) |

## Setup

| # | Command | Exit | Note |
|---|---|---|---|
| S1 | `npm ci` | 1 | `EUSAGE`: there is no `package-lock.json`. The repository's own lockfile is `pnpm-lock.yaml`. |
| S2 | `pnpm install --frozen-lockfile` | 0 | "Done in 16.9s using pnpm v11.19.0" |
| S3 | `ls /usr/lib/postgresql/` | 0 | Only `16` is present. PostgreSQL 17 was **not** obtained, because PLAN does no database work. Every database check is labelled PG17-later in spec §9.2. No PG16 result is claimed. |
| S4 | `id builder` | 0 | The user already exists, so no `useradd` was needed. No PostgreSQL work was run. |

## PLAN checks (commands run from the checkout; all real output)

| # | Command | Exit | Decisive output |
|---|---|---|---|
| E1 | `git status --short` | 0 | before the first commit: `?? docs/cloud-tasks/results/` only |
| E2 | `git rev-parse HEAD origin/cloud-base/b8-paid-cap-mechanism origin/cook/b7-providers` | 0 | `d0a1c8a3…14790d9b` ×2, then `412d0c14…2a` |
| E3 | `git merge-base --is-ancestor 412d0c1… origin/cloud-base/b8-paid-cap-mechanism` | 0 | the source base is an ancestor |
| E4 | `git log 412d0c1..origin/cloud-base/b8-paid-cap-mechanism` | 0 | one commit: `d0a1c8a docs: define cloud mini-lead gates and paid-cap PLAN chunk` |
| E5 | `node -e` lookup of `check`, `check:demo`, `build`, `check:test-loaders`, `check:test-quarantine`, `check:migrations`, `test:product-shell`, `test:improve-control-room`, `test:improve-control-room-postgres`, `test:components`, `test:ci-component-shards` | 0 | all `true` |
| E6 | `ls` of the cited scripts, sources and `tests/helpers` | 0 | all present: `scripts/check-test-lane-coverage.mjs`, `scripts/check-private-names.mjs`, `scripts/ci/check-test-loaders.mjs`, usage/provider/service/database/budget/harness sources |
| E7 | `grep -n 'paidExecutionReady: false' …loop-adapter.ts` | 0 | `701:` |
| E8 | `grep -n 'spawn(c.interpreter' …loop-adapter.ts` | 0 | `376`, `535`, `615`, `665` |
| E9 | `grep -n '24\*3600_000' …loop-provider-service.ts` | 0 | `79:` (stale rule `>`) |
| E10 | `grep -n 'async revalidate' …loop-provider-service.ts` | 0 | `148:` |
| E11 | `grep` for `priceAtV1` / `providerPriceDigestV1` | 0 | `48:` and `52:` |
| E12 | `grep` for `costForUsageV1` / `usageCostPlanV1` / `usageMeasurementSchemaV1` | 0 | `100:`, `71:`, `30:` |
| E13 | `sed -n 556,566p .github/workflows/ci.yml` | 0 | "Component lanes shard 1" runs `test:product-shell` (`:563`), with `PG_BIN /usr/lib/postgresql/17/bin`; `:558` is the shard guard |
| E14 | `grep -rn 'capNano\|priceRowDigest\|providerVersion\|servedModelId' src \| wc -l` | 0 | `0`: the pin is not implemented on this base |
| E15 | `ls src/usage/v1 tests \| grep -c paid-run` | 1 | `0`: the proposed NEW names are free (grep exits 1 on no match) |
| E16 | `node -e` check that `test:components` contains `test:product-shell` | 0 | `true` |
| E17 | `node --import tsx <scratch script calling priceAtV1>` | 0 | 06:59Z→3000, 07:00Z→6000, 07:01Z→6000, 06:00Z→3000, 06:02Z→3000; `getUTCDay(2026-03-08)` = 0 (Sunday). This confirms the T8 DST expectation on the real function. |
| E18 | `node scripts/check-private-names.mjs` | 0 | `private-name check skipped: no list configured (not a GitHub Actions run)`. **This is not a pass.** The denylist is unavailable here, and the lead must run the full privacy gate before integration. |
| E19 | `grep tsconfig.vps.json include` / `tsconfig.json include` | 0 | the VPS config lists explicit entries (no `src/usage/v1`); `tsconfig.json` includes `**/*.ts` |
| E20 | `git diff --check` | 0 | no whitespace errors (run before the final commit) |
| E21 | Bounded public-text scan of the five result docs (see the status progress log) | — | details in the final section below |

Product tests were not run, because PLAN is specification-only.

## Helpers and dispositions

| Helper | Scope | Findings and disposition |
|---|---|---|
| Spec helper (Claude, Explore, read-only) | Harness execution seams, provider/price shapes, durable facilities, lanes, existing fakes | **Facts.** The harness and engine are opaque subprocesses. There is no per-call hook. The pin is not implemented. `budget-store` is in micro-USD. `loop-providers` runs on PGlite. No billable fake provider exists. **Verification.** The mini-lead re-checked the key facts: adapter :376 and :701, `owner-trusted-local-cli-execution.ts` :82/:94/:101, `budget-store.ts` :9/:16, and E14. |
| Spec reviewer (Claude, general-purpose, read-only) | Spec r1 against the task, the playbook and the code | 2 HIGH, 6 MEDIUM, 7 LOW. All were verified against the code (`ci.yml:563`, `prices:95`/`:38`, the strict usage schema, adapter :706-713, publish :112) and **all were resolved in spec r2**. The reviewer independently recomputed T1, T2, T4, T5, T8 and T13, and all matched. No finding remains open. |

### Disposition of each finding

| # | Severity | Finding | Resolution in r2 |
|---|---|---|---|
| 1 | HIGH | Self-asserted consent | Server-persisted single-use consent (spec §3.1–3.2 rule 3, D11; T9 rows) |
| 2 | HIGH | Stop/block race between reserve and dispatch | Dispatch re-check under the mutex (spec §5.2, §6.1 step 7, D12; T13b) |
| 3 | MEDIUM | Cache semantics | `cacheReporting` modes (D4 amendment; T14b) |
| 4 | MEDIUM | Strict usage mapping and ids | Exact mapping; valid synthetic ids |
| 5 | MEDIUM | Invariant contradiction | `settledAccounted` plus a separate `excessNanoUsd` |
| 6 | MEDIUM | Deadline anchor and skew | Deadline measured from `t0`; `clockSkewMs`; T8 skew case |
| 7 | MEDIUM | Model filtering | Rows filtered per model; T8 isolation case |
| 8 | MEDIUM | Resolver completeness | Added to P3; `unpaid` runs get no executor |
| 9 | LOW | Citations | Fixed |
| 10 | LOW | T5 table | Fixed |
| 11 | LOW | Digest meaning | D10 deviation; digests recomputed |
| 12 | LOW | Integer bounds | Bounds stated; BigInt `inCeil` |
| 13 | LOW | Reasoning | Refused |
| 14 | LOW | Formatter cost | Cached formatter |
| 15 | LOW | Clock / T13 cap | Single clock; cap set |

## Allowed writes check

The final result commit changes only these files under `docs/cloud-tasks/results/`: the spec, decisions, owner-questions, evidence and status files, plus `status.md.progress`. It contains no executable code and changes nothing in `QUEUE.md`. The final status commit records `git show --stat` as the check.

## Cleanup

There were no long-lived processes. Both helper agents finished. Scratch files stayed outside the repository.
