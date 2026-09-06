# Supplied-resource native connector lifecycle

Architect implementation contract; not acceptance or authority to activate anything.

One connector owns one supplied node runtime and HTTP client/host for one preselected
canonical queue/task. Construction is inert. Explicit `run(initial|recover, signal)`
opens the transport and performs bounded exchanges. A runtime-owned observation of
accepted signed dispatch distinguishes waiting from ready; it is not execution permission.
Only existing guarded runtime start/poll operations can admit native calls. Initial
mode invokes start at most once, then polls; recover mode never invokes start. Reporting
and HTTP flushing follow the existing durable reporter and signed protocol owners.

The run has a configured cycle bound, interval and wall-clock deadline, one invocation
per connector, no overlapping native operations, no HTTP retries and no automatic
recovery after uncertainty. Terminal native state and ambiguous/unknown/offline state
are returned distinctly from reaching the cycle bound. Reaching a bound is not evidence
the upstream run stopped or completed. Normal exit disconnects and closes local owners;
failure/abort invalidates locally and drains underlying operations boundedly. It does
not issue a native stop, renew a lease or delete retained journals. Recovery requires
a new explicitly selected connector/runtime over the retained caller-owned journals.

The connector closes the supplied runtime and client, not their caller-owned journals,
signing keys, credentials or other resource stores. Capture supplied callbacks/config;
retain underlying pending operations through actual settlement. A close timeout remains
uncertain and cannot become a clean shutdown on retry. Return only bounded status, not
raw credentials, protocol bodies or result contents. Native TLS ports and waiting may
be injected for deterministic tests; no production effect is performed during this build.

A native factory composes the existing mTLS client and HTTP host, using the exact
configured destination/private pin and guarded runtime. Explicit exports are node-private.
The private server host exposes explicit `dispatch` to capture the existing verified
owner identity and exact task, stage then transmit on the same captured generation.
Both steps retain existing canonical approval/lease checks. A replaced connection
cannot inherit a pending dispatch; repeated overlapping calls are refused. This is
not a new web endpoint, signer, approval or global queue, nor proof of native start.
Continuous multi-task selection belongs to CR14D. Service installation, physical listener,
credential/journal provisioning, native qualification and deployment remain gated.
