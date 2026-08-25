# Multi-Agent Orchestration & Control-Room Landscape + Hermes Remote Interfacing

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Scope:** (1) platforms that let one operator run many AI agents from one interface, including job-decomposition-across-agents systems; (2) every non-app, non-SSH way into Hermes Agent; (3) official repos and build-path recommendation.

---

## TL;DR

1. **The control-room category is real and crowded** — but almost all of it orchestrates *coding* agents (Claude Code, Codex, Gemini CLI) on git worktrees. The strongest verified open-source options are **Gas Town** (17.7k★, coordinator+merge queue), **Superset** (13.2k★, 100+ parallel agents IDE), **Agent Orchestrator** (9.8k★, fleet manager w/ PR-per-agent), and **AgentTeams** (5.5k★, Matrix-room-based human-in-the-loop OS). None of them natively manage Hermes Agents — they'd need adapters.
2. **You already own a native multi-agent orchestration layer you may not know about:** Hermes ships **Kanban** (SQLite task board, atomic claim, dependencies, swarms, dispatch daemon, review gates, shared across profiles) plus **Peer-to-peer messaging** (`hermes peer dm` — machine-A messages machine-B's agent over an authenticated API server and prints the reply). Marvin↔Johnny5 is one `peer add` away from first-class.
3. **Hermes has five remote interfaces that need no SSH and no desktop app:** Web Dashboard (`hermes dashboard`, port 9119, full REST API at `/api/*` incl. sessions/cron/config/memory), headless `hermes serve` (JSON-RPC/WebSocket backend), `hermes webhook subscribe` (event-driven inbound), `hermes chat -q` one-shot over any transport, and the peer API server. Auth ranges from basic-auth env vars to Nous Portal OAuth to service bearer tokens.
4. **Official repos:** core + desktop live in ONE repo — `github.com/NousResearch/hermes-agent` (234k★, MIT, desktop at `apps/desktop/`). Docs at hermes-agent.nousresearch.com/docs. There is no separate desktop-app repo.
5. **Recommended path:** don't adopt an external control room yet — stand up the **native stack first** (dashboard on both machines + kanban board + peer mesh), then bolt an external UI on top only if the native one falls short.

---

## Part 1 — The orchestration/control-room landscape

### 1a. Verified platform table (GitHub API checked 2026-08-22)

| Platform | Stars | License | Last push | What it actually is |
|---|---|---|---|---|
| [Gas Town](https://github.com/gastownhall/gastown) | 17,723 | MIT | 2026-08-19 | Multi-agent workspace manager: scales to 20–30 agents with a coordinator, git-backed issue tracking, health watchdogs, Bors-style merge queue |
| [Superset](https://github.com/superset-sh/superset) | 13,225 | NOASSERTION¹ | 2026-08-22 | Agentic code editor built around running 100+ coding agents in parallel on one machine |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 9,849 | Apache-2.0 | 2026-08-22 | Agent IDE managing fleets of coding agents; isolated worktrees, PR-per-agent, single control surface, plugin adapter architecture |
| [AgentTeams](https://github.com/agentscope-ai/AgentTeams) | 5,458 | Apache-2.0 | 2026-08-22 | Collaborative multi-agent OS; transparent human-in-the-loop coordination via **Matrix chat rooms** — closest thing to a generic (non-coding) control room |
| [CodexMonitor](https://github.com/Dimillian/CodexMonitor) | 4,246 | MIT | 2026-03-26² | Native app monitoring/orchestrating multiple Codex agents across local workspaces (**resting**) |
| [clawe](https://github.com/getclawe/clawe) | 749 | AGPL-3.0 | 2026-02-23² | "Trello for OpenClaw agents" — multi-agent coordination boards (**resting**) |
| [ai-maestro](https://github.com/23blocks-OS/ai-maestro) | 754 | MIT | 2026-08-20 | Dashboard spanning **multiple machines**; adds memory search, code-graph queries, agent-to-agent messaging; supports Claude/Aider/Cursor |
| [Forge Orchestrator](https://github.com/nxtg-ai/forge-orchestrator) | 158 | NOASSERTION¹ | 2026-08-20 | Coordinates Claude Code + Codex + Gemini CLI on ONE shared repo through a research→plan→delegate→adversarial-verify→deploy pipeline; file locking, drift detection; single Rust binary |

¹ `NOASSERTION` = GitHub's license bot hasn't classified the LICENSE file yet; check the repo's LICENSE directly before relying on it (per external-project-research pitfall 24).
² Dormant/resting per the community awesome-list tracking — listed for completeness, not recommended for adoption.

### 1b. Adjacent classes (for orientation, not control rooms)

- **Frameworks** (you write the orchestration code): LangGraph, Google ADK (`google/adk-python`), CrewAI, AutoGen, Haystack — 14k+ repos under GitHub's `multi-agent` topic. These are libraries, not operator surfaces.
- **Directories worth watching:** [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) (curated list, actively maintained) and [openorchestrators.org](https://openorchestrators.org/) (directory of open orchestration platforms, launched Jun 2026).
- **Enterprise governance layers** (TrueFoundry/FutureAGI-style comparisons) — SaaS, heavier than this use case needs.

### 1c. Honest gap analysis

Every serious control-room project above assumes its agents are **coding agents driven by CLI substrates** (Claude Code/Codex/Cursor) or LLM-API calls. None speaks Hermes natively. Two integration shapes exist:

1. **Adapter shape:** treat each Hermes instance as a black-box agent reachable via `hermes chat -q` or its dashboard/peer API — the orchestrator spawns tasks, Hermes executes. Feasible today; requires writing an adapter per platform.
2. **Skip-and-use-native shape:** Hermes already contains kanban swarms + peer messaging + dashboards (Part 2). For *managing Hermes instances*, the native stack beats every external option because it understands skills, crons, memory, and sessions natively.

### 1d. Fit assessment vs our stack (Marvin Mac mini + Johnny5 VPS)

| Option | Fit | Why |
|---|---|---|
| Gas Town | Medium | Best-in-class coordinator patterns, but built around git-worktree coding agents; our agents are ops agents |
| Superset / Agent Orchestrator | Low-Medium | Same substrate assumption; heavy local IDE focus |
| AgentTeams | Medium-High | Matrix-room model generalizes beyond coding; human-in-the-loop by design; would need a Hermes bridge bot |
| ai-maestro | Medium | Multi-machine dashboard concept matches Marvin+Johnny5 exactly; small project (754★) = risk |
| **Native Hermes stack** | **High** | Zero new infrastructure; kanban+peers+dashboard cover ~90% of the stated need |

---

## Part 2 — Hermes Agent: every remote interface (no app, no SSH)

All facts below verified against the installed v0.20.4 CLI (`hermes <cmd> --help`) and the official docs on 2026-08-22.

### 2a. Web Dashboard — `hermes dashboard`

The primary remote surface. Browser admin panel served by FastAPI/Uvicorn:

```bash
cd ~/.hermes/hermes-agent && uv pip install -e ".[web,pty]"   # one-time deps
hermes dashboard                    # http://127.0.0.1:9119
hermes dashboard --host 0.0.0.0 --port 9119 --no-open   # remote mode (auth REQUIRED)
```

- **Pages:** Status (gateway state, active/recent sessions, token usage, auto-refresh), Sessions, Cron (aggregates across profiles), Config, API Keys, Skills, MCP, Models, Memory, Logs, and a **Chat tab** (real TUI embedded via PTY/WebSocket).
- **Machine-level, multi-profile:** one dashboard manages every profile on the box; profile switcher in URL (`?profile=worker`). Cron page aggregates across profiles.
- **Auth providers:** basic auth (`HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD/SECRET`), Nous Portal OAuth (`hermes dashboard register` provisions the client), and **non-interactive bearer tokens** for service-to-service calls (`supports_token` on the `DashboardAuthProvider` ABC; bundled `drain` provider verifies `Authorization: Bearer` against `HERMES_DASHBOARD_DRAIN_SECRET`, fails closed if secret <256 bits). Custom providers implementable.
- **REST API** (what a control room would call): `/api/status`, `/api/config`, `/api/credentials`, `/api/cron`, `/api/mcp`, `/api/memory`, `/api/logs`, `/api/gateway`, `/api/model`, `/api/actions`, `/api/analytics`, `/api/messaging`, `/api/pairing`, `/api/portal`, and more.
- **Remote hardening path:** systemd unit running the command above + reverse proxy; official docs show the exact unit file. A merged PR (#88074) adds **remote-gateway headers for Cloudflare Access proxies** — i.e., tunneling a VPS dashboard through CF Access is a first-class supported pattern.
- Verify gate: `curl -s http://HOST:9119/api/status | jq '.auth_required, .auth_providers'`.

### 2b. Headless backend — `hermes serve`

Same port family (default 9119), zero UI: the JSON-RPC/WebSocket gateway the desktop app itself talks to (`tui_gateway` API). This is the cleanest programmatic substrate for a custom control room: drive `hermes serve` on each machine, connect any WebSocket client. Flags: `--port/--host/--stop/--status/--isolated`. (`--insecure` is deprecated/no-op — public binds always require auth.)

### 2c. Peer-to-peer agent messaging — `hermes peer`

The built-in cross-machine primitive:

```bash
# on Johnny5: enable the api_server platform, then on Marvin:
hermes peer add johnny5 --url https://<johnny5-host>:<port>   # stores API_SERVER_KEY locally
hermes peer dm johnny5 "summarize yesterday's ATS orders"     # → reply printed here
```

- `peer dm <peer>/<agent> "..."` delivers into the remote agent's canonical Bot Chat **over the peer's API server** and prints the reply — no SSH, no Telegram, synchronous request/response.
- Peers must run the `api_server` platform. This is the sanctioned replacement for ad-hoc R2-inbox relays when you want conversational round-trips.

### 2d. Event-driven inbound — `hermes webhook`

`hermes webhook subscribe/add/list/test` — register HTTP endpoints that activate the agent on events (CI finished, email arrived, form posted). Inbound-only trigger surface; pairs well with an external orchestrator that emits events.

### 2e. Kanban swarms — built-in job decomposition

`hermes kanban init/create/swarm/decompose/dispatch/daemon/watch/request-review...` — durable SQLite task board shared across profiles: tasks claim **atomically**, support dependencies, execute in isolated workspaces per named profile, include review/promote/archive gates and a dispatch daemon. This IS the "one job handled by multiple agents coming together" feature — native, already installed. Spec: docs/user-guide/features/kanban (+ `docs/hermes-kanban-v1-spec.pdf`).

### 2f. Scripted one-shot — `hermes chat -q`

Any transport that can exec a process can drive Hermes: `hermes chat -q "<prompt>" -m <model> -s skill-a,skill-b --yolo -Q` (quiet, approval-free, clean stdout). Works over SSH, Tailscale exec, CI runners, or another agent shelling out. (Shape per the `hermes-cron-cli-shape` skill: top-level `-q` is dead; `chat` subcommand is required.)

### 2g. Nous Portal (hosted control plane)

portal.nousresearch.com — OAuth identity + model/tool gateway + `/local-dashboards` registration for exposing local dashboards. Optional; relevant because desktop-app ↔ remote-backend sign-in uses the same Portal OAuth flow.

### 2h. Desktop app as a thin remote

Not a separate repo: Electron app at `apps/desktop/` in the main repo. Its Settings → Gateways → **Remote gateway** turns it into a graphical remote for a VPS Hermes (URL + Portal/basic sign-in). Self-contained: runs its own `hermes serve`; never touches the web dashboard.

### 2i. Recommended remote topology for Marvin + Johnny5

```
Alastair (phone/laptop)
  │
  ├─ https://dashboard.marvin…  ← hermes dashboard @Mac mini  (CF Access / basic-auth)
  ├─ https://dashboard.johnny5… ← hermes dashboard @VPS      (CF Access; PR #88074 pattern)
  │
Marvin ⇄ hermes peer dm ⇄ Johnny5        (conversational, sync)
Marvin ⇄ hermes kanban (shared board)    (job decomposition, async)
external events → hermes webhook         (optional)
```

No new software required for v1. An external control-room UI becomes optional chrome on top of these APIs later.

---

## Part 3 — Official repos & links

| Thing | Where | Notes |
|---|---|---|
| Core repo | **https://github.com/NousResearch/hermes-agent** | 234,335★, MIT, default branch `main`, pushed 2026-08-22 (verified via GitHub API) |
| Desktop app | Same repo → `apps/desktop/` (+ `apps/shared/`, `apps/bootstrap-installer/`) | Electron; label `comp/desktop`. **No separate desktop repo exists** (org search: 0 standalone desktop repos) |
| Install | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | Linux/macOS/WSL2/Termux |
| Docs | https://hermes-agent.nousresearch.com/docs | Authoritative source for all features above |
| Dashboard doc | …/docs/user-guide/features/web-dashboard | Remote setup, auth providers, API |
| Kanban spec | …/docs/user-guide/features/kanban | Swarm/job-decomposition design |
| Portal | https://portal.nousresearch.com | Hosted gateway + dashboard registry |
| Local install (this Mac) | `~/.hermes/hermes-agent`, v0.20.4 (2026.8.18), git method | Currently 337 commits behind upstream — `hermes update` available |

Related org repos noticed during verification (context, not control-plane): `hermes-example-plugins`, `hermes-telegram-business`, `agent-governance-toolkit`, `hermes-paperclip-adapter`, `kanban-video-pipeline`.

---

## Recommendation (explicit)

**Phase 1 (do now, $0):**
1. `hermes update` on both machines (337 commits behind).
2. Enable `hermes dashboard` on Marvin + Johnny5 behind existing Cloudflare Access hostnames.
3. Wire `hermes peer add` both directions; retire ad-hoc inbox polling for conversational traffic (keep R2 for artifacts).
4. Move the Ox-Alpha-style multi-step builds onto a real `hermes kanban` board instead of the hand-rolled R2 session JSON (which produced the stale-result bug we hit on 2026-08-21 — kanban's atomic claim + dependency edges fix that class).

**Phase 2 (only if native falls short):** pilot **Gas Town** (coordinator/watchdog patterns, MIT) or **AgentTeams** (Matrix-room HITL, generalizes past coding agents) with a Hermes adapter via `chat -q`/peer API. Re-evaluate triggers: (a) you routinely juggle >5 concurrent agent jobs, (b) you want cross-org agents (Codex/Claude Code) in the SAME board as Hermes, (c) native dashboard UX blocks daily use.

---

## Sources manifest (all fetched/verified 2026-08-22)

**Primary — local ground truth:**
- `hermes --help`, `hermes {serve,peer,webhook,console,kanban,portal} --help` — v0.20.4 installed CLI
- `git remote -v` in `~/.hermes/hermes-agent` → NousResearch/hermes-agent.git
- GitHub API: `repos/NousResearch/hermes-agent`, `contents/apps`, `orgs/NousResearch/repos`, per-candidate repo lookups (raw responses archived in session)

**Primary — vendor docs:**
- https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard (full-page extract cached: `~/.hermes/cache/web/hermes-agent.nousresearch.com-2235233911.md`)
- https://hermes-agent.nousresearch.com/docs/integrations/nous-portal (cached)
- https://hermes-agent.nousresearch.com/docs/user-guide/desktop (search snippet, headline claims cross-checked vs cached pages)
- https://github.com/NousResearch/hermes-agent/issues/84483 + PR #88074 (remote gateway / Cloudflare Access)

**Independent:**
- https://github.com/andyrewlee/awesome-agent-orchestrators (curation list)
- https://openorchestrators.org/ (directory)
- https://www.augmentcode.com/tools/open-source-agent-orchestrators (roundup corroborating AO/worktree framing)
- Per-platform GitHub repos (table §1a) — star/license/push dates all from api.github.com this session

**Known gaps:** Superset + Forge licenses pending LICENSE-file confirmation (API said NOASSERTION); Gas Town/Superset capability claims taken from READMEs, not hands-on tests; kanban swarm behavior verified from help text + docs, not exercised end-to-end in this session.

## Verification checklist
- [x] Every repo existence/star/license/push verified via GitHub API 2026-08-22 (not memory)
- [x] NOASSERTION licenses flagged rather than guessed (pitfall 24)
- [x] Hermes interface claims verified against installed CLI help + official docs
- [x] No install recommendation without cost: Phase 1 items are $0 and reversible
- [x] Dated filename + R2 persistence + PROJECT.md declaration done
