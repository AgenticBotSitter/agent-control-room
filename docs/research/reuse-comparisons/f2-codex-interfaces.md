# F2 Codex interface comparison — scoped code evidence

2026-09-08, baseline3b7588b. OpenAI Docs skill used to search and open current
official interface documentation before source comparison. Native runtime/provider
calls: zero. This is partial F2, not fleet support or complete F2 selection.

## Candidates and observed code paths

Official documentation distinguishes SDK job automation from App Server custom
client integration. TypeScript wraps local execution; the Python SDK controls local
App Server JSON-RPC with a pinned runtime in published distributions. That makes
Python SDK a relevant alternative to writing another interactive RPC client.
Sources: [SDK](https://learn.chatgpt.com/docs/codex-sdk),
[App Server](https://learn.chatgpt.com/docs/app-server). These living pages are
guidance, not evidence that our old installed executable supports every method.

| Candidate | Inspected actual implementation | Fit and limitations |
| --- | --- | --- |
| TypeScript SDK0.153.4, exact registry archive | Bundled `Thread.runStreamedInternal`, `run`, `CodexExec.run`, constructor/env/command mapping; source map contains original sources | Same language and JSONL event family as existing adapter. Public exported Thread accepts an internal execution port, useful for isolated tests, but production must use supported entrypoints. SDK does not replace application validation, effect ownership or cancellation proof. |
| Python SDK source553df1c691fe8bf7747e50da22f1342984495ae0 | `sdk/python/src/openai_codex/client.py`: start/close, request/raw waiter, turn_start lock, turn_interrupt, notify, optional overload retry | Existing typed app-server operations and turn notification routing may avoid custom RPC work. Adds Python/generated models/runtime dependency and a Node/Python boundary unless placed in native worker. Full package/transport not executed here. |
| Current Control Room exec adapter | `src/harness/codex-v1/decoder.ts`, `result.ts`, manifest | Retain scoped event/sequence/terminal validation and result identity. Manifest pins0.150.0-alpha.8/macOS; neither new SDK experiment nor package platform list updates that qualification. |
| Current direct App Server adapter | `isolated-jsonrpc.ts`, `isolated-topology.ts` | Bounded frame/pending requests, initialization/correlation, server-request refusal and disconnect classification already exist. SDK is a replacement candidate for transport/session convenience only, not permission to delete these requirements. |

Actual TypeScript `CodexExec.run` uses `exec --experimental-json`, maps resume ID,
sandbox/approval/network options and passes AbortSignal to spawn. If env override
is absent it copies ambient environment. Python `start` copies ambient environment
then updates configured values. Explicit isolated parent environment is therefore
necessary for Python as well; env additions alone do not remove inherited secrets.
Neither process path was run in this evaluation. No Codex executable was installed.

Python `_request_raw` registers a UUID waiter before writing and discards it on
write error; the inspected wait uses `waiter.get()` without a local timeout argument.
Overall cancellation/disconnect behavior requires inspecting the actual router and
transport, not inferring an application deadline from this method. `turn_interrupt`
names both thread and turn. `close` tries terminate/wait then kill; it does not by
itself provide our owned-descendant settlement evidence. Optional overload retry
is separate from turn_start; do not mislabel every operation as automatically retried.

## Executed experiments

`research/reuse-comparisons/f2-codex-sdk-fit.mjs` imports the unmodified pinned
published Thread implementation, with a synthetic async execution port. It never
constructs Codex/CodexExec, discovers binaries, spawns a process or sets outputSchema.
The real SDK stream crosses our existing decoder/result projector.

Eight checks passed:
- final text digest, scoped terminal result and usage mapping;
- observed thread ID passed into next synthetic turn;
- EOF without terminal event returns SDK partial output, while our result projector
  rejects it (negative integration evidence, not a claim of whole-SDK failure);
- malformed JSON and explicit failed turn refuse;
- duplicate terminal event and invalid native thread ID refused by current projection;
- AbortSignal forwarded to the synthetic port, explicitly not cancellation acceptance.

`research/reuse-comparisons/f2-python-rpc-fit.py` parses three exact method AST bodies
from pinned source and exercises interrupt, request/write failure and notification
with synthetic peer/router/model ports. Four checks passed. No complete Python
package import, generated model validation, real transport or cross-language bridge.
These are E2 method tests, not equivalent to full SDK E3 or native qualification.

Upstream TS `tests/runStreamed.test.ts` inspected: its test proxy drives real Codex
runtime events; not executed because this scope forbids native agent calls. Python
`tests/test_client_rpc_methods.py` selected model/RPC tests inspected, not run.
Main-source tests are not represented as tests of the published0.153.4 artifact.
Our tests retain stdout summaries; no provider token/result material is involved.

Independent review requested stronger digest and ordering checks. The Python writer
now asserts its waiter exists at the moment of writing; the TypeScript test compares
the exact expected digest. An initial strengthened check incorrectly expected raw
text hashing and failed. Inspection of `src/security/canonical-digest.ts` confirmed
the existing protocol hashes canonical JSON (including string quotes); corrected
independent expected bytes pass. Eight TS and four Python checks reran successfully.
No product hashing behavior was changed. The acquisition ledger was also completed.

## Comparative decision, not a blanket winner

**TypeScript SDK is a viable job-oriented adapter candidate with the lowest observed
language boundary cost.** Direct App Server and Python SDK remain serious options
for interactive approvals/turn steering/session inspection. Do not pick one as a
universal winner based on eight parser checks. Further fit evidence must compare
the actual bounded transport/session requirements using a synthetic peer and exact
versioned schemas, then separately qualify native behavior.

| Option | Integration work | What it could remove / must retain |
| --- | --- | --- |
| TypeScript SDK | Thin execution/event bridge, bounded output/error handling, exact env/profile selection and authoritative end-state checks | Could replace duplicated argv/stream orchestration; retain current decoder/result validation, approvals, journals and native cleanup. No deletion measured yet. |
| Direct App Server | Keep existing bounded JSONL session; refresh generated schema/capability mapping and version tests | No new Python process/dependency. Maintains more custom transport code; must compare against actual SDK router before choosing to retain it. |
| Python SDK | Typed operations and notification router plus narrow Node/Python host bridge or native Python worker boundary | Could replace some RPC/session machinery, but introduces model/runtime distribution and bridge operations. Do not import login/goal/helper effects into the permitted command surface. |

No credible scored winner, timing estimate or service-memory comparison yet. Runtime
code deleted today: zero. Required custom core is exact canonical task/run/effect
binding and refusal of incomplete/ambiguous evidence—not another generic SDK.

## Next decisive tests

1. Inspect and execute actual Python message router and published distribution models
   under a synthetic peer; compare out-of-order, duplicate/unknown response, disconnect,
   late reply, unsolicited server request and explicit thread/turn identity.
2. Compare current direct session against generated current schemas and typed client;
   preserve strict allowed-method boundary. Do not infer WebSocket production support
   from a transport appearing in docs. Local-only stdio remains the current shortlist.
3. Exercise actual TS execution transport with a plainly synthetic child executable
   only if scoped, including abort/nonzero/truncated/oversize output. No real Codex.
4. Native runtime/version/host behavior remains E4 and requires a new exact approval;
   no credentials or past one-shot authority used in this goal.
5. Finish Hermes lifecycle/file and room comparisons separately; neither SDK test
   completes all A5/B3/B6/B8/B9 responsibilities.

## Provenance and licensing

Published SDK0.153.4 archive SHA512:
cf4acdf16310c70107607a4327228767034d52d33fd69767c662a8a48277a8c099cb20deb2d688852183674bf44528e6f9112e8dc17235df79a16b3bf335a046.
The manifest declares Apache-2.0 and dependency @openai/codex0.153.4; that dependency
was NOT downloaded. No npm install ran. GitHub source pin553df1c691fe8bf7747e50da22f1342984495ae0
root Apache license was inspected separately; do not infer complete release/vendored
binary notice clearance from it. Registry metadata did not supply a gitHead for this
SDK release; archive integrity identifies tested code, not an invented source match.
See [acquisition ledger](f2-acquisitions.md) for exact paths/hashes and cleanup.
