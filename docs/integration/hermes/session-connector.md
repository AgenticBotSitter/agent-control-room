# Upstream Hermes session connector

Maps one Control Room task onto the three supported upstream Hermes session tools at
`asimons81/hermes-gpt` revision `89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73`. It replaces no
shared contract and introduces no second scheduler, authority or store.

## What is mapped

| Control Room step | Upstream tool | Module |
| --- | --- | --- |
| Start one turn | `hermes_session_continue` | `submitHermesSessionTurnV1` |
| Observe progress | `hermes_session_job_status` | `pollHermesSessionJobV1` |
| Read one bounded result | `hermes_session_job_result` | `collectHermesSessionResultV1` |

Everything else upstream exposes is out of scope. `cancel`, `events`, `resume`, `read`,
`usage` and `artifacts` have no interface at this revision and fail closed with a named
reason through `hermesSessionUnsupportedOperationV1`.

## Bounds taken from the pinned revision

Read from `operator_session.py`, not chosen here: prompt ceiling 65,536 characters, result
cap 24,000 characters with a 500-character floor, timeout clamped to 10–3,600 seconds, and
a job id of exactly 32 lowercase hex characters.

Upstream **clamps** `timeout` and `max_chars` silently instead of refusing. The client
refuses out-of-range values locally, so a caller cannot believe a deadline or cap that
upstream would quietly replace. Both refusals happen before any call is made.

## Three upstream behaviors that shape the design

**The session lock narrows the duplicate-execution window; it does not close it.**
Upstream keeps one active job per session id and refuses a second *concurrent* turn with
`SESSION_BUSY`. But `_active_sessions` is process memory, and `_watch` drops the entry as
soon as the turn's process exits. A retry after the first turn finished — or after any
upstream restart — is accepted and starts a second real turn.

A lost submit is therefore **unrecoverable uncertainty**, and must never be retried by any
caller. There is no recovery path either: the job id is returned only by the submit call,
and the supported tool set has no job-listing operation, so a job whose id was never
observed cannot be found again. The client never retries `hermes_session_continue`, and
the runtime reports `uncertain` rather than implying the turn can be reconciled.

`busy` remains a distinct outcome from `refused`: it means a turn is running right now and
must be waited on, not retried or reported as a failure.

**`orphaned` is uncertainty, not an outcome.** Upstream `_reconcile` marks a running job
`orphaned` after a restart when process ownership could not be proven. The runtime returns
`uncertain`, never a completion and never a failure. `timed_out` is likewise uncertain: the
process group was terminated at upstream's deadline.

**Two different truncation limits apply, and they disagree.** Upstream caps at 24,000
*characters*; Control Room's ceiling is 65,536 *bytes*. A response of 24,000 four-byte
codepoints satisfies the upstream cap at 96,000 bytes. The runtime reports
`upstreamTruncated` and `ceilingTruncated` separately, and trims on a codepoint boundary so
the stored text is never invalid UTF-8.

A successful job with empty output returns `uncertain`, not an empty accepted result.

## Identity

Every outcome carries the exact Control Room lineage (tenant, project, job, attempt, run,
node) plus the upstream session and job id.

The MCP wrapper in `server.py` resolves a unique-prefix session id before delegating, so
the id a turn actually starts against can differ from the one requested. Refusing that
would strand a turn that has already begun real work, so `submitHermesSessionTurnV1`
records both ids and reports `resolvedByUpstream`; pass the resolved id back as
`upstreamSessionId` when collecting the result. A `job_id` that does not match what was
asked for is still refused as an identity mismatch.

That wrapper also emits two further `session_control` codes beyond
`operator_session.py`: `SESSION_ID_NOT_FOUND_OR_AMBIGUOUS` and `SESSION_CONTINUE_FAILED`.

## Evidence, and what it does not prove

The three mapped operations move from `source_inspected` to `fixture_tested`: recorded
transports replay the pinned upstream response and error shapes, including the structured
envelope from `operator_policy.make_error_envelope`.

**This does not enable execution.** `connectorOperationAdmissibleV1` requires
`actual_interface_tested` or `native_qualified`, so the shared admission rule still refuses
every call. No live Hermes installation was contacted, no process was started and no
provider was called. Live qualification against a real installation is separately
authorized work and belongs to the worker-setup and release-acceptance packages.

The unsupported operations keep `source_inspected`: no fixture can exercise a tool that
does not exist upstream, so claiming fixture evidence for them would be false.

## Deliberately not done here

- **No shared terminal-evidence kind.** `src/harness/v1/terminal-result-evidence.ts`
  defines `hermes_native_snapshot`, whose source fields (lease, snapshot digest, native run
  key) belong to the native node path and do not exist on the FastMCP session path.
  Producing that kind from this connector would misstate provenance. Binding this outcome
  into shared terminal evidence needs a new evidence kind in that file, which is outside
  this package's owned paths and is lead-owned integration.
- **No test-lane registration.** The issue reserves `package.json` for integration, so the
  three new test files are not yet attached to a lane.
- No change to shared authority, database, artifact storage, server composition,
  authentication or another connector.
