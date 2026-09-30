# Running DB tests from a sandbox

The local test runner lets a sandboxed helper ask a trusted Mac-side service to run one approved test command. Every command runs under a per-run macOS Seatbelt (`sandbox-exec`) profile that starts from **deny by default** (on top of Apple's `system.sb` base). This is what stops a test file the helper wrote — whether it is the `--file` target or the code behind an allowed package script — from reaching anything outside its run:

- **Reads:** the system is readable, but nothing under the service account's home, `/tmp`, `/var/folders` or `/Volumes` is, except the worktree, the run's own temporary directory, and the node and PostgreSQL install trees. The token file, audit log and config folders, `~/.config`, `~/.claude`, `~/.codex`, `~/.pgpass`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.gitconfig`, `~/Library/Keychains`, `~/work/acr-private`, every `~/work/acr-package-*` live-app folder, and any configured `protectedReadPrefixes` stay unreadable and unwritable even if they sit inside an allowed root.
- **Writes:** only the worktree and the run's temporary directory.
- **Network:** loopback TCP only on the run's port block, and Unix sockets only inside the run's temporary directory. A local PostgreSQL socket, ssh-agent or Docker socket elsewhere is refused.
- **Programs:** node, the PostgreSQL binaries, esbuild from the worktree's `node_modules`, and a short list of shell tools. `launchctl`, `open`, `osascript` and `ssh` cannot be executed, LaunchServices and Apple Events are denied, and a test can signal only processes inside its own run's sandbox, so it cannot hand work to anything unsandboxed or stop the live app or this service.
- **Other processes:** a test can see the command line, environment, working directory and open files only of processes inside its own run. It cannot read them for this service, the live app, an agent session or another run, and it cannot list the process table. This matters because those environments hold credentials, and the worktree is writable, so the rule has to hold against native code a helper compiled, not just against node. (`(deny default)` does not cover this on current macOS. The profile denies process info and the `kern.procargs*`/`kern.proc.*` sysctls explicitly; both are needed.) `lsof` is not available to tests.

System folders outside the home directory, such as `/opt/homebrew`, `/Library` and `/private/etc`, stay readable, so do not keep secrets or a live database there.

The environment sets `HOME` and `TMPDIR` to the run's temporary directory, and `ATTACK_KIT_SOCKET_ROOT` to the same place so the attack kit's short Unix-socket folders stay inside the run. Git is not available to tests under the runner (the shared `.git` is outside every allowed root), `/bin/ps` cannot run under any Seatbelt profile because it is setuid, and `perl` is not on the exec list. So `tests/attack-kit.test.ts` and three tests in `tests/postgres-shared-memory-teardown.test.mjs` fail under the runner today and must still be run by hand.

## One-time host setup

1. Copy `scripts/test-runner/config.example.json` to the default private location at `.config/agent-control-room/test-runner.json` under the service account's home directory, or choose another private path and pass `--config` to both commands.
2. Replace every placeholder with an absolute path. Keep the token and audit log outside every repository. Each worktree entry is an absolute string prefix, such as `/path/to/work/acr-cook-`.
3. In `allowedScripts`, pin every allowed package-script name to the EXACT command string that name must have in `package.json` — copy it verbatim. The service refuses a request the moment the worktree's `package.json` disagrees with the pinned text, byte for byte, and it never invokes `pnpm`: the pinned string is parsed into a literal `node` argv and spawned directly, so a worktree's `.npmrc`, `node_modules/.bin`, or pre/post-script hooks can never widen what runs.
4. Optionally list more absolute directories under `protectedReadPrefixes` that the sandbox must refuse to read. The service **refuses to start** if the token, audit or config folder, or any protected prefix, contains a worktree prefix's parent folder or `/tmp`, and it refuses a run (`500 sandbox_profile_invalid`) if a protected folder would contain the worktree or a toolchain tree. A deny that cannot be enforced is never silently dropped.
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

Every run uses a new short `/tmp/acr-tr-*` directory and a detached process group, sandboxed as described above. On completion, cancellation, or timeout, the service stops every PostgreSQL instance it finds under that run's temporary directory (including one the attack kit's own cluster registry names) whose port is inside the assigned block and whose command name and working directory prove it is really a postmaster rooted there — `pg_ctl start` runs the postmaster under `setsid`, outside the runner's own process group, so this check does not rely on process-group membership. A data directory, whether found under the temporary directory or named in the registry, must resolve inside the run's temporary directory or worktree before it is trusted. It then terminates the run's process group, kills any other process still holding a working directory under the run's temporary directory, and kills every process that still carries the run's `CONTROL_ROOM_TEST_RUN_ID` in its environment (catching a detached grandchild that kept the worktree as its working directory and started its own session), and removes the temporary directory. If anything still holds a TCP socket on the run's port block after that, the block is quarantined and not handed to another run until it is clear. It never calls `reap-orphans.sh` or `ipcrm`. If the client disconnects before a run finishes, or even before it starts, the service aborts or skips that run immediately rather than holding its concurrency slot and port block until the timeout.

The private JSON-lines audit log records the worktree, approved command, port block, duration, exit status, and output byte count. It never records the bearer token or command output.
