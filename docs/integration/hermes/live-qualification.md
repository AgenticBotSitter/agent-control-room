# Live qualification — Hermes connector (issue #8)

Short procedure for maintainer approval. Offline evidence (Path A) is in
`tests/hermes-gpt-mapping.test.ts` (recorded transport,
`src/harness/hermes-native-v1/hermes-gpt-recorded-responses.ts`,
upstream pin `asimons81/hermes-gpt@11db8ac`). Live acceptance needs a
**separately authorized gate** — this document does not authorize it.

## Preconditions (all required before any live call)

1. Maintainer names the exact upstream revision + host (Linux, private loopback
   first per #8). Record both here; `11db8ac` is the inspected pin, not an
   approved live target.
2. The upstream exposes the native contract the adapter asserts
   (`hermes.api_server.capabilities`, `POST /v1/runs` → `202
   {run_id: run_<32hex>, replayed:false}`, `GET /v1/runs/{id}`, SSE events,
   `POST /v1/runs/{id}/stop`). If it does not, stop: that is the documented
   mapping gap, not a qualification failure — route to Codex for decision.
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
