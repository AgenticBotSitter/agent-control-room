# Gate 2 — Hermes Lifecycle/Schema Spike on Isolated Checkout

**Gate:** 2 of 8 (`docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md`)
**Owner dossier:** this file
**Date:** 2026-08-22 · **Runner:** Marvin (Mac mini)
**Repo:** https://github.com/NousResearch/hermes-agent.git
**Pinned SHA:** `987064caa4f8845f605ac7346fed5b72fddfb21c` (`987064c`, 2026-08-23 +0530, "fix: restore generic corruption match in FTS self-heal", shallow clone depth 50)
**Isolation:** fresh clone at `/tmp/hermes-isolated`; all live runs used `HERMES_HOME=/tmp/hermes-g2-home` (throwaway). Production `~/.hermes/hermes-agent` (v0.20.4) untouched; no production state read or written.
**License note:** repo is MIT (LICENSE:1-2). Deps installed into a throwaway venv for the spike: `pyyaml`, `python-dotenv`, `python-dotenv` transitive — permissive, internal-use only. No Hermes code is being redistributed by this research.

---

## Standing-rules ledger (per gate rules 1–7)

| # | Rule | Where satisfied |
|---|------|-----------------|
| 1 | Source URL + version/commit | Header above; every cite is `file:line` in `/tmp/hermes-isolated @ 987064c` |
| 2 | Tested vs documented | "TESTED" / "DOCUMENTED" labels throughout + ledger at end |
| 3 | Sanitized commands, no credentials | §Method; capture script wrote only synthetic `g2test*` data |
| 4 | Expected-vs-actual for hands-on tests | §Tested-vs-documented ledger (3 anomalies explained) |
| 5 | License/distribution effect | Header note; nothing redistributed |
| 6 | Adopt/Wrap/Borrow/Build/Defer per component | §Seams table |
| 7 | Risk + trigger per finding | §Risks & triggers |

---

## Method & isolation (sanitized)

```bash
# Isolated checkout (no in-place update of anything):
git clone --depth 50 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-isolated
git -C /tmp/hermes-isolated rev-parse HEAD   # -> 987064caa4f8845f605ac7346fed5b72fddfb21c

# Throwaway runtime for schema capture (Python >=3.10 required; system 3.9 fails PEP-604 syntax):
uv venv /tmp/hermes-g2-venv --python 3.12 && uv pip install --python /tmp/hermes-g2-venv/bin/python pyyaml python-dotenv

# Capture run — temp HERMES_HOME, zero production contact:
HERMES_HOME=/tmp/hermes-g2-home /tmp/hermes-g2-venv/bin/python /tmp/g2_capture.py
```

Capture script steps: import `tui_gateway.server` and dump its live method registry → init `SessionDB` and insert a synthetic session/message/usage row → init `kanban_db`, run create→claim→complete lifecycle → dump `sqlite_master` DDL of both DBs → list `$HERMES_HOME` layout. Evidence files copied to `research/evidence/g2_*`.

---

## (1) tui_gateway JSON-RPC method registry + exact schemas

### Registry mechanics — TESTED (imported the real module)

- `_methods: dict[str, callable] = {}` — `tui_gateway/server.py:145`. Handlers self-register via decorator `def method(name)` — `tui_gateway/server.py:2062-2067`.
- Validation/dispatch: `handle_request` — `tui_gateway/server.py:2078-2089`; JSON-RPC errors `-32600` (bad request), `-32602` (params must be object), `-32601` (unknown method); app errors use positive codes (4002/4004/4006/4007/4090/4010/4130/50xx…).
- `dispatch(req, transport)` — `tui_gateway/server.py:2126`: methods in `_LONG_HANDLERS` (`server.py:203`) run on a thread pool with contextvars snapshotted so pool workers write back to the bound transport; everything else inline.
- Wire protocol is **newline-delimited JSON-RPC 2.0 in both directions**, identical over stdio (TUI, `tui_gateway/entry.py`) and WebSocket (`tui_gateway/ws.py:1-27` docstring). Server→client events are *notifications* with method `"event"`.

### Event frame shape — TESTED (captured from live module)

`tui_gateway/server.py:1678-1689` builds:

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"tool.start","session_id":"sess-g2test","payload":{...}}}
```

Delivery precedence (`server.py:1660-1676`): event frames with a session_id go to that session's bound transport → else the request's ContextVar transport → else stdio. Session-less global events fan out via `_broadcast_global_event` (`server.py:1710+`). Per-token frames (`message.delta`, `reasoning.delta`, `thinking.delta`) are coalesced ~33 ms on WS (`ws.py:47-60`); any non-streaming frame flushes ahead of buffered tokens to preserve ordering.

Event vocabulary observed in emitters (`grep '_emit("' tui_gateway/server.py`): `message.start|delta|interim|complete`, `reasoning.available|delta`, `thinking.delta`, `tool.start|generating|output_risk|complete`, `status.update`, `approval.request`, `notification.clear`, `session.info`, `session.usage`, `reaction`, `error`, `terminal.close`, `preview.restart.progress`, `voice.*`, `wake.detected`, `moa.*`, `browser.progress`. — DOCUMENTED (grep), frame shape TESTED.

Runtime registry count: **172 methods** (dumped to `evidence/g2_tui_gateway_methods_runtime.txt`). Static grep found 162 decorators — delta is multi-line registrations. Relevant families: `prompt.*`, `session.*`, `subagent.*`, `delegation.*`, `approval.*`, `handoff.*`, `profiles.*`, `projects.*`, `config.*`, `complete.*`, `model.*`, `tools.list`, `slash.exec`, `rollback.*`, `browser.controller.*`, `image.*`, `file.attach`, `billing/subscription.*`, `pet.*`.

### prompt.submit — DOCUMENTED (handler read) · `tui_gateway/methods_prompt.py:268`

Params: `session_id`, `text` (sanitized server-side), `display_kind` (only `"hidden"` whitelisted), optional rewind set `truncate_before_user_ordinal | truncate_before_row_id | truncate_before_message_id` **requires `confirm_truncate`** (else error 4004), `interrupted` (barge-in latch), `queued`, `surface:"hud"`.
Behavior: if session busy, does NOT reject — queues as next turn (default interrupts the live turn via `_handle_busy_submit`); re-binds `session["transport"] = current_transport()` every submit so streaming follows the newest client (`methods_prompt.py:330-333`); active-session slot limit can reject with 4090; lazy/watch sessions reject mid-child-run with 4009.

### session.resume — DOCUMENTED · `tui_gateway/methods_session.py:356`

Params: `session_id` (required, 4006 if missing; title fallback lookup), `cols`, `profile` (resume across another local profile's state.db), `defer_history`, `omit_messages`, `lazy` (watch windows).
Behavior: follows compression-continuation chain via `db.resolve_resume_session_id()` to bind the live tip; resume-safety guard raises `SessionResumeTooLargeError` → error 4130 (limit from `sessions.max_resume_messages`, 0 disables); fail-open on transient guard failures; live sessions are reused (`_reuse_live_payload`) instead of rebuilt.

### session.interrupt — DOCUMENTED · `tui_gateway/methods_session.py:3179`

Params: `session_id`. Sets `session["_turn_cancel_requested"]=True`, bumps `_queued_prompt_generation` (invalidates queued prompts), calls `request_hard_interrupt(agent)`, force-clears a stuck `running` flag, resolves pending gateway approvals as `"deny"` (resolve_all). Compute-host-isolated variant delegates to supervisor interrupt and returns `{"status":"interrupted","turn_isolation":true}`. Stop kills the TURN only — agent-started background processes are intentionally left running.

### Steer / inject — DOCUMENTED

- `session.steer` — `methods_session.py:3456`: params `{session_id, text}` (text required, 4002). Calls `agent.steer(text)`: text lands on the last tool result of the next tool batch — no interrupt, no new user turn, no alternation violation. Returns `{"status":"queued"|"rejected","text"}`. Records an inflight correction so a resume during the turn still renders the steered text.
- `session.redirect` — `methods_session.py:3493`: hard redirect of the active model turn when the agent supports `_supports_active_turn_redirect`; during the turn-build window it degrades to queueing.
- `subagent.steer` — `methods_session.py:3292`: `{subagent_id (4000), text (4002), session_id}`; resolves the child in the delegation registry; steering authority is verified against the request's own transport + live session record (`_current_session_steer_authority`, `server.py:2091+`) — public session ids are only hints, transport rebinding invalidates stale claims. `"queued"` ≠ delivered: a child past its final tool batch surfaces `missed_steer` on completion.
- `subagent.interrupt` — `methods_session.py:3281`: `{subagent_id}` → `{"found": bool}`.
- `delegation.status` / `delegation.pause` — `methods_session.py:3253/3273`: active subagent list, spawn depth/concurrency caps, pause flag.

---

## (2) api_server platform vs serve/tui-gateway responsibility split — DOCUMENTED

Three distinct things share one agent core:

| Surface | What it is | Entry point | Owns |
|---|---|---|---|
| **tui_gateway** | In-process JSON-RPC core (§1). Stdio for Ink TUI; WebSocket for desktop/web via mount below. | spawned per process; `hermes --tui` child or embedded | Live session objects, turns, steering authority, approvals, streaming events |
| **serve / dashboard** | One FastAPI app (`hermes_cli/web_server.py`, ~18.6k lines). `serve` = headless backend (no UI build, no SPA, neutral ready sentinel) — `main.py:11265-11268`; `dashboard` = same app + SPA. Both mount the gateway at `@app.websocket("/api/ws")` → `tui_gateway.ws.handle_ws` (`web_server.py:17183-17213`, gated by `_DASHBOARD_EMBEDDED_CHAT_ENABLED`, `web_server.py:524`). | `hermes serve --port N` / `hermes dashboard` | Machine management REST (§3), PTY/console bridges, plugin mounts, cron/sessions/profile routers |
| **api_server platform** | A *messaging-gateway platform* (same registry as Telegram/Discord): `PLATFORMS["api_server"]` — `hermes_cli/platforms.py:42`, adapter `gateway/platforms/api_server.py`. OpenAI-compatible HTTP API run inside the gateway process (`hermes gateway run`), default port 8642, auth via `API_SERVER_KEY`. Endpoints (adapter docstring `gateway/platforms/api_server.py:1-45`): `POST /v1/chat/completions` (stateless; opt-in continuity via `X-Hermes-Session-Id`), `POST /v1/responses` (stateful via `previous_response_id`), `GET/DELETE /v1/responses/{id}`, `GET /v1/models`, `GET /v1/capabilities`, session CRUD under `/api/sessions[...]` incl. `/chat[/stream]` and `/fork`, and a **runs API**: `POST /v1/runs` (202 + run_id) → `GET /v1/runs/{id}` → SSE `GET /v1/runs/{id}/events` → `POST /v1/runs/{id}/approval|steer|stop`. With `gateway.multiplex_profiles`, secondary profiles are reached via `/p/<profile>/...` URL prefixes. | gateway process | Programmatic/OpenAI-compatible access |

Split summary: **tui_gateway = conversational control plane (one live process, richest verbs)**; **serve/dashboard = machine REST + UI + bridges (many profiles per machine)**; **api_server = standards-shaped ingress owned by the gateway platform layer**.

---

## (3) Dashboard REST endpoints sufficient for READ-ONLY worker detail

All behind the dashboard session-token middleware (bearer token or cookie); non-loopback binds engage the OAuth gate; WS upgrades take `?token=`.

Core routes (path → handler, isolated-tree line numbers):

- `GET /api/health` → `web_server.py:3453` · `GET /api/status?profile=<name>` → `web_server.py:3544` (machine liveness + per-profile gateway badge; shared liveness ladder with `/api/messaging/platforms`) · `GET /api/system/stats` → `web_server.py:4012`
- Sessions: `GET /api/sessions` (`web_routers/sessions.py:53`, limit≤100/offset/min_messages), `GET /api/sessions/search` (:169), `GET /api/sessions/{id}` (:555), `GET /api/sessions/{id}/messages` (:601), `GET /api/sessions/stats` (:523), `GET /api/sessions/{id}/latest-descendant` (:578), `GET /api/sessions/{id}/export` (:735)
- Cron: `GET /api/cron/jobs?profile=all` (`web_routers/cron.py:63`), `GET /api/cron/jobs/{job_id}` (:68), `GET /api/cron/jobs/{job_id}/runs?limit=` (:73), `GET /api/cron/delivery-targets` (:83)
- Usage/analytics: `GET /api/analytics/usage` (`web_server.py:15478`), `GET /api/analytics/models` (:15666)
- Ops reads: `GET /api/logs` (:12348), `GET /api/config` (:6844), `GET /api/model/info` (:6893), `GET /api/dashboard/plugins` (:18099)

Kanban worker detail (plugin-mounted, same auth): under `/api/plugins/kanban/` — `GET /board` (`plugins/kanban/dashboard/plugin_api.py:380`), `GET /tasks/{task_id}` (:519), `GET /workers/active` (:1551), `GET /runs/{run_id}` (:1611), `GET /runs/{run_id}/inspect` (:1634), `GET /stats` (:2204), `GET /assignees` (:2220), `GET /tasks/{task_id}/log` (:2241), `GET /boards` (:2462), `GET /diagnostics` (:1463).

That set covers status / sessions / cron / usage / kanban-worker detail without any write route.

---

## (4) Profile routing mechanics (`-p <name>`) — DOCUMENTED

Two different mechanisms share the word "profile":

1. **CLI profile selection → HERMES_HOME.** `_apply_profile_override()` — `hermes_cli/main.py:505-650` runs BEFORE any hermes import: scans raw argv for `-p/--profile` (also `--profile=NAME`), skipping value-consuming flags and `mcp add --args` passthrough; validates against `^[a-z0-9][a-z0-9_-]{0,63}$`; sets `HERMES_HOME` env and strips the flag so argparse never sees it. Precedence: explicit flag > pre-set HERMES_HOME **only if** its parent dir is literally `profiles` (issue #22502 heuristic) > sticky `~/.hermes/active_profile` > root home. Exception: s6-supervised gateway children never follow sticky active_profile (fixed slot identity).
2. **Gateway message routing → profile per chat scope.** `gateway/profile_routing.py:1-70`: config `gateway.profile_routes[]` maps platform scopes to profiles with specificity — thread 14 > chat 6 > guild 2 — parent-chain matching carries channel routes into threads/forum posts; unmatched → default profile; a route naming an unserved profile raises `ProfileRouteRejected`.
3. **Dashboard is machine-level.** A named-profile `dashboard` launch re-execs as the machine dashboard pinned `-p default` with `--open-profile <name>` preselected; per-request scoping is `?profile=` (`main.py:11310-11345`). One dashboard per machine is deliberate ("machine management surface").

---

## (5) Session / job / usage correlation — TESTED (schema created + rows inserted in isolation)

- Store: single SQLite file `$HERMES_HOME/state.db` opened by `SessionDB` (`hermes_state.py:3585`; cross-profile resume opens `<profile_home>/state.db` — `methods_session.py:383-390`). Base DDL `hermes_state_common.py:336-462`; migrations/additive columns in `hermes_state_schema.py`.
- `sessions` table: identity (`id` PK, `source`, `session_key`, `chat_id/thread_id`, `parent_session_id` lineage), model config + `system_prompt_hash`, token/cost rollups (`input/output/cache_read/cache_write/reasoning_tokens`, `estimated_cost_usd/actual_cost_usd/cost_status/pricing_version`), activity/title, handoff fields, compression bookkeeping, `profile_name`, flags (`archived/pinned/hidden`).
- `messages`: FK `session_id`, role/content/tool_calls/reasoning payloads, `active`/`compacted` (rewind/compression), `platform_message_id`, display sidecars. FTS views for search.
- **Usage tie-in:** `session_model_usage` PK `(session_id, model, billing_provider, billing_base_url, billing_mode, task)` holds per-model deltas. Main loop accumulates via `update_token_counts` (`hermes_state.py:8198`); auxiliary calls (vision, compression, titles…) record via `record_auxiliary_usage` (`hermes_state.py:8290`) which deliberately does NOT touch the `sessions` summary row (gateway overwrites summary counters with absolute totals); analytics read the union (`usage_totals`, `hermes_state.py:9152`).
- Jobs/delegations: `async_delegations` table (DDL `hermes_state_common.py:486`); live state via `delegation.status` RPC; cron jobs live in the cron scheduler store surfaced read-only through `/api/cron/*`.
- Live capture (TESTED): created `g2test-session-0001` + message + aux-usage row. Actual matched design: `session_model_usage` got the delta while the `sessions` summary counters stayed 0 (`evidence/g2_session_row_sanitized.json`, `g2_state_db_schema.sql` = 49 objects).

Correlation key for a control room: **session_id** joins sessions↔messages↔usage↔delegations; `session_key`/`chat_id` join to gateway routing scopes; kanban tasks carry an optional `session_id` column (see §8).

---

## (6) Cancellation + reconnect behavior per surface — DOCUMENTED (+ one tested guard)

- **TUI (stdio):** same handlers as §1. Interrupt = cooperative hard-interrupt of the model call + queue generation bump; background processes survive; stuck `running` desync self-heals on next interrupt.
- **WS clients (desktop/web via `/api/ws`):** `WSTransport.write` latches closed only on real socket errors while holding the send lock; a slow event loop (>10 s write timeout) logs and leaves the frame in flight instead of killing the stream (`ws.py:160-200`) — fixes "subagent window shows zero streaming". Disconnect cleanup unregisters transports (`server.register_live_transport/unregister`, `handle_ws` finally `ws.py:295+`). Reconnect path = reopen socket then `session.resume`; live sessions are reused rather than rebuilt; every `prompt.submit` rebinds the session transport to the current connection (`methods_prompt.py:330-333`), so a client that reconnects and submits resumes receiving events without server restart.
- **Dashboard PTY bridge:** `@app.websocket("/api/pty")` (`web_server.py:16993`) spawns `hermes --tui` as a child; that PTY-side gateway opens a back-WS to `/api/pub` (`WsPublisherTransport`, `tui_gateway/event_publisher.py:1-20`) and the dashboard rebroadcasts verbatim to `/api/events` subscribers (`web_server.py:17222/17250`). Failure mode explicitly best-effort/silent: dead WS short-circuits writes, bounded queue (256) drops on full, **no auto-reconnect** — fine for sidebar observability, not an audit log. Child death = PTY exit; stale serve/dashboard processes are scanned by PID (`main.py:8088-8140`).
- **Gateway platforms (Telegram/Discord/api_server/webhook):** turns serialized per RESOLVED session_id by a generation-scoped, identity-checked turn lease with fail-closed timeout (`TurnLeaseTimeoutError` → visible resend notice; idempotent release; `gateway/turn_lease.py:1-40`). Graceful stop paths exist (`gateway/drain_control.py`, `shutdown_flush.py`, `shutdown_watchdog.py` — not deep-dived).
- **api_server runs:** `POST /v1/runs/{run_id}/stop` interrupts a running agent; SSE `/events` carries structured lifecycle events (documented from adapter source; not exercised end-to-end).
- **Kanban mutation guard — TESTED:** any process carrying env marker `HERMES_DELEGATED_CHILD_CONTEXT` (=1, inherited by delegate_task children) fails CLOSED on every board write via `write_txn → _assert_not_delegated_child_mutation` (`kanban_db.py:165-187`). Observed: our spike subprocess raised `PermissionError("delegate_task child contexts cannot mutate Kanban tasks or boards")` until the marker was stripped for the throwaway run. The docstring itself notes neither the tools-layer nor CLI guard is a trust boundary; the DB-layer check is.

---

## (7) Dashboard plugin-to-local-node bridge pattern — DOCUMENTED

The sanctioned way to add dashboard UI/API on a node without touching core:

1. **Ship `plugins/<name>/dashboard/manifest.json`.** Discovery scans three sources (`_discover_dashboard_plugins`, `web_server.py:17958-18060`): user `~/.hermes/plugins/`, bundled `<repo>/plugins/`, project `./.hermes/plugins/` (opt-in via truthy `HERMES_ENABLE_PROJECT_PLUGINS` — strict truthiness after GHSA-5qr3-c538-wm9j). Manifest fields: `name`, `tab {path, position, override?, hidden?}`, `slots[]` (frontend `registerSlot(pluginName, slotName, Component)`), `api` → Python file **restricted to a relative path inside the plugin's `dashboard/` dir** (`_safe_plugin_api_relpath`, anti absolute-path RCE).
2. **Backend:** the api file must expose a FastAPI `router`; mounted at `/api/plugins/<name>/…` by `_mount_plugin_api_routes()` (`web_server.py:18595-18710`, executed at startup). Bundled plugins are trusted-but-disableable; **user plugins must be in the `plugins.enabled` allow-list before their Python is imported** (#46435 / GHSA-mcfc-hp25-cjv7). Project plugins get UI assets only, never backend import.
3. **Frontend assets:** served from `/dashboard-plugins/{plugin_name}/{file_path}` (`web_server.py:18507`).
4. **Auth:** plugin HTTP sits behind the same session-token middleware as core routes; plugin WS upgrades delegate to the canonical `_ws_auth_ok` gate (`plugins/kanban/dashboard/plugin_api.py:44-56`).
5. **Reference implementation:** `plugins/kanban/dashboard/plugin_api.py` — thin wrappers over `hermes_cli.kanban_db`/direct SQL so CLI, gateway command, and dashboard cannot drift; live updates via an `/events` WS tailing append-only `task_events` on short poll (WAL lets reads ride alongside IMMEDIATE write txns).

For the control room this means: a "worker detail" panel should be built as a standalone dashboard plugin repo installed into `~/.hermes/plugins/` (per AGENTS.md contribution rubric), reading through the §3 endpoints — not as core patches.

---

## (8) Kanban API/event mapping (CLI verbs → board events) — DOCUMENTED (+ tested lifecycle)

**Storage (single-node, by design):** `<root>/kanban.db` where `<root>` = shared Hermes root (profiles collapse onto ONE board — it IS the cross-profile coordination primitive); additional boards are directories `<root>/kanban/boards/<slug>/` each with own DB/workspaces/logs. Board resolution order: explicit `board=` arg → `HERMES_KANBAN_BOARD` → legacy `HERMES_KANBAN_DB` → `<root>/kanban/current` file → `default` (`kanban_db.py:1-50`). Dispatcher pins workers via injected env vars; workers cannot see other boards.

**Tables** (`kanban_db.py:1333-1520`, dumped in `evidence/g2_kanban_db_schema.sql`): `tasks` (status lane, assignee, claim_lock/expires, worker_pid, heartbeat, current_run_id, consecutive_failures breaker, block_kind/block_recurrences loop guard, per-task model/provider/reasoning overrides, goal_mode, session_id), `task_links` (parent→child deps), `task_comments`, **`task_events` (append-only: id, task_id, run_id, kind, payload, created_at)**, `task_runs` (status running|done|blocked|crashed|timed_out|failed|released; outcome completed|blocked|crashed|timed_out|spawn_failed|gave_up|reclaimed), `task_attachments`, `kanban_notify_subs` (gateway watcher cursor `last_event_id`).

**Verb → event map** (`_append_event` within `write_txn`, `kanban_db.py:4300-4318`):

| CLI verb(s) (`hermes_cli/kanban.py:216-862`) | Event kind(s) in task_events |
|---|---|
| `init` | (schema only) |
| `boards create/rm/switch` | board metadata + `current` file (not task events) |
| `create` | `created` |
| `assign` / `set-model` / reasoning effort | `assigned`, `model_override_set`, `reasoning_effort_set` |
| `claim` (dispatcher uses same fn) | `claimed` (+ `claim_rejected{parents_not_done}`, `claim_extended`) |
| `complete` | `completed` (+ `completion_blocked_hallucination`, `suspected_hallucinated_references`) |
| `block` / `unblock` | `blocked` (+ `block_loop_detected`), `unblocked` (+ `dependency_wait`) |
| `schedule` | `scheduled` |
| `archive` | `archived` |
| `comment` | `commented` |
| `link` / `unlink` | `linked`, `unlinked` |
| `promote` | `promoted` / `promoted_manual` |
| `request-review` / `request-changes` / `reopen-review` | `review_requested`, `changes_requested`, `review_reopened` |
| `edit` | `edited` |
| `attach` / `attach-rm` | `attached`, `attachment_removed` (+ `artifacts` payload events) |
| swarm decompose/specify | `decomposed`, `specified` |
| reclaim/stale sweep | `reclaimed`, `reclaim_deferred`, `respawn_guarded` |
| dispatcher runtime | `spawned{pid}`, `heartbeat`, run outcomes `timed_out`/`gave_up`/`error`, `descendant_invalidated` |

TESTED lifecycle (isolated run): create→claim→complete produced exactly `created → claimed{lock,expires,run_id} → completed{result_len,summary}` plus a `task_runs` row `status=done outcome=completed` (`evidence/g2_kanban_lifecycle.txt`).

Consumers: gateway kanban-notifier tails `task_events` past `kanban_notify_subs.last_event_id`; dashboard plugin `/events` WS tails the same table; `tail` verb streams a task's events.

**Explicitly out of scope and NOT proposed:** any cross-machine SQLite/R2 replication of kanban.db or state.db. Kanban here is mapped as a node-local coordination surface only.

---

## Tested vs documented ledger

**TESTED on pinned SHA (isolated, temp HERMES_HOME):**
1. `tui_gateway.server` imports with minimal deps; registry exposes 172 methods (expected ~162 from static grep; actual higher due to multi-line registrations — benign).
2. Event frame shape matches documented `{method:"event", params:{type,session_id,payload}}`.
3. state.db schema creation + session/message/aux-usage inserts; aux usage lands ONLY in `session_model_usage`, summary row unchanged (expected per design — actual matched).
4. kanban.db init + full create→claim→complete lifecycle emitting `created/claimed/completed` + closing run row.
5. Delegated-child kanban guard fires on env-marker inheritance (unexpected at first run; expected once root-caused to `HERMES_DELEGATED_CHILD_CONTEXT` — actual matched code intent after stripping marker for throwaway run).
6. System Python 3.9 cannot even parse the codebase (PEP-604 at module top level) — node runners need ≥3.10.

**DOCUMENTED (source-read only, not executed end-to-end):** exact RPC param/response schemas (read from handler code); full event vocabulary; serve/dashboard split details; api_server endpoints incl. `/v1/runs` lifecycle; turn-lease properties; plugin mounting security gates; profile override precedence corner cases; WS slow-loop tolerance behavior. A real agent turn was deliberately NOT run (requires provider keys; out of spike scope).

## Recommended seams

**Execution seam (ONE):** drive Hermes workers as **spawned processes speaking the tui_gateway JSON-RPC dialect over stdio** (spawn like the dashboard's PTY bridge does; drive `session.create → prompt.submit → session.steer/session.redirect → session.interrupt → session.resume`; consume newline-delimited `event` frames). Rationale: it is the single choke point every other surface already funnels through (the WS mount reuses `dispatch` verbatim — `ws.py:5-10`), has the strongest cancellation semantics, per-process blast radius, and needs no long-lived daemon per node. Fallback: the **api_server platform's `/v1/runs` lifecycle** (202/SSE/stop/approval) when a long-lived OpenAI-compatible ingress is preferred — heavier, gateway-coupled.

**Read/management seam (ONE):** **`hermes serve` (headless) REST, read-only subset** — `/api/status`, `/api/sessions*`, `/api/cron/jobs[/runs]`, `/api/analytics/usage`, plus the kanban plugin's read routes (`/api/plugins/kanban/board|tasks/{id}|workers/active|runs/{id}`) — optionally joined by the `/api/events` WS for lossy live observability only. Control Room treats these as projections; it does not write state through them initially. Build any richer panel as a standalone **dashboard plugin** (§7 pattern), never a core patch.

**Component decisions:** tui_gateway lifecycle — **Adopt** (execution seam); serve REST — **Adopt (read-only)**; dashboard-plugin bridge — **Wrap** (our panel ships as a plugin); api_server `/v1/runs` — **Borrow** (fallback only); Kanban — **Defer**: consume read-only / via existing CLI where Hermes-native workers collaborate; do NOT make it Control Room's bus; cross-machine workflow durability belongs to Gate 3's engine.

**Kanban is NOT the control room global bus.** It is a node-local, single-SQLite coordination primitive for Hermes-profile workers. Global orchestration/state stays in the Control Room's own durable engine (Gate 3).

## Risks & triggers

| Risk | Trigger to re-evaluate |
|---|---|
| `tui_gateway/server.py` is a fast-churning god-file; schemas above are pinned to `987064c` | Any hermes-agent minor bump considered for adoption → re-run this spike script (cheap, no keys needed) |
| `/api/ws` gated by `_DASHBOARD_EMBEDDED_CHAT_ENABLED` (currently `True`, `web_server.py:524`); close codes 4401/4403 on auth/gate failure | If we build on serve-side WS and see 4403 in the field → verify flag + auth mode first |
| `/api/pub`→`/api/events` mirroring is best-effort lossy (drop-on-full, silent dead-WS) | Missing frames under load → treat events WS as non-authoritative; rely on REST/DB reads for truth |
| Node Python floor ≥3.10 (spike hit TypeError on 3.9) | Windows/Gate-4 runner images must pin modern Python |
| Kanban delegated-child guard is env-var-based, explicitly not a trust boundary | Gate 6 threat model must not count it as containment |
| api_server multiplex prefix (`/p/<profile>/…`) behavior varies with `gateway.multiplex_profiles` | If fallback seam is activated, test prefix routing on the target build |
| Untested: real provider-keyed turn, WS reconnect race under mid-turn drop | Before build phase, run one keyed smoke turn on a disposable profile |

## Evidence inventory (`research/evidence/`)

`g2_tui_gateway_methods_runtime.txt` (172 methods) · `g2_event_frame_shape.json` · `g2_state_db_schema.sql` (49 objects) · `g2_kanban_db_schema.sql` (22 objects) · `g2_kanban_lifecycle.txt` (events + runs) · `g2_session_row_sanitized.json` · `g2_usage_totals.json` · `g2_hermes_home_layout.txt` (temp-home layout). Capture script preserved at `/tmp/g2_capture.py` (re-runnable against any pinned checkout).
