# b5-repair-guard-isolation findings

## Bases

- Starting HEAD (published task base): `4c7cf8c66746627684176392135fbaaa78ce1be7`
- Parent (implementation base): `2e91e867c20cb5a0ab8b8ddff41402f75c9f4041` (verified `HEAD^`)
- Output branch: `cloud/b5-repair-guard-isolation`

## Environment and setup (deviation recorded)

| Command | Exit | Note |
| --- | --- | --- |
| `node --version` | 0 | v22.23.4 |
| `npm ci` | 1 | EUSAGE: repo has no package-lock.json; it uses pnpm (`packageManager: pnpm@11.19.0`) |
| `pnpm install --frozen-lockfile` | 0 | installed from the repo's own `pnpm-lock.yaml` |
| `test -x node_modules/.bin/tsx` | 0 | |
| `id builder` | 0 | account already present |
| `test -x /usr/lib/postgresql/17/bin/initdb` | 1 | PostgreSQL 17 absent |
| `apt-get update && apt-get install -y postgresql-17` | 100 | package not in Ubuntu 24.04 archive |
| adding the PGDG apt repository (key download) | 22 | HTTP 403 from the egress proxy |
| `test "$(git rev-parse HEAD^)" = 2e91e86...` | 0 | |
| `chown -hR builder:builder "$PWD"` | 0 | restored with `chown -hR root:root "$PWD"` before Git checks |

**PostgreSQL used: 16.15** (`PG_BIN=/usr/lib/postgresql/16/bin`, newest installed). All task
commands below were run unchanged except `PG_BIN=/usr/lib/postgresql/17/bin` was replaced by the
16 path. The lead should re-run on PostgreSQL 17 before integration.

## Change

Changed files:

- `tests/improve-control-room-first-website.test.ts`
- `tests/improve-control-room-first-website-mutations.test.ts`
- this findings file

Runtime helper `tests/helpers/improve-control-room-first-website.ts` is byte-unchanged
(sha256 `ead8ac7f95773c59f5571ee6a6819bb09bc4d25d203ede10f48427d4b4eae1ac` before and after;
`git diff --quiet` on it exits 0).

Regression "B5 verifier requires closed-browser rejection and original-builder repair" (name and
mutation assertion message "B5 repair by a different writer is refused by the repair guard" kept):

1. Writes the untouched fixture and requires `incomplete`.
2. Identity-only forged case: repair step (`steps[3]`, n=4, build) gets `identity = "writer-other"`
   and `provider.admittedIdentity = "writer-other"`; a cloned pin set's qualified `lineup[3]` gets the
   same identity. Asserts full-detail `refusalAt` = `B5_REJECTION_REPAIR:original builder repair`.
3. Family-only forged case: repair step and cloned `lineup[3]` get `family = "family-other"`.
   Same exact code/detail; message "B5 repair by a different family is refused by the repair guard".
4. Restores the untouched fixture (default fixture pins) and requires `incomplete`.

Sanity assertions pin that slot 3 is the `writer-b`/`family-b` repair build before forging. The
fixture is not promoted to real; the guard is not reimplemented.

Mutation suite: the existing original-builder probe keeps its combined two-clause deletion as a
control and additionally runs two exact-one-match scratch mutations through `assertGuardBites`:

- identity only: `|| repair.identity !== defective!.identity || repair.family` -> `|| repair.family`
- family only: ` || repair.family !== defective!.family)` -> `)`

Each requires exit 1, no signal, its own assertion text, `ERR_ASSERTION`, `# tests 1`, `# fail 1`,
no SyntaxError/skip/zero-test/timeout, the other clause's assertion text absent, no
`B5_PROVIDER_PROVENANCE_MISMATCH` in output, byte-identical restore and a restored green run.
Probe count (26), partitions (2 x 13, disjoint) and selector guard are unchanged.

## Red-first evidence (scratch graph `.test-tmp/repair-red`, local clone + symlinked node_modules)

| Run | Helper state | Exit | Counts | Result |
| --- | --- | --- | --- | --- |
| old test, unmutated (accidental extra control; mutation step was skipped by a failed root `git log`) | original | 0 | tests 1 pass 1 | green |
| old test | both clauses removed | 1 | tests 1 fail 1 | ERR_ASSERTION, expected `B5_REJECTION_REPAIR`, actual `B5_PROVIDER_PROVENANCE_MISMATCH` (the masking described in the task) |
| new test | identity clause removed | 1 | tests 1 pass 0 fail 1 skipped 0 | ERR_ASSERTION "different writer", expected `B5_REJECTION_REPAIR:original builder repair`, actual `incomplete` |
| new test | family clause removed | 1 | tests 1 pass 0 fail 1 skipped 0 | ERR_ASSERTION "different family", expected same, actual `incomplete` |
| new test | restored (sha256 matches original) | 0 | tests 1 pass 1 | green |

Both one-clause deletions are caught by their own case; neither reaches a provenance refusal.
No helper mutation was committed; scratch was removed afterwards.

## Final runs (as `builder`)

| Command | Exit | tests/pass/fail/skipped/cancelled | Duration |
| --- | --- | --- | --- |
| named regression (`--test-name-pattern='^B5 verifier requires ...repair$'`), before change | 0 | 1/1/0/0/0 | 10 s |
| named regression, after change | 0 | 1/1/0/0/0 | 7 s |
| full `tests/improve-control-room-first-website.test.ts` | 0 | 152/152/0/0/0 | 380 s |
| mutations partition 1 | 0 | 14/14/0/0/0 (13 probes + parent); log `selected=13/13 total=26 overlap=0 complete=true`; original-builder probe logs combined, identity-only and family-only kills | 338 s |
| `tsc --project tsconfig.vps.json` | 0 | n/a | 32 s |

Partition 2 was not run (not required by the task; untouched probes).

## Cleanup

- Scratch `.test-tmp/repair-red` removed; `.test-tmp/` empty.
- No `builder` postgres or node processes left; no `attack-kit-mutation-run-*` dirs left in /tmp.
- Fixture teardown handled by the existing tests (`t.after`).
- Ownership restored to root before Git operations.

## Limitations

- PostgreSQL 16.15 instead of 17 (17 not installable in this environment).
- `pnpm install --frozen-lockfile` instead of `npm ci` (no npm lockfile in repo).
- Private-name check runs without a list (SKIP); CI's configured privacy checks are still required.
- Elapsed task time about 20 minutes.

## Scans (as root after ownership restore)

- Secret-pattern scan on the 3 changed paths: exit 0, `secret-scan files=3 findings=0`.
- Private-name guard without a list: exit 0, SKIP ("no list configured"); not a full privacy pass.
- `git diff --check`: exit 0.
