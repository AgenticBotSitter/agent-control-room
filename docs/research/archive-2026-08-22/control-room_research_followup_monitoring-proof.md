# Uptime Kuma Integration Proof (Gate 7)

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 7. Subagent died at iteration cap pre-write (Docker absence discovered independently in Gate 3 work — no local container runtime exists on this Mac). Compiled from transcript salvage + prior same-session repo/license verification. Hands-on legs: BLOCKED locally, exact runbook preserved for Johnny5 where Docker lives.

---

## TL;DR

Kuma stays the recommended external monitor (MIT, 90k★) but the gate's real deliverable is the **boundary statement**: Kuma is an *adapter-fed observer*, never the control room's authoritative service database — CR's own SQLite/Postgres service registry remains canonical and Kuma probes it via generated check definitions. All seven verification dimensions are specified with sanitized commands; six are UNTESTED-pending-VPS (no Docker here), one (license) is verified. Alert-latency and payload-schema numbers get filled when the runbook executes; nothing was invented to fill them.

## Positioning (required by gate)
- Authoritative service database = **CR server's own registry** (service table: id, owner-node, endpoints, expected-check-interval, tags).
- Kuma = stateless-ish probe fleet + alert router reading a GENERATED list of monitors exported from that registry (`cr export-monitors | kuma-import`), one-way. Deleting Kuma must never lose service truth.
- Telegram delivery reuses existing bot identity under a dedicated notifications chat — ownership stays with Alastair's bot account, not a Kuma account.

## Verification dimensions

| # | Dimension | Method spec (runbook) | Status |
|---|---|---|---|
| 1 | Authenticated private-endpoint checks | Add HTTP(s) monitor → URL `http://127.0.0.1:9119/api/status`, Basic Auth section w/ dashboard creds; expect 200+green | UNTESTED-pending |
| 2 | Push/dead-man + latency | Create Push monitor; `curl -fsS "<push-url>"` cron every 60s; stop pushing; record DOWN alert timestamp delta (expect ≈ retry interval × retries + grace, default ~2-3min at 60s cadence) | UNTESTED-pending |
| 3 | Webhook/API into synthetic incident | Notification type Webhook → local receiver (`python -m http.server 9911` logging POSTs); force monitor down; capture JSON body fields (heartbeat object: monitorID/name/status/msg/time) for up AND down | UNTESTED-pending |
| 4 | Dedup/ack/recovery/maintenance | Schedule maintenance window over a monitor; verify suppression during window + auto-resume after; ack behavior in UI documented | UNTESTED-pending |
| 5 | Telegram channel config | Bot token (from vault, [REDACTED]) + chat id fields; test-send button; confirm message lands in CR alerts chat | UNTESTED-pending |
| 6 | Backup/export/upgrade | Data dir = `/app/data/kuma.db` (SQLite); backup = stop container + copy db; built-in Export/Import of monitors tested; upgrade path: pin image tag → pull minor → migrate notes from release page | UNTESTED-pending (SQLite location verified from docs knowledge, flagged) |
| 7 | License/distribution | louislam/uptime-kuma LICENSE = **MIT** (verified earlier today via GitHub API row in license matrix) → embedding/redistribution clean with copyright notice retention | ✅ VERIFIED |

## Runbook (Johnny5, disposable-first)

```bash
# throwaway first (per approval boundary): LAN-only bind
docker run -d --name kuma-test --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -v /opt/cr/kuma/data:/app/data louislam/uptime-kuma:1.23.xx  # pin exact tag at pull
# reachability only via SSH tunnel: ssh -L 3001:127.0.0.1:3001 johnny5
# execute dimensions 1-6 above; paste observed latencies/payloads back into this dossier
```
Promotion rule: throwaway passes all six pending rows → recreate as named stack `kuma-prod` with same version pin; register in CR service registry as monitored-service #1 (dogfood).

## Adapter shape (CR side)
```python
class MonitorAdapter(Protocol):
    def sync_services(self, services: list[ServiceRow]) -> None: ...   # registry -> Kuma monitors
    def incident_webhook(self) -> callable: ...                          # Kuma -> CR incidents table
    def heartbeat_url(self, job_id: str) -> str: ...                     # dead-man URLs injected into cron wrappers
```
Incidents land in CR's own DB (webhook receiver writes them); Kuma UI is operational glass, not source of truth.

## Verdicts
Kuma: **Adopt** (post-runbook confirmation). Heartbeat-injection wrapper: **Build tiny** (append curl line via cron-wrapper template). Registry-export importer: **Build tiny**.

## Risks & triggers
1. Single Kuma instance = monitor SPOF → acceptable v1 (CR core doesn't depend on it); trigger: missed-incident event ⇒ second instance cross-probing.
2. SQLite-at-40KB-scale fine; trigger: >500 monitors or multi-user edit contention ⇒ Postgres backend evaluation (Kuma roadmap-dependent).
3. Version drift: pin tag at deploy; trigger: security advisory on louislam/uptime-kuma ⇒ out-of-band upgrade following §6 path.

## Report-format compliance
Sources: github API license row (this session), docs.openclaw-style primary fetches not needed here; subagent-transcript doc citations for monitor types; versions: image tag pinned at pull (runbook), MIT license verified; tested-vs-documented explicit per row (six UNTESTED-pending declared, zero fabricated results); sanitized commands included; A/W/B/B/D verdicts given; risks+triggers enumerated.
