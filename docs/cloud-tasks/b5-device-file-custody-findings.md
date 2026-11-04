# b5-device-file-custody findings

## Bases

- Starting HEAD (published base, task-document commit): `31a7553ff5dd3a270889e6716ace2ec043964efd`
- Its parent (implementation base, verified): `2e91e867c20cb5a0ab8b8ddff41402f75c9f4041`
- Output branch: `cloud/b5-device-file-custody`

## Changed files

- `tests/improve-control-room-first-website-device.test.ts`: imports `readB5DeviceFileV1`, `link`, `unlink`; adds helper `privateFile` and two tests:
  - `B5 device reader exact size boundary`
  - `B5 device reader refuses hard links and public modes`
- `docs/cloud-tasks/b5-device-file-custody-findings.md` (this file)

No production, package, lockfile, workflow, schema or migration file changed.

## Environment deviations (recorded honestly)

- `npm ci` exit 1 (EUSAGE): the repository has no npm lockfile; its own lockfile is `pnpm-lock.yaml`. Dependencies were installed with `pnpm install --frozen-lockfile` (pnpm 11.19.0, exit 0). The scheduled worker prompt required dependency setup, which overrides the task file's no-install line.
- PostgreSQL 17 was unavailable: `apt-get install -y postgresql-17` exit 100 (package not found); adding the PGDG repository failed (key download returned 403 through the proxy). PostgreSQL **16** (`/usr/lib/postgresql/16/bin`) was used as `PG_BIN` instead. The device test file does not start a cluster, so this does not affect these results.
- `builder` already existed. Node v22.23.4.

## What the tests cover

Size (all with real files under `scratch(t)`, explicit `chmod 0600`, byte buffers):
- cap=32: 32 bytes accepted and returned byte-for-byte (`deepEqual`); 33 bytes refused `B5_DEVICE_SIZE`.
- Multibyte: 8 four-byte code points = 16 UTF-16 units but 32 bytes; accepted at cap=32, refused `B5_DEVICE_SIZE` at cap=`string.length` (16). Cap is bytes.
- Default cap: 65536 bytes accepted; 65537 refused `B5_DEVICE_SIZE`.

Custody:
- Private single-link file accepted.
- `link()` to a second task-owned name: asserted `nlink === 2`, mode 0600; both names refused `B5_DEVICE_CUSTODY`. Link removed, `nlink === 1` asserted, unchanged original accepted again.
- Separate single-link file `chmod 0644` (actual mode asserted): refused exact `B5_DEVICE_CUSTODY`; `chmod 0600` restores acceptance.
- Missing path → `B5_DEVICE_PATH`; symlink inside root to a task-owned file → `B5_DEVICE_PATH`; file in a sibling task-owned scratch dir passed with the other root → `B5_DEVICE_PATH` (refused by the path check before any open/read).
- Each test unlinks every file/link it created and asserts its scratch dirs are empty; `scratch(t)` also removes the dirs.
- No uid-mismatch or open-race cases (per task).

## Commands, exits, counts

All test commands run as `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/16/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 [--test-name-pattern='^B5 device reader (exact size boundary|refuses hard links and public modes)$'] tests/improve-control-room-first-website-device.test.ts` (task commands, with PG_BIN=16 as above).

| Run | Exit | tests/pass/fail/skip/cancel | Note |
|---|---|---|---|
| selected, new tests | 0 | 2/2/0/0/0 | ~3.5 s |
| mutant A: stat-size guard `need(directory \|\| s.size <= cap, …)` removed (1 exact match) | 0 | 2/2/0/0/0 | **expected survival (defence control)**: the post-read `bytes.length <= cap` check still refuses 33 bytes with `B5_DEVICE_SIZE` |
| green after A restore | 0 | 2/2/0/0/0 | |
| mutant AB: both size checks removed (1 exact match each) | 1 | 2/1/1/0/0 | expected kill: `B5 device reader exact size boundary` fails "Missing expected rejection" at the 33-byte cap=32 assertion (test line 1141) |
| green after AB restore | 0 | 2/2/0/0/0 | |
| mutant C: only `&& s.nlink === 1` removed (1 exact match) | 1 | 2/1/1/0/0 | expected kill: `refuses hard links…` fails "Missing expected rejection" for `B5_DEVICE_CUSTODY` at the nlink=2 assertion (test line 1164); size test unaffected |
| green after C restore | 0 | 2/2/0/0/0 | |
| full device file | 0 | 75/75/0/0/0 | 11 s |
| `tsc --project tsconfig.vps.json` | 0 | — | 35 s |

Note: a first attempt at the AB mutant used a pattern with a stray trailing space that matched 0 times, so that run only applied A (and passed); it was discarded and redone with an asserted exact-one match for each removal (row above). Mutants were applied in place to the production module and restored from a byte copy, verified with `cmp` before each green rerun.

### Size layers, stated honestly

`readDeviceFile` has two independent size layers: the `lstat` size check in `custody()` and the post-read `bytes.length` check. Removing either alone is not detected by the 33-byte assertion because the other still refuses with the same code. Only deleting both is killed. The new tests prove the combined boundary, not each layer on its own.

## Cleanup

- `.test-tmp/` empty after all runs (`ls -A` showed nothing); no clusters or processes started.
- Ownership restored with `chown -hR root:root` before Git checks/commit.

## Scans

See the status file for the secret-scan and private-name output. The private-name check without a list is a SKIP, not a full privacy pass; the lead must run CI's configured privacy checks.

## Limitations

- PostgreSQL 16, not 17 (not used by this file).
- Dependencies from pnpm frozen lockfile, not `npm ci`.
- Per-layer size coverage is not separately provable through the public reader.
