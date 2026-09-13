# Linux worker preparation

This is the safe preparation path for a separately installed Control Room worker on a Linux workstation or private server. It performs no package installation, enrollment, service setup or harness execution.

## Preparation boundary

Choose one reviewed connector profile and prepare the strict sanitized input consumed by `scripts/check-private-worker-preparation.mjs`. It must bind the intended tenant, node, `linux` platform, architecture, opaque private-endpoint digest, connector-profile digest, and exact bridge, harness and Node runtime versions and integrity digests. Supply only already-observed aggregate capacity facts and separately trusted capability evidence.

Never invoke Hermes, Codex or another harness merely to identify its version. Use the reviewed installed-package or release record. Do not include hostnames, addresses, account names, paths, environment variables, credentials or raw command output. They are neither accepted nor returned by the checker.

After the repository's frozen dependency preparation, check the supplied facts with:

```sh
node --import tsx scripts/check-private-worker-preparation.mjs --input /absolute/path/to/sanitized-worker-facts.json
```

The result is fail-closed. Missing or mismatched runtime facts refuse. Stale or unverified capabilities remain unavailable. Missing usage remains `unknown`. Even `ready: true` grants no execution authority and starts no harness.

## One-shot lifecycle

The reviewed `scripts/run-private-node.mjs` launcher accepts one explicit mode. `initial` can make one bounded start; `recover` can read only the exact run identity retained in the private journals. Do not wrap it in a shell, service-manager or container restart loop. Existing connector transport reconnection is the only automatic reconnection allowed, and only where that connector already supports it.

On cancellation or host interruption, preserve all private journals. An uncertain drain, late resource acquisition or partial thread/turn record requires operator attention and never permits a second process, task, turn or delivery. Cleanup may close resources acquired by that launcher attempt; it must not delete shared state or unrelated processes.

## Nondestructive upgrade and retirement

Before upgrading, stop new admissions and drain the current worker. Keep the old release and all journals available until the replacement passes preparation and recovery rehearsal. Never overwrite credentials, repositories, worktrees or unresolved journals during an upgrade.

To retire a worker, revoke future admission in Control Room, then stop the separately managed launcher or service. Preserve native credential storage, source repositories, active worktrees and unresolved journal files for deliberate operator review. No broad delete command is supplied. Uninstalling code is not proof of a clean drain and does not authorize journal or workspace deletion.

Persistent services, real credentials, enrollment and native/provider calls require their own reviewed operator procedure and explicit authority.
