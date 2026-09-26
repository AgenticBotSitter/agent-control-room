# Private macOS service runtime port

**Status:** source-only production composition with disposable injected-host
tests. It has not written a LaunchAgent, called `launchctl`, started or stopped
a service, read a credential, opened a network connection, or changed an
installation.

## What this package completes

`private-macos-service-runtime-port.ts` fills the narrow composition beneath
the accepted macOS service owner runner and tool adapter. It binds one owner
GUI domain, the fixed `xyz.agentcontrolroom.local` label, the exact owner
LaunchAgents target, and the reviewed release, service definition, service,
database, protected-data and supervisor evidence digests before any injected
host method can be called.

The runtime supplies:

- a separately frozen `nativePort` view with exactly the four keys required by
  the existing strict tool adapter (`schema`, `performStep`,
  `observeInstalledService`, and `cleanup`), sharing the runtime's locks and
  uncertainty state;
- a read-only preflight that observes the fixed target but cannot start it or
  write the definition;
- fixed status, start, stop and restart controls for later owner-held
  composition; and
- final redacted health observation compatible with the existing platform
  service evidence.

There is no command string, shell, ambient environment, alternate label,
caller-selected target, generic process controller, new supervisor, database,
scheduler or receipt store.

## Failure and duplicate rules

Construction is inert. Every operation has a bounded deadline and abort
signal. Authorization and host calls are included in that deadline; a private
child signal is cancelled when the deadline expires. Final health observation
is similarly deadline-bounded and is validated only after a timely return.
Cleanup uses a fixed 30-second ceiling and forwards either caller cancellation
or that ceiling to the injected host, so a never-settling cleanup cannot leave
the adapter pending indefinitely. Host replies must repeat the complete
captured target and identity.
A mutating control additionally requires a captured owner-held authorization
callback to return an exact request-bound confirmation before even the service
status host is entered. Read-only status and preflight do not require that
confirmation. The callback is an injected private capability, not a browser
boolean or configuration-file claim.
A known refusal before an effect remains a refusal. A thrown, malformed,
changed or lost reply is uncertainty.

Exact repeated controls share an in-flight operation and replay one completed
receipt without repeating the effect. Reusing an operation ID with changed
content refuses. An operation that becomes uncertain is poisoned in that live
port and cannot be repeated automatically. A successful mutation followed by
cancelled, expired, unknown or malformed final status is also uncertainty—not
a clean refusal. All mutation entry points share one lock, so an install/start
step and a different start/stop/restart request cannot overlap. The registry is deliberately
bounded and process-local; durable owner-action settlement remains the
responsibility of the existing installation journal rather than a new store.

Restart is stop then start. Once stop is known to have succeeded, any missing
or failed start is uncertainty and is not retried. The accepted upper service
lifecycle remains responsible for release-update rollback; this lower port
does not invent a competing rollback policy.

## macOS availability statement

This is a per-user LaunchAgent. The accepted service is expected to return at
the owner's next login. It is **not** a pre-login or logged-out system service.
Supporting that behavior would require a separately reviewed LaunchDaemon or
signed-app design.

## Remaining owner/native gate

The injected host is still required to implement descriptor-safe definition
publication and the fixed service-manager operations under attached-owner
authorization. Real publication, service registration, start, stop, restart,
background-item consent and qualification remain owner-attended effects. The
source package must not be described as a live installed service until that
host is separately implemented, reviewed and qualified.

## Verification

```text
node --import tsx --test tests/private-macos-service-runtime-port.test.ts
npx tsc --noEmit --incremental false
```

The disposable suite covers inert construction, read-only preflight,
strict runtime-to-tool-adapter composition, initial-install compatibility,
deadline-bounded authenticated-health shaping, start, status,
stop, restart, exact replay, concurrent duplicate suppression, changed-request
refusal, authorization and host deadline expiry, no mutation after refusal,
post-effect uncertainty poisoning, cross-entry mutation exclusion, bounded cleanup and
honest owner-login-only availability.
