# Private macOS service tool adapter

**Status:** source-only production-shaped adapter with injected-port tests. It
has not written a LaunchAgent, invoked the service manager, started a process,
or inspected an owner's filesystem.

## Retained composition

`private-macos-service-tool-adapter.ts` sits beneath the accepted
`private-macos-service-owner-runner.ts`. The runner still owns attached-owner
confirmation, deadlines, cleanup bounds, uncertainty, final service evidence
and journal settlement. The adapter reuses its exact six-step install sequence,
the rendered `macos-local-service-package.ts` definition and the existing final
service observation. It creates no second lifecycle, store, supervisor, label,
service definition or retry loop.

The adapter accepts only the fixed `xyz.agentcontrolroom.local` label and the
exact `<captured owner home>/Library/LaunchAgents/xyz.agentcontrolroom.local.plist`
target. `/tmp`, `/var`, `/Library/LaunchDaemons` and suffix-only substitutes are
not owner homes and refuse. The reviewed service package, lifecycle, release,
LaunchAgents-directory identity and service identity are captured before use.
Only the ordered structured operations emitted by the runner are accepted.
Each native deadline is the earlier of the runner's overall deadline and the
fixed step timeout (30 seconds, or 120 seconds for service start). A synchronous
single-flight guard refuses a concurrent second call before native entry.
Shell text, ambient environment, caller-selected commands, reordered operations
and substituted definitions or paths refuse. Native methods are bound when the
adapter is created, so later mutation cannot replace them.

## Native blocker

Node does not expose the reviewed operations required to publish the
LaunchAgent through an already-opened parent directory and invoke the fixed
service-manager target with bounded process custody. A path-based `writeFile`
plus an ambient `launchctl` child would leave both publication and command
custody ambiguous. This package therefore adds no Node filesystem,
child-process or shell fallback. The accepted first-install guarantee is
defined in `MACOS_SERVICE_CUSTODY_DECISION.md`; it deliberately does not claim
that launchd consumed a particular filesystem inode.

A later reviewed native port must implement the structured step request. Its
receipt binds the request, lifecycle, release and rendered definition digests;
echoes the exact captured LaunchAgents-directory and service identity digests;
and returns an opaque publication identity digest when installation succeeds.
That digest proves the reviewed bytes were published and rechecked through the
held directory; it is not proof that launchd consumed the same inode. Journal
success additionally requires fresh authenticated application health bound to
the installation, release, configuration and service instance. The native
implementation must honor the runner's bounded cleanup signal. An explicit
`failed_before_effect` may be returned only before the named operation can
have taken effect. Throws, malformed receipts, cancellation after entry or
missing/changed identity facts are uncertainty and are never retried
automatically.

## Verification

`pnpm test:macos-service-tool-adapter` runs disposable injected-port checks for
the exact sequence, canonical owner target, deadline cap, concurrent-entry
refusal, digest identity continuity, immutable callables, refusal versus
uncertainty and absence of shell/environment/native implementations.
Construction is inert; no test invokes a real filesystem, process or
service-manager operation.
