# E80 — explicit compiled-release launcher

2026-09-06. Launcher implementation, help/refusal/filesystem tests only. No live start.

`scripts/run-private-vps.mjs` now supplies an operator executable around the existing
compiled renderer, restricted browser asset loader, installed PostgreSQL/pg-boss host
and E79 signal lifetime. There is no alternative HTTP server, supervisor or database
implementation. Importing the script is inert; direct invocation without exact explicit
configuration refuses. Help does not load the compiled application or operator module.

The only start argument is `--configuration` followed by an absolute `.mjs` path.
The file must be regular, nonsymlink, owned by the invoking POSIX user, inaccessible
to group/others and at most 256 KiB. Its canonical path must match. These are setup
checks, not protection against malicious trusted code or same-UID/admin replacement.
The release and configuration tree must be operator-controlled and immutable during
startup. Never accept this path from an HTTP request, worker message or downloaded job.

## Operator configuration contract

The trusted executable module exports:

- `schema = "control-room.private-vps-configuration/v1"`;
- `createConfiguration({ signal })`, returning the existing host's `configuration`,
  `port`, and optional `nativeHttps` inputs. See PrivateTaskStartupConfiguration in
  src/web/v1/private-task-startup.ts and NativeHttpsConfiguration in native-https-service.ts.

E83 additionally requires returned `mode: "website-only"` or `mode: "agent-tasks"`;
see REUSE_E83_EXPLICIT_LAUNCH_MODE.md. No real operator configuration existed to migrate.

Its role is to assemble reviewed configuration and already-qualified resources. It
must honor cancellation and must not start listeners/workers, provision databases,
perform deployment or acquire resources requiring separate cleanup. Static import
side effects are forbidden by this operator contract. Configuration is executable
trusted code, not sandboxed data; loader checks cannot enforce those behavioral rules.
Real key loading and any native credential-store operation retain their scoped authority.

The launcher installs stop observation before importing the operator module. It uses
fixed compiled release paths relative to itself, never cwd module discovery. The
renderer, assets and cancellation signal cannot be overridden by returned configuration.
Startup failures and uncertain cleanup use fixed messages and nonzero exit status,
without printing exception details or credentials. No forceful process exit or retry
is included; the eventual service manager owns hard termination and restart policy.

## Verification

Three tests pass: exact argument grammar; actual subprocess help/refusal commands;
ownership-mode/path checks using a temporary module that must never execute. The test
module/directory is removed afterward. Targeted lint passes after replacing a prohibited
control-character regex with equivalent character-code checks. No application source
or dependency change; no rebuild/full default lifecycle rerun was needed.

Successful launcher startup is NOT qualified: real configuration is not supplied and
no production service is installed. Existing E79 compiled-host evidence remains separate.
The next acceptance must test the launcher with reviewed disposable resources, then
real PostgreSQL/TLS/owner setup under a consolidated authorization. Do not present this
script alone as an installed or ready-to-use Control Room instance.
