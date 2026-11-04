# release-fixture-cleanup findings

Result: DONE. Both release fixture consumers now hand root removal to the test's cleanup registrar immediately after allocation, before any fallible setup.

## Base

- Cloned HEAD (published base `cloud-base/release-fixture-cleanup`): `53f883da0f81725248116c53087ef13f1ee27085`.
- `HEAD^` = `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26` (matches the expected `cloud/pack-1` source).
- Output branch: `cloud/release-fixture-cleanup`.

## Changed paths

- `tests/helpers/release-fixture-temp.ts`: `releaseFixtureTemp` takes an optional injected temp base (default unchanged: inherited TMPDIR; nested-TMPDIR checkout-sibling rule unchanged). New `ownedReleaseFixtureTemp(owner, repository, prefix, base?)` allocates and registers `rm(root)` on `owner.after` before returning. New test-only `ReleaseSourceSeams` type and the shared regression driver `verifyReleaseFixtureCleanupOwnership`.
- `tests/protected-release-review-native-owner-seam.test.ts`, `tests/three-worker-activation-bundle-preflight.test.ts`: local `releaseSource(owner, seams = {})` allocates via `ownedReleaseFixtureTemp` (ownership begins before mkdir/assembly/staging/preparation); assemble/stage/prepare and repository/temp base are injectable with real defaults; callers pass `t`; the redundant later `t.after(rm)` registrations were removed. Each file gains `release fixture setup failures retain cleanup ownership`, which drives that file's own `releaseSource`.
- This findings file.

No installer, assembly, staging, production, dependency, lockfile, script or workflow changes. Existing assertions unchanged.

## Regression design

For each consumer, inside a disposable synthetic layout (`mkdtemp` under the test temp dir: `repo/`, `tmp-outside/`, `repo/tmp/`):

- Real `assembleLocalReleaseV1` still refuses an output nested in the synthetic repository, and the output is not created.
- For TMPDIR outside and nested under the synthetic repository, and for sentinel failures injected in assembly and in staging separately: the rejection is the identical sentinel object; the allocated root exists and is outside the synthetic repository (nested case: sibling of it); exactly one cleanup hook was captured; running captured hooks as teardown removes the root.
- Positive case per layout: injected successful operations; root still exists after setup with exactly one registered hook, and is removed only when the hook runs.
- The real existing release tests remain the real-fixture positive cases (real assembly/staging/preparation, cleanup via `t`).
- A `t.after` backstop removes only exact roots observed through the injected operations plus the test's own scratch dir; no prefix scan.

## Setup (from root)

| Command | Exit |
|---|---|
| `npm ci` | 1 (no `package-lock.json`; repo pins `pnpm@11.19.0` with `pnpm-lock.yaml`) |
| `pnpm install --frozen-lockfile` (repo's own lockfile) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not found) |
| add PostgreSQL apt repository (key download) | 22 (HTTP 403 via egress proxy) |
| fallback: `PG_BIN=/usr/lib/postgresql/16/bin` (PostgreSQL 16.15) | n/a; no test in this task uses PostgreSQL |
| `id builder` | 0 (already present) |
| `chown -hR builder:builder "$PWD"` | 0 |
| `node scripts/build-vps.mjs` as builder (generated, ignored `dist-vps/` required by real assembly) | 0 |
| `chown -hR root:root "$PWD"` before Git | 0 |

Node `v22.23.4`.

## Commands and counts

All test commands ran as `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 ...` on the two test files.

| Run | Exit | tests / pass / fail / cancelled / skipped |
|---|---|---|
| Baseline full, before `dist-vps` build | 1 | 11 / 7 / 4 / 0 / 0 (ENOENT `dist-vps/client` inside assembly) |
| Baseline full, after build, unmodified tests | 0 | 11 / 11 / 0 / 0 / 0 |
| Red: selected `^release fixture setup failures retain cleanup ownership$` (seams wired, registration still after setup) | 1 | 2 / 0 / 2 / 0 / 0 |
| Green: same selected command after the fix | 0 | 2 / 2 / 0 / 0 / 0 |
| Green: full both files | 0 | 13 / 13 / 0 / 0 / 0 |
| `node_modules/.bin/tsc --project tsconfig.vps.json` | 0 | n/a |

Expected negative-control failure (both files, identical): `outside/assembly: exactly one cleanup registered` — `0 !== 1` (`ERR_ASSERTION`).

`tsconfig.vps.json` does not include `tests/`; additionally `tsc --noEmit -p tsconfig.json` reports the same 7 pre-existing errors with and without this change (in unrelated `tests/improve-control-room-loop-*` files), none in changed paths. Not repaired (out of scope).

## Cleanup evidence

- The first baseline run reproduced the reviewed F1 leak live: assembly threw and 4 fixture roots were left under `/tmp` (two `acr-owner-review-seam-*`, two `acr-activation-release-*`). Those exact four paths, created by this run, were recorded by name and removed individually.
- After every later run (baseline-after-build, red, green selected, green full): no `acr-*` entries under `/tmp` and no checkout-sibling `*-acr-*` entries. The red run left nothing because of the exact-root backstop.
- Not run: real-fixture run with TMPDIR inside the checkout (would create checkout siblings in a root-owned parent not writable by the build user). The nested layout is covered synthetically.
- No PostgreSQL clusters or other processes were started.

## Checks

- Secret scan (`scanTrackedSecrets` with injected file list, 4 files): findings=0.
- Private-name guard (`env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs`): SKIP — no list in a public cloud clone; not a full privacy pass. Lead CI must supply the real list.
- `git diff --check`: clean.

## Limitations

- PostgreSQL 17 unavailable in this environment (16.15 present); irrelevant to this task's tests.
- Dependencies installed with `pnpm install --frozen-lockfile` because `npm ci` has no npm lockfile to use.
