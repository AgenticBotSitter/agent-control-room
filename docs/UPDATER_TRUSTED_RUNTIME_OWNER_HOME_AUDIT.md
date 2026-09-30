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
- `src/harness/hermes-021-v1/reviewed-executable-identity.ts` passes the owner's
  `HOME` while identifying a reviewed worker executable. It is reachable from
  owner-trusted CLI composition and fleet harness adapters, so item 6 must move
  the identification call to the connector.
- `src/harness/hermes-021-v1/subprocess-stream-json-host.ts` passes the owner's
  `HOME` in the runner spawn path. Item 6 must replace that service-reachable
  environment with connector-supplied evidence.
- `scripts/mac-local/start-web-host.mjs` passes the owner's `HOME` while probing
  configured local bot executables. The installed supervisor may not retain
  that probe; the connector must report bounded capability evidence instead.
- `scripts/qualify-local-workers.ts` passes the owner's `HOME` while qualifying
  local workers. It must remain an owner-side qualification command and must
  not be called by an installed service.

These are design questions for item 6. Item 3 does not weaken a profile to
keep them working.

## Owner-session and connector tools (expected owner-home access)

The following are not Control Room services. They intentionally run as the
interactive owner and remain outside the service profiles:

- `scripts/fleet/connector.mjs` reads the connector credential below the
  owner's configuration directory.
- `scripts/run-work-intake.ts` reads its owner-side client configuration.
- `scripts/mac-local/claude-review.mjs`,
  `scripts/mac-local/repin-workers.mjs`,
  `scripts/mac-local/rehearsal/setup.ts`, and
  `scripts/mac-local/probe-adapters.ts` discover or run owner-installed bot
  clients.
- `scripts/mac-local/service.mjs` manages the owner's legacy LaunchAgent. It is
  superseded for installed services by items 4 and 5.
- `scripts/test-runner/service.mjs` reads the dedicated test-runner account's
  configuration and uses its home only to construct explicit sandbox denies.
- `scripts/worker-inbox-platform/lib/runtime.mjs` and
  `scripts/worker-inbox-platform/lib/instructions.mjs` generate owner-side
  connector paths and install instructions.
- `src/harness/codex-v1/owner-trusted-local-exec.ts` launches the owner-installed
  Codex tool with the owner's `HOME`; it belongs only in the owner connector.
- `src/installer/v1/macos-local-launcher-bundle.mjs` reads the owner's home only
  while composing and validating the owner-session launcher bundle.
- `src/installer/v1/private-installed-configuration-native-verifier-custody.ts`
  and `src/installer/v1/private-installed-configuration-v3-owner-writer.ts`
  derive the expected protected configuration path in owner-session custody
  code; installed services must receive the resulting reviewed path instead.

## Build-time tools

`scripts/build-fleet-connector.mjs` reads the invoking build user's home only
to ensure that home-owned source paths are not copied into the connector
bundle. It is not shipped as a service runtime.

## Deliberate profile boundaries

The builder profile receives a per-job `TMPDIR`, and the trusted spawn boundary
sets that exact value in the builder child environment. The shared temporary
tree remains unwritable.

The profiles do not deny network access. Supervisor, gateway, PostgreSQL,
builder, and upgrader network policy must therefore be constrained by their
service design and host controls; item 3 does not claim a Seatbelt network
boundary.

Each profile currently makes one narrow exception to the `/usr/local` read
deny for the literal root-installed `/usr/local/bin/control-room` shim. This is
not an owner-home exception and does not permit listing or reading sibling
paths. The exception remains explicit pending the installer/daemon integration
decision about whether any service invokes the shim; it must not be widened.

Any new owner-home read reachable from supervisor, gateway, PostgreSQL,
builder, upgrader, dump, or restore is a release blocker. The resolution is to
move the operation to the owner connector or redesign the input, never to add a
profile exception. `tests/updater-trusted-runtime.test.mjs` scans production
sources for direct `HOME`/home-directory reads and fails when a source is not
listed in this audit.
