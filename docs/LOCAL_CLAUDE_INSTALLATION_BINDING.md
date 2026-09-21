# Local Claude installation preparation

This source-only preparation binds existing evidence to the running
`agent_readiness` installation stage. It starts no process, constructs no
callback, enables no worker and grants no task, retry or resume authority.
It cannot qualify Claude, install it, read credentials or advance setup.

The matching reuse-map row is **Claude Code: retain Control Room; official SDK
is a test reference**. The decision in
[CLAUDE_CODE_PRIVATE_PROCESS_ACQUISITION_REUSE_DECISION.md](CLAUDE_CODE_PRIVATE_PROCESS_ACQUISITION_REUSE_DECISION.md)
remains unchanged. Anthropic's MIT SDK at
`f7547d7233527739ece8b12ed28c57be96c966b5` supplied earlier framing/cleanup
test references only. No donor source or additional dependency is retained.

## Binding and trust boundary

`prepareLocalClaudeInstallationBindingV1` consumes private installation inputs:
the exact topology and selected local Claude route, release, accepted connector
profile, captured fixed process configuration, complete existing Claude process
readiness, installation readiness, backup/restore proof, supervisor readiness,
and separately retained process and healthy-service observations. The process
observation binds its readiness to that exact route, profile, configuration and
release. The existing `local_runner_bridge` proof must name the Claude process
readiness digest. Recovery and service outcomes must match the passed setup
stages; protected-data identity must match the observed service.

The output contains only fingerprints, stage/revision, a fixed text-review
classification and false capability flags. Exceptions contain one fixed refusal
code. Private paths, arguments, worker identities and raw evidence never leave
this boundary. `verifyLocalClaudeInstallationBindingV1` recomputes everything
against separately supplied current private inputs; a saved preparation or a
newly calculated hash cannot validate itself. Changed, revoked, uncertain,
missing or malformed observations are refused. The private installer must
independently reread observations before calling this function: hashes are not
authenticated evidence, current health checks or protection against replaying
an entire old private snapshot.

The shared `local-platform-service-observation.ts` owns the strict service
observation shape and digest used by both Hermes and Claude. It preserves the
original v1 hash domain so previously recorded platform-service outcomes remain
valid. The old Hermes digest helper remains a compatibility wrapper. No service
stage, supervisor, scheduler or database is created per harness.

## Exact remaining source and owner boundary

The existing executor already joins the queue, authenticated delivery receipt,
owned session, stream decoder, protected terminal staging, publication and
restart recovery. Private application admission already requires Claude process,
backup/restore and supervisor proof. This preparation deliberately mounts no
callback into that admission path.

The missing implementation remains a qualified process host beneath
`AcquireClaudeCodeProcessV1` and `OwnedClaudeCodeProcessV1`. That existing seam
receives a binding fingerprint but not the canonical `prepared.delivery.input`.
The installed program's input interface, private authentication custody,
cancellation/kill/reap behavior and restart-result behavior still require
owner-attended qualification. If stdin is qualified, extend the existing byte
port/session with bounded input delivery; do not invent another session owner.
Until then this preparation reports `qualified_private_process_host_required`,
even with complete supplied fixture evidence. Neither a successful unit test
nor syntactically valid private command arguments prove a live Claude setup.

Tests use disposable in-memory data, including deliberately fictitious command
arguments, and never invoke Claude or inspect a real private installation.
