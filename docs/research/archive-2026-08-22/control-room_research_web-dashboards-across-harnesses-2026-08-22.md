# Web Dashboards & Interfaces Across Agent Harnesses

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Companion to:** orchestration, harnesses, and secrets dossiers in this folder
**Question answered:** Hermes has `hermes dashboard` (:9119). Do OpenClaw and the other harnesses have equivalents? What exactly does each expose, on which ports, with what auth?

---

## TL;DR

Yes — **OpenClaw ships four browser/terminal surfaces**, headlined by its **Control UI** (Gateway-served dashboard at port 18789 with live AI-generated session digests and a read-only side-chat companion). Across the category, **every serious personal-agent harness now treats "localhost web UI + authenticated remote access" as table stakes**: AutoGPT, OpenHands, Khoj, and Letta all ship first-party web interfaces; Goose is desktop-app-first; DeepSeek Harness (dev preview) and the pure-CLI coding agents (Aider, Cline) have none. For the control-room goal, this means each agent already exposes an HTTP/WebSocket surface that an umbrella layer can proxy or aggregate without touching agent internals.

---

## Verified interface matrix (all primary-source checked 2026-08-22)

| Harness | Web dashboard? | Surface(s) | Port / access | Auth model |
|---|---|---|---|---|
| **Hermes Agent** | ✅ | Web Dashboard (`hermes dashboard`), Chat tab (embedded TUI via PTY), Desktop app (Electron), TUI, CLI | 9119 default; `--host 0.0.0.0` for remote; REST API `/api/*` | Basic auth env vars, Nous Portal OAuth, service bearer tokens (`drain` provider); public binds always require auth |
| **OpenClaw** 🦞 | ✅ ×3 web + TUI | **Control UI** (chat/config/sessions), Dashboard (gateway admin), WebChat (plain browser chat), TUI | Gateway serves UI at `http://<host>:18789/`; optional `gateway.controlUi.basePath` prefix | Token or password supplied in WebSocket handshake (`connect.params.auth.token/password`); CORS `allowedOrigins` config; remote-access guide documented |
| **AutoGPT** | ✅ | "Frontend" platform UI — visually build/deploy/run agents | Self-hostable platform (frontend+server); hosted at agpt.co | Account system on platform |
| **OpenHands** | ✅ (web-*first*) | The web app IS the product ("Agent Canvas"); hosted cloud also offered | Source run: `npm install && npm run dev`; docs.all-hands.dev moved (308) | App-level accounts |
| **Khoj** | ✅ | Full web app — chat, search, custom agents | Self-hosted or khoj.dev | App accounts |
| **Letta** | ✅ ⚠️ | **ADE** (Agent Development Environment) — web IDE for building/stateful agents | docs.letta.com live; specific ADE URL 404'd when probed this session — treat details as [UNVERIFIED-today] | — |
| **Goose** | ❌ web / ✅ desktop | Native desktop app + CLI with extension system | No first-party browser dashboard found in docs | n/a |
| **DeepSeek Harness** | ❌ | None shipped — dev-preview runtime; compose-your-own via plugins (BYO UI explicitly) | n/a | n/a |
| **Aider** | ❌ | Terminal pair-programmer only | n/a | n/a |
| **Cline** | ❌ | IDE extension / SDK / CLI | n/a | n/a |

## Deep dive — OpenClaw Control UI (the closest Hermes-dashboard peer)

From https://docs.openclaw.ai/web/control-ui (fetched 2026-08-22):

- **Architecture:** small Vite + Lit single-page app served by the Gateway process itself; speaks directly to the Gateway WebSocket on the same port (18789). No separate backend service.
- **Scope:** chat, config, sessions — functionally parallel to Hermes's dashboard pages.
- **Session observer (unique):** while you watch a running session, the Gateway shows the model's latest safe preamble as the headline; with a utility model configured it upgrades to a richer compact status digest — assessment, plan progress, pull requests, elapsed time. Done/failed runs keep a frozen "finished" time. Session observation is on by gateway default; toggle via `gateway.controlUi.sessionObserver: false`.
- **Side-companion (unique):** `/btw <question>` or `/side <question>` in the composer opens a read-only companion thread about the selected session — bounded snapshot of history loaded lazily, held in Gateway memory, never written into `chat.history`. Highlighting text in a message offers "More details" / "Ask in side chat."
- **Session rail UX:** compact pill shows the live digest; expanded rail shows plan progress + PRs; auto-expands when a run is stuck or needs input; docks as a 400px column on wide panes, overlays on mobile. Shared with the official iOS/Android session lists.
- **Related surfaces:** separate Dashboard doc (`/web/dashboard`), Health Checks, TUI (`/web/tui`), WebChat (`/web/webchat`).
- **Remote access:** documented pattern at `/gateway/remote` (same bind+auth shape as Hermes).

### How Hermes vs OpenClaw dashboards differ

| Dimension | Hermes dashboard (:9119) | OpenClaw Control UI (:18789) |
|---|---|---|
| Orientation | Ops/admin: cron, memory, skills, MCP, API keys, config, logs | Conversation/session-centric: live runs, digests, side-chat |
| Multi-agent | Multi-profile switcher (one server manages all profiles on the box) | Multi-agent routing with per-agent sessions/workspaces |
| Programmatic surface | Broad REST API (`/api/status`, `/api/cron`, `/api/memory`, …) + bearer-token service auth | Gateway WebSocket API (auth in handshake) |
| Unique capability | Embedded real TUI chat over PTY; cross-profile cron aggregation | Utility-model session digests; read-only companion thread |
| Remote pattern | systemd unit + reverse proxy; CF Access header support merged (#88074) | Documented remote-access guide; CORS origin allowlist |

## Control-room implication

Every harness worth managing already exposes an HTTP(S)/WS surface:

```
Umbrella (future control room)
  ├─ proxy: hermes.marvin…  :9119   (REST + PTY chat)
  ├─ proxy: claw.gateway…   :18789  (WebSocket UI)
  └─ aggregate: status pings to each /api/status-style endpoint
```

An umbrella layer needs no agent-side code for read-mostly control (status, sessions, config viewing) — just authenticated proxies behind Cloudflare Access, one hostname per machine, mirroring what we already do for tracker.agenticbotsitter.com. Deeper integration (tasking across agents) rides the kanban/peer layer from the orchestration dossier instead of scraping UIs.

## Sources manifest (all fetched 2026-08-22)

- https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard (cached full-page extract, earlier today)
- Local CLI ground truth: `hermes --help`, `hermes serve/dashboard --help` (v0.20.4)
- https://docs.openclaw.ai/ (homepage — Control UI listed as first-class nav item) + https://docs.openclaw.ai/web/control-ui (full fetch)
- https://agpt.co/ (AutoGPT platform positioning) + DataCamp AutoGPT guide (Frontend/UI corroboration)
- https://github.com/OpenHands/OpenHands README (Agent Canvas quickstart, npm dev commands) + openhands.dev
- https://khoj.dev/ (HTTP 200 probe, earlier dossier) — web-app-first positioning
- docs.letta.com (200 OK root; ADE deep-link 404 — flagged above)
- Goose/DeepSeek/Aider/Cline negatives from their respective docs probes this session + prior harnesses dossier

**Known gaps:** OpenClaw Dashboard page (`/web/dashboard`) content not separately fetched (linked only); Letta ADE specifics unverified today; Goose negative based on docs structure, not exhaustive search.

## Verification checklist
- [x] OpenClaw claims from primary docs fetched this session (not memory)
- [x] Port numbers and auth mechanics quoted from source
- [x] Unverified items explicitly flagged ([UNVERIFIED-today])
- [x] Cross-linked to sibling dossiers; consistent format
