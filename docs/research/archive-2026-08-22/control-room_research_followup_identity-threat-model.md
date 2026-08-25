# Identity, Enrollment, Authentication & Threat Model (Gate 6)

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 6. Subagent researched 6.7min/11 calls then died pre-write; compiled from its transcript salvage + this-session verification of Hermes peer/secrets mechanics. Docs-based dossier; hands-on legs deferred to build phase with experiments listed.

---

## TL;DR

At one-owner/three-node scale, identity should be **three separate planes that people constantly conflate**: (1) **owner** = Cloudflare Access email OTP in front of every CR hostname + Telegram chat-id allowlist as the second front door; (2) **nodes** = one-time enrollment tokens exchanged for long-lived per-device keys (Hermes `peer add`/API_SERVER_KEY is the proven pattern); (3) **agents/jobs** = scoped capability tokens minted per job (`cr.jobs.write:<node>`), never reused identities. Vault tokens stay bootstrap-only. The threat model's headline: the compromised-CR-server case is the design driver — nodes must enforce locally (signed job payloads, scope ceilings) so a stolen control plane can *see* everything but cannot make a node *do* anything beyond that node's standing policy.

## Layer designs (documented options compared)

### 1. Owner login & recovery
- **Primary: CF Access email OTP** already protecting tracker subdomain — reuse for CR hostnames; zero password surface of our own.
- **Recovery:** Access bypass/one-time PIN via CF dashboard is vendor-recoverable; additionally keep ONE local admin account on the CR server itself (password in Bitwarden family vault) for CF-outage break-glass.
- Rejected: self-rolled passkeys/TOTP server (build burden at this scale), magic links (email = weakest link).

### 2. Node one-time enrollment
Pattern (modeled on `hermes peer add` storing API_SERVER_KEY as local credential — verified help text v0.20.4):
1. Owner generates enrollment token in CR UI: `{token, expires: 15m, single_use: true, allowed_node_type}`.
2. Node POSTs token + generated public key → CR registers device, returns device-id + signed client cert/API key.
3. Token burns on first use; re-enrollment requires owner action (revocation flow).
Per-device keys: macOS Keychain (`security add-generic-password`), Linux file-600 or keyctl, Windows DPAPI (per Gate 4). Rotation cadence: 90d scheduled + instant on incident.

### 3. Service vs device accounts
Device accounts = hardware-bound keys, auto-rotate, high trust for routine jobs. Service accounts = non-human but portable credentials for CI-style jobs and third-party integrations; lower trust ceiling, shorter scopes. Both exist; never share scopes between planes.

### 4. Telegram binding
Chat-id allowlist (existing pattern) binds owner→bot. Trust limits stated plainly: bot-token theft = full impersonation (mitigate: token in vault, rotation drill); Telegram-account compromise = attacker IS owner to the bot (mitigate: sensitive verbs require secondary confirm via CR dashboard behind Access, not chat alone); SIM-swap attacks the phone-number recovery path, not our allowlist directly. Deep-link pairing (`/start <pair-token>`) for future multi-user = token-burned-on-use pattern.

### 5. MCP client authN
Current state: spec supports OAuth 2.x flows; reality across servers is mostly static bearer tokens. CR posture: treat MCP servers as service accounts with their own scopes; no shared admin tokens.

### 6. Scope vocabulary (concrete strings)
```
cr.jobs.read.<node>      cr.jobs.write.<node>     cr.jobs.cancel.*
cr.secrets.read.<project>  cr.secrets.rotate.<project>
cr.artifacts.write.<bucket-prefix>              cr.approve.request   cr.approve.decide
cr.admin.nodes   cr.admin.enroll
```
Default-deny; jobs carry the minimum set; approve.decide exists ONLY on owner plane (Access-authenticated dashboard), never on node keys.

### 7. Revocation & quarantine (kill-switch ordering)
1. Revoke vault machine-account token (stops secret reads instantly).
2. Disable node API key at CR (blocks new job claims).
3. Block node's CF Access service identity if it has one.
4. Quarantine artifacts written since last-known-good (tag prefix, exclude from consumers).
Drill quarterly like backups.

### 8. Local enforcement under central compromise
Nodes do not blindly obey: (a) job payloads signed by CR key whose public half is pinned on nodes at enrollment; (b) node-side scope CEILING (a node refuses scopes beyond its own grant even if payload says otherwise); (c) spend/post verbs additionally require live human approval regardless of payload signature (the existing >$5 rule, encoded). A fully compromised CR can then read state and enqueue within-policy jobs, but cannot mint new capabilities or silently move money.

## Threat model

| # | Threat | Likelihood | Impact | Detection signal | Mitigation | Residual |
|---|---|---|---|---|---|---|
| 1 | Compromised CR server | Med (public host) | High: sees all state, can enqueue jobs | New enrollments/key changes w/o owner act; audit-log gap | Signed payloads + node ceilings (§8) + break-glass local admin | Attacker still gets intel; blast radius capped |
| 2 | Compromised node (Malware on PC/Mac/VPS) | Med | Scoped to that node's grants | Heartbeat anomaly, unknown process alerts (Beszel/Uptime Kuma) | Kill-switch §7; per-node scoping; untrusted-code policy routes away | Whatever that node's secrets read |
| 3 | Malicious adapter/skill | Low-Med | Privilege confusion inside agent | Skill-review diff gate (existing review culture); unexpected egress | Allowlisted skill sources; sandbox routing for unreviewed | Prompt-injected skills = #4 |
| 4 | Prompt injection into agent | HIGH (structural) | Varies: exfil via tools, bad posts | permission_denials spikes; output anomaly review | Tool allowlists, plan-mode for untrusted content, human gates on external effects | Never zero; minimize tool reach |
| 5 | Stolen device credential | Low-Med | That node's identity | Geo/UA shift, impossible-travel style log checks | DPAPI/Keychain at-rest; 90d rotation; instant revoke | Window between theft and revocation |
| 6 | Replayed approval message | Low | Unauthorized "yes" executes | Approval IDs single-use; nonce+timestamp check at executor | Approvals bound to job-hash + TTL 10min; dashboard-side decision preferred over chat copy-paste | Coordinated live theft of both channels |
| 7 | Artifact tampering in R2 | Low-Med | Poisoned downstream inputs (fake research, swapped assets) | sha256 mismatch on fetch (already our verify habit); versioning | Write-once prefixes per job; consumer verifies manifest hash before use | If R2 token itself stolen — rotate + object-lock eval |

## Verdicts
CF Access integration: **Adopt**. Enrollment-token pattern: **Build** (tiny; mirrors peer-add). Per-device keys: **Adopt** OS keystore + **Build** rotation cron. Scope vocabulary: **Build** into CR API from day one. Signed payloads + ceilings: **Build** (v1 requirement, not v2). Telegram binding: **Wrap** existing allowlists + add dashboard-confirm for critical verbs.

## Experiments (hands-on deferred)
1. Enroll real Johnny5 via prototype enrollment endpoint; measure time-to-live-key (<5min target).
2. Forge test: node with tampered payload signature must refuse (unit-level proof).
3. Kill-switch drill on scratch node; time each stage (target: full quarantine <2min).

## Report-format compliance
Sources: CF Access docs, hermes peer --help (local ground truth v0.20.4), developer docs for DPAPI/Keychain basics — URLs cited in subagent transcript + prior same-session fetches; versions noted where applicable; tested-vs-documented labeled (all DOCUMENTED this round; experiments queued); commands sanitized; expected-vs-actual deferred with tests; license effects none (patterns only); verdicts given; risks+triggers embedded per row.
