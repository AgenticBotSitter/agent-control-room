# Running DB tests from a sandbox

The local test runner lets a sandboxed helper ask a trusted Mac-side service to run one approved test command. The service is not another sandbox: only configure worktrees and package scripts that are safe to execute with the Mac user's file access.

## One-time host setup

1. Copy `scripts/test-runner/config.example.json` to the default private location at `.config/agent-control-room/test-runner.json` under the service account's home directory, or choose another private path and pass `--config` to both commands.
2. Replace every placeholder with an absolute path. Keep the token and audit log outside every repository. Each worktree entry is an absolute string prefix, such as `/path/to/work/acr-cook-`.
3. Reserve the configured port pool for this service. A run receives one whole block; the first port is `CONTROL_ROOM_PG_TEST_PORT_BASE` and the remainder is `CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE`.
4. Start the host-side service outside the sandbox:

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

The file form accepts only files under `tests/` ending in `.test.ts`, `.test.tsx`, or `.test.mjs`. The script form accepts only an exact configured name that is present in that worktree's `package.json`. No extra arguments or caller environment variables cross the boundary.

The client prints the exit status, TAP counts, failing test names, and a capped log excerpt. It exits nonzero when the service refuses the request, the command fails, or the run times out.

## Cleanup and records

Every run uses a new short `/tmp/acr-tr-*` directory and a detached process group. On completion, cancellation, or timeout, the service stops only PostgreSQL instances whose `postmaster.pid` is under that run directory, whose port is inside the assigned block, and whose process group is the one created for that run. It then terminates that process group and removes the temporary directory. It never calls `reap-orphans.sh` or `ipcrm`.

The private JSON-lines audit log records the worktree, approved command, port block, duration, exit status, and output byte count. It never records the bearer token or command output.
