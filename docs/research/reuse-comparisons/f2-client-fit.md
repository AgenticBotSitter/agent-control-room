# Actual Codex Python client: lifecycle and refusal comparison

2026-09-08, CR baseline fbac95b; upstream openai/codex
553df1c691fe8bf7747e50da22f1342984495ae0. Research only.

## Decision-changing evidence

The actual `CodexClient` now runs, beyond the earlier router-only experiment, with
real subprocess pipes, reader/stderr threads, response routing and generated models.
Its explicit launch override starts only our synthetic Python peer. No native Codex,
provider, personal profile, credentials, network listener or application change.

Fifteen checks pass across five owned peers after independent-review correction. Actual initialize, configured refusal
of command/file/tool/unknown requests, typed streaming, interrupt, EOF/malformed
responses, bounded external close and process reaping execute. The refusal handler
always returns decline; no command or file operation is supplied or executed.
For tool/call and unknown methods this proves the callback's response reaches the
authored peer, not that a real server accepts that generic refusal response schema.

Three integration mismatches matter:

1. `stream_text` emits a typed delta with the requested turn ID but a different thread
   ID. Preserve CR's exact thread/turn binding before accepting content or usage.
2. A synthetic peer delivering turn notifications and completion before the start
   response leaves the stream waiting. The actual router discards pending events on
   unregistered completion; the client subsequently registers an empty queue. The
   corrected experiment controls this ordering and closes the client to wake it.
   This does not establish how frequently a real server emits that ordering.
3. `CodexConfig.env` merges into parent environment, rather than replacing it. A
   synthetic parent marker remains alongside configured overlay. Launch this SDK
   worker itself with a sterile environment; setting config.env alone is insufficient.

Request waits also have no built-in short deadline: an intentionally held request
remains waiting for150ms, then actual close wakes it. This observation plus source
`waiter.get()` supports requiring an outer deadline, not an arbitrary long timeout
benchmark. Close reaps each synthetic single process here, not native process trees.

## Fidelity, correction and scope

The initial optimistic streaming test waited and was interrupted with SIGINT, exit130.
Its finally block closes/reaps peers. It was not a pass. We inspected the actual router,
then split a controlled post-registration stream and deterministic early-completion
negative. The whole corrected experiment has a15-second alarm plus per-wait bounds;
it passed once (14checks, five peers), direct output retained separately in
[evidence](f2-client-evidence.json). No upstream code was patched to make it pass.
Independent review found that a timed join alone could mistake a not-yet-scheduled
consumer for a blocked stream. The corrected negative first waits for the actual
start response to be consumed and its empty turn queue registered, then observes
the wait. The updated run passed15checks across five reaped peers; its separate
output is retained, without erasing the earlier14-check result.

Nine pinned source files totaling404,162bytes are checked before import; namespaces
omit package facades deliberately and imported module origins are checked. This is
the complete selected synchronous client dependency closure, not the published SDK's
high-level package façade or async client. Existing Python/Pydantic are used, not newly
installed. The harness executes in a sterile parent environment; it tests merge
semantics with synthetic markers only, never reading or reporting ambient secrets.
Source/dependency provenance remains scoped: imported upstream sources are hashed;
the entire installed Python/Pydantic tree is not revalidated by this experiment.

## Fit and alternatives

Official documentation describes SDK and app-server integration surfaces:
[SDK](https://learn.chatgpt.com/docs/codex-sdk),
[app server](https://learn.chatgpt.com/docs/app-server). Current pages were opened;
the immutable source and executed experiment—not documentation claims—establish the
behavior above. Retain the existing Apache-2.0 source license and eventual Python
dependency notices when shipping; this evaluation imports no code into the product.

Prefer supported SDK mechanisms where they replace a complete responsibility, not
a second correlation queue beside our existing one. The synchronous Python client
can supply typed requests/notifications and subprocess transport, but needs explicit
refusal, exact identity checks, bounded queues/frames/deadlines, sterile worker startup
and durable CR settlement. It adds Python packaging and a TS/Python boundary. Existing
TS SDK process transport and direct bounded CR session remain viable alternatives.
Production deletion in this experiment: zero. Do not delete the current observer,
broker, admission or journals from these client-only successes.

Next decisive test: actual client output into existing CR observer/result/usage
contracts, explicit-ID resume, disconnect/reconstruction and uncertain-start handling;
compare equivalent scope against TS SDK and direct session. No candidate is fully
selected and native qualification remains separately gated. The early-completion
finding must have a tested adapter/upstream resolution before this client replaces
our transport. No new custom generic JSON-RPC router is justified by these findings.

## Acquisitions and cleanup

139GiB free before download. Restricted fetch failed before acquiring bytes; scoped
public retry fetched the seven earlier pinned files, then two client dependencies.
Exact URLs/hashes and owned root in [ledger](f2-client-acquisitions.json).
No package install. After independent source inspection and corrected terminal run,
removed only the exact416KiB owned source/receipt tree. Absence check passed. Five
peers were reaped in the final run; no persistent services. Registry/source URLs and
hashes remain in the ledger for reproduction; application dependencies unchanged.
