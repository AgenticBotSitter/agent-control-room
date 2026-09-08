# F2 synchronous client independent source review

2026-09-08; baseline `fbac95b`, uncommitted research additions. Reviewed harness,
direct corrected receipt, acquisition JSON, report, retained nine upstream files and
the relevant current `isolated-jsonrpc.ts` boundaries. No rerun, download, native
agent, service or application change. Cleanup is the author's responsibility; this
review did not independently observe process or directory cleanup.

## Findings

### F2-C-01 — P2: early-stream negative lacks an acknowledged reached state

`f2-client-fit.py` starts `early_consumer`, joins for 150ms and asserts that it remains
alive with no output. That also passes if the consumer has not reached `turn/start`
or processed its response. The peer does emit completion before its start response,
and actual router source (`route_notification`, lines 204–213) conclusively discards
unregistered pending events on completion. However, the executed assertion does not
prove the claimed empty registered queue / stuck-after-response state. The ordinary
positive stream already polls registration; use an equivalent bounded acknowledgement
of the early request's registered queue (and its empty/pending state) before asserting
the wait and closing. Until then describe this as source-established ordering defect
plus a weaker observed wait, not a deterministic executed reproduction.

### F2-C-02 — P3: refusal is callback transport evidence, not all-method protocol fit

The four synthetic server requests have empty parameters, and the authored peer accepts
the same `{decision: decline}` shape for command approval, file approval, tool call and
an invented unknown method. This proves the actual client's configured callback is used
and its result is written back; it does not establish valid native tool-call/unknown-method
refusal responses or upstream enforcement. Keep the report's explicit refusal requirement,
but do not describe all four as native protocol-qualified refusals. An adapter must map
method-specific rejection/error semantics before real integration.

## Evidence accepted within scope

- Actual synchronous `CodexClient`, router, generated models, pipe readers and subprocess
  transport execute unmodified pinned source. Launch override demonstrably bypasses native
  resolver/package-bin launch; Python peer code performs only synthetic message handling.
- Wrong-thread delta acceptance with the same turn is positively established by exact
  two-element output assertion. `stream_text` source checks turn ID, not thread ID.
- Initialize, interrupt response, EOF/malformed waiter wake, parent environment merge,
  externally closed held request, and five direct-child process reaps agree with source.
  Interrupt response is not proof of actual cancellation. The 150ms hold is not a measured
  timeout limit; unbounded `waiter.get()` establishes the missing built-in deadline.
- Fourteen named checks are present in the corrected direct stdout receipt. Initial exit
  130 remains explicitly unsuccessful and transcribed rather than falsely direct evidence.
  Alarm/finally cleanup does not establish descendant-tree containment; none is claimed.
- Exact source file set, symlinks and SHA-256 checks run before imports; package namespaces
  avoid initializer execution. Module origins are checked after execution. Unlike the
  prior router guard, this harness only rejects preloaded root namespaces, not every
  prefixed submodule before import: treat the recorded fresh `env -i` process as the
  evidence boundary, not a general hostile-interpreter import sandbox. Python/Pydantic
  and `_version.py` distribution metadata fallback are not a fully pinned dependency tree.
- Nine code files total 404,162 bytes in the acquisition record. The selected closure is
  not the public facade, async client, native runtime or full distribution. No new license
  audit occurred here; Apache-2.0 upstream attribution and eventual transitive notices
  remain shipping obligations, not satisfied by these code-file hashes alone.

## Fair integration conclusion

Keep the actual adapted SDK as a strong reuse option, alongside the TS SDK and existing
direct session. This run usefully replaces assumptions about the router alone with real
client behavior, but does not select a production transport or justify deleting policy.
Current CR session limits frames/pending requests, forbids server requests and closes
terminally; the observer binds exact thread/turn and validates lifecycle/usage. Those
responsibilities have not been connected to this Python client in the experiment.

Next bounded comparison should feed actual client output through existing CR observer,
usage and settlement contracts, retaining exact identity and uncertain-start handling,
then compare the same explicit-ID resume/reconstruction cases against TS SDK/direct
session. A controlled resolution of F2-C-01 is needed before asserting the early-ordering
adapter works. Native execution remains separately gated. Current production deletion:
zero; no reason here to build another generic JSON-RPC router.

## Focused correction disposition

Rechecked changed source and `independentReviewRecheck` receipt without executing again.
F2-C-01 is addressed: the early consumer must now reach its actual client's registered
empty turn queue within two seconds before the waiting assertion. In this source path,
registration follows consumption of the start response, while the single pipe reader
has already processed earlier completion. An unscheduled consumer cannot satisfy that
positive acknowledgement. The new direct stdout records this added check, 15 checks,
five reaped peers, exit 0, 0.641672041 seconds; earlier 14-check evidence remains distinct.
This reproduces the synthetic ordering defect, not an adapter fix or real-server frequency.

F2-C-02 is addressed for report scope: tool/unknown decline responses are explicitly
limited to authored-peer callback delivery, not native schema acceptance. No remaining
blocking finding for this bounded research checkpoint. All integration, import-environment,
license and native/CR-mapping limits above still apply. Cleanup remains author-observed.
