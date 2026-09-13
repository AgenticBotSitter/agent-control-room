# macOS worker preparation

This is the safe preparation path for a separately installed Control Room worker on macOS. It does not install, enroll or start Hermes, Codex or another harness. A passing preparation report means only that already-supplied facts match the operator-selected connector profile; it is not permission to run work.

## Before a worker can be enabled

The operator must select one reviewed connector profile and provide a sanitized preparation input for `scripts/check-private-worker-preparation.mjs`. The input binds:

- the Control Room tenant and node identities;
- `macos` and the expected processor architecture;
- opaque digests for the private endpoint and connector profile;
- exact bridge, harness and Node runtime identifiers, versions and integrity digests;
- already-observed aggregate memory and storage facts; and
- current, separately trusted capability evidence.

Do not run a harness to discover its version. Obtain the exact version and integrity identity from the reviewed installed-package record. Do not put a URL, hostname, username, path, credential or command output in the preparation input. The checker has no field for those values and returns no endpoint or local path.

Run the checker only after the repository's frozen dependency preparation has succeeded:

```sh
node --import tsx scripts/check-private-worker-preparation.mjs --input /absolute/path/to/sanitized-worker-facts.json
```

`ready: true` is a configuration result, not execution authority. An unavailable operation, stale telemetry, unverified capability, wrong profile or any identity mismatch keeps the worker unavailable. Missing usage is reported as `unknown`, never zero.

## Initial and recovery operation

Use the reviewed `scripts/run-private-node.mjs` entry with an operator-owned configuration. `initial` is one start attempt. `recover` reads only the exact durably recorded run. The launcher intentionally has no automatic restart loop. A transport may reconnect only under its existing reviewed reconnect policy; that does not permit a new process, task, turn or delivery.

If the Terminal process is interrupted, preserve every bridge, start, run, admission, execution and effect journal. Reopen those exact files and inspect their recorded state before choosing recovery. A recorded thread with an unknown turn is unresolved and cannot be read, resumed or restarted automatically.

## Upgrade and removal

For an upgrade, stop new assignment admission, let owned work drain, and retain the current release plus every journal until the new release has passed the same preparation check and a recovery rehearsal. Do not migrate, overwrite or recreate credentials as part of a code upgrade. Keep repositories and active worktrees intact.

For removal, first revoke future admission at Control Room and stop the operator-managed worker. Retain credentials in their native store, repositories, worktrees and all unresolved journals for manual disposition. This project deliberately provides no recursive deletion or credential-removal command. Removing application files does not prove that a running process drained or that unfinished work is safe to discard.

Real enrollment, native execution, credential access and persistent service setup remain separately approved operations.
