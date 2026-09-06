# E59 — VPS task transport compatibility

2026-09-06. Local source/build verification; no listener or deployment.

Executable-startup inspection found a route/transport mismatch. The Node bridge rejected
every body over 8,192 bytes, while protected task routes allow 16,384/24,576/32,768-byte
envelopes. A valid 3,000-character task can exceed 8 KiB in UTF-8. Direct Fetch-handler
tests missed this hop.

The bridge now permits at most 32,768 bytes for POSTs in the existing project task API
namespace, retaining the 8,192-byte ceiling elsewhere. Declared lengths and streamed
bytes use the same ceiling. Authentication, endpoint schemas/body limits, normalization,
deadlines and active-request limits remain unchanged. Namespace matching is not authority.

Fourteen transport checks pass: exact UTF-8 bounds, declared/chunked lengths, overflow
and similarly named non-task paths. The compiled startup test sends a valid >8 KiB
proposal through the compiled Node bridge, protected route and disposable SQL store,
receiving 201. All 35 compiled regressions, TypeScript, targeted lint and production
build pass. Existing build warnings remain. No new full-suite acceptance is claimed.

## Startup findings for the next block

Reuse existing `createPrivateNodeService` and compiled `serving.js`; no new listener is
needed. Installed Vinext CLI defaults to `dist` and binds all interfaces in production.
Our output is `dist-vps`, and the existing private service is loopback-bound. Plain
`vinext start` is not the private setup command.

The default task startup closure has no queue factories. Compose existing installed
queue factories explicitly, then compiled handler/assets/service in the same process
so they share the installed application. Full configuration still requires checkpoint,
trust, session/signing and key-source collaborators: an environment example or JSON
file alone cannot provide these callable resources. Owner signing remains separate.

Runnable host configuration and credential provisioning are unfinished. No service,
provider, new download, secret access or GitHub publication occurred. Sites guidance
was checked; existing Sites metadata and the separate VPS architecture were preserved
under the owner's local-only instruction.
