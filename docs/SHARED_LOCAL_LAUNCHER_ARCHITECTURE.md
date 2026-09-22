# Shared local launcher architecture

## Decision

Agent Control Room uses one trusted local-launcher core for every supported
desktop platform. Platform packages supply only the operating-system boundary:
the verified archive wrapper, the fixed browser opener executable, and later a
native service adapter. They do not get a separate setup flow, database,
scheduler, permission system, or journal.

The accepted macOS package is the first adapter over this core. Linux can reuse
the same core with its own deterministic wrapper and `xdg-open` boundary.
Windows still needs a native custody, process, browser-opener, and service
adapter before it can use this core safely.

## Security properties

- The outer archive verifier returns the exact inner release-manifest digest.
- The core stages and re-verifies that exact release before any child runs.
- Resume requires the expected release version and manifest digest and compares
  both with the saved journal before dependency preparation.
- A release upgrade keeps the same installation topology identity but cannot
  accidentally run preparation for the older release.
- The setup host opens only `http://127.0.0.1:3210/setup`.
- The platform adapter fixes the opener executable; untrusted input cannot
  select a command or URL.
- The supervisor owns termination and reaping of its child process group.

## Reuse decision

This is an **internal extraction and narrow adaptation**, not a new launcher.
It reuses Control Room's accepted release assembler, release stager, dependency
preparer, clean-install rehearsal, setup-plan bootstrap, setup host, and process
supervisor. T3 Code and the reviewed Hermes desktop projects were useful
references for packaging and local-session presentation, but their application
state, authority, update, credential, and process models do not replace Control
Room's existing security boundaries. No donor source code is copied here, so no
new third-party notice is required by this package.

## Not yet claimed

This source package does not publish a release, install a persistent service,
create a database, enable a worker, or prove Linux or Windows installation.
Those effects remain separate reviewed stages.
