# PR 510 Linux witness run (diagnosis only)

- Branch under test: `cook/b5-first-website` at `2e91e867c20cb5a0ab8b8ddff41402f75c9f4041`, checked out as `cloud/pr510-linux-witness`.
- PR base in the event: `df5036b0a0f6764d64c4a4b0ab6311ef6f9c63e2`. `origin/main` was 2 commits ahead (`feebc2b`, which merges `5d6a22c` "test: stabilize main component lane fixtures"). CI tests the merge ref, not the head. This run tested the head.
- No product or test code was changed. This file is the only commit.
- Date of run: 2026-11-04 (UTC).

## Verdict

**BLOCKED for PostgreSQL coverage; no product bug found.**

Every lane that needs a real PostgreSQL 17 cluster could not run here. That covers the PG halves of all five component shards, the mutation lanes, affected-tests, the full Mac-local rehearsal, and the owner-browser rehearsal suites. The reason is the egress policy: `apt.postgresql.org`, `www.postgresql.org` and `ftp.postgresql.org` are refused (HTTP 403 at the proxy, or DNS failure). Only PostgreSQL 16 is installed. The only PG17 build that could be reached is an npm-packaged build, and the session's safety check refused to execute downloaded binaries, so it was not used.

Everything that does not need PG17 was run. Each failure in it was reduced to an exact reproduction (table below). Five failures are the same ones PR 510's own CI run already shows (run `41767513780`, attempt 1, same head sha). All five are test or CI-wiring defects, not product defects.

### Failures that block the merge gate (seen in CI and reproduced or explained here)

| # | CI job / step | Symptom | Cause | Class |
|---|---|---|---|---|
| F1 | Component lanes (4), `test:improve-control-room` | `The runner has received a shutdown signal` during `tests/improve-control-room-loop-bridge.test.ts` (last line `ok 307 …`) | Test-harness memory retention. That file (new in PR 510, 1724 lines) holds about 230 MB per test. It grows to about 13.9 GB and is OOM-killed. | **Test bug** (new file; pattern is shared) |
| F2 | Mutation checks (lineage and attention), "Prove authorized loop bridge guards" | `B1b guard-off proofs with restored green checks` `test timed out after 550000ms`; subtests cancelled or never started | The non-PostgreSQL probe group alone needs about 26 × 24 s ≈ 625 s, over the 550 s test timeout. PR 510 added 122 lines of probes. | **Test bug** (budget) |
| F3 | Mutation checks (finalization and website), "Re-run declared guard mutations" | `Mutation checks failed: 1 mutation check(s) failed` on `mutation-checks/cook-c5b.json` | Entry 17's test needs macOS `/usr/bin/lockf`, so its baseline always fails on Ubuntu. PR 510 edited entry 9 of that manifest, which makes CI select the whole manifest. | **Test/manifest bug** (Linux vs macOS), triggered by PR |
| F4 | Component lanes (5), `test:improve-control-room-postgres` | `B4 BASE upgrade preserves signed 0301 and 0302 history`: `git ls-tree … 11fba7c… → fatal: not a tree object` | The test needs historical commit `11fba7c`. The components job checks out with the default `fetch-depth: 1`, so the commit is absent. | **Test bug** (depends on git history CI does not fetch) |
| F5 | Component lanes (1), `test:fleet` | `real PostgreSQL: 0234's down restores the schema exactly, byte for byte`: digest `41d09ffffe47…` ≠ pinned `e07286aaeeb8…` | `PRE_0234_DIGEST` was refreshed for 0303–0305 in `4ea96c0`. Migrations 0307 (PR-only) and 0308 (added after that refresh) also apply after 0234 and change the measured schema. The pin is stale. | **Test bug** (stale pin); not re-measurable here without PG17 |

### Failures seen only here (environment differences)

| # | Where | Symptom | Cause | Class |
|---|---|---|---|---|
| E1 | Shards 1–5, PG halves; attack kit; operations mode; search-path gate | "requires PostgreSQL 17; never skip", `attack_kit_postgres_unavailable`, sentinel "proof ran exactly once" asserts, mutation baselines `invalid_test_command` | No PG17 binaries (by design, these fail rather than skip) | Environment |
| E2 | Shard 3 `test:mac-local-integration`: `claude-`/`codex-`/`hermes-owner-trusted-local-exec.test.ts` | `{status:'cleanup_uncertain', reason:'process_group_still_running'}` instead of `timed_out`/`deadline_exceeded` | PID 1 in this container reaps orphaned zombies about 0.5–2 s late. The product rechecks `kill(-pgid,0)` 50 ms after SIGKILL (`KILL_CONFIRM_MS = 50`), and a zombie still answers. CI shard 3 passed. | Environment (see note N2) |
| E3 | Shard 1 `test:fleet` | R6K-02/03 lock-crash, R6F-04 10 s timeout, R2C-10 `19 !== 20` | Load flakes. All three files pass in isolation. R2C-10 is already fixed on main by `5d6a22c`, which the CI merge ref includes. | Environment/flaky |
| E4 | Shards 4–5: `durable-result-publication`, `linear-pipeline`, `work-batch-owner-approval` | `signal: 'SIGKILL'` (cgroup OOM) | The same retention pattern as F1, under this sandbox's 13.36 GiB memory cgroup. Two of the kills overlapped with diagnosis probes running in parallel. CI passed these files. | Environment-amplified (same root cause as F1) |

## Environment

| Item | CI (`ubuntu-latest`) | This run |
|---|---|---|
| OS | Ubuntu 24.04 runner | Ubuntu 24.04.5, Firecracker microVM |
| CPU / memory | 4 vCPU / 16 GB (+ swap) | 4 vCPU / 15.7 GB, memory cgroup limit 14341881856 bytes (13.36 GiB), no swap |
| Node | `setup-node` 22 (22.13.0 for unified, rehearsal and browser jobs) | 22.23.4 for every lane |
| pnpm | `packageManager` pnpm@11.19.0 | 11.19.0 |
| PostgreSQL | PGDG `postgresql-17` | **not installable** (PGDG blocked); only PG 16 present; `PG_BIN=/usr/lib/postgresql/17/bin` set but empty |
| Chromium | `playwright install --with-deps chromium` | Preinstalled Playwright 1.63.0 browsers (chromium-1243), the same build the project's Playwright resolves; install step not rerun |
| zsh / `ss` / `/private/tmp` | installed / present / created | installed via apt / installed / created `1777` |
| User | `runner` (non-root, sudo) | every lane ran as non-root `builder` via `runuser -u builder --`, checkout chowned to `builder` |
| Locale | `LANG=C.UTF-8` | `LANG=LC_ALL=C.UTF-8` exported for every lane (one browser step restarted to get it) |
| Secrets | none for fork-safe steps; `CONTROL_ROOM_PRIVATE_NAMES` in `quick` | none; token-like variables stripped from every lane's environment; `CI=true` |
| PID 1 | runner init (prompt reaping) | `process_api --firecracker-init` (lazy reaping, see E2) |

Install: `pnpm install --frozen-lockfile --ignore-scripts` → exit 0 (14 s).

Lanes ran keep-going: a failing step did not stop later steps, so every step got a result. CI `quick` steps are fail-fast.

## Lane results

Counts are summed `# tests/pass/fail/skipped` TAP summaries per command. Where a test spawns child `node --test` runs that print their own summary, nested summaries are included, so treat counts as approximate for the mutation and attack-kit lanes. "rc" is the step's exit code.

### Route, PR claims, manifest selection (fast, no dependencies)

| Step | Command | rc | Result |
|---|---|---|---|
| Route | `git diff --name-status origin/main...HEAD` → `node scripts/ci-path-routing.mjs` | 0 | `full=true`, classes `database,docs,frontend,release,server,unknown,workflow`; every lane early |
| PR claims | `GITHUB_EVENT_PATH=<PR 510 event with real body, base df5036b, head 2e91e86> node scripts/ci/check-pr-claims.mjs` | 0 | `PR claims check passed` |
| Mutation manifest selection | `bash scripts/ci/check-mutation-manifest-branch.sh mutation-checks/cook-b5-first-website.json df5036b… 2e91e86…` | 0 | Branch's own manifest absent; selected `cook-c5b.json` and `cook-subscribe-grant.json` (both modified by the PR) |
| Affected planner selection | `node scripts/ci/affected-tests.mjs --github-output df5036b…` | 0 | `all=true needs-pg=true defer-to-full-suite=true` |

### `quick` (Quick checks): all pass

| Step | Command | rc | tests/pass/fail/skip |
|---|---|---|---|
| lane coverage + routing + guards | `node scripts/run-tests-with-quarantine.mjs --test tests/check-test-lane-coverage.test.mjs … tests/runtime-inventory-ci.test.mjs` | 0 | 97/97/0/0 |
| PR claims checker | `node --test tests/check-pr-claims.test.mjs` | 0 | 37/37/0/0 |
| affected-test planner | `node --test tests/affected-tests.test.mjs` | 0 | 57/57/0/0 |
| keep-going runner | `node --test tests/run-scripts-keep-going.test.mjs` | 0 | 11/11/0/0 |
| mutation workflow guards | `node scripts/run-tests-with-quarantine.mjs --test tests/verify-mutation-checks.test.mjs` | 0 | 52/52/0/0 |
| front door | `pnpm run test:front-door` | 0 | 26/26/0/0 |
| reachability | `node scripts/check-test-lane-coverage.mjs` | 0 | `all 940 test files are reachable from GitHub Actions` |
| quarantine | `node scripts/check-test-quarantine.mjs` | 0 | `quarantine list valid (0 entries)` |
| migration numbers | `node scripts/ci/check-migration-numbers.mjs` | 0 | 175 files, no duplicate |
| private names | `node scripts/check-private-names.mjs` | 0 | **skipped**: no list configured (not a GitHub Actions run). In CI this runs with the repository secret. |
| gateway tolerance | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run build && node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/mac-local-fleet-gateway-tolerance.test.mjs` | 0 | 7/7/0/0 |
| test loaders | `pnpm run test:test-loaders && pnpm run check:test-loaders` | 0 | 42/42/0/0 |
| owner paste-file | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:owner-paste-file` | 0 | 55/55/0/0 |
| owner review readiness | `node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/browser/owner-review-readiness.test.ts` | 0 | 2/2/0/0 |
| hygiene | `pnpm run test:hygiene` | 0 | 12/12/0/0 |
| demo type check | `NODE_OPTIONS=--max-old-space-size=4096 pnpm run check:demo` | 0 | tsc clean |
| server type check | `pnpm run check` | 0 | tsc clean |

### Contributor demo, server, articles, migration lint, quarantined: all pass

| Step | Command | rc | tests/pass/fail/skip |
|---|---|---|---|
| demo tests | `pnpm run test:demo` | 0 | 66/66/0/0 |
| demo build | `pnpm run test:build:demo` | 0 | 2/2/0/0 |
| server build and test | `pnpm run test` | 0 | 245/231/0/14 (opt-in device, frozen-config and real-PG17 gates; CI's server job has no PG either) |
| built Mac-local navigation | `pnpm run test:built-mac-local-navigation` | 0 | 1/1/0/0 |
| article build | `pnpm run test:build:articles` | 0 | 1/1/0/0 |
| migration baseline | `npm exec --yes --package=squawk-cli@2.61.0 -- node --test tests/migration-lint-baseline.test.mjs` | 0 | 19/19/0/0 |
| migration changes | `npm exec --yes --package=squawk-cli@2.61.0 -- node scripts/check-migration-changes.mjs --base origin/main --baseline scripts/ci/migration-lint-baseline.json` | 0 | `Squawk passed 22 new migration(s)` |
| quarantined (non-blocking) | `pnpm run test:quarantined` | 0 | no quarantined tests |

### Unified local and multi-computer product tests: pass

| Step | Command | rc | tests/pass/fail/skip |
|---|---|---|---|
| topology and installable product | `pnpm run test:unified-topology && … test:launch-daemons && … test:local-installation && … test:protected-data-transaction && … test:local-hermes-admission && … test:private-local-runtime-assembly` | 0 | 915/837/0/78 (all 78 skips are macOS-native: Apple compiler, `plutil`, `launchctl`, native helpers; same on CI Ubuntu) |
| local adapters and surfaces (50 files) | `node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/claude-code-local-delivery-composition.test.ts … tests/worktree-evidence-web-authorization.test.ts` | 0 | 196/196/0/0 |

### Owner browser journey: non-PG steps pass, rehearsal suites blocked

| Step | Command | rc | Result |
|---|---|---|---|
| loop Start/reopen/Stop | `pnpm run test:improve-control-room-loop-browser` | 0 | Playwright 2 passed |
| intake and owner decisions | `pnpm run test:improve-control-room-loop-attention-browser` | 0 | 4 passed |
| candidate Home/saved request | `pnpm run test:improve-control-room-loop-candidate-browser` | 0 | 8 passed |
| finalization attention | `pnpm run test:improve-control-room-loop-finalization-browser` | 0 | 2 passed |
| first website journey | `pnpm run test:improve-control-room-first-website-browser` | 0 | 2 passed |
| B5 host and candidate regression | `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/first-website-host-status-read.test.ts … tests/improvement-finish-card-probe.test.tsx` | 0 | 44/43/0/1 (the exempted run-24 publication reproduction skip) |
| inbox phone geometry | `pnpm test:inbox-browser` | 0 | 2/2/0/0 |
| owner/adversarial/phone-width rehearsal suites | `pnpm mac:rehearsal up …` + `journey.ts --browser-*-e2e` | — | **not run** (needs PG17) |

### Component lanes (5 shards), run with `PG_BIN` set but no PG17 present

CI command per shard: `node scripts/ci/run-scripts-keep-going.mjs <the shard's units>`, with `PG_BIN=/usr/lib/postgresql/17/bin`. Run here unchanged.

| Shard | rc | Units failed / total | Failing units here | Classification |
|---|---|---|---|---|
| 1 | 1 | 2/15 | `test:r6w-authorization-postgres` (sentinel: PG proof must have run → `TypeError … reading 'isAvailable'` because the web fixture is undefined without PG), `test:fleet` (E3) | E1, E3 |
| 2 | 1 | 2/16 | `test:database` (mutation self-check "guard did not bite" because its concurrency proof skips without PG), `test:result-upload-ingress-postgres` (sentinel) | E1 |
| 3 | 1 | 2/16 | `test:mac-local-integration` (E2 ×3, plus two PG-required cases), `test:result-file-catalog-postgres` (sentinel `0 !== 1`) | E1, E2 |
| 4 | 1 | 2/16 | `test:results` (`durable-result-publication.test.ts` SIGKILL, E4), `test:improve-control-room` (`improve-control-room-loop-bridge.test.ts` SIGKILL, **F1**) | F1, E4 |
| 5 | 1 | 5/20 | `test:coordination` (SIGKILL `linear-pipeline`, `work-batch-owner-approval`, E4), `test:owner-push:postgres`, `test:postgres-production`, `test:improve-control-room-postgres`, `test:result-file-download-postgres` (all "requires PostgreSQL 17; never skip") | E1, E4 |

Raw totals: shard 1 1690/1643/3/43, shard 2 901/742/2/157, shard 3 947/831/6/110, shard 4 1250/1175/2/73, shard 5 1285/1080/78/127 (tests/pass/fail/skip).

Shard extras:

| Step | Command | rc | Result |
|---|---|---|---|
| shard workflow guard | `pnpm run test:ci-component-shards` | 0 | 20/20 |
| search_path catalog gate | `node --import tsx scripts/check-migration-search-path.mjs` | 1 | `search_path_gate_requires_postgresql_17` (E1) |
| Mac-local real pages | `pnpm run test:mac-local-real-pages` | 0 | 80/79/0/1 |
| operations mode | `pnpm run test:operations-mode` | 1 | 24/3/3/18: PG cases skip, their 3 mutation baselines fail (E1) |
| runtime-assembly memory guard | `pnpm run test:private-local-runtime-assembly:memory-guard` | 0 | 35/35 |
| bot dogfood | `pnpm run test:bot-dogfood` | 0 | 3/0/0/3 (all PG-skipped, not proved) |
| attack kit | `pnpm run test:attack-kit` | 1 | 189/119/11/59: all failures need real PG (E1) |
| resource-bound contracts | `node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/resource-bound-native-contract-v2.test.ts tests/resource-bound-codex-contract-v2.test.ts tests/resource-bound-local-start-contract-v2.test.ts` | 0 | 14/14 |
| Phase 2B | `pnpm run test:phase2b` | 0 | 40/40 |

### Mutation lanes

| Step | Command | rc | Result here |
|---|---|---|---|
| authorized loop bridge guards | `pnpm run test:improve-control-room-loop-bridge-mutations` | 1 | 27/20/5/0, cancelled 2, **timed out at 551.7 s** (F2). Two failures are its PostgreSQL probes (E1). |
| finalization/website re-run of `cook-c5b.json` | `node scripts/ci/verify-mutation-checks.mjs mutation-checks/cook-c5b.json` | 1 | 17 of 18 checks pass; entry 17 `baseline failing with exit 1` (F3) |
| lineage, ui, attention, recovery, monitoring, candidate (`:source`, `:ui`, `:sql-*`), finalization, finalization-load, first-website part-1 and part-2, `--anchors-only`, `cook-subscribe-grant.json` | as in `ci.yml` | — | **not run**: the lineage, candidate-SQL and first-website probes need PG17 (`postgres:true` probes, `applyMigrations`). Results without PG would be meaningless. |

### Not run on this machine

| Lane | Reason |
|---|---|
| Affected tests (fast) | 124 PG-gated files; needs PG17. In CI it was still in progress about 2.5 h after it started. |
| Full Mac-local rehearsal | `mac:rehearsal up` needs PG17 |
| macOS updater tests and the macOS `full-gate` entry | macOS-only (`lockf`, Xcode CLT, BSD metadata) |
| Release distribution verification | manual `workflow_dispatch`, macOS-only |
| Runtime inventory publisher proof | not triggered by PR 510 (no path match). Its unit test already ran in `quick`. |
| `full-gate` Linux entries | no-op for this PR: routing put every lane early (`full=true`) |

## Root-cause details and exact reproductions

Unless noted, every command below runs from the checkout root as the non-root user, with `LANG=C.UTF-8` and `PG_BIN` unset.

### F1: bridge test file exhausts memory (CI: runner shutdown in shard 4)

Reproduce:

```bash
node --import tsx --test --test-concurrency=1 tests/improve-control-room-loop-bridge.test.ts
```

Resident memory, sampled every 2 s with the file run in-process (`node --import tsx tests/improve-control-room-loop-bridge.test.ts`): 150 MB, then 1.3 GB, 2.5 GB, 3.6 GB … 12.8 GB, 13.4 GB. The kernel then logs `Memory cgroup out of memory: Killed process … (node) … anon-rss:13941420kB` immediately after `ok 59 - B5 working branch: ENOBUFS-size untracked tree refuses as dirty before intake`. That is roughly 230 MB retained per test. CI's 16 GB runner died at the same point in the same file (last line `ok 307 - B5 superseded A2 waiting_approval …`). Two isolated reproductions and the in-shard run all OOM'd.

Mechanism, narrowed with three probes kept outside the repo:

1. Open and close the shared fixture (`tests/helpers/web-foundation.ts` `fixture()`, a fresh in-memory PGlite plus every migration) in a plain loop. RSS levels off at about 530–800 MB, with or without `--expose-gc`.
2. The same thing as N `node:test` tests, each doing `const f = await fixture(); t.after(() => f.db.close());`. RSS grows linearly: 524, 747, 976 … 3789 MB after 15 tests, even with `gc()` forced in each test.
3. The same `node:test` tests but closing inline (`await f.db.close()` inside the test body). RSS stays flat at about 530–584 MB.
4. The bridge file with `--expose-gc` and a preload that calls `gc()` every second still reaches 13.9 GB and is OOM-killed. The memory is retained, not just uncollected.

Conclusion: `node:test` keeps each completed test's `t.after` hook closure alive. The closure captures the fixture, which keeps the closed PGlite instance and its WASM heap reachable. PGlite's `close()` does not release that heap. Every fixture in a file is therefore retained until the file's process exits.

The pattern (`taskFixture()`/`fixture()` closed in `t.after`) is used throughout the suite. PR 510's new `tests/improve-control-room-loop-bridge.test.ts` has enough tests for the total to pass a 16 GB runner. No product code is involved.

Class: test bug (test-harness retention), surfaced by a test file new in PR 510.

### F2: bridge mutation test exceeds its own timeout

Reproduce:

```bash
pnpm run test:improve-control-room-loop-bridge-mutations
```

The run here lasted 551.7 s.

- `not ok 1 - B1b guard-off proofs with restored green checks`: `test timed out after 550000ms`.
- Twenty-two non-PG subtests finished at about 24.2 s each; `completed command cleanup` was cancelled by its parent, and `sweep outside freshness window`, `bounded sweep page` and `loop key equals legacy key` never started.
- CI shows the same shape: 24 passed, `bounded sweep page` cancelled, `loop key equals legacy key` `parentAlreadyFinished`, total 550.7 s.

At about 24 s per probe, the non-PG group's 26 probes need about 625 s. That exceeds `{timeout:550000}` in `tests/improve-control-room-loop-bridge-mutations.test.ts` even when the PostgreSQL group runs concurrently, and PR 510 added 122 lines of probes. The probes that ran all caught their mutations, so this is a timing budget problem, not a guard that failed to bite. (The two PG probes failed here only because PG17 is absent.)

Class: test bug (timeout budget).

### F3: `cook-c5b.json` entry 17 cannot pass on Linux

Reproduce the failing baseline directly. It fails without any mutation applied:

```bash
node --import tsx --test --test-name-pattern='daemon reads updater.json' tests/updater-protected-config.test.mjs
```

The result is `not ok 1 - the daemon reads updater.json at the production-default path and ignores ambient PG settings`, `error: 'updater_local_lock_refused'`, thrown from `src/updater/v1/fs-safety.mjs:162`. That line handles the error event of `spawn("/usr/bin/lockf", …)`, and `/usr/bin/lockf` does not exist on Linux.

Full check:

```bash
node scripts/ci/verify-mutation-checks.mjs mutation-checks/cook-c5b.json
```

It reports 17 checks passing, then `FAIL: src/updater/v1/updater.mjs — ambient PG variables must not override the root-owned updater configuration: baseline failing with exit 1`, then `Mutation checks failed: 1 mutation check(s) failed`. This is the same summary CI printed.

PR 510 did not change the test, `fs-safety.mjs` or `updater.mjs`. The lockf requirement dates from `771287a`, 2026-10-04. PR 510 changed only entry 9's `find` anchor (commit `7e337fe`, a digest refresh), and that makes `check-mutation-manifest-branch.sh` select the whole manifest on the Ubuntu runner.

Class: test/manifest bug (a macOS-only test in a manifest that CI re-runs on Linux), triggered by the PR's manifest edit.

### F4: candidate upgrade test needs git history that the CI checkout lacks

Reproduce:

```bash
git clone -q --depth 1 file://<checkout> depth1 && cd depth1 && git ls-tree -r --name-only 11fba7c7899319ee0e21e5849bd77f010b1f2cc0 -- db/ deploy/postgres/migration-ledger.json
```

The result is `fatal: not a tree object`, the same error as CI. In this run's own checkout (a shallow clone with about 50 commits of history), `11fba7c` exists and the command succeeds. The `test-components` job's `actions/checkout` has no `fetch-depth`, so it fetches only the merge commit.

The test is `tests/improve-control-room-loop-candidate-postgres.test.ts:343`, "B4 BASE upgrade preserves signed 0301 and 0302 history", which PR 510 added.

Class: test bug, or CI wiring (the test assumes history that its job does not fetch).

### F5: stale `PRE_0234_DIGEST` pin

Evidence, without PG17:

- `tests/fleet-worker-capacity-down-postgres.test.ts` pins `PRE_0234_DIGEST = "e07286aa…"`, refreshed in `4ea96c0` ("Refresh migration test baselines for retained loop candidates"). The comment accounts for 0303–0305 only.
- `db/migrations/0307_control_loop_candidate_review_identity.sql` (`55d5c28`, not on the PR base) and `0308_validate_control_loop_update_candidates_check.sql` (`e289832`, a descendant of `4ea96c0`) come later.
- The test applies the whole ledger, runs 0234's down and hashes the web login's schema, so 0307 and 0308 are included.
- CI measured `41d09ffffe474b6da71a6e9927586ec11d4be6e79912fcf2cc240b20933cb4be`.

To confirm on a machine with PG17:

```bash
PG_BIN=/usr/lib/postgresql/17/bin node --import tsx --test tests/fleet-worker-capacity-down-postgres.test.ts
```

Class: test bug (stale measured pin). Product correctness of 0307 and 0308's down migrations is not implicated by this assertion alone.

### E2: process-group cleanup reports `cleanup_uncertain` here

Reproduce:

```bash
node --import tsx --test --test-concurrency=1 tests/claude-owner-trusted-local-exec.test.ts
```

The result is `not ok 8 - cancel and deadline stop the complete detached process group`, with actual `{status:'cleanup_uncertain', reason:'process_group_still_running'}`. The `codex-` and `hermes-` variants fail the same way.

A minimal probe (outside the repo) starts a detached group whose leader exits and leaves a TERM-ignoring `sh` behind, then SIGKILLs the group. 500 ms later the group still exists as a single zombie, `<pid> 1 <pgid> Z sh`, and `kill(-pgid,0)` succeeds; by 2 s it returns `ESRCH`. Five of five repeats match.

The adapters (`src/harness/{claude-code-v1,codex-v1,hermes-local-v1}/owner-trusted-local-exec.ts`) check `processGroupExists` `KILL_CONFIRM_MS = 50` ms after SIGKILL. This container's PID 1 (`process_api --firecracker-init`) reaps orphans late. CI shard 3 passed.

Class: environment difference.

### E3: fleet load flakes

All three pass in isolation:

```bash
node --import tsx --test --test-concurrency=1 tests/fleet-connector-lock-crash.test.mjs
```

```bash
node --import tsx --test --test-concurrency=1 tests/fleet-connector-round6.test.mjs
```

```bash
node --import tsx --test --test-concurrency=1 --test-name-pattern=R2C-10 tests/fleet-connector-update.test.mjs
```

Results: 18/18, 29/29 and 2/2. Main's `5d6a22c` already rewrites R2C-10 to tolerate bounded-wait timeouts under load. In CI, shard 1's `test:fleet` failure was F5, not these.

## Notes for the lead

- N1. No product defect was found. Every failure is in tests, test infrastructure, manifest selection or the environment. F1–F5 are the items that keep PR 510's merge gate red. F1 and F2 come from test volume that PR 510 added; F3, F4 and F5 come from PR-specific test or manifest edits.
- N2. E2 is an environment difference, but the 50 ms confirmation window reports a TERM-ignoring group's zombie as "still running" on any host whose init reaps late. That is a robustness edge, not a CI failure.
- N3. `bot-dogfood` and several `*:postgres` units "pass" without PG only because their cases skip. Their green here proves nothing, and all of them must be rerun with PG17.
- N4. CI ran the merge ref, which also contains `5d6a22c` (stabilised `fleet-connector-update`, `operations-mode-stop-postgres` and `project-activity-postgres` tests). This run tested the PR head as instructed, so its view of those three files is the head's.
- N5. To finish this witness, rerun in an environment where `apt.postgresql.org` and `www.postgresql.org` are allowed. Those runs: the five component shards with PG17, every mutation step, affected-tests, the full Mac-local rehearsal and the owner-browser rehearsal suites. Then re-measure F5's digest.

DONE/BLOCKED status: **BLOCKED**. PostgreSQL 17 lanes could not run (PGDG egress denied). All non-PG lanes ran and every failure was diagnosed.
