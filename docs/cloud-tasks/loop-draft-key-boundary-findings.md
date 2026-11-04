# loop-draft-key-boundary findings

Result: **BLOCKED** - the cloud environment is missing required prerequisites, so the new test could not be run or verified.

## Base

- Cloned HEAD (published base): `429e2ad91d8271fad401d246ecbfe3b0cdea1929`
- `git rev-parse HEAD^`: `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26` (matches the expected `cloud/pack-1` source)
- Output branch: `cloud/loop-draft-key-boundary`

## Setup check (from the clone root)

| Check | Result |
| --- | --- |
| `node --version` | `v22.23.4` |
| `test -d node_modules` | exit 1 - **missing** |
| `id builder` | present |
| `test -x /usr/lib/postgresql/17/bin/initdb` | exit 1 - **missing** (only a PostgreSQL 16 tree exists) |
| `test -x /usr/lib/postgresql/17/bin/pg_ctl` | exit 1 - **missing** |

The task forbids installing or downloading dependencies, so the setup failed here and every command that depends on it was stopped.

## Attempted command

The first task command (selected test), run as `builder` after `chown -hR builder:builder "$PWD"`:

```
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B1a draft key lower boundary refuses before persistence$' tests/improve-control-room-desk.test.ts
```

Exit 1: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'`. Counts: tests 1, pass 0, fail 1, cancelled 0, skipped 0. This is a module-loading failure, so **no test body ran**. It is not a pass and not a regression signal.

Not run, because each one depends on the missing dependencies:

- The mutant negative control and the restored-green rerun under `.test-tmp/`
- The full desk suite
- `tsc --project tsconfig.vps.json`
- The `scanTrackedSecrets` secret scan and the private-name guard

## Unverified implementation (for the lead to verify)

Changed path: `tests/improve-control-room-desk.test.ts`. The change adds a `WebAccessError` import from `../src/web/v1/access-verifier` and adds the test `B1a draft key lower boundary refuses before persistence` directly after the owner-guard test. The test does the following:

- Uses the fixed synthetic keys `loop-key-15-abc` and `loop-key-16-abcd`, and asserts their lengths are 15 and 16.
- 15-character key: expects a `WebAccessError` with `code === "invalid_request"`, and checks that `f.writes()`, the `requests` count and the `inputs` count are unchanged against the fixture baseline.
- 16-character key: expects `replayed === false`, a new `loop-request:` ID that differs from the fixture's, writes +2, and requests/inputs counts each +1.
- Exact retry with the 16-character key: expects `replayed === true`, the same request and savedInput, and no new write or row.
- Checks that dispatches stay at 0.

No product, migration, package or lockfile changes.

## Negative control (still to run)

In a scratch copy under `.test-tmp/`, change only the `#loopKey` regex in `src/improve-control-room/v1/service.ts` from `{16,100}` to `{15,100}`, and confirm the edit matched exactly one line (`    if (!/^[A-Za-z0-9:_-]{16,100}$/.test(key)) throw new WebAccessError("invalid_request");`). Then run the selected-test command with cwd set to that copy.

Expected failure: `AssertionError` at `assert.ok(error instanceof WebAccessError, "15-character key refused by the service")`, because the 15-character key would be saved. Restoring `{16,100}` should then pass.

## Cleanup

- No PostgreSQL cluster or other process was started.
- The scratch `.test-tmp/` directory was removed.
- Checkout ownership was returned to root with `chown -hR root:root "$PWD"`.
