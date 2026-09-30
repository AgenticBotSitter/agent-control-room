# Trusted-runtime owner-home audit

This is the item-3 audit required by the updater safety design. It records code
that still reads the interactive owner's home; it does not grant any Seatbelt
exception. Service profiles deny `/Users` in full.

## Must leave service processes

- `src/harness/claude-code-v1/owner-trusted-local-exec.ts` passes the owner's
  `HOME` and launches the owner-installed Claude executable. It is reachable
  from the current task-host composition. Item 6 must keep this only in the
  owner LaunchAgent connector.
- `src/harness/hermes-local-v1/owner-trusted-local-exec.ts` does the same for
  Hermes. Item 6 must keep it only in the owner LaunchAgent connector.
- `src/harness/hermes-021-v1/runner-compatibility.ts` probes an owner-installed
  worker with the owner's `HOME`. Item 6 must move that probe to the connector.
- `scripts/mac-local/start-web-host.mjs` passes the owner's `HOME` while probing
  configured local bot executables. The installed supervisor may not retain
  that probe; the connector must report bounded capability evidence instead.

These are design questions for item 6. Item 3 does not weaken a profile to
keep them working.

## Owner-session and connector tools (expected owner-home access)

The following are not Control Room services. They intentionally run as the
interactive owner and remain outside the service profiles:

- `scripts/fleet/connector.mjs` reads the connector credential below the
  owner's configuration directory.
- `scripts/run-work-intake.ts` reads its owner-side client configuration.
- `scripts/mac-local/claude-review.mjs`, `repin-workers.mjs`,
  `rehearsal/setup.ts`, and `probe-adapters.ts` discover or run owner-installed
  bot clients.
- `scripts/mac-local/service.mjs` manages the owner's legacy LaunchAgent. It is
  superseded for installed services by items 4 and 5.
- `scripts/test-runner/service.mjs` reads the dedicated test-runner account's
  configuration and uses its home only to construct explicit sandbox denies.
- `scripts/worker-inbox-platform/lib/runtime.mjs` and
  `scripts/worker-inbox-platform/lib/instructions.mjs` generate owner-side
  connector paths and install instructions.

## Build-time tools

`scripts/build-fleet-connector.mjs` reads the invoking build user's home only
to ensure that home-owned source paths are not copied into the connector
bundle. It is not shipped as a service runtime.

Any new owner-home read reachable from supervisor, gateway, PostgreSQL,
builder, upgrader, dump, or restore is a release blocker. The resolution is to
move the operation to the owner connector or redesign the input, never to add a
profile exception.
