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

Node does not expose a safe operation that can publish the LaunchAgent through
an already-opened parent directory with no-follow and exact file identity, then
bind the service-manager operation to that same identity. A path-based
`writeFile` plus `launchctl` child process would reopen the race and would also
make command and environment custody ambiguous. This package therefore adds no
Node filesystem, child-process or shell fallback.

A later reviewed native port must implement the structured step request. Its
receipt binds the request, lifecycle, release and rendered definition digests;
echoes the exact captured LaunchAgents-directory and service identity digests;
and returns an opaque definition identity digest when installation succeeds.
Every later start and health step must preserve that exact definition identity.
The digest is a native identity token, not a claim that Node observed a device
or inode. The native implementation must establish its digest using no-follow,
identity-bound handles. It must separately implement final observation and
honor the runner's bounded cleanup signal. An explicit `failed_before_effect`
may be returned only before the named operation can have taken effect. Throws,
malformed receipts, cancellation after entry or missing/changed identity facts
are uncertainty and are never retried automatically.

## Verification

`pnpm test:macos-service-tool-adapter` runs disposable injected-port checks for
the exact sequence, canonical owner target, deadline cap, concurrent-entry
refusal, digest identity continuity, immutable callables, refusal versus
uncertainty and absence of shell/environment/native implementations.
Construction is inert; no test invokes a real filesystem, process or
service-manager operation.
