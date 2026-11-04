# b5-transport-digest-binding findings

## Bases
- Starting HEAD (published base, task-doc commit): d33ffca8181f011ee0ddc443d21b0cb3eb1a5ff2
- Parent / implementation base: 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041 (verified `HEAD^`)
- Output branch: cloud/b5-transport-digest-binding

## Changed files
- tests/improve-control-room-first-website-device.test.ts — new test "B5 transport file digest binds exact private bytes"; adds `loadB5TransportV1` and `rename` to existing imports.
- docs/cloud-tasks/b5-transport-digest-binding-findings.md — this file.
- No production, package, lockfile, workflow, schema or migration change.

## Setup (actual)
| command | exit |
|---|---|
| `node --version` (v22.23.4) | 0 |
| `npm ci` | 1 (EUSAGE: repo has no package-lock.json; it pins pnpm and ships pnpm-lock.yaml) |
| `pnpm install --frozen-lockfile` (repo's own lockfile, pnpm 11.19.0) | 0 |
| `test -x node_modules/.bin/tsx` | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not in distro repos) |
| fetch of PostgreSQL apt signing key (to add PGDG repo) | 22 (HTTP 403 via proxy); repo entry removed again |
| `id builder` | 0 (already present) |
| `mkdir -p .test-tmp && chown -hR builder:builder "$PWD"` | 0 |

PostgreSQL 17 unavailable; newest present was 16, so `PG_BIN=/usr/lib/postgresql/16/bin` was used in place of the `/17/` path in the commands. The selected test and the device suite use no native PostgreSQL, so this does not affect the result.

## Test design
- `scratch(t)` root (asserted 0700); qualification file placed by writing a 0600 `wx` staging file then `rename` over the target (asserted 0600, single link, regular file).
- `authorizedAt`/`expiresAt` refreshed to now−60 s / now+1 h so the fixed fixture date cannot decide outcomes.
- Pins are `b5DeviceHashV1` of the serialized bytes, computed and retained before each call; the wrong pin is a literal all-zero sha256.
- Cases: matching pin accepts; omitted pin accepts (current API); wrong pin → `B5_DEVICE_QUALIFICATION_CHANGED`; trailing-whitespace replacement (asserted to parse to an equal value) → old pin and wrong pin refuse with `B5_DEVICE_QUALIFICATION_CHANGED`, new independent pin accepts, omitted pin accepts; malformed JSON (0600) with mismatched pin → `B5_DEVICE_QUALIFICATION_CHANGED`, with its own matching pin → `B5_DEVICE_JSON`, and unpinned → `B5_DEVICE_JSON`.
- Success is defined by literal codes/origin/login, not by values read back to define expectations.

## Runs (as builder, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1, PG_BIN=/usr/lib/postgresql/16/bin)
| run | exit | tests/pass/fail/skipped/cancelled | duration |
|---|---|---|---|
| selected new test, initial green | 0 | 1/1/0/0/0 | ~4 s |
| **expected control failure**: selected test in mutant graph | 1 | 1/0/1/0/0 | ~4 s |
| selected new test, restored | 0 | 1/1/0/0/0 | ~2 s |
| full device module | 0 | 74/74/0/0/0 | ~12 s |
| `tsc --project tsconfig.vps.json` | 0 | — | ~39 s |

### Mutant (red)
Task-owned scratch module graph at a disposable /tmp directory (copy of the checkout without .git/node_modules/.test-tmp, node_modules symlinked). Exact-one-match edit in `scripts/workflow-journeys/first-website-device.ts` replaced only the `expectedDigest` comparison line with `void expectedDigest;`. The new test failed with `AssertionError: Missing expected rejection.` expecting `code: 'B5_DEVICE_QUALIFICATION_CHANGED'` at the wrong-pin assertion (test line 1155), after the matching-pin and omitted-pin acceptances passed — i.e. a behavioral failure, not date/path/import/JSON setup. The scratch graph was then deleted; the real checkout's production file was never edited.

## Cleanup
- Mutant graph removed (verified absent). `.test-tmp/` contains 0 entries after runs (fixture teardown removed its scratch root).
- No PostgreSQL cluster or listener started. Ownership restored with `chown -hR root:root "$PWD"` before Git operations.

## Scans
- Secret scan on the two allowlisted files: exit 0, `secret-scan files=2 findings=0`.
- Private-name guard (no list): exit 0, SKIP ("no list configured").
- `git diff --check`: exit 0.

## Limitations
- Establishes byte binding and digest-before-JSON precedence with synthetic fixtures only; not a real Tailscale, device or owner qualification.
- PostgreSQL 16 used instead of 17 (irrelevant to these tests).
- Private-name guard without CI's list is a SKIP, not a full privacy pass; the lead must run configured CI privacy checks.
- Approximate total elapsed for the task: under 15 minutes.
