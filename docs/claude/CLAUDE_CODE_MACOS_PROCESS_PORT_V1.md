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
custodian to perform cleanup. The native executable now starts an independent
supervisor and an otherwise empty process-group anchor before the custodian can
read HOLD. A suspended target joins that anchored group. If the custodian dies,
the supervisor retires the entire anchored group, reaps its own children and
proves group absence before returning the reserved recovery exit. The task is
still uncertain and is never resumed or retried; only native capacity is safe
for a later, separately authorized task. Neither the anchor nor target pid is
published as protocol or application authority.

## Activation remains blocked

The module exports these unresolved boundaries explicitly:

- `owner_attended_native_login_qualification_missing`: real installed Claude
  authentication and its supported executable layout remain untested. The
  helper deliberately supplies no HOME or login environment. Tests never use
  owner credentials or launch Claude.
- `installed_helper_release_custody_missing`: the adapter checks the helper
  file and ancestor permissions and hashes an opened file before spawning its
  path. This detects drift but is not kernel-bound helper launch custody. An
  installed protected release and its bootstrap/recovery trust must be
  established before this factory becomes a production default. The adapter
  does not defend against arbitrary hostile same-user replacement.

The protected pre-admission composer now moves qualification onto this same
supervised helper route. It consumes the installed-manifest release capability,
checks the exact helper, executable and workspace identities, and fixes the
Opus/text-only/no-tools argument vector before the target can start. Its
sanitized report carries only an opaque digest of that exact route. A generic
spawn or the older path-only command produces no such digest and cannot become
installation readiness evidence. The later installed-port composer re-derives
the digest from its protected manifest and refuses a substituted report.

This remains source evidence until the owner provides a protected manifest-v3
installation and runs the owner-attended qualification. The command-line entry
accepts no executable or workspace paths; an installed owner host must inject
the one-use route capability in process. An ordinary source checkout is never
treated as native qualification.

## Verification

`tests/claude-code-macos-process-host-ports.test.ts` runs bounded native
tests using compiled disposable fixtures. It covers host signal handoff,
output/status separation, invalid requests and pins, duplicate/concurrent
calls, replacement and symlink refusal, TERM-resistant escalation, remaining
ordinary descendants, custodian death before HOLD and after GO, bounded recovery,
bounded output, stale HOLD,
fragmented/malformed/extra/partial status frames, sequential task reuse, and
authority refusal followed by safe HOLD retirement and a later valid task.

The artificial status fixture proves parser behavior only: it launches no
target. Actual group retirement assertions use the real native helper and a
separate tiny target fixture. All native tests skip on non-macOS hosts; that
skip is not evidence of another platform's support. The test is registered in
`test:native-fences`, and the full TypeScript check passes.
