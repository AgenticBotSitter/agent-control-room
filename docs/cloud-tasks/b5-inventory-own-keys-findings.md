# b5-inventory-own-keys findings

## Bases

- Starting HEAD (task-document commit): `bcaad43dd3f1415f768acc7e8424366b3d35cba2`.
- Implementation base (HEAD^ check passed): `5a891a6083a7a125cf7afbe51265d22554df2a07`.
- Branch: `cloud/b5-inventory-own-keys`. Node v22.23.4. Ran as the environment's worker uid; no identity or safe.directory changes.

## Problem (confirmed)

`b5RefusalInventoryV1` counted with plain objects and `bump(r,k)` did `r[k]=(r[k]??0)+1`. A literal detail `"__proto__"`
reads the inherited `Object.prototype` and the assignment goes to the inherited setter, so the label never appears as a key.
The computed inventory was unchanged and the literal-allowlist assertion accepted an unlisted detail. (`constructor`,
`toString` and `hasOwnProperty` became own keys with garbage string counts, so the old helper already rejected them, but only
by accident.) The runtime allowlist `b5KnownRefusalDetailsV1` was not affected and was not changed.

## Change (tests/improve-control-room-first-website.test.ts only)

- All counters (per-module literal counts, nonliteral, no-detail) are `Map<string,number>`. The returned inventory is
  normalized with `Object.fromEntries`, which defines own data properties, so `"__proto__"` becomes an ordinary own key and
  the returned objects keep `Object.prototype` (the existing exact `deepEqual` comparisons are unchanged and still strict).
- AST traversal, escape detection, canonical-kind extraction, omission policy, expected counts and every existing assertion are
  unchanged.
- New mutation vectors in `B5 refusal producer inventory rejects uncovered details` (memory-only producer copies, exact-one
  anchor, mutant must parse):
  - `helper __proto__ literal` (the red vector, in the fixed case list).
  - Matrix: labels `__proto__`, `constructor`, `toString`, `hasOwnProperty` plus an ordinary control `unlisted ordinary detail`,
    across sites `helper refuse`, `helper bad`, `helper broken`, `helper new` (`new B5RefusalV1(code, "x")`),
    `controller new`, `host new` = 30 independent mutants. Each must fail with `^literal refusal detail missing`, be counted as
    an own key, and be counted exactly once. The controller has no literal producer today; the `new B5RefusalV1` form is the
    only producer syntax it supports.
  - Asserts none of these labels is in the runtime allowlist, and that normalized output objects have `Object.prototype`.

## Commands and results

Focused command (exact, from the task):
`env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B5 refusal' tests/improve-control-room-first-website.test.ts`

| Step | Exit | Time | tests/pass/fail/skipped/cancelled | Notes |
|---|---|---|---|---|
| Baseline focused (unchanged base) | 0 | 4s | 2/2/0/0/0 | both named bodies ran |
| Red: `__proto__` vector added, old counters | 1 | 2s | 2/1/1/0/0 | `Missing expected exception: helper __proto__ literal` (expected) |
| Fixed counters + full matrix, focused | 0 | 5s | 2/2/0/0/0 | final bytes |
| Copied-graph control (old counters restored) | 1 | 4s | 2/1/1/0/0 | `Missing expected exception: helper __proto__ literal` (expected) |
| Real source re-run after control | 0 | 5s | 2/2/0/0/0 | |
| Broader (`^B5 refusal\|^B5 controller keeps only known\|^B5 controller applies the same refusal`) | 0 | 9s | 4/4/0/0/0 | all 4 named bodies ran |
| `tsc --project tsconfig.vps.json --noEmit` | 0 | 31s | n/a | production regression check only |

Extra (not required): `tsc --project tsconfig.json --noEmit` exits 2 with 7 errors, byte-identical to the unmodified base
(all in loop-bridge/candidate/recovery tests); none in the edited file.

## Negative control

Task-owned graph `.test-tmp/old-counter-graph`: tracked files copied, `node_modules` symlinked to the provisioned install,
current test file copied, then only the four counter lines restored to the old plain-object implementation (each anchor
matched exactly once; producer sources byte-identical to the checkout). The same focused command fails with the intended
diagnostic naming the vector. The graph was removed by an EXIT trap; no child processes remained. The real checkout's
production files were never modified.

## Setup notes

- Worker setup asked for `npm ci`; the repo has no npm lockfile (`packageManager: pnpm`, `pnpm-lock.yaml`), so `npm ci`
  exited 1 (EUSAGE). Used the repo's own lockfile: `CI=1 pnpm install --frozen-lockfile` (exit 0).
- PostgreSQL 17 was unavailable (apt: package not found; adding the upstream apt key was refused by the network proxy, 403).
  Only PostgreSQL 16 is present. This task needs no native PostgreSQL; none was started.

## Unrun steps and limitations

- No native PostgreSQL or packet/native gates (out of scope by design).
- The private-name guard ran without a configured list, so it is an explicit SKIP, not a pass; configured privacy CI must run
  before integration.

## Cleanup

Scratch was limited to `.test-tmp/` (untracked) and `/tmp` logs; the copied graph was removed, and the remaining `.test-tmp/`
scripts and logs are removed before the final commit. Zero owned processes left.

## Scans

- `scanTrackedSecrets` on the 2 changed files: `RESULT secret-scan files=2 findings=0` (exit 0).
- `check-private-names.mjs` (no list): `private-name check skipped: no list configured` (exit 0) — explicit SKIP.
- `git diff --check`: exit 0. `git status --short`: only the two allowlisted paths.
