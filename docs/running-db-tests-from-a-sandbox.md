# Running DB tests from a sandbox

The local test runner lets a sandboxed helper ask a trusted Mac-side service to run one approved test command. Every command runs under a per-run macOS Seatbelt (`sandbox-exec`) profile: it can write only to its worktree and its own run's temporary directory, it cannot read the token file, the audit log, the config, `~/.ssh`, keychains, or any configured protected prefix, and it can reach the network only on loopback ports inside its assigned block. This is what stops a test file the helper wrote — whether it is the `--file` target or the code behind an allowed package script — from reaching anything outside those bounds.

## One-time host setup

1. Copy `scripts/test-runner/config.example.json` to the default private location at `.config/agent-control-room/test-runner.json` under the service account's home directory, or choose another private path and pass `--config` to both commands.
2. Replace every placeholder with an absolute path. Keep the token and audit log outside every repository. Each worktree entry is an absolute string prefix, such as `/path/to/work/acr-cook-`.
3. In `allowedScripts`, pin every allowed package-script name to the EXACT command string that name must have in `package.json` — copy it verbatim. The service refuses a request the moment the worktree's `package.json` disagrees with the pinned text, byte for byte, and it never invokes `pnpm`: the pinned string is parsed into a literal `node` argv and spawned directly, so a worktree's `.npmrc`, `node_modules/.bin`, or pre/post-script hooks can never widen what runs.
4. Optionally list absolute directories under `protectedReadPrefixes` that the sandbox should also refuse to read (for example, a private planning repo outside every worktree).
5. Reserve the configured port pool for this service. A run receives one whole block; the first port is `CONTROL_ROOM_PG_TEST_PORT_BASE` and the remainder is `CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE`.
6. Start the host-side service outside the sandbox:

   ```sh
   pnpm test-runner:serve
   ```

On first start, the service creates a 256-bit bearer token with mode `0600`. It refuses a token file or audit log that is a symlink, belongs to another user, or is accessible by group or other users. The HTTP listener is always `127.0.0.1`.

## From the sandbox

Do not start PostgreSQL yourself. Ask the service to run either one test file:

```sh
node scripts/test-runner/client.mjs --worktree /absolute/path/to/acr-cook-worktree --file tests/example.test.ts
```

or one configured package script:

```sh
node scripts/test-runner/client.mjs --worktree /absolute/path/to/acr-cook-worktree --script test:database
```

The file form accepts only files under `tests/` ending in `.test.ts`, `.test.tsx`, or `.test.mjs`. The script form accepts only an exact configured name whose `package.json` body matches the pinned command byte for byte. No extra arguments or caller environment variables cross the boundary.

The client prints the exit status, TAP counts, failing test names, and a capped log excerpt. It exits nonzero when the service refuses the request, the command fails, or the run times out. The client has no request timeout of its own, so a long-running approved command (the configured `timeoutMs` can be up to an hour) is never cut off on the client side while the server is still working on it.

## Cleanup and records

Every run uses a new short `/tmp/acr-tr-*` directory and a detached process group, sandboxed as described above. On completion, cancellation, or timeout, the service stops every PostgreSQL instance it finds under that run's temporary directory (including one the attack kit's own cluster registry names) whose port is inside the assigned block and whose command name and working directory prove it is really a postmaster rooted there — `pg_ctl start` runs the postmaster under `setsid`, outside the runner's own process group, so this check does not rely on process-group membership. It then terminates the run's process group, kills any other process still holding a working directory under the run's temporary directory (catching a detached grandchild that escaped the group by starting its own session), and removes the temporary directory. It never calls `reap-orphans.sh` or `ipcrm`. If the client disconnects before a run finishes, the service aborts that run immediately rather than holding its concurrency slot and port block until the timeout.

The private JSON-lines audit log records the worktree, approved command, port block, duration, exit status, and output byte count. It never records the bearer token or command output.
