# Control Room Research: OpenAI Codex CLI — Integration Deep-Dive

**Date:** 2026-08-22 · **Researcher:** Marvin (Hermes Agent) · **Task:** codex-integration-deep-dive
**Method:** live local inspection + GitHub API verification, this session. Every claim below is from tool output captured today unless marked *(docs)*.

---

## Coverage index (control-room-research contract, 16 items)

| # | Item | Where in this doc |
|---|---|---|
| 1 | Official interfaces/repos | §0 + repo facts table |
| 2 | Versions/commits | §0 (codex-cli 0.139.0; repo push 2026-08-22) |
| 3 | Licenses | §0/repo table (openai/codex Apache-2.0) |
| 4 | OS support | §0 binary target aarch64-apple-darwin; (docs) macOS/Linux/WSL2 |
| 5 | Auth/subscription | §0 auth.json analysis (ChatGPT OAuth vs API key) + §4 |
| 6 | Start/stream/steer/approve/cancel/resume | §1–§3 + §7 wrapper verbs |
| 7 | Session/subagent model | §2 rollouts/resume/fork |
| 8 | Skills/plugins/MCP/hooks | §6 MCP support |
| 9 | Filesystem/worktree isolation | §3 sandbox modes + Seatbelt |
| 10 | Usage/cost reporting | §5 JSONL usage events |
| 11 | Failure/restart recovery | §2 resume + §7 cancel/resume commands |
| 12 | Stable vs experimental | §5 programmatic surface incl. experimental app-server |
| 13 | Security concerns | Security concerns section |
| 14 | A/W/B/B/D verdict | Verdict: ADOPT as wrapped worker node |
| 15 | Minimal integration example | Minimal integration example section |
| 16 | Unanswered questions | Unanswered questions section |

## 0. Ground truth inspected

| Item | Value |
|---|---|
| Binary | `~/.local/bin/codex` → `~/.codex/packages/standalone/releases/0.139.0-aarch64-apple-darwin/bin/codex` |
| Version (`codex --version`) | **codex-cli 0.139.0** |
| Build commit | `unknown` (standalone builds don't embed a commit hash; `codex doctor` reports `commit unknown`) |
| Update available | **0.149.0** (per `codex doctor`) — we are 10 minor versions behind |
| Install method | standalone unix package (self-managed under `~/.codex/packages/`), NOT npm/brew |
| `CODEX_HOME` | `~/.codex` |
| `~/.codex/config.toml` | **DOES NOT EXIST.** Only `auth.json`, `log/`, `packages/`, `tmp/` present. ⚠️ Corrects the task premise: no OpenRouter `model_providers` block is configured locally yet; Codex is running on default ChatGPT OAuth auth. |
| Auth (redacted) | `auth.json` keys: `auth_mode`, `OPENAI_API_KEY` (empty), `tokens{id_token, access_token, refresh_token, account_id}`, `last_refresh` → **ChatGPT subscription OAuth path**, not API-key billing. Values never read/printed. |
| Sessions on disk pre-test | none (`sessions/`, state DBs all missing — created lazily on first run) |

**Repo facts via GitHub API (fetched this session, 2026-08-22T21:32Z push):**

| Field | Value |
|---|---|
| Repo | `openai/codex` — "Lightweight coding agent that runs in your terminal" |
| Language | Rust |
| Stars / Forks | **113,158 / 17,348** |
| Open issues | 13,486 |
| Created / pushed_at | 2025-04-13 / **2026-08-22T21:32:01Z** (same-day activity; extremely active) |
| Default branch | `main`; not archived |
| License | **Apache-2.0** (API + raw `LICENSE` fetch of LICENSE header both confirm) |

**OS support:** macOS (verified live, aarch64-apple-darwin), Linux (binary embeds `codex-linux-sandbox`, Landlock), Windows (native sandbox code paths + docs). Install paths: standalone script, npm `@openai/codex`, brew.

---

## 1. Non-interactive/headless invocation — `codex exec`

Verified against installed 0.139.0 help text:

```
Usage: codex exec [OPTIONS] [PROMPT]
       codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]   # also --last
       codex exec review [...]                              # repo code review
```

**Prompt/stdin contract:** prompt as positional arg; if omitted or `-`, read from **stdin**. If stdin is piped *and* a prompt arg is given, stdin is appended as a `<stdin>` block. ⚠️ Live-observed gotcha: with stdin attached to a pipe, exec prints `Reading additional input from stdin...` and waits for EOF — **a cron wrapper must close stdin (`< /dev/null`) or it can hang forever**.

**Key flags (all verified in `--help`):**
- `-C/--cd DIR` working root; `--add-dir DIR` extra writable dirs
- `-s/--sandbox {read-only|workspace-write|danger-full-access}`
- `--skip-git-repo-check` (else Codex refuses to run outside a git repo); `--ephemeral` (don't persist session files)
- `--json` — emit event stream as JSONL on stdout
- `-o/--output-last-message FILE` — write final agent message to file
- `--output-schema FILE` — constrain final response to a JSON Schema
- `-m/--model`, `-p/--profile`, `-c key=value` TOML overrides, `-i` images, `--color`
- `--ignore-user-config`, `--ignore-rules` (clean-room automation runs)
- No `-a/--ask-for-approval` flag exists on `exec` (top-level only): non-interactive runs are approval-less by design; sandbox escalations simply fail rather than prompt.
- `--dangerously-bypass-approvals-and-sandbox` exists but should never appear in our wrappers.

**Exit codes (live-tested):** `0` success · `1` runtime error (e.g., nonexistent session UUID) · `2` CLI usage error (e.g., unrecognized flag). Treat anything ≠0 as job failure.

## 2. Session model — rollouts, resume, fork

Live-verified by running two real sessions:

- Rollout location: **`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<thread_id>.jsonl`** (observed: `sessions/2026/08/22/rollout-2026-08-22T15-50-48-01a02b74-….jsonl`)
- Rollout record types (inspected): `session_meta` (id, timestamp, cwd), `event_msg` (`task_started`, `user_message`, …), `response_item` (full model/exec messages incl. injected `<permissions instructions>` and `<environment_context>`), `turn_context` (cwd, workspace roots).
- Companion state DBs under `$CODEX_HOME`: `state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite` (created lazily; reported by `codex doctor`). Plus optional `history.jsonl` (disable: `[history] persistence = "none"`).
- Thread id surfaced in-band as first JSONL event of `--json`: `{"type":"thread.started","thread_id":"<uuid>"}` — parse this line to learn the id for later resume. Session files are written incrementally, so a killed job leaves a resumable partial rollout.
- **Resume:** `codex exec resume <SESSION_ID|"--last"> [PROMPT]`. Live test resumed thread `01a02b74-…` and the model recalled its prior answer ("SMOKE_OK"). ⚠️ Verified pitfall: `exec resume` **rejects `--sandbox`** (exit 2) — pass sandbox/approval via `-c sandbox_mode="read-only"` instead. Resume defaults to cwd-filtered picker; `--all` disables filtering.
- **Fork:** top-level `codex fork [SESSION_ID|--last] [PROMPT]` branches an old session into a new thread id (interactive-oriented; exec has no fork subcommand).
- `codex archive/unarchive` exist for session housekeeping.

## 3. Sandbox & approval modes

- `-s/--sandbox`: **read-only** (default posture for safe runs) | **workspace-write** (cwd + tmp writable; `[sandbox_workspace_write] network_access=false` by default, `writable_roots[]`, `exclude_slash_tmp`, `exclude_tmpdir_env_var`) | **danger-full-access** (no sandbox at all).
- `approval_policy` (config/`-c`): `untrusted` | `on-request` | `never` (+ granular table form); `on-failure` deprecated. Non-interactive `exec` never prompts regardless.
- **macOS enforcement is Seatbelt** — verified in binary: `/usr/bin/sandbox-exec`, `.sbpl` policy strings, `sandboxing/src/seatbelt.rs`. Linux uses bundled `codex-linux-sandbox` (Landlock). So on this Mac mini, read-only/workspace-write are genuine kernel-level confinement, not honor-system.
- Newer alternative: `default_permissions = ":read-only" | ":workspace" | ":danger-full-access"` named permission profiles *(docs)* — don't combine with `sandbox_mode`.
- In workspace-write, `.git/` may stay read-only → `git commit` can require escalation *(docs)*.

## 4. Model/provider config & profiles

⚠️ **Nothing is configured locally yet** (no config.toml). Target OpenRouter block per current docs *(docs, verified schema rows)*:

```toml
model = "openai/gpt-5-mini"            # any OpenRouter model slug
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"          # key lives in env, never in file
wire_api = "responses"                  # ONLY supported value now ("chat" removed)
request_max_retries = 4                 # defaults shown for reference
stream_max_retries = 5
stream_idle_timeout_ms = 300000
```

- `wire_api`: docs now say **"`responses` is the only supported value, and it is the default"** — good news: matches OpenRouter's `/v1/responses` endpoint; no chat-completions fallback exists anymore.
- Reserved provider ids: `openai`, `ollama`, `lmstudio` (+ built-in `amazon-bedrock`). Custom ids like `openrouter` are fine.
- Auth options mutually exclusive: `env_key` vs command-backed `[model_providers.<id>.auth]` vs `experimental_bearer_token` vs `requires_openai_auth`.
- **Profiles changed in 0.134.0+:** `-p/--profile name` layers **`$CODEX_HOME/<name>.config.toml`** over base config. Legacy `[profiles.name]` tables and top-level `profile =` selector are **no longer supported**. So an OpenRouter profile = create `~/.codex/openrouter.config.toml`, run `codex exec -p openrouter …`.
- Project-local `.codex/config.toml` cannot override `model_providers`/provider/auth keys (security) — user-level only.
- Secret hygiene: `[shell_environment_policy]` can strip `*_KEY/*_SECRET/*_TOKEN` from spawned-command envs.

## 5. Programmatic surface

- **JSONL event stream** (`--json`) — live-captured sequence:
  `thread.started{thread_id}` → `turn.started` → `item.started/item.completed` (`command_execution` items carry full `command`, `aggregated_output`, `exit_code`) → `item.completed{type:"agent_message",text}` → `turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens,…}}`. One JSON object per line ⇒ trivially parseable stream for Hermes.
- `-o FILE` last-message extraction; `--output-schema` structured finals.
- **`codex mcp-server`** — run Codex itself **as an MCP server over stdio**: Hermes' native-mcp could embed a full Codex agent as tools without shelling out. This is the cleanest bidirectional integration surface.
- **`codex app-server`** (experimental) — daemon/proxy subcommands; transports `stdio://` (default), `unix://PATH`, `ws://IP:PORT` (+ token/JWT auth options for non-loopback); `generate-json-schema` / `generate-ts` emit protocol bindings. Designed exactly for IDE-style structured integrations.
- Also experimental: `remote-control` (daemon mgmt), `exec-server`, `codex cloud`. Feature flags via `codex features list` (~60 flags incl. stable `multi_agent`, `hooks`, unified_exec).
- `notify` hook: external program invoked with JSON (`agent-turn-complete`, thread-id, last message) — webhook-style completion signaling *(docs)*.

## 6. MCP support

Two directions, both present in 0.139.0:
1. **Codex as MCP client:** `codex mcp list|get|add|remove|login|logout`; servers declared under `mcp_servers.<id>` (stdio `command`+`args`, HTTP with `bearer_token_env_var`, oauth/chatgpt auth fallback, per-tool approval modes). Local state: currently zero servers configured.
2. **Codex as MCP server:** `codex mcp-server` exposes the agent over stdio MCP — consumable directly by Hermes' native-mcp client.

## 7. Hermes-driven wrapper — start / stream / cancel / resume

Concrete contract (all commands verified this session):

```bash
export PATH="$HOME/.local/bin:$PATH"

# START (safe read-only cron form; stdin MUST be closed)
JOB=$(mktemp -d /tmp/codex-job.XXXXXX)
codex exec \
  --sandbox read-only \
  -C "$WORKDIR" \
  --json \
  -o "$JOB/last.txt" \
  "$PROMPT" \
  < /dev/null > "$JOB/events.jsonl" 2> "$JOB/err.log"
echo $? > "$JOB/exit"          # 0 ok | 1 runtime | 2 usage

# STREAM: tail -f $JOB/events.jsonl   (or poll from the process tool)
THREAD_ID=$(head -1 "$JOB/events.jsonl" | python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["thread_id"])')

# CANCEL: kill the backgrounded PID (process action=kill). Partial rollout persists;
#         resumable because rollouts are written incrementally.

# RESUME (note: -c, NOT --sandbox — verified exit-2 rejection):
codex exec resume "$THREAD_ID" -c sandbox_mode="read-only" --json "continue: …" </dev/null

# RESUME most recent regardless of id:
codex exec resume --last -c sandbox_mode="read-only" "next step" </dev/null
```

Hermes mapping: `terminal(background=true)` → session_id; `process poll/log` = streaming; `process kill` = cancel; parse `thread_id` from first JSONL line and stash it in job metadata for resume. For richer control later, swap `exec` for `codex app-server --listen stdio://` (or register `codex mcp-server` via native-mcp).

---

## Security concerns

- **danger-full-access blast radius:** removes ALL filesystem/network confinement on a host that holds Alastair's keys, Hermes data, R2 credentials. A prompt-injected or hallucinating Codex could exfiltrate secrets, rewrite `~/.hermes`, destroy repos. Never acceptable in cron wrappers; only inside a throwaway VM/container that is itself the boundary. Our skill's gateway workaround (`--sandbox danger-full-access` when bubblewrap breaks) does not apply on macOS — Seatbelt works here; keep read-only/workspace-write.
- Prompt-injection surface: Codex reads repo content incl. `AGENTS.md`, `.codex/config.toml` (project layer loads only when trusted; provider/auth keys ignored there — good design).
- `auth.json` sits world-unreadable (600) with long-lived OAuth refresh tokens; treat `~/.codex` as secret-bearing. Cron scripts must never cat/log it.
- workspace-write + `network_access=true` would allow outbound exfil from a "writable" job; leave network off for untrusted tasks.
- Exec context inherits env; consider `[shell_environment_policy]` filters so spawned commands don't see unrelated secrets.

## Verdict: **ADOPT (as wrapped worker node)**

Rationale: Apache-2.0, same-day-active upstream (113k stars), real OS-level sandboxing on macOS, first-class headless mode (`exec --json`, output-schema, resume by thread id), dual MCP surfaces, and profile-based provider switching that fits our OpenRouter plan. Wrap rather than raw-drive: the stdin-EOF hang, `resume` flag asymmetry, and danger-full-access footgun all demand a thin Hermes wrapper owning flags, logging, and cancellation.

## Minimal integration example (cron-safe, read-only)

```bash
#!/bin/bash
# hermes-codex-job.sh — read-only codex run from a Hermes cron context
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
WORKDIR="${1:?usage: hermes-codex-job.sh <git-workdir> <prompt> }"; PROMPT="${2:?}"
JOB="$(mktemp -d /tmp/codex-job.XXXXXX)"

codex exec --sandbox read-only -C "$WORKDIR" --json -o "$JOB/last.txt" \
     "$PROMPT" < /dev/null > "$JOB/events.jsonl" 2> "$JOB/err.log"
rc=$?

tid=$(head -1 "$JOB/events.jsonl" | sed -n 's/.*"thread_id":"\([^"]*\)".*/\1/p')
printf '{"exit":%d,"thread_id":"%s","job":"%s"}\n' "$rc" "${tid:-none}" "$JOB"
tail -5 "$JOB/err.log" >&2 || true
[ "$rc" -eq 0 ] && cat "$JOB/last.txt"
exit "$rc"
```

(For write jobs, swap to `--sandbox workspace-write` and keep `network_access` off.)

## Unanswered questions

1. **OpenRouter + Responses wire-compat:** docs confirm `wire_api="responses"` is the only mode, but we haven't live-run Codex against `openrouter.ai/api/v1` yet (no config.toml exists). Reasoning-effort/tool-call fidelity across non-OpenAI models untested.
2. **Billing collision:** current auth.json is ChatGPT OAuth. Adding `env_key=OPENROUTER_API_KEY` profiles coexists fine, but which credential wins when neither profile nor default is explicit needs one deliberate test.
3. **Kill semantics:** SIGTERM mid-turn confirmed to leave a resumable rollout? (Incremental writes strongly suggest yes; not yet force-killed live.)
4. **`codex exec review`** capabilities/flags unexplored — candidate for PR-review lane.
5. **app-server protocol stability:** experimental; `generate-json-schema` output version-drift between 0.139→0.149+ unknown. Pin before building on it.
6. **Windows/Linux parity** irrelevant for this Mac mini but noted if control room ever distributes workers.
7. Whether `default_permissions` profiles will replace `sandbox_mode` flags soon (beta) — watch before standardizing wrappers.

## Cross-refs

- Landscape scans: `orchestration-landscape-2026-08-22.md`, `agent-harnesses-landscape-2026-08-22.md`
- License matrix: `control-room_research_license-reuse-matrix.md`
- Skill note: local `codex` skill documents a `--yolo` flag that **does not exist in 0.139.0** (now `--dangerously-bypass-approvals-and-sandbox`); patch queued separately.
