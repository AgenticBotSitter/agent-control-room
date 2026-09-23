# macOS Claude process adapter: source evidence

The Node adapter in
`src/node-bridge/private-macos-claude-code-process-host-ports.ts` supplies the
existing installed Claude process-host interface using the
[ACRCCP1 native helper](CLAUDE_CODE_MACOS_PROCESS_CUSTODY_V1.md). It is explicit
source code with disposable test evidence. It is not wired into installation,
the owner qualification command, or production activation.

## Ownership and lifecycle

Owner-held source configuration supplies the exact helper digest, executable
digest, executable and workspace filesystem identities, owner identity,
existing qualification/workspace bindings, deadlines, and byte limits. There
is no command, arbitrary argument, environment, credential, or shell input
from a task. The native helper receives the same fixed supplied-text review
arguments as the existing host, including the rolling `opus` alias.

Verification starts only the helper. The target remains unstarted until the
existing host passes its synchronous authority fence and calls `launch`.
`launch` synchronously returns ownership before scheduling the GO frame.
Input operations await the helper's STARTED response. Responses and target
output use separate pipes, so output cannot forge a process status.

The higher host's `bounded()` aborts its temporary verification signal even
after verification succeeds. The adapter detaches that signal when VERIFIED
transfers custody to its retained session. If the higher host never launches,
the native HOLD deadline expires and the helper retires without starting the
target. Abort before that transfer cancels verification.

One adapter permits sequential tasks after certain retirement. It refuses
overlapping verification because the current verification request has no
per-attempt lookup key. Unknown retirement leaves that adapter locked; it
cannot silently become available or retry a task. Concurrent workers require
separate retained adapter instances under the existing controller authority.
An abandoned HOLD is different: a valid REFUSED frame received before GO,
followed by the helper's expected exit code 1 and complete pipe closure,
proves no target was started and releases capacity. A higher-host authority
refusal therefore expires safely without disabling later authorized tasks.

## Boundaries and failure behavior

Status is parsed as bounded binary frames. The adapter checks framing,
reserved bytes, transitions, exit kind and group-absence evidence. It retains
at most the bounded output allowance per stream and bounds task input. TERM
and KILL are sent through the helper's existing process-group protocol.

A target's EXIT frame alone does not finish the Node result. The helper must
also close successfully, with no extra/partial frames and no helper error
output. Target error output stays separate and is not logged or interpreted
as helper evidence. Helper death, bad framing, lost custody or output overflow
rejects the result as uncertain.

On uncertainty the adapter closes the control pipe, allowing the still-live
helper to perform cleanup. It never kills the helper as a substitute for
proving target retirement. If the helper itself receives SIGKILL, Node cannot
establish process-group recovery from this protocol. A future independent
supervisor or equivalent reviewed recovery design remains necessary. The
helper-death test uses a target fixture that retires itself; that is negative
evidence about uncertainty, not evidence of production recovery.

## Activation remains blocked

The module exports these unresolved boundaries explicitly:

- `owner_attended_native_login_qualification_missing`: real installed Claude
  authentication and its supported executable layout remain untested. The
  helper deliberately supplies no HOME or login environment. Tests never use
  owner credentials or launch Claude.
- `independent_helper_death_recovery_missing`: SIGKILL of the helper cannot
  guarantee cleanup, and the Node process cannot reconstruct custody from
  status frames without identities.
- `installed_helper_release_custody_missing`: the adapter checks the helper
  file and ancestor permissions and hashes an opened file before spawning its
  path. This detects drift but is not kernel-bound helper launch custody. An
  installed protected release and its bootstrap/recovery trust must be
  established before this factory becomes a production default. The adapter
  does not defend against arbitrary hostile same-user replacement.

Nothing in this document converts prior path-only Claude qualification into
native custody evidence. The real qualifier must move to this same reviewed
path and introduce appropriate versioned evidence before promotion. It also
needs a private workspace with mode 0700; an ordinary source checkout should
not be assumed to meet that native requirement.

## Verification

`tests/claude-code-macos-process-host-ports.test.ts` runs ten bounded native
tests using compiled disposable fixtures. It covers host signal handoff,
output/status separation, invalid requests and pins, duplicate/concurrent
calls, replacement and symlink refusal, TERM-resistant escalation, remaining
ordinary descendants, helper-death uncertainty, bounded output, stale HOLD,
fragmented/malformed/extra/partial status frames, sequential task reuse, and
authority refusal followed by safe HOLD retirement and a later valid task.

The artificial status fixture proves parser behavior only: it launches no
target. Actual group retirement assertions use the real native helper and a
separate tiny target fixture. All native tests skip on non-macOS hosts; that
skip is not evidence of another platform's support. The test is registered in
`test:native-fences`, and the full TypeScript check passes.
