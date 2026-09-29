# Private macOS service owner runner

**Status:** source-only initial-install boundary. It has not installed or
started a service. The repository still has no reviewed production launchd,
process, filesystem or service-observation implementation for this port.

## Reuse decision

This package composes the existing Control Room contracts instead of adding a
second supervisor or state machine:

- `platform-service-lifecycle.ts` remains the authority for the ordered
  initial-install steps and the exact release, plan, service, database,
  protected-data and supervisor-readiness bindings;
- `macos-service-owner-action.ts` remains the executor-neutral step sequencer;
- `macos-local-service-package.ts` remains the fixed label, argument and plist
  renderer and continues to forbid environment variables;
- `local-platform-service-observation.ts` remains the terminal service-state
  evidence parser; and
- the existing installation-plan journal remains the only receipt store.

The earlier T3 review in `PLATFORM_SERVICE_LIFECYCLE.md` already supplied the
useful stop/order/recovery concepts. No additional external framework, command
runner, service manager or process supervisor is needed for this seam.

## Boundary and guarantees

`src/installer/v1/private-macos-service-owner-runner.ts` accepts only the
already-prepared macOS initial install from `not_installed`. It re-verifies the
complete lifecycle and rendered service package, requires exact passed
database, protected-data, first-owner and recovery prerequisites, and requires
an attached-owner confirmation bound to the request and lifecycle digests.

The injected tool receives only branded structured step requests from the
existing lifecycle. Callers cannot provide a command, service operation,
environment variable, retry policy or alternate label. The service definition
is the exact reviewed rendering with one fixed label and fixed arguments. A
known failure before any write refuses; malformed replies, cancellation,
deadline expiry, observation mismatch, or failure after a write may have begun
are uncertainty. Cleanup is independently bounded and must be confirmed before
any terminal confirmation is returned.

After all steps complete, the runner independently requires an exact running
observation bound to the topology, release, service identity, database,
protected data and supervisor-readiness record. The result contains digests and
state only. It grants no agent readiness. A separate settlement function can
advance only the existing running `platform_service` stage, using one exact
terminal receipt in the existing append-only installation journal.

There is no uninstall, repair, delete, retry, fallback, second database,
migration system, credential store, listener, or live process capability in
this package.

## Exact production blocker

No default tool port is supplied. Production still needs one separately
reviewed owner-attended macOS implementation that performs the fixed launchd
definition write and service transitions, returns the required structured
replies and final observation, and proves bounded cleanup. Until that binding
is reviewed and qualified from an attached Terminal, this contract cannot make
a local background service operational.

The focused tests use injected fakes only. They cover exact sequencing,
request shape, fixed identity, changed inputs, attached-owner binding, mutable
port substitution, pre-effect refusal, post-start uncertainty, cancellation,
deadlines, cleanup, final evidence, journal identity and exact replay. They are
source evidence, not a native launchd rehearsal.
