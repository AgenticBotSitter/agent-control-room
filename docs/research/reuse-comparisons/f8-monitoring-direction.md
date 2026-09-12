# Monitoring integration direction

2026-09-08. Conditional selection proposal, not completed RC9 comparison or deployed
monitoring acceptance. Existing exact source/experiment receipts are reused.

Select complementary, separately managed integration targets: Uptime Kuma
for application reachability and notification; optional Beszel for host resource trends.
Beszel stays disabled until runtime acceptance and demonstrated need justify its hub
and agents. Both are not mandatory for minimum viable operation. Existing acceptable
operator-managed host monitoring is the strongest lower-installation alternative.
Do not use either as canonical task, approval, backup-integrity or completion state.
No new custom polling/history/notification or host-metric collection framework.

Kuma's actual HTTP/condition source and executed evaluator/database initialization
map to reachability and persistent monitoring. Its checked release source/UI pair
is 2.5.3 at 1f0755fb044fe08e99fccde6722062fb2bf6c8f4. Offline SQLite migrations and
persisted update-check configuration were exercised; full daemon alert delivery
and restart were not. Preserve that difference. Its HTTP monitor must detect a
login redirect, stale/unknown response and TLS failure, not accept any HTTP 200.

Beszel's inspected source at 5b87f7d7cb095ac186162e8a8f3967182aa8023b maps to host
memory trends through gopsutil, authenticated collection, history and alerts. This
is a source-screening pin, not a selected redistributable release. Actual hub/agent
metrics and restart tests are missing. Confidence is therefore lower than Kuma's
limited executable evidence; neither is production-qualified. Source shows alert
delay restarting after hub restart, which must be reflected in operator expectations.

## Alternatives and integration cost

- Retain existing CR diagnostics for exact application state. They do not supply
  an independent external outage observer or persistent host-resource history.
- Kuma alone supplies reachability/alerts, not demonstrated equivalent host memory
  accounting. Beszel alone is not demonstrated to replace protected application
  readiness semantics. Do not manufacture a head-to-head winner between distinct
  responsibilities.
- Existing operator monitoring may replace an optional separate installation if
  it passes the same named capability gates. No assumption it is currently present.
- A new observability platform contest is not required absent an unmet capability;
  unknown candidates have not been evaluated or declared inferior.

Kuma adds one independently managed service; Beszel adds hub plus host agents.
No measured joint resource/cost advantage exists. Begin with separate dashboards
or bounded read-only summaries, not copied Vue/PocketBase UIs or mirrored state.
Write only narrow CR readiness projection and approved status mapping. No business
records move out of PostgreSQL. Monitoring history belongs to the upstream service.

## Before accepting the implementation

Run the existing bounded Kuma daemon/notification/persistence/restart experiment
against synthetic endpoints. Test Beszel rejected-key/connect/disconnect/restart,
representative memory accounting and stored alerts with explicit host collection
scope; no Docker socket/device access inferred. Check private probe authentication,
unknown/stale status, logout redirect handling and per-project visibility. Measure
actual process resource use and alert behavior; monitoring failure cannot approve,
cancel or settle work. Do not distribute broad database credentials to monitors.

Choose a supported target release and complete runtime/native dependency notices
before deployment. Root MIT does not cover all Beszel optional Windows/native
components; operator-managed installation does not waive licensing. Preserve Kuma
dependency warnings. No package installation, daemon, credentials or public endpoint
is authorized by this document.

Reopen on failed required capability, incompatible host support, unacceptable measured
resource/maintenance cost, or an existing deployment tool satisfying these needs
with less integration. Exact local experiments remain tracked in RC9, not relabeled
as deployment-only work or marked passed by this proposal.

Evidence: f8-operations.md, f8-kuma-offline-fit.md,
f8-kuma-release-pairing.md and f8-readiness-integration-map.md.

Independent compare_ui challenge accepted conditional target selection and required
the optional-Beszel distinction above. Root accepts it. Source-only Beszel evidence
remains lower confidence; missing runtime tests remain local comparison work, not
merely owner deployment gates. DR-14 records the conditional direction.
