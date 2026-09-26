# Claude Code private process acquisition reuse decision

## Job and retained contract

Validate a privately configured Claude Code host beneath the existing
`AcquireClaudeCodeProcessV1` and `OwnedClaudeCodeProcessV1` seam. This packet
is a non-live containment/preflight foundation, not a task runner or Claude P3:
the existing acquisition seam receives a binding digest but no task input.

## Reuse decision

- Retain the existing Control Room owned-process session and stream decoder.
  They already bound line framing, result handling, cancellation, cleanup and
  no-retry/no-resume semantics.
- Retain a narrow custom host preflight for fixed executable, arguments and
  working directory. It cannot acquire a child yet.
- Retain a narrow custom first-task invocation policy. It accepts exactly one
  text-review argument set and therefore cannot gain a resume session, tools,
  MCP servers, plug-ins, unattended permission approval, or persistent session
  through a task or browser input. The policy is based on the documented Claude
  CLI flags, not copied source code. Exact installed-version support remains an
  owner-attended qualification requirement.
- `anthropics/claude-agent-sdk-python` at `f7547d7233527739ece8b12ed28c57be96c966b5`
  (MIT) is reference only. We inspected
  `src/claude_agent_sdk/_internal/query.py`,
  `src/claude_agent_sdk/_internal/transport/subprocess_cli.py`, and
  `tests/test_close_cancellation.py`: their subprocess buffering and cleanup
  test ideas inform this preflight's boundary tests, but no code is copied.
  Its Python runtime, executable
  discovery, inherited environment, settings/plugins and resume behavior do
  not fit this contract.
- `anthropics/claude-code-action` at `cfc3eb22bfed5c26ef66e3223c982af27e4524de`
  (MIT) is reference only. We inspected `base-action/src/run-claude.ts`,
  `base-action/src/retry.ts`, and `base-action/src/validate-env.ts`: it is an
  Actions wrapper with inherited environment, arbitrary options, retries,
  transcripts and result-only completion semantics.

No external candidate removes more Control Room code than this thin preflight
without adding a competing session owner, credential path, scheduler, or task
authority. No third-party code is retained, so no attribution entry is needed.

## Required owner-attended ABI qualification before invocation work

The canonical task source is `prepared.delivery.input` from
`ClaudeCodeLocalDispatchPreparationV1`; it is already digest-bound in the
controller delivery packet. Before any real child can be acquired, the owner
must qualify the installed Claude ABI and record evidence for all of these:

- how that exact bounded input is supplied without argv, logs, files or a new
  environment variable;
- which owner-attended private credential custody/environment is permitted,
  including proof that no browser, worker, task or inherited process
  environment selects it;
- how cancellation closes stdin, terminates, kills if necessary and reaps the
  exact child; and
- restart/recovery behavior proving no resume, retry or second process is
  treated as safe.

If stdin is the qualified ABI, the smallest follow-up is a bounded
`writeStdin` operation on the existing `ClaudeCodeProcessBytePortV1`, invoked
by the existing owned-process session before it exposes decoded stdout. That is
an existing-port extension, not a second session manager. This packet makes no
such ABI assumption or contract change.
