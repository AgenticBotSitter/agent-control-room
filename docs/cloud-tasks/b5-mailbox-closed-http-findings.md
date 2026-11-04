# b5-mailbox-closed-http findings

- Starting HEAD (task-document commit): `6f18fd11c57bc90387b79c4b6c1629e6dfddd38e`
- Implementation base (HEAD^): `9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3` (verified)
- Branch: `cloud/b5-mailbox-closed-http`; Node v22.23.4; worker uid 0 (container default)
- Dependencies: the repository ships `pnpm-lock.yaml` only, so `npm ci` exited 1 (EUSAGE, no package-lock). Installed from the repo's own lockfile with `pnpm install --frozen-lockfile` (pnpm 11.19.0, matches `packageManager`), exit 0. No package/lockfile change.
- No native PostgreSQL used, installed or started (task scope is pure unit/in-memory).

## Change

Only `tests/improve-control-room-first-website-device.test.ts` (plus this file). `B5DeviceRefusalV1` added to the existing import. Two new tests placed after `F03b mailbox close drains ...` (which is unchanged):

1. `B5 closed mailbox HTTP refuses project GET, owner POST and sign-in POST before render or evidence`
   - Real-mode (`real: true`) disposable mailbox in `.test-tmp/f03b-closed-*`. Sequence 1 is accepted (observation, receipt, sealed service evidence); sequence 2 (`prepare`) is pending with its session challenge issued, so every request below would reach a live evidence branch if the fence were absent.
   - Awaited `close()`; `close()` returns the same promise before and after settling (idempotent).
   - Correlated project GET, synthetic owner intake POST (201 accepted body) and sign-in POST (201 with an owner cookie) each reject with exactly `B5DeviceRefusalV1` code `B5_DEVICE_CLOSED`; per-case render callback count is 0.
   - Whole mailbox tree (every file's bytes plus directory listing) is byte-identical before/after; no `session-wait.json`; `abandoned/` empty; `currentRequest()` still sequence 2; `observation()` unchanged; `readReceipt(1)` still verifies.
2. `B5 closed mailbox HTTP drains an already-entered render without new post-close evidence`
   - A correlated project GET (would publish `observations/1.json` if completed while open) enters render and is held on a promise barrier; `close()` is started and is shown unsettled after 5 macrotask turns.
   - Documented current behavior (no new policy invented):
     - close waits for the entered ordered exchange (drain);
     - a post-close ordered GET queues behind the held exchange (serial exchange chain), stays unsettled until release, then rejects with `B5_DEVICE_CLOSED` and never renders;
     - after release the held response is returned unchanged (200, original body, no `set-cookie`, i.e. no correlation cookie);
     - no observation, empty `observations/`, mailbox tree byte-identical to the pre-close snapshot, pending request unchanged.
   - Barrier released in `finally`; cleanup (close then remove scratch) is registered before any fallible fixture work.

## Commands (run from clone root, all with `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp`)

Focused: `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B5 closed mailbox HTTP|^F03b mailbox close drains' tests/improve-control-room-first-website-device.test.ts`

| Run | Exit | Time | tests/pass/fail/skipped/cancelled |
|---|---|---|---|
| Baseline focused (before change) | 0 | ~4s | 1/1/0/0/0 (only F03b existed) |
| First focused attempt (draft) | 1 | ~2s | 3/2/0/0/1: draft awaited a post-close ordered GET before releasing the barrier; it queues behind the held exchange, so the test was rewritten to pin that ordering |
| Focused, final, real checkout | 0 | ~2s | 3/3/0/0/0 (all three named bodies executed) |
| **Negative control** (copied graph, guard removed) | 1 (expected) | ~4s | 3/1/2/0/0 |
| Copied graph restored | 0 | ~2s | 3/3/0/0/0 |
| Full module | 0 | ~11s | 75/75/0/0/0 |
| `node_modules/.bin/tsc --project tsconfig.vps.json --noEmit` | 0 | ~36s | n/a (production regression check only; the VPS project does not typecheck this test file) |

## Negative control

- Copied graph: tar copy of the clone (excluding `.git`, `node_modules`, `.test-tmp`) into a disposable `/tmp/b5-closed-mut-*` directory, with `node_modules` symlinked to the provisioned install.
- Mutation: removed only the line `need(!closed, "B5_DEVICE_CLOSED");` directly preceding `const attempt = pending` in `handle`'s exchange. Anchor matched exactly once; guard count went 2 -> 1, so the independent `locked()` fence used by `request()`/`accept()` stayed in place. `diff` showed a one-line deletion.
- Result: test 1 failed at `Missing expected rejection: project GET must refuse with exact B5_DEVICE_CLOSED`; test 2 failed at the post-close ordered GET rejection (`Missing expected rejection.`). The pre-existing `F03b mailbox close drains ...` still **passed** under the mutation, confirming it gave no named regression for this fence before this change.
- Restoration: copied the real source back, `cmp` identical, reran green (3/3). Removed the copy. The real checkout's production file was never edited (`git diff -- scripts src` empty).

## Native/gated bodies

The full module reported 0 skipped. No test in it started native PostgreSQL: the two `withRealPostgres` calls are refusal-before-acquisition assertions. No native lane or gate was enabled.

## Cleanup

- `.test-tmp/` was empty after the final runs. One `.test-tmp/f03b-closed-*` directory was left behind by the cancelled draft run; it was removed before the final runs. Every later run left nothing behind.
- Mutation copy removed; no child test processes left (`pgrep` empty).

## Limitations

- The drain test covers real mode. In rehearsal (`real: false`) mode the project GET is not an ordered exchange, so `close()` does not track or await it. This is documented here and not asserted.
- The private-name guard ran without a configured list, so it is an explicit SKIP, not a full pass. The lead must run configured privacy CI before integration.

## Scans

- `scanTrackedSecrets` on the 2 changed files: exit 0, findings=0.
- `scripts/check-private-names.mjs` (list unset): exit 0, "skipped: no list configured". This is a SKIP with configured=0 and scanned=0.
- `git diff --check`: exit 0.
