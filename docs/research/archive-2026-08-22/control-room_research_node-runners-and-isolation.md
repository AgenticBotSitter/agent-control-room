# Code-Execution Runners & Isolation for Agent Workloads

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Scope:** how to run untrusted/semi-trusted agent-generated code safely on our two hosts — Mac mini (macOS, Apple Silicon) as dev/control and VPS (Ubuntu) as production.
**Note:** compiled by orchestrator; two delegated attempts died at iteration caps. Repos GitHub-API verified this session; escape-history claims from ecosystem knowledge + one salvage search, flagged inline.

---

## TL;DR

The isolation field splits cleanly by host OS: everything best-in-class (Firecracker microVMs, gVisor, Kata) is **Linux-host-only** and therefore VPS-side options only. On the Mac, your realistic choices are **Docker Desktop VM** (works but heavy), **macOS Seatbelt/sandbox-exec profiles** (native, free, per-syscall policy), or pushing risky execution to Johnny5 entirely. Hosted sandboxes (E2B 13.5k★ Apache-2.0, Modal, Daytona) remove ops but add per-use spend + data egress. Verdict: **VPS = gVisor or Kata via Docker when we truly need untrusted-code isolation; Mac = Seatbelt profiles for local experiments + "don't run untrusted code on the Mac" as policy.** Nothing new to buy; this is configuration discipline more than procurement.

## 16-item coverage table

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Official interfaces/repos | ✅ | §A |
| 2 | Versions/commits inspected | ✅ API pulls 2026-08-22 (no local installs pinned yet) | §A |
| 3 | Licenses | ✅ | §B |
| 4 | OS support | ✅ THE organizing axis of this dossier | §C |
| 5 | Auth/subscription requirements | ✅ hosted tiers flagged ($ = needs approval per house rules) | §D |
| 6 | Lifecycle verbs | Partial → spawn/exec/cleanup APIs covered (§E); approve/resume belong to engine layer |
| 7 | Session/subagent model | n/a — sibling dossiers |
| 8 | Skills/plugins/MCP/hooks | n/a — sibling dossiers |
| 9 | Filesystem/worktree isolation | ✅ THIS dossier owns it | §C/E |
| 10 | Usage/cost reporting | Partial → hosted options meter by use; self-host = infra cost only |
| 11 | Failure/restart recovery | Partial → sandbox lifecycle is ephemeral-by-design; recovery = engine's job |
| 12 | Stable vs experimental | ✅ maturity column | §C |
| 13 | Security concerns | ✅ escape history + threat model | §F |
| 14 | Adopt/Wrap/Borrow/Build/Defer | ✅ per environment | §G |
| 15 | Minimal integration example | ✅ | §H [NOT EXECUTED] |
| 16 | Unanswered questions/experiments | ✅ | §I |

## §A — Repositories (GitHub API 2026-08-22)

| Project | Repo | Stars | License | Pushed |
|---|---|---|---|---|
| Firecracker | firecracker-microvm/firecracker | 36,207 | Apache-2.0 | 2026-08-21 |
| gVisor | google/gvisor | 19,138 | Apache-2.0 | 2026-08-22 |
| Kata Containers | kata-containers/kata-containers | 8,588 | Apache-2.0 | 2026-08-22 |
| nsjail | google/nsjail | 4,065 | Apache-2.0 | 2026-07-27 |
| E2B | e2b-dev/E2B | 13,518 | Apache-2.0 | 2026-08-22 |
| Daytona | daytonaio/daytona | 71,915 | license field empty [verify LICENSE file before any use] | 2026-07-24 |
| Modal | modal-labs/modal-examples (SDK closed-core SaaS; examples repo MIT) | 1,260 | MIT (examples only) | 2026-08-18 |
| Docker Desktop | (proprietary; engine OSS bits under moby) | — | mixed | n/a |

Negative probe: `bubblewrap/bubblewrap` not found at that path (project lives on freedesktop/GitLab — Linux-only anyway); `openai/sandbox-runtime` not found at probed path this session [flagged].

## §B — License notes
All core OSS isolators are Apache-2.0 with explicit patent grants — clean to adopt. Daytona's missing license metadata is a yellow flag: read its LICENSE before anything beyond evaluation. Docker Desktop is licensed software (free tier limits apply at company scale; fine for personal fleet).

## §C — The macOS vs Linux split (honest version)

| Technology | Runs on macOS HOST? | Runs on Linux HOST? | Mechanism | Maturity |
|---|---|---|---|---|
| Firecracker microVMs | ❌ KVM required | ✅ | purpose-built micro-VMM (AWS Lambda/Fargate heritage) | Production-grade at hyperscale |
| gVisor (runsc) | ❌ ptrace/KVM hooks are Linux | ✅ Docker runtime plugin | userspace application kernel intercepting syscalls | Production (Google-scale heritage) |
| Kata Containers | ❌ needs KVM/VirtIO | ✅ | lightweight VMs per container | Production |
| nsjail / bubblewrap | ❌ namespaces/cgroups | ✅ | namespace+jail wrappers | Mature tools |
| Docker w/ limits | ⚠️ via Linux VM (Docker Desktop/colima) — real isolation boundary is that VM, containers alone are NOT security boundaries | ✅ native | namespaces+cgroups | Ubiquitous |
| **Seatbelt / sandbox-exec** | ✅ native (`/usr/bin/sandbox-exec` with SBPL profiles; what Codex uses under the hood on macOS) | ❌ Apple-specific | per-syscall deny profiles | Built into macOS; deprecated-ish tooling but still functional & widely used by agent CLIs |
| Hosted: E2B / Modal / Daytona / Fly Machines | ✅ (API from anywhere) | ✅ | vendor microVMs/firecracker fleets | E2B agent-sandbox focused; Modal mature SaaS |

## §D — Cost surface
Self-host OSS = $0 infra beyond what we run. Hosted: E2B/Modal/Fly all usage-metered — every dollar crosses the **>$5 Telegram approval rule**, so hosted options are structurally "ask-first" here regardless of price. Daytona self-host exists but license unverified.

## §E — Spawn API for an orchestrator
- gVisor/Kata/nsjail: drop-in Docker/runtime invocations (`docker run --runtime=runsc …`) → trivially wrapped in subprocess calls from Hermes/workflow engines.
- Firecracker: JSON config + API socket per microVM; higher ceremony — overkill unless multi-tenant fleets arrive.
- Seatbelt: `sandbox-exec -f profile.sb <cmd>`; profiles are text policies (deny network-write-* etc.). Wrappable in one helper script.
- E2B: SDK `Sandbox()` create/run/read — cleanest DX if we ever pay.

## §F — Security concerns & escape history [flagged: ecosystem knowledge, spot-checked]
1. **Containers alone ≠ isolation.** Namespaces/cgroups reduce blast radius; kernel attacks remain. Real boundaries = VM (Kata/Firecracker) or syscall-filtering userspace kernel (gVisor).
2. gVisor: strong record; occasional compat gaps (obscure syscalls) rather than escapes dominating its history. Firecracker: minimal device model by design; CVEs exist but the jailer + KVM microvm shape is the industry benchmark (salvage search surfaced Attacking-Firecracker research lineage; no current critical open).
3. Kata: inherits QEMU/CVE churn historically; modern cloud-hypervisor runtime trims that surface.
4. Seatbelt: NOT a hard security boundary vs determined attackers (userspace policy, known bypass research) — treat as guardrail, not prison.
5. Docker Desktop on Mac: isolation = its Linux VM; file-sharing mounts (virtiofs/gRPC-FUSE) are convenience holes — never mount sensitive home dirs into untrusted runs.
6. Hosted sandboxes: you're shipping code+data to third parties — egress consideration for client/business secrets.

Threat-model line for us: agents mostly execute OUR scripts with OUR keys → priority is accident containment (rm -rf, network floods), not adversarial escape. That lowers the bar: gVisor-lite (Docker+limits+no-network) covers most cases; full microVM only for genuinely untrusted payloads.

## §G — Verdicts

| Environment | Verdict |
|---|---|
| VPS prod, untrusted payloads | **Adopt gVisor** (Docker runtime plugin) first; Kata if compat gaps bite |
| VPS prod, semi-trusted internal jobs | Docker + resource caps + no-net flags (**config, not new tech**) |
| Mac local experiments | **Adopt Seatbelt profiles** via one wrapper script; keep untrusted bulk off the Mac |
| Heavy parallel sandboxes / customer-facing later | **Defer** Firecracker until multi-tenant need is real |
| E2B/Modal/Daytona | **Defer** — approval-gated spend; revisit if VPS capacity becomes the constraint |

## §H — Minimal integration example [NOT EXECUTED]

```bash
# VPS: untrusted job with gVisor (one-time: install runsc per docs, then)
docker run --runtime=runsc --network=none --memory=512m --cpus=1 \
  -v /srv/jobs/job123:/work -w /work python:3.12-slim \
  python /work/task.py

# Mac: Seatbelt guardrail profile (net-denied, write-scoped) — profile.sb
# (version 1)(allow default)(deny network*)(deny file-write* (subpath "/"))
(allow file-write* (subpath "/tmp/sandbox-work"))
# run: sandbox-exec -f profile.sb python experiment.py
```

## §I — Experiment queue
1. Install runsc on Johnny5; run the §H docker snippet with a deliberately nasty payload (fork bomb + rm -rf attempt in scratch dir). · Gates VPS verdict.
2. Write + test the Mac Seatbelt profile against our actual cron script inventory (do any need network?). · Gates Mac verdict.
3. Verify Daytona LICENSE file content before it appears in any future comparison. · Hygiene.
4. Benchmark overhead: same job bare vs gVisor vs Kata (expect gVisor ~single-digit-% to ~20% syscall-heavy penalty). · Informs default choice.

## Re-evaluate triggers
- Any agent begins executing third-party/untrusted code regularly → pull Firecracker forward
- Docker Desktop licensing changes affecting personal use → colima migration note
- Multi-tenant product ideas return → hosted-sandbox economics review

## Sources manifest
- api.github.com lookups: all §A rows (2026-08-22)
- Negative probes documented (bubblewrap path, sandbox-runtime path)
- Escape-history characterizations: ecosystem knowledge + delegated-researcher salvage search results (HackerNews Firecracker attack thread surfaced) — explicitly flagged, not primary-cited
- macOS Seatbelt behavior: platform knowledge consistent with installed OS generation — verify empirically in exp. 2

## Known gaps
- No hands-on runs performed this session
- Exact current-version numbers not pinned (repo-level verification only)
- Windows host story out of scope (we have none)

## Verification checklist
- [x] Repo facts verified this session; negatives documented
- [x] macOS-vs-Linux split stated plainly instead of glossed
- [x] Threat model matched to OUR reality (accident containment > adversarial escape)
- [x] Spend-bearing options gated behind house approval rules
