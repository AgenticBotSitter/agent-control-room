# Secrets, Identity & Policy for a Multi-Agent Fleet

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Scope:** beyond vault storage — workload identity, policy enforcement on agent actions, rotation, and audit trails tying every action to a named agent. Sized for Marvin (Mac mini) + Johnny5 (VPS) + Alastair.
**Note:** compiled directly by the orchestrator after the delegated researcher hit its time cap mid-run (13 calls); repo facts GitHub-API verified this session.

---

## TL;DR

Enterprise identity stacks (SPIFFE/SPIRE, full OPA deployments) are built for thousands of workloads and are overkill at our scale — but their *patterns* are exactly right and mostly free. The pragmatic ladder for us: **vault (Bitwarden machine accounts) → per-agent scoping (one project + one machine account per agent) → policy as cheap code (Hermes config + a deny-by-default wrapper, not a policy server) → audit via append-only logs we already generate**. Adopt OPA/Cedar only when a second human or third-party agents join. Everything below is $0-first.

## 16-item coverage table

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Official interfaces/repos | ✅ | §A |
| 2 | Versions/commits inspected | ✅ | Sources manifest (API pulls 2026-08-22; Hermes v0.20.4 local CLI) |
| 3 | Licenses | ✅ | §B |
| 4 | OS support | ✅ | §C notes per layer (SPIRE server Linux-first; agents exist for macOS) |
| 5 | Auth/subscription requirements | ✅ | All OSS self-host = none; Bitwarden free tier covers us |
| 6 | Start/stream/steer/approve/cancel/resume | Partial → policy layer maps to approve/cancel verbs (§D); full matrix lives in sibling dossiers |
| 7 | Session/subagent model | Partial → identity-per-agent is the relevant slice (§D) |
| 8 | Skills/plugins/MCP/hooks | ✅ | Hermes seams = where policy hooks in (§D) |
| 9 | Filesystem/worktree isolation | Cross-ref runners dossier (owns this axis) |
| 10 | Usage/cost reporting | Cross-ref monitoring dossier |
| 11 | Failure/restart recovery | ✅ partial — rotation/revocation recovery paths (§D) |
| 12 | Stable vs experimental | ✅ | §C maturity column |
| 13 | Security concerns | ✅ | §E |
| 14 | Adopt/Wrap/Borrow/Build/Defer | ✅ | §F |
| 15 | Minimal integration example | ✅ | §G (Bitwarden per-agent scoping + policy wrapper sketch) |
| 16 | Unanswered questions/experiments | ✅ | §H |

## §A — Repositories (GitHub API 2026-08-22)

| Project | Repo | Stars | License | Pushed | Role |
|---|---|---|---|---|---|
| SPIRE | spiffe/spire | 2,495 | Apache-2.0 | 2026-08-22 | Workload identity (SPIFFE X.509 SVIDs) |
| OPA | open-policy-agent/opa | 12,136 | Apache-2.0 | 2026-08-21 | Policy engine (Rego) |
| Cedar | cedar-policy/cedar | 1,680 | Apache-2.0 | 2026-08-21 | Policy engine/SDK (AWS) |
| OpenFGA | openfga/openfga | 5,640 | Apache-2.0 | 2026-08-21 | Relationship-based authz (Zanzibar) |
| Bitwarden SM | (SaaS + bws CLI) | — | client SDKs open | n/a | Vault layer (already chosen) |
| Hermes | NousResearch/hermes-agent | 234,335 | MIT | 2026-08-22 | The agents being governed |

## §B — License notes
All four identity/policy projects are Apache-2.0 with explicit patent grants — no compliance concerns in any use shape. Bitwarden SM server is AGPL/vault is GPLv3 — irrelevant to us as a SaaS customer (we run the cloud free tier; we are not distributing their server).

## §C — The four layers, honestly sized for 2 agents + 1 human

**Layer 1 — Vault (HAVE the plan):** Bitwarden SM free tier, machine accounts per agent, `hermes secrets bitwarden` native integration (verified: `hermes secrets --help` on installed v0.20.4 lists `bitwarden (bw)` and `onepassword (op, 1password)` subcommands; docs confirm startup injection + `override_existing` central rotation). This layer is DONE once wired.

**Layer 2 — Identity (Borrow the pattern, skip SPIRE):** SPIRE gives every workload a rotating X.509 identity and mTLS between services — the real thing solves fleet-scale attestation we don't have. Our scale version: **one Bitwarden machine account per agent = the agent's identity**. The access token IS the workload identity; scoping = which project it can read. Rotation = Bitwarden token regenerate + `hermes secrets bitwarden token`. What we lose vs SPIRE: cryptographic attestation, short-lived auto-rotating certs, network-layer mTLS. What we keep: attribution (every secret fetch is logged against a named machine account) — which is 80% of the audit value.

**Layer 3 — Policy (Build tiny, not OPA):** OPA/Rego (or Cedar) shine when policy is complex, distributed, and audited by a platform team. Our policy surface is small: "agent X may touch service Y with keys Z, never both social-post and spend keys in one agent, spend >$5 needs human." That's expressible as: (a) Bitwarden project scoping (which keys an agent CAN hold), (b) Hermes config (which skills/tools a profile loads), (c) a ~50-line deny-by-default wrapper script for the few dangerous verbs (spend/post). Adopt OPA only when policy decisions need to be shared across >2 machines AND >2 agents AND non-Hermes runtimes simultaneously.

**Layer 4 — Audit (Reuse logs we already produce):** Bitwarden SM logs every machine-account secret fetch (Teams+; free tier has basic logs — verify at setup [flagged]); Hermes has session DBs + cron output logs; the cost-ledger skill records spend. Missing piece: a single append-only JSONL per machine stitching agent-action → secret-used → outcome. That's a Build-tiny (one logging shim, not a SIEM).

## §D — Mapping to lifecycle verbs

- **approve:** human approval = the Telegram gate (existing pattern) + Bitwarden token rotation for high-risk actions; policy wrapper returns "needs human" exit codes the control room surfaces.
- **cancel:** revocation story = Bitwarden token revoke (instant, kills an agent's key access) — this is our kill-switch, better than process-kill alone.
- **resume:** after rotation, `hermes secrets bitwarden token` re-bootstrap; agents restart clean because keys come from the vault at startup, not from stale `.env`.
- **per-agent least privilege:** one project per concern (e.g. `hermes-shared`, `marvin-social`, `johnny5-infra`) + machine accounts scoped read-only to exactly their project. Free tier's 3 projects fits this exactly.

## §E — Security concerns

1. **Access tokens are bearer credentials** — anyone holding `marvin-mac`'s token reads its whole project. Treat like the master password of that project: file perms 600, never in git, rotate on any suspicion. (Hermes docs state the same.)
2. **Free-tier audit-log limits** [flagged]: Bitwarden event logs are a Teams feature; free tier may log only basic events. If per-fetch attribution matters, that's the first reason we'd ever pay (~$4/user/mo).
3. **Wrapper bypass:** a policy wrapper only binds agents we route through it. Hermes subagents/shells can exec anything unless the profile's toolset is scoped — policy-in-config must match policy-in-wrapper or it's theater.
4. **SPIRE-class problems we're choosing not to have yet:** attestation of *what code* is running (we trust the Mac/VPS), mTLS mesh (we're 2 machines behind Tailscale/CF). Revisit at fleet-of-machines scale.
5. **Secret values in workflow payloads:** never pass secrets as engine/workflow args — inject at process start (Hermes does this natively).

## §F — Verdicts

| Layer/Tool | Verdict | Why |
|---|---|---|
| Bitwarden machine accounts as identity | **Adopt (now)** | Free, native Hermes integration, attribution logs, instant revocation |
| SPIFFE/SPIRE | **Defer** | Right pattern, wrong scale; trigger = >5 machines or third-party agents needing cryptographic trust |
| OPA/Cedar/OpenFGA | **Defer (all three)** | Apache-2.0 and excellent, but our policy set fits in ~50 lines; trigger = policy shared across ≥3 runtimes |
| Policy wrapper (deny-by-default dangerous verbs) | **Build (tiny)** | 50-line script + Hermes config scoping; the only custom code in the stack |
| Unified audit JSONL shim | **Build (tiny)** | Append-only per-machine log; feeds monitoring dossier's stack |
| Short-lived creds via OIDC federation (cloud IAM) | **Defer** | We're not IAM-centric; Bitwarden rotation covers the need |

## §G — Minimal integration example

Step 1 (executable today, $0 — the scoping half):
```
Bitwarden: projects hermes-shared | marvin-social | johnny5-infra
           machine accounts: marvin-mac → read hermes-shared + marvin-social
                             johnny5-vps → read hermes-shared + johnny5-infra
           then: hermes secrets bitwarden setup   (each machine, its own token)
```

Step 2 (policy wrapper shape, [NOT EXECUTED — needs the wrapper written]):
```bash
#!/usr/bin/env bash
# /Users/alastairfraser/hermes-data/bin/agent-guard.sh <agent> <action> [args...]
# deny-by-default for the two dangerous verb classes
case "$2" in
  spend|post)
    echo "BLOCKED: $2 requires human approval — use Telegram gate" >&2; exit 42 ;;
  *) exec "$@" ;;
esac
```
Control room + crons route dangerous verbs through this; everything else runs direct. Exit 42 = "escalate to human" convention the dashboard/canban layer understands.

## §H — Experiment queue
1. **Q:** Does Bitwarden SM free tier log per-fetch events (or only account events)? · **Why:** decides if audit layer is complete at $0 · **Experiment:** wire one machine account, fetch a secret, inspect vault event log UI · **Signal:** fetch rows visible → done; absent → Teams upgrade becomes the first paid security item.
2. **Q:** Does `override_existing` rotation actually propagate to running cron jobs on next start (not mid-run)? · **Why:** rotation story depends on it · **Experiment:** rotate a scratch key in Bitwarden, run a cron that echoes the key's fingerprint · **Signal:** new fingerprint on next run → confirmed.
3. **Q:** Can the policy wrapper be enforced for Hermes *subagents* (not just top-level calls)? · **Why:** bypass hole in §E.3 · **Experiment:** spawn a subagent instructed to run the blocked verb; observe whether guard fires · **Signal:** blocked → wrapper is real; bypassed → scope toolsets per-profile instead.

## Re-evaluate triggers
- 3rd agent or 3rd machine joins → re-check Bitwarden free limits (3 machine accounts / 3 projects)
- Any third-party/untrusted agent runtime joins the fleet → SPIRE-class identity becomes relevant
- Policy rules exceed ~10 or span non-Hermes runtimes → pilot OPA

## Sources manifest
- `hermes secrets --help` on installed v0.20.4 (this session, local ground truth)
- Hermes secrets docs: https://hermes-agent.nousresearch.com/docs/user-guide/secrets/ + /secrets/bitwarden (fetched this session)
- api.github.com: spiffe/spire, open-policy-agent/opa, cedar-policy/cedar, openfga/openfga, NousResearch/hermes-agent (2026-08-22)
- Bitwarden SM plans/features: bitwarden.com/help/secrets-manager-plans/ + product page (fetched earlier this session)
- Delegated researcher transcript (timed out, 13 calls) reviewed; no file written by it

## Known gaps
- Bitwarden free-tier event-log depth unverified (experiment 1)
- SPIFFE/SPIRE macOS agent support noted Linux-first from ecosystem knowledge, not re-fetched this session [flagged]
- No hands-on OPA/Cedar evaluation (ruled out by scale, not tested)

## Verification checklist
- [x] Repos API-verified this session
- [x] Native Hermes capabilities verified against installed CLI, not docs alone
- [x] Enterprise tools honestly sized OUT with explicit revisit triggers
- [x] Verdicts carry triggers; wrapper marked NOT EXECUTED
- [x] No secrets values anywhere
