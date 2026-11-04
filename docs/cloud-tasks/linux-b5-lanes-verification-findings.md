# linux-b5-lanes-verification findings

Verification only. No implementation, test, package, lockfile or workflow file was changed; this file is the sole committed change.

## Bases

- Starting HEAD (published base, task-document commit): `5ac142834a67470d19012df2c00b177a2b2898f4`
- Implementation base (HEAD^): `2e91e867c20cb5a0ab8b8ddff41402f75c9f4041` (checked, matches)
- Output branch: `cloud/linux-b5-lanes-verification`
- Changed files: `docs/cloud-tasks/linux-b5-lanes-verification-findings.md` (plus the worker status file under `docs/cloud-tasks/results/`)

## Environment and deviation from the specified commands

Disposable Linux cloud clone, run as root, tests run as the unprivileged `builder` account via `runuser -u builder --`.

| Step | Exit |
|---|---|
| `node --version` → v22.23.4 | 0 |
| `npm ci` (queue-worker setup step) | 1 — repo has no `package-lock.json`; it pins `packageManager: pnpm@11.19.0` with `pnpm-lock.yaml` |
| `pnpm install --frozen-lockfile` (repo's own lockfile, no lockfile change) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` (distro repos) | 100 — package not available |
| add PostgreSQL apt repository (key fetch) | 2 — HTTP 403 from the environment's network policy; repo entry removed again |
| `apt-get install -y postgresql-17` (after adding repository) | 100 |
| `id builder` (account already present) | 0 |
| `test -x .../initdb`, `test -x .../pg_ctl` (PostgreSQL 16 bin dir) | 0, 0 |
| `test "$(git rev-parse HEAD^)" = 2e91e86…` | 0 |
| `mkdir -p .test-tmp && chown -hR builder:builder "$PWD"` | 0 |
| `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/build-vps.mjs` | 0 (20 s) |

**Deviation:** PostgreSQL 17 could not be installed in this environment, so every test/partition command was run exactly as specified except with `PG_BIN=/usr/lib/postgresql/16/bin` (PostgreSQL 16.15, Ubuntu package) instead of `/usr/lib/postgresql/17/bin`. All disposable-cluster bodies that ran in this lane therefore ran against **PostgreSQL 16, not 17**. This is not PG17 evidence; a PG17 rerun is still needed before treating these results as matching the frozen environment.

No qualification env vars were set, no native packet was supplied, no skip gate was removed, no timeout was changed.

## B5 seven-file lane (3 serial rounds)

Command (as specified, PG_BIN substituted as above):

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/16/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-first-website.test.ts tests/improve-control-room-first-website-a2.test.ts tests/improve-control-room-first-website-host-postgres.test.ts tests/improve-control-room-first-website-device.test.ts tests/improve-control-room-first-website-device-postgres.test.ts tests/improve-control-room-first-website-controller-postgres.test.ts tests/improve-control-room-desk.test.ts
```

| Round | Exit | tests | pass | fail | cancelled | skipped | Elapsed |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 335 | 321 | 0 | 0 | 14 | 640 s |
| 2 | 0 | 335 | 321 | 0 | 0 | 14 | 651 s |
| 3 | 0 | 335 | 321 | 0 | 0 | 14 | 623 s |

The set of skipped test names was byte-identical in all three rounds.

### Per-file top-level results (identical in all three rounds)

Node reports one aggregate for the multi-file invocation; the per-file split below is derived by matching each top-level `ok`/`not ok` line to the file that declares that test name (48 of 287 top-level lines were attributed by run order where the name is built dynamically). Totals count top-level tests only (287); the 335 aggregate also counts subtests.

| File | top-level | pass | fail | skip | cancel |
|---|---|---|---|---|---|
| tests/improve-control-room-first-website.test.ts | 109 | 109 | 0 | 0 | 0 |
| tests/improve-control-room-first-website-a2.test.ts | 40 | 38 | 0 | 2 | 0 |
| tests/improve-control-room-first-website-host-postgres.test.ts | 13 | 8 | 0 | 5 | 0 |
| tests/improve-control-room-first-website-device.test.ts | 73 | 73 | 0 | 0 | 0 |
| tests/improve-control-room-first-website-device-postgres.test.ts | 10 | 3 | 0 | 7 | 0 |
| tests/improve-control-room-first-website-controller-postgres.test.ts | 10 | 10 | 0 | 0 | 0 |
| tests/improve-control-room-desk.test.ts | 32 | 32 | 0 | 0 | 0 |

### Gated skips — NOT qualification

These 14 bodies did not run. They remain skips by design; nothing here is real native/device/host qualification.

Packet/configuration-dependent native proof bodies:

- `B5 actual phone and desktop Tailscale smoke` — owner-approved device/transport packet required
- `B5 actual device forced-abort deadline` — same gate
- `B5 actual device forced-abort stop` — same gate
- `B5 actual device forced-abort cold-read` — same gate
- `B5 actual device forced-abort verifier` — same gate
- `B5 actual device forced-abort interrupt` — same gate
- `B5 real Mac-local assembly and owned restart/close` — frozen F03-0 packet and strict B5 config not supplied
- `F03a native abort during pool-open owns late resolution` — frozen configuration required
- `F03a native abort during listener-bind owns late resolution` — frozen configuration required
- `F03a native abort during ready owns late resolution` — frozen configuration required
- `F03a real PG roles, disposable seed and local sign-in prerequisites` — gated on `CONTROL_ROOM_B5_ASSEMBLY_PG=1` (real PG17)
- `B5 cooperative PG17 SIGTERM child stops PG after owner receipt` — gated on `CONTROL_ROOM_B5_SIGNAL_REQUIRE_PG=1`

Other gated skips:

- `B5 real settings/lineup honours reviewed overrides; pinned roster and interpreter refusals (fixture assembly)` — lead-gated pinned tools unavailable
- `B5 retained finished-run finalization bridge guard` — read-only retained root not supplied

The always-run guards did execute and pass, including `B5 host-postgres frozen native gate cannot skip to green`, `B5 device-postgres native gates cannot skip to green with absent qualification`, `B5 controller native gate missing qualification is a hard failure` and the controller-postgres missing/malformed-qualification refusals.

## Mutation partitions (each once)

Command (as specified, PG_BIN substituted), with `--test-name-pattern='^B5 verifier guard mutations partition N '` on `tests/improve-control-room-first-website-mutations.test.ts`.

| Partition | Exit | tests | pass | fail | cancelled | skipped | Elapsed | Harness line |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 14 | 14 | 0 | 0 | 0 | 328 s | `B5 partition: selected=13/13 total=26 overlap=0 complete=true` |
| 2 | 0 | 14 | 14 | 0 | 0 | 0 | 308 s | `B5 partition: selected=13/13 total=26 overlap=0 complete=true` |

All 26 probes (13 + 13) printed `baseline=true loaded=true intended_assertion=true restored=true green=true`. Each mutant failure was the expected control (exit 1, `ERR_ASSERTION`, `# fail 1`, intended assertion text present, no SyntaxError/timeout/zero-selection/skip), and each restored file ran green. These expected mutant failures are controls, not regressions.

Partition 1 probes: real versus fixture qualification; candidate repository HEAD and clean state; closed-browser rejection and original-builder repair; mandatory provider discriminator; complete owner action list; service capture head correlation; cold read before shared teardown; narrow unauthenticated snapshot; independent capture approval; retained owner removal receipt; native receipt route admission; complete final website report; screen response versus signed cold record.

Partition 2 probes: rejected and final head binding; artifact byte binding; full cleanup and retained corpus; fixture provider verdict; capture qualification; device closure attestations; provider manifest versus independent pins; observed cleanup target absence; private artifact mode; complete qualified lineup; actual staged provider provenance; selected identity admission; controller missing qualification.

## Regressions

None observed. No failure, cancellation or timeout in any run.

## Cleanup

- `.test-tmp/` empty after all runs (mutation scratch clones removed by the harness).
- No `postgres` or test `node`/`tsx` processes remained after the runs.
- `git status --short` clean before writing this file (dependency install changed no tracked file).
- Ownership restored with `chown -hR root:root "$PWD"` before Git checks.

## Unrun work and limitations

- PostgreSQL 17 unavailable (not in distro repos; PostgreSQL apt repository blocked by network policy). All cluster work ran on PostgreSQL 16.15. PG17 rerun remains required.
- Dependencies installed with `pnpm install --frozen-lockfile` (the queue setup's `npm ci` cannot run without a package-lock).
- The 14 gated bodies listed above were not run; no packet or qualification env was provided.
- Per-file counts are derived from TAP names (see note above); aggregate counts are Node's own.
- Private-name check runs without a list (SKIP); CI's configured privacy checks must run before integration.
- No browser, device, real provider or agent CLI was used.

## Scans (after restoring root ownership)

- `scanTrackedSecrets` on the findings file: `secret-scan files=1 findings=0`, exit 0.
- `check-private-names.mjs` without a list: `private-name check skipped: no list configured` — SKIP, not a privacy pass.
- `git diff --check`: exit 0.
