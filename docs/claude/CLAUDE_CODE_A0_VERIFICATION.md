# Claude Code CLI — Stage A0 verification

Author: Claude (Sonnet 5). Date: 2026-09-13.
Purpose: re-verify the 2026-08-22 research dossier against a real, installed CLI, per
`docs/claude/CLAUDE_CODE_HARNESS_PLAN.md` Stage A0. That dossier's own caveat was that the
binary was never installed on this Mac, so its flag-level claims were never live-tested.

## What was done

Installed `@anthropic-ai/claude-code@2.1.270` locally into a scratch directory (not global,
not this repo) and ran it **unauthenticated** — no login, no API key, no credentials entered
anywhere, per the standing rule that credential/account actions are not something this agent
performs. Every command below either needs no auth (`--version`, `--help`) or fails cleanly at
the auth check before any model call, which is enough to capture the process lifecycle,
exit-code, and event-shape behavior an adapter's decoder has to handle — at zero API cost
(`total_cost_usd: 0` in every captured result).

## Correction to the August dossier

The dossier's flag list was close but not exact. Live `--help` on 2.1.270 shows:

- `--permission-mode` choices are **`acceptEdits`, `auto`, `bypassPermissions`, `manual`,
  `dontAsk`, `plan`** — not the three-value set (`acceptEdits|plan|bypassPermissions`) the
  dossier assumed. The adapter's compatibility/manifest layer should treat this as a 6-value
  enum, not 3.
- `--dangerously-skip-permissions` and the newer, more explicit
  `--allow-dangerously-skip-permissions` (enables the *option* to bypass without it being
  default) both exist. The plan's rule — never pass either in unattended fleet jobs — still
  holds for both spellings.
- Several capabilities the dossier did not mention at all, directly relevant to future stages:
  - **`--max-budget-usd <amount>`** — a built-in per-run cost ceiling (print mode only). This
    is a real candidate for enforcing Control Room's cost ledger at the harness level instead
    of only after the fact.
  - **`--session-id <uuid>`** — lets the caller pin the session UUID instead of letting Claude
    Code generate one. Relevant to how the adapter maps native session identity to the
    tenant/node/adapter-bound digest the SDK boundary requires — worth a design note in Stage
    A1, not decided here.
  - **`--bg`/`--background`, plus `attach <id>`, `logs <id>`, `stop|kill <id>`, `rm <id>`,
    `agents`** — a whole detached-session lifecycle already built into the CLI itself. Stage A's
    "wrap the CLI as a subprocess" plan should look at whether Control Room drives this native
    background-session mechanism instead of reinventing its own PID tracking. Flagging for
    Stage A3, not deciding here.
  - **`--restricted`** — strips all command/code-running tools (Bash, PowerShell, REPL, etc.)
    and WebFetch, confines file tools to the working directories, refuses
    `bypassPermissions`, and ignores project/user settings files. This is a stronger sandbox
    posture than anything the dossier considered and is worth evaluating for fleet nodes in
    Stage C.
  - **`--json-schema`** — structured output validation, useful for a decoder that wants a
    guaranteed final-result shape rather than parsing free text.

None of this changes the Phase A/Phase B split in the plan (wrap the CLI for
start/stream/cancel/resume/usage; defer `steer`/`request_response` to an SDK host). It only
sharpens what the manifest and decoder need to model.

## Exit codes observed

| Command | Exit code | Notes |
|---|---|---|
| `claude --version` | 0 | `2.1.270 (Claude Code)` |
| `claude --not-a-real-flag` | 1 | `error: unknown option '--not-a-real-flag'` to stderr, no JSON |
| `claude -p "..." --output-format stream-json` (unauthenticated) | 1 | Full JSONL lifecycle still emitted — see below |
| `claude -p "..." --output-format json` (unauthenticated) | 1 | Single JSON result object, `is_error: true` |
| `claude -p "..." --resume <unknown-uuid>` | 1 | Plain text to stdout: `No conversation found with session ID: <uuid>`, no JSON — resume-not-found is **not** wrapped in the JSONL envelope |

The last row matters for the decoder: not every failure path is JSON, even in
`--output-format json` mode — a resume-target lookup failure short-circuits before the output
formatter is even selected.

## Real stream-json event shapes captured

Three real events from one `--output-format stream-json --verbose` run (unauthenticated,
`total_cost_usd: 0`), reformatted for readability:

**1. `system` / `init`** — first event, before anything else:
```json
{
  "type": "system", "subtype": "init",
  "cwd": "...", "session_id": "a33ecb62-bede-447d-81e1-5578adba9807",
  "tools": ["Task", "Bash", "Read", "Edit", "Write", "..."],
  "mcp_servers": [], "model": "claude-opus-5[1m]", "permissionMode": "default",
  "apiKeySource": "none", "claude_code_version": "2.1.270",
  "agents": ["claude", "claude-code-guide", "Explore", "general-purpose", "Plan", "..."],
  "capabilities": ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
  "memory_paths": { "auto": "..." },
  "messaging_socket_path": "/tmp/cc-socks/54597.sock",
  "fast_mode_state": "off"
}
```
Confirms the dossier's claim that `system`/`init` carries model, permission mode, tool list and
session id. New and not in the dossier: `capabilities` (a versioned feature-flag array —
`normalizeEvent` should probably record this per adapter version), `apiKeySource` (useful to
confirm which credential path is active without reading secrets), and
`messaging_socket_path` (a live IPC socket path — likely how `--print` steering/interrupt would
be wired if ever used; not relevant to Phase A which declares no `steer`).

**2. `assistant`** message on an auth failure — note the error is carried *inside* a normal
assistant message, not a separate event type:
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant", "type": "message", "model": "<synthetic>",
    "stop_reason": "stop_sequence",
    "content": [{ "type": "text", "text": "Not logged in · Please run /login" }],
    "usage": { "input_tokens": 0, "output_tokens": 0, "...": 0 }
  },
  "session_id": "a33ecb62-...", "error": "authentication_failed",
  "is_api_error_message": true
}
```
The decoder needs to check `is_api_error_message` / `error` on assistant frames, not assume
every `assistant` event is a normal turn.

**3. `result`** — final event, terminates the stream:
```json
{
  "type": "result", "subtype": "success",
  "is_error": true, "terminal_reason": "api_error",
  "num_turns": 1, "duration_ms": 46, "duration_api_ms": 0,
  "total_cost_usd": 0, "result": "Not logged in · Please run /login",
  "usage": { "...": "..." }, "modelUsage": {},
  "permission_denials": [], "subagent_stats": { "spawned": 0, "...": 0 },
  "session_id": "a33ecb62-...", "uuid": "1c7bba9b-..."
}
```
Worth flagging for Stage A2 (decoder): **`subtype` says `"success"` even though `is_error` is
`true`** and `terminal_reason` is `"api_error"`. The decoder must key off `is_error` /
`terminal_reason`, not `subtype`, to classify a run as failed. This is exactly the kind of
sharp edge fixture-driven decoding is meant to catch before it reaches production.

`total_cost_usd` and the `usage` block on `result` are the metering source the plan's Stage A2
decoder should map to the harness event schema's `usage` output form.

## What Stage A0 did not verify

No authenticated run was performed — that needs a `claude auth login` or an API key, both of
which are account/credential actions this agent does not take unilaterally. So the
happy-path event sequence for a real completed turn (tool_use / tool_result frames, a
non-error `assistant` message, a `result` with real `total_cost_usd`) is **still unverified
against a live run** and remains the dossier's claim, not confirmed fact. Whoever owns
Anthropic API billing for fleet nodes (open question 3 in the plan) should authorize a small
authenticated smoke test before Stage A2's decoder is treated as fixture-complete.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
