# Shared connector and result contract

**Status:** lead decision for the public initial release, September 12, 2026.  
**Code contract:** `src/harness/v1/connector-profile.ts`.

Control Room owns projects, task admission, attempts, review, revision, artifacts and
recovery decisions. A harness connector translates one upstream interface; it does not
become another scheduler or grant itself permission. Its profile is inert metadata,
not an executable plugin and not proof that advertised operations work.

## Common rules

- Every connector pins its exact upstream revision, version, transport, isolation,
  credential-resolution and distribution mode.
- Every operation is explicitly `supported`, `unsupported` or `unknown`, with its
  evidence level. Source and fixture evidence can select work but cannot enable an
  operation. Runtime admission requires actual-interface or native qualification.
- An upstream ID is correlated to the canonical tenant, project, task, attempt and
  Control Room run. An upstream completion message is evidence; canonical result and
  review records decide completion.
- Submit is never blindly repeated after an uncertain reply. Reconnect/read/status
  is distinct from resume or a new turn. Unsupported cancel, usage or replay remains
  visible rather than fabricated.
- The initial artifact is one UTF-8 text result of at most 65,536 bytes. Control Room
  verifies exact bytes, hash, size and run lineage before storing it. No connector may
  turn agent text, a path or an arbitrary URL into a download capability. Additional
  and binary attachments remain disabled for this contract version.
- Public extensions may observe through bounded read interfaces. Execution bindings,
  credential lookup, approval, signing, schema writes and task completion stay in the
  reviewed core. Removing an extension cannot remove canonical history.

## Initial connector decisions

### Hermes

Use `asimons81/hermes-gpt` revision
`89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73` through an operation-level FastMCP
binding. Source inspection confirms `hermes_session_continue`,
`hermes_session_job_status` and `hermes_session_job_result`. The result is capped by
upstream at 24,000 characters and must still pass Control Room's UTF-8 byte bound.

The source does not provide the durable idempotency, SSE, stop or replay interface
assumed by the existing experimental `/v1/runs` adapter. PR #14 remains useful fixture
and uncertainty evidence only. Cancel, event replay and per-job usage are unsupported;
restart may report a running job as `orphaned`, which is uncertainty, not resumability.
Before submit is admitted, run the unmodified FastMCP implementation through
continue → status → result and cover busy, truncation, lost-submit and restart/orphaned.

### Codex

Use the official Codex App Server as a parent-owned stdio JSON-RPC process. The selected
integration pin is `0.150.0-alpha.8` until intentionally upgraded. Retain initialization,
thread/turn identity, notification correlation, interrupt and bounded framing already
present in the codebase. `thread/read` is the required read-only recovery primitive;
resume and a new turn are never substitutes for status inspection. Inbound App Server
approval requests remain unsupported, not silently accepted.

The non-experimental schema generated from the exact selected package is now retained
as sanitized version/digest/`thread/read` evidence and bound to the narrow adapter.
Actual admission still requires a test that `thread/read(includeTurns: true)` after
process restart reads the exact thread without resuming or starting work. Production
WebSocket transport, dynamic tools and automatic approval are outside the initial contract.

## Optional components

- Herdr v0.9 (`b99002ac99b09e00b4ca692436cb15a6b0d676f1`) stays an
  operator-installed, observation-only pane source. It is not task authority, a remote
  transport or proof of completion. Native same-host isolation remains unqualified.
- Current Control Room React panels and react-markdown/GFM remain the UI base. From
  Hermes WebUI, retain only anti-stuck streaming/pending semantics as tests. A Hermes
  Desktop active-session strip is deferred unless a real second in-app view switcher
  is still needed. Do not import either global store, full shell or Electron runtime.
- Built-in health and Needs attention projections are the initial monitoring surface.
  Uptime Kuma and Beszel remain separate optional services; neither is installed or
  copied into Control Room and neither becomes task authority.

Copied donor code must record upstream URL, immutable revision, original path, local
destination, modifications, license/copyright and notices in `THIRD_PARTY.md`. Invoking
an operator-installed binary does not authorize redistributing that binary.
