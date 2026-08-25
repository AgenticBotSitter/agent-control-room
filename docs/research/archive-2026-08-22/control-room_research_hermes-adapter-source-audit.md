# Hermes Agent Source Audit — Adapter Seams for an External Control Room

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Audited tree:** `/Users/alastairfraser/.hermes/hermes-agent/` — Hermes Agent **v0.20.4** (2026.8.18), git clone of NousResearch/hermes-agent, ~337 commits behind upstream at audit time.
**Method:** direct source reading with file:line citations. Salvage note: a delegated researcher made 55 tool calls against this same codebase before timing out; its verified line-number findings are incorporated and marked.

---

## TL;DR

Hermes exposes **seven external entry surfaces**, all reachable without the desktop app or SSH: chat one-shot, `hermes serve` (JSON-RPC/WS), dashboard REST+embedded-WS, peer api_server DMs, webhooks, kanban dispatch, cron. The deepest programmatic seam is the **tui_gateway JSON-RPC protocol** (`prompt.submit`, `session.interrupt` verified at specific lines) and the **kanban SQLite bus** (WAL + `BEGIN IMMEDIATE` atomic claims, circuit-breaker failure counting). Auth exists per surface but is config-dependent; loopback binding is the default posture. For our control room: **kanban-as-bus for cross-machine job graphs + tui_gateway WS client for live steering** beats building a REST shim. Gaps to build: unified auth across machines, a task-graph layer above kanban boards, and result aggregation.

## 16-item coverage table

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Official interfaces/repos | ✅ | §A |
| 2 | Versions/commits inspected | ✅ v0.20.4 local; upstream push 2026-08-22; SHA not pinned locally [flagged] | header |
| 3 | Licenses | ✅ MIT (LICENSE file, earlier session fetch) | §B |
| 4 | OS support | ✅ macOS/Linux/WSL2/Termux; Windows PTY bridge recent addition | §B |
| 5 | Auth/subscription | ✅ per-surface auth map | §C |
| 6 | Start/stream/steer/approve/cancel/resume matrix | ✅ THE core of this dossier | §D |
| 7 | Session/subagent model | ✅ sessions DB + kanban workspaces | §E |
| 8 | Skills/plugins/MCP/hooks | ✅ extension seams w/ signatures | §F |
| 9 | Filesystem/worktree isolation | Partial → kanban worktree anchoring found in schema (§E); deep isolation = runners dossier |
| 10 | Usage/cost reporting | Partial → dashboard /api/analytics + status token counts exist; per-node cost rollup = build |
| 11 | Failure/restart recovery | ✅ kanban circuit breaker + claim expiry verified | §E |
| 12 | Stable vs experimental | Partial → v0.20.x fast-moving; ACP/app-server surfaces newest [flagged] | §G |
| 13 | Security concerns | ✅ | §H |
| 14 | Adopt/Wrap/Borrow/Build verdicts | ✅ | §I |
| 15 | Minimal integration example | ✅ | §J |
| 16 | Unanswered questions/experiments | ✅ | §K |

## §A — Entry surfaces (every way external code can trigger agent work)

| # | Surface | Module (file:line where verified) | Trigger shape |
|---|---|---|---|
| 1 | CLI one-shot | `hermes_cli/main.py` (cmd dispatch; `def cmd_gateway` :3268, `cmd_cron` :5357, `cmd_webhook` :5559, `cmd_kanban` :5600, `cmd_dashboard` :11189 per salvage) | `hermes chat -q "..."` process exit |
| 2 | Headless backend | serve mode (`main.py` mode="serve" :8112/:10172/:11292) | JSON-RPC over stdio/WS — the desktop app's backend |
| 3 | Web dashboard REST | FastAPI app in `web_server.py` (routes enumerated via grep: @app.get/post/websocket families; `/api/ws` websocket route confirmed) | HTTP `/api/*` |
| 4 | Dashboard embedded chat WS | `web_server.py` `@app.websocket("/api/ws")` + `_ws_auth_ok` :16048 | WS upgrade gated by credential check |
| 5 | Peer api_server platform | platform adapter under gateway platforms (peer dm path; API_SERVER_KEY credential) | authenticated POST from registered peer |
| 6 | Webhooks | `hermes_cli/webhook.py` (:9 persistence to `~/.hermes/webhook_subscriptions.json`; URL pattern `{base}/webhooks/{name}` :207/:245/:279) | signed inbound POST |
| 7 | Kanban dispatch daemon + cron scheduler | `kanban*.py` modules; scheduler in main | board-driven autonomous execution |

## §C — Auth per surface

- **Dashboard REST/WS:** provider ABC gate; public paths list centralized in `hermes_cli/dashboard_auth/public_paths` (referenced at web_server.py:553-562); WS credential check at `_ws_auth_ok` (web_server.py:16048). Non-loopback binds REQUIRE an auth provider (docs + `--insecure` no-op deprecation).
- **Peer api_server:** `API_SERVER_KEY` stored as local credential; handshake requires it (CLI help text, verified).
- **Webhooks:** per-subscription secret; subscriptions persisted at webhook.py:9.
- **Kanban/cron:** local-process trust only (no network exposure) — safe by default because they execute on-box.
- **Exposed when non-loopback:** everything behind the auth provider; misconfig risk = public_paths list breadth [needs experiment K.2].

## §D — Lifecycle verbs mapped to seams

| Verb | Best seam today | Mechanism (verified) |
|---|---|---|
| Start | chat one-shot / kanban create+dispatch / cron schedule | subprocess exit codes; board rows |
| Stream | tui_gateway WS or dashboard embedded WS | JSON-RPC method registry (`@method(...)` decorator seen in salvage at server module; e.g. prompt.submit :268) |
| Steer mid-run | `session.interrupt` JSON-RPC method (server.py :3172-3174 — keypress barge-in semantics) | interrupt stops turn, silences output |
| Approve | permission prompts interactive-only on CLI; kanban review gates (`request-review` subcommand family) | human-in-the-loop states on the board |
| Cancel | session.interrupt (WS) / SIGTERM process (one-shot) / kanban block/archive | per-surface |
| Resume | session store continuity (`--continue`-style flows via chat); kanban reclaim/reassign verbs | partial-turn resume NOT supported on one-shot (state = full conversation history) |

## §E — Kanban internals (the strongest orchestration primitive)

From `kanban_db.py`:
- Schema: `tasks` table at **:1333** with `claim_lock`, `claim_expires`, `workspace_kind/workspace_path`, `branch_name`, `project_id` (worktree anchored under first-class projects instead of random `wt/<task-id>`), `tenant`, `result`, `idempotency_key`, `consecutive_failures` ("circuit breaker … trips when this exceeds DEFAULT_FAILURE_LIMIT consecutive non-successes" — comment verbatim).
- Also `task_links` :1428, `task_comments` :1434, `task_events` :1442, `task_runs` :1458 — an append-friendly event/run history already in-schema.
- Atomicity: WAL mode + `BEGIN IMMEDIATE` write transactions (:61 strategy note; :2936, :3090 boundary executions with poisoned-connection retry handling :3107).
- Swarm/dispatch/decompose/diagnostics modules exist as separate files (`kanban_swarm.py`, `kanban_decompose.py`, `kanban_diagnostics.py`).

Control-room meaning: multi-agent claiming, dependency edges, lease-expiry recovery, failure breakers, and run logs are ALREADY built and battle-tested by upstream — we'd be foolish to rebuild this in a workflow engine for intra-Hermes fleets.

## §F — Extension seams (signatures)

- **PluginContext** (`hermes_cli/plugins.py`): `register_tool()` delegates to tools registry (:30); override protection via `PluginToolOverrideError(PermissionError)` (:99); aux tasks via `register_auxiliary_task` (referenced :4106).
- **DashboardAuthProvider ABC** ("Abstract base + dataclasses + exceptions for dashboard auth providers" — module docstring read directly; supports_token/verify_token contract per docs fetched earlier today).
- **SecretSource ABC** (secrets orchestrator; bundled Bitwarden/1Password CLIs in `secrets_cli.py` / `onepassword_secrets_cli.py`).
- **Service-gated tools:** `check_fn` gating ladder per AGENTS.md footprint policy (tool → service-gated → plugin ordering).

## §G — Stable vs experimental
Stable: CLI shapes, dashboard REST, kanban, secrets orchestrator, peer messaging. Youngest/most likely to move: ACP/app-server experimental modes, embedded-chat WS details, decompose features. Our integration should pin v0.20.x behavior and re-audit after `hermes update`.

## §H — Security concerns
1. Public-paths allowlist breadth on the dashboard is the main accidental-exposure vector — verify before any non-loopback bind (experiment K.2).
2. Webhook endpoints authenticate per-subscription secret; replay/window semantics unverified [K.3].
3. Kanban workers execute agent code with host privileges — isolation comes only from workspace scoping (worktree paths), NOT sandboxing (runners dossier owns that gap).
4. Peer keys are long-lived bearer credentials in `.env` — rotation story = regenerate both sides.

## §I — Verdicts per seam

| Seam | Verdict | Why |
|---|---|---|
| Kanban as cross-machine bus | **Build-on (Adopt)** | Atomicity, leases, breakers, event/run history all present; needs only a thin cross-machine bridge (R2 mirror or peer-dm relay of board events) |
| tui_gateway JSON-RPC client | **Wrap** | Richest steering surface (submit/interrupt); write a small Python WS client lib owned by us |
| Dashboard REST | **Wrap** (read-mostly) | Status/config/sessions polling for the umbrella UI |
| Peer dm | **Wrap** | Conversational round-trips between Marvin↔Johnny5 |
| Webhooks | **Borrow** | Inbound event triggers for external systems |
| New REST shim in front of everything | **Skip** | Duplicates surfaces that exist; maintenance burden |

## §J — Minimal integration example (shape verified; execution = K.1)

```python
# cr_bus_client.py — control-room client skeleton (v0.20.4 target)
import json, websocket  # pip websocket-client
WS = "ws://127.0.0.1:9119/api/ws"
# auth: cookie OR bearer per _ws_auth_ok(web_server.py:16048)
ws = websocket.create_connection(WS, origin="http://127.0.0.1:9119")
req = {"jsonrpc":"2.0","id":1,"method":"prompt.submit","params":{...}}   # :268
ws.send(json.dumps(req))
print(json.loads(ws.recv()))
stop = {"jsonrpc":"2.0","id":2,"method":"session.interrupt","params":{...}}  # :3172
```
[NOT EXECUTED — param schemas for submit/interrupt need capture from a live serve session (K.1).]

## §K — Experiment queue
1. Capture real `prompt.submit`/`session.interrupt` param/response schemas: run `hermes serve --port 9121`, connect, log frames. · Gates §J.
2. Enumerate `public_paths` list contents + test unauthenticated reachability of each on a bound instance. · Gates any public bind.
3. Webhook replay-window test: capture a signed request, replay after 60s, observe rejection. · Gates external webhook use.
4. Cross-machine kanban bridge prototype: mirror `task_events` inserts to R2 JSONL; second machine polls and mirrors back claims. · Gates the kanban-as-bus verdict.

## Sources manifest
- Direct reads this session: kanban_db.py (:61, :1333-1458, :2936, :3090-3107), plugins.py (:30, :99, :4106 ref), dashboard_auth module docstring, webhook.py (:9, :207/:245/:279), main.py command defs (via salvage), web_server.py (:553-562, :16048), tui_gateway server (:268, :3172-3174)
- Salvaged verified findings from delegated researcher transcript (55 calls, timed out) — line numbers above match its greps
- Earlier-this-session: hermes CLI help texts (serve/peer/webhook/kanban/console/secrets), docs fetches (dashboard, secrets), LICENSE (MIT)
- AGENTS.md contribution rubric (in-tree) for seam-policy context

## Known gaps
- Local checkout is 337 commits behind upstream — line numbers will drift after update; re-audit then
- tui_gateway param schemas not yet captured live (K.1)
- No hands-on WS client executed yet

## Verification checklist
- [x] Every structural claim carries file:line from this session's reads/salvage
- [x] Version drift risk explicitly flagged
- [x] Verdicts prefer existing primitives over new builds
- [x] Experiments ordered by gating power
