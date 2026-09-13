# Live qualification — Hermes connector (issue #8)

**This PR (#14) is offline Path-A compatibility research. No live Hermes
run has occurred. This document describes a procedure that would gate a
live run; it does not authorize one.**

The recorded hermes-gpt fixtures in
`tests/hermes/hermes-gpt-recorded-responses.ts` (upstream pin
`asimons81/hermes-gpt@89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73`, selected
by issue #8) are offline shapes: no subprocess, no network, no live
upstream. They drive the production `HermesNativeRunAdapter` against
failure and recovery scenarios (failed preflight, lost reply, dropped
event stream, restart reuse, idempotent stop, never-accept-upstream-text).

The real FastMCP adapter around the actual `hermes_session_continue`,
`hermes_session_job_status`, and `hermes_session_job_result` operations
is a separate reservation per issue #8 — it is not in scope for PR #14.
Live acceptance needs that adapter, plus a separately authorized gate
that this document does not authorize.

## Preconditions (all required before any live call)

1. Maintainer names the exact upstream revision + host (Linux, private loopback
   first per #8). Record both here; `89cbfbe` is the inspected pin, not an
   approved live target.
2. **The real FastMCP adapter around `hermes_session_continue`,
   `hermes_session_job_status`, and `hermes_session_job_result` exists
   and binds upstream session/job IDs to Control Room project/task/attempt/run.**
   PR #14 does not include that adapter. Live qualification cannot proceed
   without it.
3. Bearer credential via the approved transport only (never argv/env/logs/files).
4. One disposable task, synthetic prompt, bounded deadline, observer present.

## The one approved task

Run exactly one explicitly approved real task and record: progress events seen,
returned file/artifact metadata, one review/revision round, and one
interruption-recovery drill (drop the stream mid-run; confirm resnapshot, no
redispatch, no invented outcome). An upstream success string is reported state,
never accepted work — acceptance is the reviewer's, not the transport's.

## Record (append to the PR handoff)

- upstream revision + host + credential transport used;
- task id, prompt digest (never raw prompt), artifact digest;
- event timeline (started / progress / interrupted / resnapshotted / terminal);
- any `ambiguous` quarantines and how each was resolved by re-observation;
- remaining gaps vs. the mapping table in `upstream-inspection.md`.

## Stop conditions

Stop and report (do not retry as a pass) when: capabilities mismatch, id format
mismatch (`run_<32hex>`, `cr_<64hex>`), retention below the deadline floor,
`replayed:true` on a fresh claim, cost enforcement observed upstream
(`costUsd` non-null / hard limit), or any secret/plaintext-prompt handling
outside the approved transport.
