# Secrets Provider Contract — Bitwarden vs 1Password (Gate 5)

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 5. Subagent hit iteration cap post-research pre-write; dossier compiled from its transcript salvage + this-session verification (hermes CLI help v0.20.4, prior same-day fetches of bitwarden plans pages + npm/pypi registry pulls).
**Hands-on status:** BLOCKED — no Bitwarden account exists yet on this machine (`hermes secrets bitwarden setup` never run; no BWS_ACCESS_TOKEN in env). Setup commands documented exactly instead. Nothing was fabricated as tested.

---

## TL;DR

The two vendors' agent-relevant products are NOT interchangeable shapes: **Bitwarden Secrets Manager** = dedicated machine-secrets system (projects, machine accounts, `bws run` injection, MIT-licensed SDKs, GPL CLI); **1Password** = one human vault with a developer layer bolted on (service accounts + Secret Automation/Connect, proprietary client terms). Both cover macOS/Windows/Linux and both do headless token auth. The control-room requirement "both providers" is satisfied through a **provider-neutral interface** (spec below) so nodes never know which vendor backs a scope. Vault tokens are bootstrap credentials only — never node identity (identity lives in the CR enrollment layer, Gate 6).

## Product separation (per vendor)

| Vendor | Human product | Machine/product | Scoping model |
|---|---|---|---|
| Bitwarden | Password Manager (vaults, collections, orgs) | **Secrets Manager** (secrets, projects, machine accounts) | SM projects ≠ PM collections; separate products, separate auth |
| 1Password | 1Password (vaults/collections for people) | **Service Accounts + Secrets Automation (Connect server)** operating on 1Password vaults | vault-based; service tokens scoped to specific vaults+permissions |

Documented sources: bitwarden.com/help/secrets-manager-overview (+plans page fetched earlier today); developer.1password.com service-account & connect docs [fetched-by-subagent this session; URLs cited in transcript].

## Contract dimensions

| Dimension | Bitwarden SM | 1Password |
|---|---|---|
| Nonhuman auth | Machine account → access token (starts `0.`), never expires optional | Service account → token (1y expiry max, renewable) |
| Scoping | Read grants per project | Token scoped to chosen vaults + read/write level |
| CLI | `bws` (auto-installed by Hermes into ~/.hermes/bin) | `op` (separate install) |
| Injection | `bws run -- cmd` injects secrets as env | `op run -- cmd` same pattern |
| Headless refresh | Token static until rotated; secrets fetched per startup | Service token expires ≤1y; refresh = reissue via admin |
| Audit depth | Event logs Teams+ tier; free = basic | Business plan activity logs; SIEM export top tier |
| Rotation/revocation | Revoke/regenerate token instantly web app; secret rotation = edit + next-start pickup (`override_existing`) | Revoke service token instantly; item edits propagate via Connect sync or CLI fetch |
| Offline/cache | bws = online-first; SDK caching possible | op reads require Connect or interactive session; cached items via desktop app only |
| Rate limits | Documented API limits (generous at our scale) | Connect/SA limits documented; fine at our scale |
| Cost | Free tier: 3 machine accounts/3 projects/unlimited secrets; Teams ~$4/user/mo | No free prod tier; Teams Starter $24.95/mo flat ≤10 users |
| Client licenses | bws GPL-3.0 (internal use clean); Python SDK Apache/MIT mix per repo | op CLI proprietary EULA; redistribution not permitted |

## Hands-on section — BLOCKED, exact commands preserved

```bash
# One-time (owner): sign up free org → vault.bitwarden.com → Secrets Manager
#   create project "Hermes Keys"; machine accounts marvin-mac / johnny5-vps;
#   create access token (never-expire), copy once.
# Then per machine:
hermes secrets bitwarden setup          # wizard: token, region US, project pick, test fetch
hermes secrets bitwarden status         # verify
echo test > scratch flow:
bws secret create <PROJECT_ID> CR_SCRATCH_TEST "dummy-value"   # node-brokered read below
```
Three modes once wired:
1. **node-brokered:** script calls `bws secret get <SECRET_ID>` and uses value in-process.
2. **harness-brokered:** config.yaml `secrets.bitwarden.enabled: true` + project_id → hermes start injects `CR_SCRATCH_TEST` into os.environ (verified mechanism exists: `hermes secrets bitwarden --help` shows setup/status/token subcommands on installed v0.20.4).
3. **destination-native:** `bws run -s <SECRET_ID> -- env | grep CR_SCRATCH_TEST` style wrap.
All three marked **UNTESTED-pending-vault-setup**; expected outputs documented from CLI docs.

## Provider-neutral interface spec (the deliverable)

```python
class SecretsProvider(Protocol):
    def get_secret(self, scope: str, key: str) -> str: ...
        # scope = logical namespace ("cr/shared", "cr/marvin-social"); vendor maps
        # scope→BW project or OP vault via config table. Raises ScopeNotFound.
    def inject(self, command: list[str], scope: str) -> int: ...
        # exec command with secrets of scope as env (wraps bws run / op run). Returns exit code.
    def rotate(self, key: str, scope: str) -> None: ...
        # vendor-native rotation: BW = PUT new value on secret; OP = item update via CLI.
    def audit_tail(self, scope: str, n: int = 50) -> list[dict]: ...
        # best-effort event rows; empty list + warning where tier lacks audit (BW free).
```
Config mapping file (per node, 0600): `{scopes: {"cr/shared": {provider: bitwarden, project_id: …}, "cr/family": {provider: onepassword, vault: …}}}`. Nodes call only this interface; swapping vendors = editing mapping + installing that CLI. Identity note enforced: interface authenticates AS a machine/service credential; CR node identity comes from Gate 6 enrollment, never from these tokens.

## Verdicts
- Bitwarden SM: **Adopt** (free tier fits 2 agents + spare; native Hermes integration).
- 1Password: **Wrap** behind the neutral interface (needed for family/human side; machine use costs ≥$24.95/mo so defer enabling until family vault exists anyway).
- Interface itself: **Build (tiny)** — the four-function Protocol + mapping config.

## Risks & triggers
1. BW free-tier audit depth unverified hands-on (blocked) → trigger: first vault wired; if per-fetch events missing, Teams upgrade becomes first paid security line-item.
2. 1Password service-token 1y expiry = calendar bomb if unmonitored → trigger: any OP scope enabled; add expiry tracking to monitoring stack.
3. bws GPL — we never redistribute it; if CR ever ships an installer bundle, revisit.

## Report-format compliance
Sources: bitwarden help/plans pages + developer.1password.com (subagent-fetched this session, cited in its transcript; plans page re-verified earlier today by me); versions: hermes CLI v0.20.4 local check, bws auto-install version TBD-at-setup; tested-vs-documented labeled throughout (hands-on BLOCKED stated up front); sanitized commands included; expected-vs-actual N/A-marked for blocked legs; license effects per row; verdicts given; risks+triggers listed.
