# b8-paid-cap-mechanism — evidence

Current phase: BUILD, CAP-A. See the current BUILD section below. Earlier PLAN commands and environments are historical, not current product qualification.

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
| Spec reviewer (Claude, general-purpose, read-only) | Spec r1 against the task, the playbook and the code | 2 HIGH, 6 MEDIUM, 7 LOW. All were verified against the code (`ci.yml:563`, `prices:95`/`:38`, the strict usage schema, adapter :706-713, publish :112) and **all were resolved in spec r2**. The reviewer independently recomputed T1, T2, T4, T5, T8 and T13, and all matched. That was the r2 reviewer disposition only; the later Sol gate found P1–P4 and r3 superseded those contracts. |

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

## Local specification revision r3 (2026-11-04)

Starting result: 61ea85a3bf5d73606dff7127816851e77c5dc9ec; source: origin/cook/b7-providers 412d0c149fe8e272c491900d7a9164f80ecb612a. Local plan branch; no push. Earlier cloud environment/setup/helper dispositions are historical and superseded where r3 changes the contract.

Independent specification gate: HIGH 2 / MEDIUM 2 / LOW 0. P1 now requires runtime store-issued consumed-consent provenance, P2 corrects all cache-mode ceilings, P3 binds a private request/options snapshot and full replay identity, P4 adds bounded CAP-A/B continuations and independent code/attack/CI/Linux/wrapper obligations. New deciding tests cover authentic/cloned/fabricated/unconsumed handles before ledger/send, none-mode actual 7500000 versus reserved 6000000/excess 1500000, exact boundaries, buffer mutation and changed output/stream replay. Q1/Q2 values are test-only and cannot authorize production/tiny probe. The paid digest/identity/one-pair and exact candidate handoff to later U83a/paid consumers is explicit.

No implementation or product/unit/PG17/provider/tools/browser/device/Linux tests were run locally; no dependency installation or real provider/model process. Documentation/source audit results follow after completion. Full private-name denylist check is NOT RUN (none supplied); bounded public-text inspection is a separate limited check. Independent re-review pending.

### r3 completed documentation checks

- `git fetch origin` → `RESULT fetch exit=0`; disposable local plan branch created from the exact cloud result head (worktree creation exit 0). The first fetch needed a metadata permission retry; no push or other task network operation.
- `python3 .test-tmp/b8-fix1-doc-audit.py` (from the parent clone) → `PATHS=96 SCRIPTS=24 SYMBOLS=70 UNRESOLVED=0`, `RESULT documentation-audit exit=0`. Existing source paths/symbols/script names and line bounds checked against origin/cook/b7-providers; absent planned files/scripts classified NEW/deferred. Initial audit-harness path/prose/generic-method matching false positives were corrected before this passing result; no product behavior was changed.
- Independent contract arithmetic → reserve=6000000, actual=7500000, excess=1500000. Timing model: +1-second fresh-intent claim checks freshness; identical +8-second result and omitted-intent copied claim do not. These are contract calculations, not executed product/PG tests.
- Source subtree comparison against the pinned base reports no implementation difference. Allowed-write audit finds exactly this ID's five result Markdown documents. Both status final lines are exactly `Status: PLAN-READY`; P1–P4/S1–S7 have explicit r3 Revision history dispositions; balanced fences and bounded public-text privacy checks pass. The denylist-dependent privacy gate is still NOT RUN.
- `git diff --check` passed before this evidence update; final whitespace/allowed-path check is repeated for the handoff. Current independent spec re-review is pending; no product green gate or reviewer CLEAN is claimed.

Historical revision handoff: r3 was subsequently committed by the lead as `fba6ae026`. The supplied independent DeepSeek specification re-review is CLEAN for this chunk, with three LOWs addressed in CAP-A. The earlier identity-blocked handoff is superseded; current build commit status is recorded below.

Final handoff: both plan branches retain exactly five changed result Markdown files. Staging and staged whitespace checks completed with exit 0; final repeat follows the last documentation update. Worktrees are retained because commit identity authorization is unresolved; they are not removed with uncommitted work. No owned process remains.

## Current BUILD: CAP-A (2026-11-04)

Native environment: Node v22.23.4, darwin/arm64; existing dependencies only. Start 2026-11-04T20:54:16.477367+00:00, deadline 2026-11-05T02:54:16.477367+00:00, update 2026-11-04T21:06:00.780956+00:00, elapsed 11.7 minutes. Starting and retained HEAD: `fba6ae026cbd7be1178df1844e15288caebeb53b`, branch `cook/b8-paid-cap`. The lead-supplied DeepSeek re-review is CLEAN for this spec revision. No product code review verdict is claimed.

Implemented CAP-A per §8.4: two modules, two tests and synthetic fixture helper. No executor, ledger, journal, scripted transport or driver was added. No shared registration file was changed. CAP-B is explicitly after independently reviewed CAP-A, so this is not the whole paid-cap mechanism and earns no spending-cap qualification. Native paid readiness remains false; T17 uses the actual adapter constructor with inert files and closes it without starting an engine.

- Admission uses opaque consumed handles authenticated by a private WeakMap, frozen private records and a private admission WeakSet. Single use, exact owner/project/request/settings/claim bindings, cap syntax/range and freshness are exercised. A 20-consume contention test observes 1 winner and 19 replays. This is not a durable/PG ledger contention proof.
- Bounds validate every profile assumption, exact input/output limits, all three cache modes and stale/unknown prices. Price scanning caches per-zone formatters and takes minute-window maxima across skew/DST using only the selected provider and served model. Money remains BigInt.
- The attached three LOWs are addressed: 27 maximum scan instants; any checkedAt refresh invalidates consent at unchanged rates (documented and tested); old r3 commit and review-status claims are explicitly superseded.

### Red/green and entry-point proof

The initial minimal compilable seams ran 3 tests, all failing at intended behavioral assertions (missing authority admitted, stale price accepted, none input ceiling bypassed). No missing import/setup failure is counted as red. This is NEW-seam red evidence, not an existing-product failure claim. Original red snapshots remain ignored scratch text only. Final CAP-A suite: 58 pass, 0 fail, 0 skipped. Actual CAP-A CLI exercise: `CAP_A_ENTRY_PASS checks=3 authentic=paid cloned=consent_missing maxNanoUsd=6000000 providerRequests=0`. The complete bounded-call driver is CAP-B and was not run.

Guard mutations lived only in throwaway copies and were removed after each probe. Provenance bypass: 55 pass/3 intended fail; none input-ceiling removal: 55/3; subset-validity removal: 57/1; served-model-filter removal: 57/1. Every restored run passes all 58, zero skips. Provenance positive remains valid before cloned/fabricated/unconsumed negatives fail. Guarded source files were never mutated for these probes. Reproduction: `.test-tmp/paid-cap/probe.py <consent-provenance|none-ceiling|subset-validity|model-filter>` reconstructs each disposable copy. Dispatch/cap/identity/Stop/request-snapshot probes belong to CAP-B and are not claimed.

### Adjacent boundary and checks

Historical usage costing/rollups, owner price-file custody, provider schema and provider service behavior remain unchanged: affected command below passes 63 tests with 0 skips. Existing service fixtures use PGlite and are not native PostgreSQL qualification. Both typechecks pass. Loader guard passes; quarantine guard has 0 entries. Product-shell exits 0 with 571 pass/0 fail/3 Chromium-not-provisioned skips, so it is INCOMPLETE against the spec's zero-skip gate. No browser was installed.

The first scratch CI-wiring probe searched for a literal pnpm invocation and failed; source inspection showed the existing serial run-scripts-keep-going runner. Correcting only that assertion yields 2 reachability checks PASS; CI and package files are unchanged. The actual lane guard still fails with exactly 2 unregistered new tests. §8.4 reserves final package registration for CAP-B; this continuation does not silently amend that seam.

`npm run build` exits 1 before compilation: Vite cannot open the temporary bundled config under node_modules/.vite-temp (EPERM through the shared dependency symlink). No dependency/tool installation, write outside the clone or build-script workaround was attempted. npm run executes the unchanged package scripts in place of pnpm run to avoid a shim.

### Commands and real output

| Command label | Exact command | Real final result | Counts |
|---|---|---|---|
| red | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT red exit=1 elapsed=0.42s` | # tests 3; # suites 0; # pass 0; # fail 3; # cancelled 0; # skipped 0; # todo 0 |
| cap-a-green | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT cap-a-green exit=0 elapsed=0.65s` | # tests 58; # suites 0; # pass 58; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-consent-provenance | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/consent-provenance/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/consent-provenance/tests/paid-run-admission.test.ts` | `RESULT guard-off-consent-provenance exit=1 elapsed=0.62s` | # tests 58; # suites 0; # pass 55; # fail 3; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-none-ceiling | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/none-ceiling/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/none-ceiling/tests/paid-run-admission.test.ts` | `RESULT guard-off-none-ceiling exit=1 elapsed=0.62s` | # tests 58; # suites 0; # pass 55; # fail 3; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-subset-validity | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/subset-validity/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/subset-validity/tests/paid-run-admission.test.ts` | `RESULT guard-off-subset-validity exit=1 elapsed=0.61s` | # tests 58; # suites 0; # pass 57; # fail 1; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-model-filter | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/model-filter/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/model-filter/tests/paid-run-admission.test.ts` | `RESULT guard-off-model-filter exit=1 elapsed=0.61s` | # tests 58; # suites 0; # pass 57; # fail 1; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-consent-provenance | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/consent-provenance/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/consent-provenance/tests/paid-run-admission.test.ts` | `RESULT guard-off-consent-provenance exit=1 elapsed=0.6s` | # tests 58; # suites 0; # pass 55; # fail 3; # cancelled 0; # skipped 0; # todo 0 |
| check-demo | `npm run check:demo` | `RESULT check-demo exit=0 elapsed=19.76s` | not a TAP test |
| guard-restored-consent-provenance | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT guard-restored-consent-provenance exit=0 elapsed=0.58s` | # tests 58; # suites 0; # pass 58; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-none-ceiling | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/none-ceiling/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/none-ceiling/tests/paid-run-admission.test.ts` | `RESULT guard-off-none-ceiling exit=1 elapsed=0.56s` | # tests 58; # suites 0; # pass 55; # fail 3; # cancelled 0; # skipped 0; # todo 0 |
| guard-restored-none-ceiling | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT guard-restored-none-ceiling exit=0 elapsed=0.56s` | # tests 58; # suites 0; # pass 58; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-subset-validity | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/subset-validity/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/subset-validity/tests/paid-run-admission.test.ts` | `RESULT guard-off-subset-validity exit=1 elapsed=0.56s` | # tests 58; # suites 0; # pass 57; # fail 1; # cancelled 0; # skipped 0; # todo 0 |
| guard-restored-subset-validity | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT guard-restored-subset-validity exit=0 elapsed=0.55s` | # tests 58; # suites 0; # pass 58; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| guard-off-model-filter | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 .test-tmp/paid-cap/probes/model-filter/tests/paid-run-bound.test.ts .test-tmp/paid-cap/probes/model-filter/tests/paid-run-admission.test.ts` | `RESULT guard-off-model-filter exit=1 elapsed=0.55s` | # tests 58; # suites 0; # pass 57; # fail 1; # cancelled 0; # skipped 0; # todo 0 |
| guard-restored-model-filter | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT guard-restored-model-filter exit=0 elapsed=0.55s` | # tests 58; # suites 0; # pass 58; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| affected-usage | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/usage-cost.test.ts tests/usage-price-table-loader.test.ts tests/usage-cost-authorization.test.ts tests/loop-provider-contract.test.ts tests/loop-providers.test.ts` | `RESULT affected-usage exit=0 elapsed=28.76s` | # tests 63; # suites 0; # pass 63; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| build | `npm run build` | `RESULT build exit=1 elapsed=0.71s` | not a TAP test |
| check | `npm run check` | `RESULT check exit=0 elapsed=16.91s` | not a TAP test |
| lane-coverage | `node scripts/check-test-lane-coverage.mjs` | `RESULT lane-coverage exit=1 elapsed=0.11s` | not a TAP test |
| quarantine | `npm run check:test-quarantine` | `RESULT quarantine exit=0 elapsed=0.21s` | not a TAP test |
| test-loaders | `npm run check:test-loaders` | `RESULT test-loaders exit=0 elapsed=0.84s` | not a TAP test |
| ci-wiring | `node -e 'const f=require("node:fs"); const s=f.readFileSync(".github/workflows/ci.yml","utf8"); const p=JSON.parse(f.readFileSync("package.json","utf8")); if(!s.includes("pnpm test:product-shell") \|\| !p.scripts["test:components"].includes("test:product-shell")) process.exit(1); console.log("CI product-shell lane reachable: 2 checks PASS");'` | `RESULT ci-wiring exit=1 elapsed=0.06s` | not a TAP test |
| product-shell | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 npm run test:product-shell` | `RESULT product-shell exit=0 elapsed=32.73s` | # tests 574; # suites 0; # pass 571; # fail 0; # cancelled 0; # skipped 3; # todo 0 |
| ci-wiring-corrected | `node -e 'const f=require("node:fs"); const s=f.readFileSync(".github/workflows/ci.yml","utf8"); const p=JSON.parse(f.readFileSync("package.json","utf8")); if(!s.includes("run-scripts-keep-going.mjs test:product-shell") \|\| !p.scripts["test:components"].includes("test:product-shell")) process.exit(1); console.log("CI product-shell lane reachable: 2 checks PASS");'` | `RESULT ci-wiring-corrected exit=0 elapsed=0.08s` | not a TAP test |
| cap-a-entry | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx .test-tmp/paid-cap/entry.ts` | `RESULT cap-a-entry exit=0 elapsed=0.33s` | not a TAP test |
| diff-check | `git diff --check` | `RESULT diff-check exit=0 elapsed=0.29s` | not a TAP test |
| cap-a-final | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | `RESULT cap-a-final exit=0 elapsed=0.7s` | # tests 58; # suites 0; # pass 58; # fail 0; # cancelled 0; # skipped 0; # todo 0 |
| check-demo-final | `npm run check:demo` | `RESULT check-demo-final exit=0 elapsed=24.13s` | not a TAP test |
| final-audit | `python3 .test-tmp/paid-cap/audit.py` | `RESULT final-audit exit=0 elapsed=0.33s` | not a TAP test |
| final-diff-check | `git diff --check` | `RESULT final-diff-check exit=0 elapsed=0.25s` | not a TAP test |

### Commit, review and remaining gates

The progressive staging/commit chain was `git add <five CAP-A files> && git -c user.name='Control Room Worker' -c user.email=worker@localhost commit -m 'test(usage): prove paid admission and bound guards red through new seams'`. `git add` exited 128 with `fatal: Unable to create index.lock: Operation not permitted`; commit was never reached. Per the brief, the lock refusal was not retried or escalated; all work is uncommitted for the lead. No Git identity configuration changed. New commit SHAs: none; retained base SHA is above. Tracked docs and five untracked sources are intentionally retained, so a clean-worktree/committed-candidate gate is not claimed.

No independent code/attack/CI review of a committed CAP-A candidate occurred. The lead-provided pinned Node22 Linux environment/image was not supplied, so required Linux parity is NOT RUN. No alternate reviewer/model CLI was launched. Local guard probes and source inspection do not substitute for those reviews. CAP-B, its executor/restart tests and driver --self-check are NOT RUN because that continuation requires reviewed CAP-A. No real paid provider, production consent endpoint, production ledger or tiny probe is available. PG17-later tests/migrations remain separately authorized production work; no PG server was started. The private-name denylist gate is NOT RUN because no lead list was provided; limited changed-file text audit is recorded separately.

Review packet source digest (uncommitted, not a git SHA): `sha256:2e9c543c48b8a56baf71b97199bb82db26bf1683d2b77ccfed002b8736447efe`.

- `src/usage/v1/paid-run-admission.ts`: `sha256:4d0d3c98a0feb41d51b26b0eeccf764664be48328c47178593a61a24c20cf9b3`
- `src/usage/v1/paid-run-bound.ts`: `sha256:3e660128a6db9e7b77a948e8a91fe8b0000d7db0752afae92352e3b5bb29d39c`
- `tests/helpers/paid-run-fake-provider.ts`: `sha256:cf5f23848d5923a7b069157d37f06663c12f336c193f1de861d872c370021fce`
- `tests/paid-run-admission.test.ts`: `sha256:ca24a32d22bb6a259f7b091d652af41775f7f7b11bf41c8b2ace51e82d2425c5`
- `tests/paid-run-bound.test.ts`: `sha256:150c539f3d7960fb2f77a131a1c3b61e9bb3fbbfe27d1c47ca523acd98972868`

Cleanup: all command sessions completed in the foreground; no listener, engine, provider or PostgreSQL process was started. All per-probe throwaway copies and per-test readiness directories were removed. Ignored scratch retains only reproduction scripts and evidence logs/snapshots, with no background job. node_modules remains its original symlink and is not staged. No downloads, network requests, live-install ports, credential files, keychain operations or real model/provider launches. The allowed-write audit covers exactly the five CAP-A files plus this chunk's spec/evidence/status docs.

Findings drafted: HIGH 0 / MEDIUM 0 / LOW 0 from local build checks; no independent review claimed.

Status: BLOCKED: CAP-A reviews/Linux/commit gates and required build/lane/zero-skip checks incomplete; CAP-B withheld


## CAP-A FIX round (2026-11-04; supersedes the earlier CAP-A handoff)

Baseline: `15431739ec5dddae885bc3fde29206342514c29c` on `cook/b8-paid-cap`. All five findings from the assigned NEEDS-FIX review have local fixes; this statement does not claim an independent CLEAN review. CAP-B remains withheld until that review.

- MEDIUM-1: frozen bounds now carry profileId/cacheReporting and reject mismatched profiles before reading usage. The predicate uses the bound's stored mode. Independent regression: additive usage costs 9000000 at literal 3000/15000 rates against a 6000000 reserve; presenting a subset profile cannot authorize it.
- LOW-1: the spec has been restored byte-for-byte to `fba6ae026`. D16 records the two pure helper export needs for reviewer/lead disposition, plus the interval/refresh clarifications, without editing the reviewed specification to grant approval.
- LOW-2: malformed route resolutions refuse route_unknown instead of throwing. Direct admission and preview are covered, and refusal preserves the capability for a valid retry.
- LOW-3: successful admission synchronously marks its consumed capability in a private WeakSet. Twenty attempts now produce one branded admission/downstream-open opportunity and nineteen consent_replayed refusals. Failed validation does not mark it. Durable CAP-B leases remain a separate obligation.
- LOW-4: expected base/two-window row-set digests, run key and the matching over-ceiling pin digest are fixed literals independently computed by Python hashlib over explicit compact sorted-key JSON. Tests no longer compute expected digests through product helpers. The new committed mutation test reconstructs throwaway copies and checks the intended behavioral assertion for each guard bypass.

Behavioral red runs preceded the fixes (same quarantine wrapper, tsx preloaded and agent CLI blocked):

| Command suffix after the common runner below | Exit | Tests / pass / fail / skipped | Observed defect |
|---|---|---|---|---|
| `--test-name-pattern='FIX MEDIUM-1' tests/paid-run-bound.test.ts` | 1 | 1 / 0 / 1 / 0 | true instead of false for the mismatched cache mode |
| `--test-name-pattern='FIX LOW-2' tests/paid-run-admission.test.ts` | 1 | 9 / 1 / 8 / 0 | shared paidRoute throws for malformed resolutions; empty Set improperly admits |
| `--test-name-pattern='FIX LOW-3' tests/paid-run-admission.test.ts` | 1 | 1 / 0 / 1 / 0 | twenty opens instead of one |

Common runner: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000`.

Final commands and results (full exact mutation child commands and real result lines are retained in the assigned FIX report and its separate progress file):

| Command | Exit | Counts |
|---|---|---|
| `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-*.test.ts` | 0 | 71 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo |
| `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/usage-cost.test.ts tests/usage-price-table-loader.test.ts tests/usage-cost-authorization.test.ts tests/loop-provider-contract.test.ts tests/loop-providers.test.ts` | 0 | 63 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo |
| `npm run check` | 0 | TypeScript, no TAP counts |
| `npm run check:demo` | 0 | TypeScript, no TAP counts |
| `node scripts/ci/check-test-loaders.mjs` | 0 | all TypeScript test invocations preload tsx |
| `node scripts/check-test-quarantine.mjs` | 0 | 0 entries |
| `node scripts/check-test-lane-coverage.mjs` | 1 | exactly 3 unregistered paid-run files, including the new reproducible mutation test; final registration remains CAP-B |
| `git diff --check` | 0 | no whitespace errors |

Reproduce guard evidence with `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-guard-mutations.test.ts`. Each child runs the 70 behavioral tests. Baseline and every restored guard run pass 70/70 with zero skips/cancellations. Every mutant exits 1 at an asserted behavioral failure; the containing mutation test exits 0. Source files stay unchanged, and every disposable directory is removed in finally. The 29 child runs comprise one baseline and fourteen mutant/restored pairs.

| Guard removed | Mutant pass | Mutant fail | Restored pass / fail | Skipped (each) |
|---|---|---|---|---|
| price-staleness | 68 | 2 | 70 / 0 | 0 |
| profile-mode-binding | 69 | 1 | 70 / 0 | 0 |
| none-ceiling | 67 | 3 | 70 / 0 | 0 |
| subset-validity | 69 | 1 | 70 / 0 | 0 |
| model-filter | 69 | 1 | 70 / 0 | 0 |
| consent-provenance | 68 | 2 | 70 / 0 | 0 |
| consume-binding | 69 | 1 | 70 / 0 | 0 |
| admission-binding | 65 | 5 | 70 / 0 | 0 |
| consumed-command | 69 | 1 | 70 / 0 | 0 |
| consumed-run | 69 | 1 | 70 / 0 | 0 |
| invalid-cap | 60 | 10 | 70 / 0 | 0 |
| consume-replay | 62 | 8 | 70 / 0 | 0 |
| admission-replay | 69 | 1 | 70 / 0 | 0 |
| resolution-shape | 63 | 7 | 70 / 0 | 0 |

The earlier uncommitted-candidate/commit-lock status belongs to the preceding BUILD and is superseded by the current FIX report's commit result. This fix adds no executor, ledger, transport, driver, adapter, package or CI change. New test registration is explicitly deferred to CAP-B along with the existing two tests. Production readiness remains false.

Not rerun in this focused fix: Vite build (the prior reviewed dependency-symlink write refusal remains unresolved), product-shell/browser qualification, independent reviews and pinned Linux parity. No production provider/profile, durable PG17 consent or real paid qualification is claimed. Exact final commit SHA and custody audit are in the assigned FIX report.

Commit outcome for this FIX: staging the nine allowed files with `git add` exited 128: index.lock creation was refused (Operation not permitted). Per the brief, no retry or escalation was made and no commit command was reached. No new commit SHA exists; baseline remains `15431739ec5dddae885bc3fde29206342514c29c`. All nine files remain uncommitted for the lead. No Git identity configuration was changed, and node_modules was never included. The pending commit is a custody blocker, independent of the passing local behavior checks.

Status: BLOCKED: git index.lock creation refused; lead must commit fixed CAP-A; CAP-B withheld

## CAP-B continuation — stopped at restart-authority contract gap

Baseline: `cook/b8-paid-cap` at `cc81268c9dfbe35a72fe7f00fbf8e59794b1ab5f` (reviewed CAP-A CLEAN). Native Node `v22.23.4`. No production/provider capability enabled.

The brief requires stopping if the reviewed spec does not match the existing code. The dependent CAP-B implementation is stopped on this exact gap:

- Spec §7.2 T5 requires a ledger-owning child to die and the parent to recover the lease and reopen its journal.
- Spec §5.2 requires `open(admission)`. Spec §3.2 rule 6 requires an authentic admission and exact journal `runKey`, `pinDigest`, and `consentId` bindings.
- Reviewed `paid-run-admission.ts:49,52` keeps issuance in a local Map and allocates each consent ID with `randomUUID()`. Lines 32, 89, 135, and 148 authenticate consumed handles/admissions using private process-local maps/sets; there is no trusted recovery/reconstitution API.
- A parent cannot authenticate a serialized child admission. A fresh genuine parent issuance for the same context/cap has matching run/pin but a different consent ID and must fail `cross_run`. Changing fields on the fresh admission creates an unbranded copy.

A real two-process probe through the existing consent/admission entry points verified five independent assertions: child JSON admission unbranded; parent admission authentic; runKey equal; pinDigest equal; consentId different. Child exit 0, reaped. This establishes the missing recovery authority path; it does not claim a completed ledger or restart implementation. The admission protections are behaving correctly.

Lead action: specify and review a safe recovery/report-only reopen contract or equivalent trusted reconstruction. Public arbitrary mint/import, deterministic consent issuance, weakening consent equality/branding, or keeping the real ledger owner alive outside the killed child would change the contract or weaken T5. None was introduced. No reviewed specification was edited.

Before discovering the blocker, a minimal executable new executor/fake seam was run red: the 5,999,999 cap dispatched instead of refusing a 6,000,000 bound; the exact 6,000,000 positive control passed. Temporary new scaffold/test/transport changes were removed on STOP. This was new-seam red evidence, never an old-product enforcement claim. Red sources and the standalone authority probe remain in ignored `.test-tmp/paid-cap-b/` only.

Retained implementation change: append all three reviewed CAP-A test files to `package.json` `test:product-shell`. Existing lane command remains an identical prefix; no file removal, skip, quarantine, CI workflow change, or dependency change. CI still reaches the lane via `.github/workflows/ci.yml:563`; aggregate `test:components` still includes it.

| Exact command (test commands use CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1) | Exit | Counts/result |
|---|---|---|
| `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-executor.test.ts` (temporary red scaffold, subsequently removed) | 1 | 2 tests / 1 pass / 1 intended assertion fail / 0 skipped |
| `node --import tsx .test-tmp/paid-cap-b/restart-authority.ts` (initial scratch probe) | 1 | setup error: relative imports traversed one directory too far; not behavioral evidence |
| `node --import tsx .test-tmp/paid-cap-b/restart-authority.ts` (corrected path depth) | 0 | 5 assertions PASS; real child exited 0 and reaped |
| `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts` | 0 | 70 tests / 70 pass / 0 fail / 0 skipped / 0 cancelled |
| `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts tests/paid-run-guard-mutations.test.ts` | 0 | 71 tests / 71 pass / 0 fail / 0 skipped / 0 cancelled; 18.75 s |
| `node scripts/check-test-lane-coverage.mjs` (initial and final) | 0 | all 934 test files reachable |
| `npm run check:test-loaders` | 0 | all TypeScript test invocations preload tsx |
| `npm run check:test-quarantine` | 0 | valid; 0 entries |
| `git diff --check` | 0 | whitespace PASS |

The mutation harness killed all 14 CAP-A mutants at their expected behavioral assertions and restored 70/70 passing tests after each, with zero skipped/cancelled; original source files remained intact and disposable mutation copies were removed. CAP-B dispatch/cap/Stop/restart mutations remain NOT RUN.

Not run after mandatory specification STOP: CAP-B executor/restart suites and driver --self-check (not implemented), remaining CAP-B attacks, affected usage/provider suites, full product-shell, check, check:demo, build, independent candidate code/attack/CI reviews, or supplied Linux parity. No CAP-B implementation is claimed. Private-name check NOT RUN without a lead-provided list. PG17-later ledger/consent/migration and production qualification remain separate future work; no PostgreSQL cluster or DB-backed test started in this continuation.

R2 residual malformed-context LOW remains unmodified after STOP. Existing mutation-harness registration is addressed. No independent partial-candidate review verdict claimed. Native paid readiness remains false (also asserted by the passing actual-adapter T17 test).

Commit custody: `git add package.json` exited 128 because index.lock creation was refused (Operation not permitted). The chained per-commit worker identity command was never reached; no retry, escalation, config edit, or new commit. Lead must commit any retained changes. HEAD remains the full baseline SHA above. No push, download, external request, real provider/model, paid probe, live install, prohibited port, PG cluster, or listener started. Owned command children completed and were reaped. node_modules remains its unchanged unstaged symlink.


Final custody audit: `python3 .test-tmp/paid-cap-b/audit.py` exited 0 with 15 assertions. Exactly package.json plus this evidence file and status changed; staged index empty; reviewed spec/source unchanged; temporary product scaffold absent; no machine/home paths added. `git diff --exit-code HEAD -- docs/cloud-tasks/results/b8-paid-cap-mechanism-spec.md` exited 0. Final whitespace initially exited 2 for one extra EOF blank line in this evidence file; trimming it made `git diff --check` exit 0. These were documentation-only corrections.

Status: BLOCKED: T5 cross-process journal reopen lacks a trusted admission recovery contract; git index.lock creation refused

## CAP-B round 2 — lead D17 settlement-only recovery (in progress)

This continuation starts at `b973364ab035ae29ef3ea51f3773dade5978cbcf` and supersedes the previous missing-recovery-contract stop. The lead explicitly chose settlement-only reopen without admission or consent. The amendment is confined to spec §7.2 T5 and marked pending review. Existing CAP-A cache-profile D17 is preserved under D19 to avoid the identifier collision.

Initial executable red: public executor ignored a ledger cap refusal and returned completed instead of refused; 1 test / 0 pass / 1 intended ERR_ASSERTION / 0 skipped, exit 1. Implemented green proof includes true ledger-owner SIGKILL after reserve, after dispatch/request receipt and after settlement, supervisor-observed exit and exact-generation lease recovery. Expected recovery amounts are independently fixed at 0, 6,000,000 uncertain and 2,700,000 settled. Settlement handles have no reserve, dispatch or settle method and cannot construct a spending executor; their terminal call refusal is run_recovered_closed. Late/duplicate information cannot lower totals. Mismatched run/pin, corrupt journal, unsafe file/symlink and simultaneous openers refuse.

The 20-caller barrier produces exactly three 6M reservation winners and seventeen cap refusals; observed request ids equal winners. A separate gate proves high-water 2. Sequential, retries, exact boundary, all cache modes/excess, identity, usage, private byte/options snapshots, replay/conflict, streams, Stop races and resource cleanup are exercised.

Guard probes run only in disposable copies. All fourteen inherited CAP-A and eight CAP-B mutants fail named behavioral assertions, with every restore green (71 CAP-A and 53 CAP-B tests at this checkpoint). CAP-B probes remove cap, dispatch order, dispatch-time Stop/block, served-id, private bytes, option identity, recovery maximum and recovery closure protections.

Affected usage/provider regressions: 63/63 pass, exit 0. Driver --self-check: 2 assertions, 0 requests, exit 0. Both typecheck commands pass. Default npm run build exits 1 on dependency-symlink .vite-temp EPERM. A local-only scratch driver runs the same createBuilder/buildApp and build-source write with configLoader runner and cacheDir from PAID_CAP_VITE_CACHE_DIR under .test-tmp: exit 0, full VPS build succeeds. No config or dependency file changed.

Setup corrections are not claimed as behavioral red: first malformed-context test accidentally merged an empty override into a valid context; first mutation baseline exposed unrelocated dynamic import and an IPC checkpoint that could exit while a bare promise awaited. The test was corrected, digest import made static and driver IPC channel explicitly referenced until SIGKILL. First typecheck reported annotations/narrowing errors, corrected before green.

Full product-shell and final custody/commit checks are in progress. Independent code/attack/CI reviews and pinned Node 22 Linux parity are not supplied in this build session; BUILD-READY remains blocked. No production readiness or real-provider qualification is awarded.

Status: BLOCKED: final local checks and independent continuation gates pending

## CAP-B round 2 final local evidence

Final behavioral command: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts tests/paid-run-executor.test.ts tests/paid-run-ledger-restart.test.ts` → exit 0; 131/131 pass, zero skips/cancellations. Includes independently parent-derived trusted run/pin expectations without parent consent, every crash checkpoint, duplicate/late recovery responses, malformed primitive/non-finite journal records and normal-open consent mismatch after close. The CAP-A LOW-1 boundary now returns refusal for nested malformed contexts/digest errors; malformed currentConfig also blocks before reservation.

Final product-shell: `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 PLAYWRIGHT_BROWSERS_PATH=.test-tmp/paid-cap-b-r2/playwright-browsers npm run test:product-shell` → exit 0, 707 tests / 704 pass / 0 fail / 3 skipped / 0 cancelled. The three inherited painted Chromium layout tests (R4U-15, R4U-17, R6PH phone layout) skip because the browser is not provisioned in the allowed worktree path. No skip/quarantine rule was added. All CAP-A/CAP-B behavioral tests and guard mutations execute without skips. Browser layout remains unverified.

All 22 mutation probes are killed at their expected assertions. CAP-A restores 71/71; final CAP-B restores 60/60, zero skips. Final CAP-B mutant results:

| Guard removed | Pass | Fail | Exit | Green restore |
|---|---|---|---|---|
| cap | 55 | 5 | 1 | 60/60 |
| dispatch order | 46 | 14 | 1 | 60/60 |
| dispatch Stop/block | 58 | 2 | 1 | 60/60 |
| served id | 57 | 3 | 1 | 60/60 |
| private body | 58 | 2 | 1 | 60/60 |
| option replay identity | 58 | 2 | 1 | 60/60 |
| recovery max | 57 | 3 | 1 | 60/60 |
| recovery closed | 56 | 4 | 1 | 60/60 |

Affected usage/provider regression command from §9.1 → exit 0, 63/63. Final `npm run check`, `npm run check:demo`, driver `--self-check` (2 assertions, zero sends), loader guard, lane coverage (936 reachable files), quarantine (0 entries), whitespace and 13-assertion scope/custody audit all exit 0. `test:product-shell` retains the former command as an identical prefix and adds only the executor/restart files; CI invocation and dependency symlink are unchanged.

The final exact `npm run build` also exits 0 with local-only `PAID_CAP_VITE_CACHE_DIR` under `.test-tmp` and a scratch Node preload that supplies Vite `configLoader: runner` and `cacheDir` at runtime. This avoids the pre-config bundle write into symlinked node_modules/.vite-temp that made the unmodified invocation fail. Normal buildApp and build-source metadata writing run. No config, build script or dependency edit is committed.

Node v22.23.4, darwin arm64. Independent candidate code/attack/CI and D17 amendment review plus supplied pinned Node 22 Linux parity remain NOT RUN; no BUILD-READY or production green. No native PG cluster was started: ipcs itself was denied, so its pipeline's printed 0 cannot qualify the under-20 native gate. Adjacent tests use unchanged PGlite/scripted fixtures. All owned command/driver/mutation children complete and are reaped; no real login, provider/model, paid probe, listener, live-install operation, push, download or credential read. No unresolved local code findings are claimed by this builder (HIGH 0 / MEDIUM 0 / LOW 0); independent review remains authoritative.

Commit custody: see the final assigned build report and git history; the next operation attempts only these fourteen allowed files with the brief-authorized per-commit identity. A denied index lock leaves the candidate uncommitted for the lead. Production readiness remains false.


Final commit attempt: `git add --` the fourteen allowed files exited 128 because index.lock creation was refused (Operation not permitted). No commit command reached, retry, escalation or identity configuration change. Lead must commit the uncommitted candidate. New commit SHA: none; retained HEAD `b973364ab035ae29ef3ea51f3773dade5978cbcf`. No push. This custody failure does not change the passing local behavior/check evidence above.

Status: BLOCKED: git index.lock refused; independent reviews and pinned Linux parity pending; painted browser layout unverified
