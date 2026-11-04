# b5-restart-outcome-matrix findings

Status: DONE. All evidence below is synthetic (unit tests with in-memory Request/Response objects; no server, listener, browser, native PostgreSQL or remote request).

## Bases

- Starting HEAD (task-document commit): 0eada2dad661c4449ba1e39ff0e563a5487236e6
- Parent / implementation base: 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3 (checked: `git rev-parse HEAD^`)
- Branch: cloud/b5-restart-outcome-matrix (normal push; no PR, no merge)

## Environment

- Node v22.23.4 (major 22 check passed); `node_modules/.bin/tsx` and `node_modules/.bin/tsc` present.
- Dependencies: the repository ships `pnpm-lock.yaml`, not `package-lock.json`, so `npm ci` exited 1 (EUSAGE: no npm lockfile). Dependencies were provisioned from the repo's own lockfile with `pnpm install --frozen-lockfile` (pnpm 11.19.0, the pinned `packageManager`), exit 0.
- PostgreSQL: not used by this task (no native PostgreSQL started). Worker setup attempted `apt-get install -y postgresql-17` (exit 100, not available; the PGDG key fetch was refused by the network policy). Newest installed is 16 (`/usr/lib/postgresql/16/bin`), unused.
- Tests ran as the worker's current uid with `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1` on every test/build subprocess, including the copied-graph controls.

## Changes

`tests/improve-control-room-first-website-device.test.ts` only (+88 lines). Production source is unchanged.

Added tests (prefix `B5 restart outcome matrix`), each in an independent fresh `restartFixture` with the real `mailbox.handle`:

- `first command <outcome>` for 399, 400, 401, 403, 409, 422, 499, 500 and a thrown render error. Each observes the request with session A (observation `1.json`), sends a first owner Confirm whose render returns that status (or throws), then a successful sign-in with session B.
  - 400..499: sequence +1; republished `request.json` equals the old request except sequence/nonce; `abandoned/` is exactly `["1.json"]` with exact keys and values (`request`, original `observation`, `events: []`, `reason: session-replaced-before-owner-command`, `counted: false`); no `session-wait.json`; the new request accepts a session-B observation (`2.json`).
  - 399, 500, throw: sequence unchanged; `request.json` unchanged; `abandoned/` empty; observation retained; `session-wait.json` is exactly `{sequence: 1, reason: "sign-in expired after you acted; ..."}`.
  - All: original `observations/1.json` bytes preserved; `receipts/` and `service/` empty; returned response is the identical rendered object (strict equality); the thrown error is rejected by identity.
- `prior accepted command then <400|409> keeps the action authoritative`: valid accepted Confirm (201 receipt), then a Start rendered with 400/409, then sign-in B. Restart stays blocked (same sequence/request, `abandoned/` empty, `session-wait.json` recorded, observation and bytes preserved, no receipt). A receipt claiming both actions refuses with `B5_DEVICE_SERVICE_MISSING` (the rejected Start fabricated nothing). A later valid Start then lets the original sequence be accepted, with service evidence exactly `[confirm 201, start 201]`, proving the earlier Confirm stayed authoritative.

Existing in-flight and malformed-response tests are kept unchanged. This pins the existing heuristic; it is not a new receipt contract.

## Commands and results

Focused command (`--test-name-pattern='^B5 (restart outcome matrix|pre-action restart admission handles|sign-in waits for an in-flight accepted Confirm)'`, as given in the task):

| Run | Exit | Time | tests / pass / fail / skipped / cancelled |
| --- | --- | --- | --- |
| Baseline (before edits) | 0 | ~3 s | 5 / 5 / 0 / 0 / 0 |
| Final, real checkout | 0 | ~2 s | 16 / 16 / 0 / 0 / 0 |
| Broader: whole device test module | 0 | ~10 s | 84 / 84 / 0 / 0 / 0 (todo 0) |
| `tsc --project tsconfig.vps.json --noEmit` | 0 | ~32 s | n/a |

All 11 new matrix bodies plus the 5 existing selected bodies were reported `ok` by name (no zero-match green). The device module contains no gated native bodies (no skip/native gate found); none were enabled.

The VPS TypeScript project excludes most tests: its pass is a production regression check only, not a typecheck of the edited test file. The executed bodies and runtime assertions are the primary evidence.

## Negative controls (expected failures)

Run in a task-owned copy of the tracked tree under `.test-tmp/mutant-graph` (only `node_modules` symlinked), with the same focused command. Each anchor matched exactly once before mutation and the replacement exactly once after; the copy was restored from its saved original after each mutant (byte-compared), and the real checkout's source hash was verified unchanged.

| Mutant in `scripts/workflow-journeys/first-website-device.ts` (copy only) | Exit | Counts | Failing bodies | Intended assertion hit |
| --- | --- | --- | --- | --- |
| `response.status < 500` -> `<= 500` | 1 | 16 / 15 / 1 | `first command 500` | `B5_MATRIX_NO_RESTART outcome=500 must retain uncertainty` |
| `response.status >= 400 &&` -> `> 400 &&` | 1 | 16 / 15 / 1 | `first command 400` | `B5_MATRIX_RESTART status=400 must republish after a first 4xx` |
| remove `!alreadyActed && ` | 1 | 16 / 14 / 2 | `prior accepted command then 400` and `then 409` | `B5_MATRIX_PRIOR_ACTION second=400 must block restart` (and 409) |
| Restored copy | 0 | 16 / 16 / 0 | none | n/a |

## Scans

See the status file for the secret-scan, private-name guard, `git diff --check` and `git status` results run on the final allowlist.

## Cleanup

`.test-tmp/mutant-graph` was removed by the control script's exit trap. Scratch logs under `.test-tmp/` (git-ignored) were removed before finishing. The tests start no child processes or listeners; each fixture closes its mailbox in `t.after`. Zero owned leftovers.

## Limitations / unrun

- Edited test code was not typechecked by `tsc` (outside the VPS project); it is executed by tsx.
- No native PostgreSQL, browser or real device lane was run (out of scope by design).
- The private-name guard has no configured list in this environment, so it is an explicit SKIP rather than a full pass; the lead must run configured privacy CI before integration.
