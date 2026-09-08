# Hermes downloads versus current result intake: root disposition

2026-09-08. Current source inspection on `codex/idea-abs-workflows`, base
`2fb66d7`; no application edits, provider calls, credentials or database activity.
This dispositions the source report `f2-hermes-artifact-fit.md`; the separate
actual session-handler fixture remains pending. No fresh test pass is claimed.

## What already supplies association

`src/harness/v1/native-run-contracts.ts` binds tenant, node, project, job, attempt,
canonical run, effect claim, operation and enrollment digests before submission.
The session ID derives from tenant/project/attempt/effect claim; the enrollment
contains the exact profile and destination. `native-task-registration.ts` carries
the binding digest and session digest into canonical registration. The native
protocol checks the returned native run and session together. Therefore, saying
Control Room has no producer/run association would be incorrect.

That association does not currently declare a filesystem export root or permitted
output paths. The inspected strict start/binding schemas have no such fields.
Session cwd is not a substitute for an admitted export scope. A downloader can use
known association without requiring Hermes to implement Control Room's IDs, but
must not infer an output grant from a model-generated pathname.

## The important existing interface mismatch

`src/harness/hermes-native-v1/task-observation.ts` hashes `snapshot.resultText`:
the existing result claim describes final response text, not every file created
during that session. `src/artifacts/v1/native-results.ts` requires that exact
completed, durably recorded observation and matching bytes. Its receipt ID is
derived from tenant/run; its manifest is one bounded UTF-8 `task_result`.

Consequently, a different downloaded file cannot truthfully enter this API by
reusing the final-response claim. Changing the claim after observation, inventing
a completed snapshot, or increasing the shared byte limit is not an adapter test.
This is an exact integration mismatch, not a reason to build a new SSH transport.

## Reuse decision boundary

- Retain the existing final-text path unchanged for that responsibility.
- Continue evaluating Hermes session-aware download as the byte transport for
  additional attachments. The fixture must execute upstream code, not a rewritten
  handler, and disclose substituted session/auth ports.
- Additional attachments require a separately reviewed manifest/association seam
  under the existing canonical task and storage authorities. Predispatch declared
  exports plus observed run/session are a viable design candidate; an upstream
  signed producer manifest is not a universal prerequisite.
- Reuse existing byte hashing, storage and canonical metadata primitives where
  their actual contracts fit. Do not pretend the single final-text receipt is an
  already-general multiple/binary-file API.
- Receipt-store transport remains an alternative with explicit one-shot/restart
  availability limitations. It is not automatically required in addition to the
  session-download route, and neither authorizes broad dashboard access.

## Finite acceptance and implementation split

The current comparison must establish actual profile/session file selection,
path behavior and byte changes, then document the smallest credible mapping and
cost relative to existing transfer alternatives. Existing task association and
final-text intake are source-backed constraints; executing those unchanged tests
again would not prove the missing attachment seam.

Implementation must separately establish declared export ownership/containment,
cross-project/attempt refusal, changed-byte handling, retained attachment metadata,
protected download, size/type limits and result/review linkage without altering
task completion. Live remote transfer and deployed endpoint authentication remain
target qualification. Neither source inspection nor synthetic profile resolution
claims that production access or attachment intake already works.
