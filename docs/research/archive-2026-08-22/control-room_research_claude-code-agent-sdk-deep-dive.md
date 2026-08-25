# Claude Code + Claude Agent SDK — Deep Dive as Control-Room Agent Nodes

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Scope:** how to drive Anthropic's Claude Code CLI and the Claude Agent SDK headlessly from our control room (Hermes on Marvin/Johnny5), with verified versions, licenses, lifecycle verbs, and integration shape.
**Note:** compiled by orchestrator after delegated researcher timed out at 600s (14 calls, no file). Ground truth re-collected this session; the installed-CLI portion is limited by what's on THIS machine (see §A caveat).

---

## TL;DR

Claude Code is the strongest *documented* CLI agent for unattended orchestration: `claude -p` print mode with `--output-format stream-json`, `--resume <session-id>` for continuation, `--permission-mode` ladder from plan/read-only up through bypass, transcripts in `~/.claude/projects/<slug>/<uuid>.jsonl`. **Licensing is the catch:** the repo is NOT open source — LICENSE.md is "© Anthropic PBC, all rights reserved" under Commercial ToS; npm packages say "SEE LICENSE IN README.md". The **Agent SDK** (`@anthropic-ai/claude-agent-sdk` v0.3.240) is the programmatic surface (query loop, hooks, canUseTool approval callbacks, subagents). Verdict: **Wrap** for our control room via `claude -p --output-format stream-json` subprocess pattern; SDK adoption only if we need in-process control.

## 16-item coverage table

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Official interfaces/repos | ✅ | §A |
| 2 | Versions/commits inspected | ✅ partial | npm dist-tags pulled live 2026-08-22; local CLI not on PATH on this Mac (§A caveat) |
| 3 | License every component | ✅ | §B — LICENSE.md fetched; proprietary, not MIT/Apache |
| 4 | OS support | ✅ | macOS/Linux/Windows(WSL); verified from docs knowledge + repo [flagged: not re-fetched] |
| 5 | Auth/subscription requirements | ✅ | §E — Pro/Max OAuth vs ANTHROPIC_API_KEY |
| 6 | Start/stream/steer/approve/cancel/resume | ✅ | §C — full matrix with flags |
| 7 | Session/subagent model | ✅ | §D — jsonl transcripts, --resume/--continue, Task-tool subagents |
| 8 | Skills/plugins/MCP/hooks | ✅ | §D.3 — MCP + hooks + slash-command/skill files |
| 9 | Filesystem/worktree isolation | Partial → permission modes + sandboxing notes; deep isolation = runners dossier |
| 10 | Usage/cost reporting | ✅ | §F — stream-json usage fields, /cost |
| 11 | Failure/restart recovery | ✅ | §C resume row + exit-code semantics |
| 12 | Stable vs experimental surfaces | ✅ | §G |
| 13 | Security concerns | ✅ | §H incl. --dangerously-skip-permissions blast radius |
| 14 | Adopt/Wrap/Borrow/Build/Defer | ✅ | §I |
| 15 | Minimal integration example | ✅ | §J safe read-only form |
| 16 | Unanswered questions/experiments | ✅ | §K |

## §A — Repos, packages, versions

| Thing | Where | Version seen 2026-08-22 |
|---|---|---|
| Docs/issues repo | anthropics/claude-code (GitHub, 142,500★, pushed today) | main |
| CLI npm package | @anthropic-ai/claude-code | 2.1.240 |
| Programmatic SDK | @anthropic-ai/claude-agent-sdk | 0.3.240 |
| Local install (this Mac) | NOT FOUND on PATH (`which claude` empty; no npm global install) — but `~/.claude/projects/-private-tmp-cc-inspect/8b665680….jsonl` transcript exists from a prior session run | unknown → treat prior runs as historical evidence only |

**Caveat:** unlike the Codex dossier (CLI present, live-tested), Claude Code's local binary isn't currently installed/on PATH here, so flag-level claims below come from official docs knowledge + registry/repo verification, marked accordingly. Installing v2.1.240 is experiment #1.

## §B — Licenses (fetched this session)

| Component | License | Text evidence |
|---|---|---|
| anthropics/claude-code repo | **Proprietary** — © Anthropic PBC, all rights reserved, subject to Commercial Terms of Service | root `LICENSE.md` (only license file; fetched) |
| @anthropic-ai/claude-code (npm) | "SEE LICENSE IN README.md" → same commercial terms | registry metadata (live pull) |
| @anthropic-ai/claude-agent-sdk (npm) | Same shape ("SEE LICENSE IN README.md") | registry metadata (live pull) |

Practical meaning: we may USE it under Anthropic's terms; we may not redistribute it or treat it as OSS. Contrast: Codex CLI is Apache-2.0. For a control room that only *invokes* these CLIs, both are fine; for anything shipping code FROM their repos, they are not.

## §C — Lifecycle matrix (start/stream/steer/approve/cancel/resume)

Verb | Mechanism | Flag/command shape
---|---|---
Start (headless) | print mode | `claude -p "<task>" [--cwd dir]`
Stream | stream-json events | `--output-format stream-json` (JSONL: system init → assistant msgs w/ usage → tool_use/tool_result → result)
Steer mid-run | SDK-only cleanly (interrupt + send); CLI: none mid-run | Agent SDK query.interrupt()/send()
Approve tool calls | permission modes + allow/deny rules | `--permission-mode acceptEdits|plan|bypassPermissions`; settings.json allow/deny; SDK canUseTool callback = programmatic approver
Cancel | kill process group (CLI); interrupt() (SDK) | wrapper sends SIGINT/SIGTERM; partial transcript persists
Resume | session resume flags | `claude --resume <session-id>` / `--continue` (most recent); sessions keyed per-project directory
Exit codes | documented set (0 success; nonzero classes for errors) [flagged: verify exact table at install] |

## §D — Session/subagent/extensions model

1. **Transcripts:** `~/.claude/projects/<path-slug>/<session-uuid>.jsonl` — confirmed on-disk shape from this Mac's leftover project dir. Session identity is per-working-directory.
2. **Subagents:** Task-tool spawns with isolated context windows; custom agents via `.claude/agents/*.md` definitions; each subagent gets its own context, tools scoped by agent definition.
3. **Extensions:** MCP client support (`claude mcp add …`) for external tools; hooks (PreToolUse/PostToolUse/etc.) for policy injection; slash commands/custom skills as markdown files. This is where a control-room policy layer could attach (PreToolUse hook = deny-by-default gate).

## §E — Auth & subscriptions

- **OAuth subscription (Pro/Max):** interactive login stored under `~/.claude/` (credentials [REDACTED]); allows automation within subscription fair-use; historically some automation restrictions on Max plans [flagged].
- **ANTHROPIC_API_KEY:** pay-per-token; simplest for headless fleets; env var or apiKeyHelper.
- Control-room implication: either works headless; API-key path gives predictable cost accounting per agent node.

## §F — Usage/cost reporting

stream-json assistant events carry `usage` blocks (input/output/cache tokens) per message; final `result` event summarizes; `/cost` in interactive mode shows session spend. A control room can therefore meter each job by parsing the result event — same pattern as our cost-ledger.

## §G — Stable vs experimental

Stable-enough: `-p`, output formats, resume/continue, MCP, permission modes. Moving/fast-changing: Agent SDK API surface (0.3.x), hook event names, agent-definition format. Pin versions; expect breaking changes between minor releases.

## §H — Security concerns

1. **--dangerously-skip-permissions / bypassPermissions**: removes ALL tool gates — any prompt-injected instruction executes. Never in unattended fleet jobs; use permission rules + hooks instead.
2. **Prompt injection surface:** web-fetch/file-read content can carry instructions; PreToolUse hooks and allowlists are the mitigation layer available to us.
3. **Credential exposure:** `~/.claude/` holds OAuth tokens — file perms + backup discipline (same treatment as `.env`).
4. **License risk:** proprietary terms can change; pinned-version + ToS review cadence recommended (add to quarterly license-matrix rerun).

## §I — Verdict

**Wrap** — drive the CLI as a subprocess node in the control room (`claude -p --output-format stream-json`), metered by result-event usage, gated by permission rules/hooks, resumed via `--resume`. **Not Adopt-as-framework** (Agent SDK in-process) until a concrete need appears (e.g., streaming approvals into Telegram). Borrow its hooks/permissions *design* when building our Hermes-side policy wrapper. License makes it unusable as redistributable plumbing — irrelevant for invocation-only use.

## §J — Minimal integration example [NOT EXECUTED locally — binary not installed; shape verified vs docs]

```bash
# one-shot read-only analysis job, safe form:
claude -p "Summarize changes in ./CHANGELOG.md since last release" \
  --permission-mode plan \
  --output-format stream-json > /tmp/cc-job.jsonl
# control room parses last line (type:"result") for summary + usage tokens;
# follow-ups: claude --resume <session_id> -p "now draft release notes"
```
Install first: `npm i -g @anthropic-ai/claude-code@2.1.240` (or package-manager equivalent), auth via existing subscription OR ANTHROPIC_API_KEY.

## §K — Experiment queue
1. **Q:** Does v2.1.40x CLI behave as documented headlessly on macOS (exit codes, stream-json shapes)? · **Experiment:** install, run §J snippet + a --resume follow-up · **Signal:** parseable result event + resumable session id.
2. **Q:** Do PreToolUse hooks fire reliably non-interactively? · **Why:** our deny-by-default policy seam · **Experiment:** hook that denies Bash rm; ask agent to delete a scratch file · **Signal:** denial event in stream.
3. **Q:** Pro/Max OAuth automation limits in current ToS? · **Why:** auth-path choice for fleet jobs · **Experiment:** read current terms page; small overnight scheduled job trial · **Signal:** no throttling/warnings → OAuth viable for light fleet use.

## Sources manifest (this session)
- registry.npmjs.org live pulls: claude-code@2.1.240, claude-agent-sdk@0.3.240 (+license fields)
- api.github.com: anthropics/claude-code (stars/pushed/default-branch); raw LICENSE.md fetch (proprietary text)
- On-disk evidence: ~/.claude/projects/ transcript layout (leftover from prior session)
- Flag-level behavior claims from official-docs knowledge — flagged inline; verify at install (experiment 1)
- Delegated researcher transcript (timeout, 14 calls) reviewed for salvage; nothing beyond this session's own collection was recoverable

## Known gaps
- No local binary installed → zero hands-on execution this session (explicit caveat throughout)
- Exact exit-code table and stream-json schema version not pinned
- Windows story (WSL requirement) not independently re-verified

## Verification checklist
- [x] Registry + repo facts live-pulled today
- [x] Proprietary license captured verbatim (not assumed OSS)
- [x] Every doc-knowledge claim flagged for install-time verification
- [x] Integration example honest about not having been executed
