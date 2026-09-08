# F2 actual Python router fit

## Decision

Do not replace Control Room's bounded TypeScript JSONL session with the Python
router alone. The router is real reusable SDK infrastructure, but its useful
typed notification/early-turn buffering is not the same responsibility as CR's
allowlisted, bounded connection and exact thread/turn settlement. Prefer the
official SDK when adopting a complete SDK worker transport; retain a narrow CR
policy wrapper. This experiment does not select or qualify that full transport.

Pinned candidate: openai/codex `553df1c691fe8bf7747e50da22f1342984495ae0`.
CR base `fd03365`. Evidence: [19 checks](f2-router-evidence.json),
[file hashes and URLs](f2-router-acquisitions.json).

## What actually ran

Actual `_message_router.py`, `_goal.py`, `models.py`, `errors.py`, generated
notification registry and generated Pydantic models imported unchanged. Existing
Python 3.12.14/Pydantic 2.13.5 sufficed: no installs, stubs, rewritten router,
providers, native Codex, services or credentials. All seven acquired source files
were hash-checked before importing. Namespace-package loading deliberately omits
upstream package `__init__` and client/transport construction: this is a dependency-
complete router subset, NOT complete SDK package/client qualification. Actual
generated `AgentMessageDeltaNotification` and actual `UnknownNotification` paths
both ran. Six checks also executed the existing CR JSONL session unchanged.
Both suites passed initially and on evidence capture; zero failed-run corrections.
The direct out-of-order assertion was subsequently strengthened to compare exact
ID, method and result (not only event kind); its six checks passed again.

| Behavior | Actual Python router result | Existing CR result |
|---|---|---|
| Out-of-order replies | Correct waiter correlation | Correct pending-method correlation |
| Duplicate/unknown reply | Ignored after waiter removed | Rejected as correlation failure |
| Late reply | Explicit discard makes it ignored | After disconnect, rejected as closed |
| Duplicate waiter ID | New waiter replaces old, leaving old empty | IDs allocated internally monotonically |
| Early typed event | Buffered and replayed on register | Raw notification emitted; downstream observer owns lifecycle |
| Turn/thread scope | Same turn, different thread reaches registered queue | Observer source validates both; not exercised here |
| Bounds | 1,001 pending turn queues and 32 response waiters admitted | Actual 17th pending request rejected (limit16) |
| Disconnect | Existing waiters awakened; new waiters still accepted afterward | Session permanently closed; repeated disconnect idempotent |
| Server request | Outside router; client handler discussed below | Actual request classified forbidden without executing handler |

These are policy differences, not claims of an upstream vulnerability. The SDK
client/caller may own lifecycle, approved actions and event consumption; this
router-only execution does not establish all those higher-level safeguards.

## Server-request seam (source inspection, not execution)

Pinned `client.py` lines 803–824 classifies incoming server requests before router
responses. `_handle_server_request` lines 826–835 invokes the configured approval
handler. `_default_approval_handler` lines 773–779 returns `accept` for command and
file-change approval requests. Therefore adopting that client with defaults is not
equivalent to CR's zero-tools/refuse-server-request policy. No handler, subprocess,
reader thread or approval was run in this experiment. A complete SDK integration
must explicitly supply rejection policy and test it at the actual client seam.

## Exact integration and removal scope

`src/harness/codex-v1/isolated-jsonrpc.ts` lines 34–142 owns connection ordering,
allowlisted methods, 262,144-byte frames, request cap16, numeric correlation and
closure. Upstream router can replace response waiter/notification queue plumbing
in a Python SDK worker, but cannot delete these policy responsibilities. CR already
uses a Map rather than a custom Python queue; inserting Python only to replace that
Map adds a language/process boundary without eliminating a whole CR component.

The same CR file's `CodexIsolatedTurnObserverV1` owns exact thread/turn binding,
monotonic usage and durable broker settlement. Keep it (or an equivalent tested
policy adapter); generated model validation is not authorization or settlement.
`isolated-topology.ts`, credential-broker admission and profile confinement are
also not replaceable by this router. Borrow generated notification schemas/types
for a future SDK-backed worker instead of inventing more protocol decoding there.

Measured adaptation in this experiment: **zero application lines changed**;
the Python harness is an import and synthetic peer exercise, not a working CR
transport adapter. Estimated integration scope, not a measured completion time:
Python worker packaging plus TS/Python boundary, explicit refusal handler, closed
state/deadline handling, bounded queues/frame enforcement and exact-scope wrapper.
Only after that could the worker's own correlation/event plumbing be removed;
the tested direct session remains needed until the replacement passes all policy
tests. This does not establish net code deletion or justify a new Python service.

## Strongest next fit experiment

Run the full actual SDK client against a synthetic stdio peer (no native Codex),
configured with explicit refusal and sterile environment. Prove initialize,
bounded request timeout, disconnect/late frames, server-request denial, streaming
turn correlation and shutdown through the same broker/observer contracts. Compare
that complete SDK worker with the official TypeScript transport candidate already
under F2 evaluation. E2 router evidence is complete for the listed cases; E3 mapped
full transport acceptance is still open. The router has no public request timeout
parameter, so the wrapper's timeout/cancel interaction must be measured rather
than assumed from `fail_all`.

## License and reproducibility

This pin's root Apache-2.0 license was inspected in the earlier
[F2 source report](f2-codex-interfaces.md); no new production dependency is added.
Existing Pydantic availability is not full transitive license approval. Shipping
an SDK worker requires release/package notices and dependency audit at that scope.
Official context: [App Server](https://developers.openai.com/codex/app-server),
[SDK](https://developers.openai.com/codex/sdk). Pinned implementation, not product
documentation, establishes the experimental behavior above.

Reacquire exact sources with `node research/reuse-comparisons/f2-router-fetch.mjs
<owned-temp-root>` then run `f2-router-fit.py` with an existing Python3.12/Pydantic2
environment. Run `node --import tsx research/reuse-comparisons/f2-router-direct-fit.ts`
for the direct comparison. No normal app test/install commands are required.

## Independent-review reproduction correction

The review identified a guard gap: listed hashes alone did not exclude additional
package initializers or an ambient installed package. This does not invalidate
the original clean-root behavior or imply extra code actually ran there.

The harness now requires exactly seven expected source files and one generated
directory, rejects symlinks and preloaded candidate modules, uses explicit
pre-import exceptions (effective under Python `-O`), creates only two explicit
namespace packages, and verifies all six actually imported candidate module origins
and the exact imported closure within the pinned tree. No SDK initializer/client is
constructed. Fetching requires an empty owned root and is capped at1,000,000bytes.

`f2-router-guard-fit.mjs` exercises actual extra-initializer, changed-hash,
missing-source and symlink fixtures plus valid/restored controls using `-O` and
`--verify-only`, before any candidate imports. All six guard cases, thirteen actual
router cases and six direct CR cases passed. Captured actual stdout, commands and
exit statuses are retained in `f2-router-guard-recheck-evidence.json`. This remains
router-only synthetic evidence; complete SDK client/transport remains open.
