# Installed Claude post-install handoff

Status: source-only integration. No Claude process, database, service, native
journal session, credential, or real installation is opened by this package.

The installed owner-host provider may now capture the existing optional
`claudePostInstall` tuple alongside its required Hermes runtime ports. The
protected loader carries that tuple through the installed Hermes composer and
the ordinary operator into the existing local runtime assembly. There is no
new admission format, transition store, scheduler, or worker lifecycle.

The tuple contains exactly `admissionInput`, `admissionRuntime`, and
`compositionInput`. Its admission input is data only; its two history/transition
readers and reviewed composition ports are supplied by the owner-held source
composition. Ordinary installed JSON still cannot supply functions, commands,
module names, or an alternate configuration loader. The new capture helper
reuses the existing host-value primitives to reject proxies and accessors
without evaluating them, copy private key bytes without caller-controlled
iteration, and capture the plain capability graph before any protected read.
Caller mutation cannot change the captured qualification record, key bytes,
reader selection, or process configuration.

The installed composer keeps Hermes, its queue and result graph mandatory. It
adds the Claude feature only when the optional captured tuple exists. Presence
is not admission: the existing runtime assembly still validates the original
settled installation, committed transition, exact qualification report,
process policy, adapter, release, authority, service and storage bindings before
constructing its branded Claude capability. It rereads the transition again
before startup and refuses drift. The original Hermes capability and shared
result-inspection path remain intact.

Provider, preflight handoff, loader and journal custody remain one-use, with
their existing blocker ordering. Claude cannot satisfy a missing Hermes input
or clear the native-journal qualification gate. The tuple is not a saved
capability: a new installed process must reconstruct owner-held ports and
repeat admission against current protected evidence.

Tests live in `tests/private-local-installation-runtime-assembly.test.ts`,
already registered in `test:server-composition`. They exercise the complete
provider-to-protected-loader-to-operator path using disposable configuration
files and injected nonexecuting ports, including immutable capture, malformed
tuples, retained blockers, qualification tampering, foreign installation,
adapter substitution, and a changed second transition observation. The startup
test stops at an injected artifact-storage sentinel; it starts no runtime.

The production owner-host provider, accepted concrete native implementations,
installed release binding and separate owner-attended qualification and
enablement remain prerequisites for live use. Signing into Claude alone does
not supply those proofs.
