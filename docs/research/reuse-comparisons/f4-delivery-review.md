# RC4 delivery comparison — independent root review

2026-09-08. Read complete authored fixture, report and condensed receipt; no rerun
or acquisition. Independently checked the recorded source/inbox root absent.
The reviewer did not reconstruct deleted upstream sources; prior pinned-source
provenance and the fixture's hash checks are evidence, not a new release audit.

No blocking contradiction for E2 local delivery/queue decisions with substituted
external transports. Nine checks reconcile with eight receipt outcome summaries:
changed-ID delivery and changed persisted body are separate checks. One authored
syntax failure is preserved and occurred before candidate code could execute.
Successful execution is reported by a condensed receipt, not retained full stdout.

Actual deliver, wake chain, queue, writer and content-wrapper logic is transpiled;
registry/stream/channel/pane/WebSocket are authored ports. Only messageRef is
extracted from notification-service by AST; the native notification implementation
does not run. The harness blocks webhook fetch and resets the upstream queue timer.
Disk writes are to a synthetic homedir supplied to the module, not the user's home.

The decisive evidence is repeated `deliver` with the same message ID and different
body: the actual caller accepts both, the writer leaves one changed inbox record,
and the queue holds two wakes. This extends the earlier writer-only observation.
It does not establish behavior of an authenticated ingress route that might impose
additional validation before calling this function. The report correctly avoids
claiming a whole-platform vulnerability.

Session/channel verification is an injected boolean. Actual fallback selection
based on that boolean is exercised, not a real message-specific acknowledgement.
Stream acceptance and pane readback similarly remain synthetic ports. Queue enqueue
and reset are tested, not timer-driven retry recovery or durable wake persistence.
For missing UUID, direct assertions check delivered=false and unchanged WebSocket
count; they do not independently compare all filesystem/channel/pane effects.
The broader before-write/wake wording is source-derived rather than fully asserted
by that particular case. This does not change the main repeated-ID finding.

## Root decision

Keep Control Room's canonical task/attempt/receipt journal as task-delivery authority.
Do not substitute this local Maestro delivery contract unchanged. Informational
wake routing is a distinct optional responsibility, not evidence that an agent
accepted the exact approved task or completed it. The existing retry/uncertainty
rules must not be relaxed to adopt the candidate.

Do not build a new general notification fallback framework now: no required missing
notification channel has been established by this comparison. If a concrete channel
gap emerges, evaluate these actual ordered adapters first, with narrow CR identity
binding and explicit wake semantics. That conditional reuse remains viable; it is
not approval of the whole Maestro service or a reason to expand the MVP scope.

This closes only the unchanged local-delivery-as-task-authority replacement question.
Coding workspace/AO ownership, saved discussion promotion, native participant
execution and any required genuine cross-machine delivery remain separate gates.
