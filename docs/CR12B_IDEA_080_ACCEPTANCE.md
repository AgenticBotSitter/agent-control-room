# CR12B-IDEA-080 filtered driver and qualification-harness acceptance

**Status:** Complete for the exact repository-only, injected-fixture, provider-disabled snapshot. No native attempt or
provider call occurred.

## Accepted driver boundary

The Hermes 0.21 Idea Lab driver is a protected translator behind an injected node-local gateway port. The repository
ships no port implementation and no default, browser, local-pilot, or production composition.

Before the port can be called, the driver rechecks the consumed admission, exact Hermes `0.21.0` revision
`29112bef099274229cadff79cdff7bf7b99c4b77`, adapter ID, provider evidence, participant identity, runtime identity,
profile identity, and conversation identity. It receives the admission from the protected coordinator rather than from
browser input.

One successful turn requires a contiguous sequence containing:

1. a zero-tool, zero-MCP session-ready event bound to every identity;
2. one filtered result or one proven definite failure;
3. one internally consistent usage observation for exactly one call; and
4. one settled completion event.

Streaming message/reasoning/thinking deltas may occur between those events, but their payloads are discarded before
schema parsing and are never returned or retained. Retained fields pass the global safe-projection and secret-material
guards. Raw native identifiers never cross the port; only opaque one-way identity digests do.

The driver enforces one timeout no longer than the configured ceiling or the session's total duration ceiling. Timeout,
transport exception, malformed or discontinuous events, identity drift, accessor/Proxy input, unexpected output,
cleanup failure, or cleanup timeout throws to the coordinator and therefore becomes terminal ambiguity after the durable
pre-call marker. There is no retry. Cleanup is required after success, proven failure, timeout, and malformed handoff.
The returned provider receipt is derived from both normalized gateway evidence and the exact cleanup receipt.

## Qualification harness

The ten-stage frozen plan requires the exact source pin, disposable profile/workspace, zero tools and MCP, harness-native
protected-value custody, pre-call marker, one filtered provider turn, usage and sequence replay, interrupt/reconcile,
cleanup, and a sanitized receipt. Its hard ceilings are one native attempt, one provider call, 300 seconds, and 256 KiB
of retained sanitized evidence.

The repository plan contains no native port or owner window, accepts no native receipt digest, and records zero native
or provider calls. Its status is `blocked_before_native_attempt`. The injected eight-scenario simulation may pass, but
its schema fixes `nativeQualified` and `livePanelEligible` to false. A caller cannot re-digest either the plan or
simulation into native authority.

## Verification

- New driver/qualification hostile suite: 10/10 passed.
- Combined CR12B suite: 69/69 passed.
- The full registered `npm test` lifecycle passed with zero failures.
- TypeScript, the full repository lint suite, production build, and whitespace validation passed.
- All 3 rendered route checks passed, including Idea Lab and its promoted project workspace.
- macOS stage-zero readiness passed without installation or repair.
- All 30 migrations recreated and verified 108 PostgreSQL tables in the disposable verification database.
- Cases cover exact completion, definite failure, streaming-content discard without Proxy traps, runtime/participant
  preflight denial, timeout abort, malformed sequence, binding drift, cleanup uncertainty, Proxy/accessor rejection,
  synchronous gateway failure with mandatory cleanup, re-digested native claims, partial simulations, and a source scan
  proving no native/process/filesystem/network client.

## Effects not performed

No Hermes install or update, native runtime/profile/workspace access, protected-value resolution, provider call, process,
filesystem mutation, network request, MCP/plugin use, project creation, production database/VPS contact, deployment, or
external effect occurred.

## Remaining gate

IDEA-090 must implement the authenticated, durable, atomic admission-consumption and accepted-native-receipt registry.
The current interface alone is not sufficient for a live owner window. Native qualification remains blocked until that
store, exact replay semantics, revocation/high-water behavior, and the final owner packet are accepted.
