# Claude Code mid-run steering — Stage D scoping note

Author: Claude (Sonnet 5). Date: 2026-09-13.

This is a scoping note, not a design. It exists to state precisely why Stage D (mid-run
steering / `request_response` approval) cannot be designed in any more detail than this
right now, and what would have to be true before it could be.

## What "steering" would mean here

Claude Code's Agent SDK (not the CLI subprocess this project has verified so far — see
`docs/claude/CLAUDE_CODE_A0_VERIFICATION.md`) exposes `query.interrupt()` and
`query.send()` on a live, in-process session. That is a different integration shape from
"spawn `claude -p ... --output-format stream-json` and read its stdout to EOF," which is
all `docs/claude/CLAUDE_CODE_EXECUTION_DESIGN.md` (Stage C) proposes. Steering a run
requires the run to be a long-lived object Control Room can call back into, not a
subprocess it starts once and waits on.

## Why this can't be scoped further today

Stage D's own dependency, stated plainly in the original harness plan and unchanged by
anything found since: it needs Stage C to exist first, for real, not just designed.
Concretely, a steering design would have to answer questions that only have real answers
once Stage C code exists and has run:

- Whether the CLI-subprocess integration path (Stage C) and an in-process Agent SDK host
  are two connectors or one connector with two transports — that changes the connector
  profile shape (`src/harness/v1/connector-profile.ts`'s `transport` enum currently has no
  value for "long-lived in-process session"; adding one is a schema change, not something
  to do speculatively).
- What "cancel" and "interrupt" actually mean differently once a run can be steered mid-way
  rather than only killed — Stage C's design proposes killing a process group as the whole
  of `cancel`. Steering needs a softer, resumable stop that Stage C's model doesn't have a
  slot for yet.
- How `docs/claude/CLAUDE_CODE_APPROVAL_AUTHORITY_DESIGN.md`'s callback-relay mechanism
  (already designed, not yet implementable — it also depends on Stage C existing) would be
  wired into a live SDK session versus a subprocess's stdin/stdout, which are mechanically
  different integration points.

Designing precise answers to these now would mean guessing at Stage C's eventual shape
before Stage C has even been reviewed, let alone built — exactly the "manifest that
overstates the runtime" failure mode the original plan warned against, just applied to a
design document instead of a manifest.

## What is already settled, and doesn't need re-deciding when this resumes

- The policy question — Control Room is the sole approval authority, a callback is a
  transport never an independent approver — is decided (`CLAUDE_CODE_HARNESS_PLAN.md` §5a)
  and does not change based on which transport carries it.
- The manifest/profile honesty rule — never declare `steer` or `approvalMode:
  "request_response"` until a runtime actually backs it — stands unchanged.

## What must be true before this note can become a real design

1. Stage C (`docs/claude/CLAUDE_CODE_EXECUTION_DESIGN.md`) reviewed and, at minimum,
   prototyped enough to know its actual `cancel` and identity-binding behavior in practice,
   not just on paper.
2. A decision on whether the Agent SDK host is a second connector or a second transport on
   the same one — an architectural call for whoever owns `connector-profile.ts`'s schema,
   not this document.
3. The credential-path decision already pending for Stage C (Stage D has no separate
   credential question — it inherits Stage C's).

Until (1) happens, this note has nothing further to say. It is deliberately short.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
