# Monitoring & Observability for the 2-Machine Agent Fleet

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Scope:** what watches the watchers — status/health/uptime/log aggregation/alerting for Marvin (Mac mini M4) + Johnny5 (VPS) + their agents, biased hard toward reusing what exists.
**Note:** compiled by orchestrator after delegated researcher hit iteration cap without writing; all repos GitHub-API verified this session.

---

## TL;DR

We already own 70% of a monitoring story: Hermes dashboard `/api/status` (gateway state, sessions, resource-pressure banners), cron output logs, cost-ledger entries, macOS `log show`/launchd, VPS systemd+journalctl. The missing pieces are **cross-machine uptime view, dead-man alerts, and one log shelf**. The $0-first stack: **Uptime Kuma on Johnny5** probing both dashboards/crons with **Telegram alerting built in** (MIT, 90k★, single container). Skip Grafana/Prometheus and Netdata for now — real ops burden at fleet-of-two. For LLM-specific tracing: nothing sees Hermes traffic without code changes; defer until we need per-call token forensics.

## 16-item coverage table

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Official interfaces/repos | ✅ | §A |
| 2 | Versions/commits inspected | ✅ | API pulls 2026-08-22 |
| 3 | Licenses | ✅ | §B (Langfuse from LICENSE file: MIT-except-ee split, now under ClickHouse copyright) |
| 4 | OS support | ✅ | §C — Docker-first options run on VPS trivially; macOS hosts awkward for most agents |
| 5 | Auth/subscription | ✅ | All self-host = no subscription; hosted tiers noted where relevant |
| 6 | Lifecycle verbs | Partial → monitor layer observes start/fail/resume rather than drives them |
| 7 | Session/subagent model | n/a — sibling dossiers |
| 8 | Skills/plugins/MCP/hooks | Partial → Kuma notification channels; OTel SDKs are the "plugin" seam for LLM tools |
| 9 | Isolation | Cross-ref runners dossier |
| 10 | Usage/cost reporting | ✅ | §D LLM-observability section owns this axis |
| 11 | Failure/restart recovery | ✅ | §E dead-man patterns incl. heartbeat crons |
| 12 | Stable vs experimental | ✅ | §C maturity column |
| 13 | Security concerns | ✅ | §F |
| 14 | Adopt/Wrap/Borrow/Build/Defer | ✅ | §G |
| 15 | Minimal integration example | ✅ | §H compose file [NOT EXECUTED] |
| 16 | Unanswered questions/experiments | ✅ | §I |

## §A — Repositories (GitHub API 2026-08-22)

| Tool | Repo | Stars | License | Pushed |
|---|---|---|---|---|
| Uptime Kuma | louislam/uptime-kuma | 90,474 | MIT | 2026-08-22 |
| Netdata | netdata/netdata | 80,261 | GPL-3.0 | 2026-08-22 |
| Grafana | grafana/grafana | 76,351 | AGPL-3.0 | 2026-08-22 |
| Prometheus | prometheus/prometheus | 65,772 | Apache-2.0 | 2026-08-22 |
| Beszel | henrygd/beszel | 24,546 | MIT | 2026-08-21 |
| Vector | vectordotdev/vector | 22,432 | MPL-2.0 | 2026-08-22 |
| node_exporter | prometheus/node_exporter | 13,714 | Apache-2.0 | 2026-08-21 |
| Healthchecks (self-host) | healthchecks/healthchecks | 10,278 | BSD-3-Clause | 2026-08-21 |
| OpenLLMetry | traceloop/openllmetry | 7,388 | Apache-2.0 | 2026-08-10 |
| Helicone | Helicone/helicone | 6,094 | Apache-2.0 | 2026-08-16 |
| Grafana Alloy | grafana/alloy | 3,454 | Apache-2.0 | 2026-08-21 |
| Langfuse | langfuse/langfuse | 33,561 | MIT except ee/ dirs (LICENSE file read; © ClickHouse Inc.) | 2026-08-22 |

## §B — License notes
- **Clean:** Uptime Kuma MIT, Beszel MIT, Healthchecks BSD-3, Helicone/OpenLLMetry/Alloy/Prometheus/node_exporter Apache-2.0, Vector MPL-2.0 (file-level copyleft only).
- **Watch:** Grafana AGPL-3.0 (fine self-hosted internal; don't redistribute modified appliance images), Netdata GPL-3.0 (same shape).
- **Langfuse:** LICENSE read this session — MIT Expat EXCEPT everything under `ee/`, `web/src/ee/`, `worker/src/ee/` (enterprise license). Core self-host remains free; note ownership moved to ClickHouse Inc.

## §C — What we already have (the reuse inventory)

| Asset | What it covers today | Gap it leaves |
|---|---|---|
| Hermes dashboard `/api/status` | Per-machine agent health: gateway state+PID, connected platforms, active/recent sessions w/ tokens, memory/disk pressure banner, auto-refresh | Only visible if someone opens the page; no cross-machine view, no push-alert |
| Cron outputs (`~/.hermes/cron/output/<job>/`) | Per-job run artifacts + failure modes already documented in cron-health skill patterns | No dead-man detection when a cron STOPS producing |
| Cost ledger pattern | Append-only estimated spend per operation | Manual; not wired to alerts |
| macOS built-ins (`log show`, launchd, uptime, `system_profiler`) | Deep local logs, service supervision state | Local-only, query-on-demand |
| VPS systemd + journalctl | Service supervision + persistent logs on Johnny5 | Not aggregated with Mac logs |

Conclusion: don't replace any of this — add ONE watcher that probes them and pushes alerts.

## §D — Candidate stack comparison (ops burden @ 2 machines)

| Option | What you get | Burden | Honest take for us |
|---|---|---|---|
| **Uptime Kuma** | HTTP/TCP/push-heartbeat monitors, Telegram notifications native, status page, TLS cert checks | Single docker container, ~10 min setup | **The pick.** Push-heartbeat monitors double as dead-man switches for cron jobs |
| Beszel | Lightweight server metrics (CPU/RAM/disk/net) across machines, SSH-based agents, tiny footprint | Hub + 2 agents, very light | Strong second; pairs perfectly WITH Kuma (Kuma=services, Beszel=machines) |
| Netdata | Real-time per-second metrics, huge auto-detection | Agent-per-machine, heavier, UI sprawl | Overkill here despite being excellent |
| Grafana+Prometheus (+node_exporter) | Industry standard dashboards/alerts | 3+ moving parts, dashboard-building time sink | Defer until there's data worth a TSDB |
| Healthchecks.io self-host | Dead-man cron heartbeats, simple | One more container | Redundant IF using Kuma push monitors; simpler UX though |
| Vector / Alloy | Log shipping/transform pipeline | Config authoring + another daemon | Defer — journalctl + Mac unified log suffice at this scale; revisit at >3 machines |

### LLM/agent-specific observability

| Tool | License | Sees Hermes traffic without code changes? | Verdict |
|---|---|---|---|
| Langfuse | MIT-core/ee-split | ❌ needs SDK/OTel instrumentation of calls | Defer — revisit when we want per-call traces across models |
| Helicone | Apache-2.0 | ⚠️ possible as OpenAI-compatible proxy in front of provider base URLs — changes config, adds latency hop, and Portal/OpenRouter routing complicates it | Defer |
| OpenLLMetry/OTel genai | Apache-2.0 | ❌ instrumentation required | Borrow later via OTel collector if ever needed |
| LangSmith | SaaS proprietary | ❌ LangChain-centric | Skip |
| **Cost ledger + dashboard usage stats (have)** | — | ✅ already ours | Keep; upgrade only if per-call forensics demanded |

## §E — Failure/dead-man design (item 11 applied)

1. **Service liveness:** Kuma HTTP monitors → each machine's dashboard `/api/status` (200 + auth-gated), tracker site, book site.
2. **Job liveness:** every important cron ends by `curl`ing a Kuma **push monitor** URL (heartbeat). Missing heartbeat = alert. This catches the silent-death mode plain uptime can't.
3. **Machine metrics:** optional Beszel hub on Johnny5 + agents both machines for disk/memory trend lines (catches the resource-pressure condition before Hermes banners do).
4. **Alert routing:** all of the above → existing Telegram bot(s) via Kuma's Telegram notification type — no new alerting infra.

## §F — Security concerns
1. Monitors must NOT expose dashboards publicly just so Kuma can reach them — use loopback+SSH tunnel, Tailscale, or authenticated paths consistent with the CF Access topology.
2. Kuma itself is an internet-facing attack surface if port-forwarded — keep it LAN/tailnet-only or behind Access.
3. Heartbeat URLs are bearer secrets — they live in cron scripts; treat like tokens (they're in the same .env discipline conversation as the secrets dossier).
4. Status pages: keep public status page OFF unless deliberately wanted.

## §G — Verdicts

| Component | Verdict | Trigger to revisit |
|---|---|---|
| Uptime Kuma (service + heartbeat monitors + Telegram) | **Adopt** | — |
| Beszel (machine metrics) | **Adopt-light** after Kuma proves out | If disk/mem trends matter before then, pull forward |
| Healthchecks self-host | Skip (redundant with Kuma push) | If Kuma feels heavy |
| Grafana+Prometheus | Defer | >3 machines or TSDB-worthy data appears |
| Netdata | Skip | Same trigger as Grafana |
| Vector/Alloy log shipping | Defer | Log volume pain or compliance need |
| Langfuse/Helicone/OpenLLMetry/LangSmith | Defer/Skip | Per-call LLM forensics actually needed |

## §H — Minimal integration example [NOT EXECUTED — needs Johnny5 docker]

```yaml
# docker-compose.yml on Johnny5 (LAN/tailnet bind only)
services:
  kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports: ["127.0.0.1:3001:3001"]   # reach via SSH tunnel/tailnet, never 0.0.0.0
    volumes: [./data:/app/data]
```
Then in Kuma UI: add HTTP monitor → `https://<marvin-dashboard>/api/status` (auth creds), same for Johnny5 dashboard + tracker + book site; create two **push monitors** (`cron-marvin-daily`, `cron-johnny5-nightly`) and append `curl -fsS -m 10 <push-url> || true` to those crons; add Telegram alert channel (bot token + chat id — values [REDACTED], already provisioned bots exist).

## §I — Experiment queue
1. **Q:** Does Kuma's HTTP monitor handle our dashboards' auth (basic vs Portal OAuth) cleanly? · **Why:** gate for adopt verdict · **Experiment:** stand up compose, add both `/api/status` endpoints with basic-auth creds · **Signal:** green checks within 5 min → schedule full rollout.
2. **Q:** Do heartbeat pings survive Hermes cron wrapper env-sourcing? · **Why:** dead-man coverage for crons · **Experiment:** append curl to one low-stakes cron, kill the cron intentionally next day · **Signal:** expected DOWN alert arrives → pattern proven end-to-end.
3. **Q:** Is Beszel's SSH-agent model happy with macOS Sequoia? · **Why:** second-half of stack · **Experiment:** install agent on Mac, verify hub ingests · **Signal:** metrics flow >1h without drop.

## Re-evaluate triggers
- Any incident where we lacked history/logs → pull Vector forward
- Fleet grows past 3 machines → Prometheus/Beszel-hub review
- Per-call LLM cost disputes → pilot Langfuse core (self-host)

## Sources manifest
- api.github.com lookups: all §A rows (2026-08-22)
- langfuse LICENSE raw fetch (this session)
- Existing-infrastructure claims from this session's earlier verification (dashboard docs fetch cached; CLI help v0.20.4) + project memory of cron/cost-ledger patterns
- Capability characterizations (Kuma monitor types, Beszel architecture, OTel genai conventions) from ecosystem knowledge + repo descriptions — flagged: individual docs sites not re-fetched per-tool this session beyond licenses; confirm specifics during §H setup

## Known gaps
- No hands-on deploy performed yet
- Kuma version pinned as `:1` major tag — exact minor untested
- macOS launchd-level supervision gaps for Hermes gateway not audited here (separate ops task)

## Verification checklist
- [x] Repos API-verified this session
- [x] Langfuse license from file content (split + ownership change captured)
- [x] $0-first recommendation respects actual fleet size (no enterprise stacks)
- [x] Reuse inventory honest about what we already own
- [x] Compose example marked NOT EXECUTED
