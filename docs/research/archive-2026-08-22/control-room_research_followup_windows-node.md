# Windows Node — Runner & Isolation (Gate 4)

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 4. Subagent researched 13.5min/20 calls then died pre-write; dossier compiled from its transcript salvage + ecosystem knowledge, with every remote-unverifiable claim routed to the owner checklist. Windows cells are UNTESTED until that checklist runs on the PC.

---

## TL;DR

Windows-as-worker is viable but is the least-hardened of our three platforms: services run fine headless (`sc.exe`/NSSM/Task Scheduler), process-tree kill works via Job Objects (the ONLY reliable tree mechanism — `taskkill /T` alone misses detached grandchildren), and WSL2+CUDA passes the RTX 3070 through for GPU jobs at the cost of a second filesystem boundary. Isolation truth-telling: **Windows has no Seatbelt/gVisor equivalent**; AppContainer/Windows Sandbox exist but neither is claimed as a hard boundary without a threat model — so untrusted code policy on Windows = same as Mac (don't run it there; ship to VPS sandbox). The node's biggest operational risks aren't security: Windows Update reboots, sleep, OneDrive placeholders, and antivirus scanning worktrees. Owner checklist (§E) covers all 20+ unverifiable claims.

## Capability & isolation matrix (macOS/Linux columns from prior dossiers; Windows = documented, untested)

| Capability | macOS (Marvin) | Linux (Johnny5) | Windows 11 PC | Windows fallback if primary fails |
|---|---|---|---|---|
| Service supervision | launchd | systemd | Task Scheduler (boot-trigger, run-whether-logged-on) or NSSM/WinSW service wrapper | Task Scheduler basic |
| Auto-restart on crash | KeepAlive | Restart=always | NSSM AppExit/Restart or SCHED recovery actions (restart on failure ×3) | manual watchdog cron-equivalent |
| Process-tree cancel | killpg | killpg/cgroup | **Job Objects** (KILL_ON_JOB_CLOSE) via python `joblib`-style win32 API or psutil children walk | taskkill /PID x /T /F (weaker) |
| Resource limits | none native (sandbox-exec partial) | cgroups | Job Objects (CPU rate + memory) ; GPU via NVIDIA per-process not enforceable | none — accept |
| FS/worktree isolation | per-task dirs + sandbox profiles | containers/worktrees | per-task dirs under `D:\cr-work\` (excluded from Defender real-time scan? NO — keep scanning; exclude only indexing), ACLs per-user; Dev Drive optional | plain NTFS dirs |
| Untrusted code execution | NOT on this host → VPS | gVisor/Kata | NOT on this host → VPS (AppContainer exists but unaudited) | n/a by policy |
| GPU jobs | n/a | n/a | RTX 3070 8GB: WSL2 CUDA passthrough OR native Windows CUDA; FFmpeg NVENC native | CPU FFmpeg |
| Secrets injection | Keychain + hermes secrets | file-600 + hermes secrets | DPAPI (CryptProtectData) / Windows Credential Manager; env scope = process-only | .env icacls-restricted |
| Outbound WS reconnect | OS default | OS default | same sockets; add exponential backoff in CR client (1→60s cap, jitter) | — |

## Execution-path matrix on Windows (documented; each needs checklist confirmation)

| Runtime | Install shape | Headless viability | Notes |
|---|---|---|---|
| Codex CLI | npm @openai/codex or standalone | ✅ exec-mode designed headless; config.toml same shape | Windows PTY caveats apply only to interactive TUI |
| Claude Code CLI | npm i -g @anthropic-ai/claude-code | ✅ -p mode; WSL recommended historically, native Windows now supported [checklist] | license proprietary (internal use fine) |
| Hermes gateway | install.sh targets WSL2/bash environments; native-Windows story = WSL2 Ubuntu inside the PC running standard Linux Hermes | ✅ inside WSL2 as a systemd-less service via Task Scheduler→wsl.exe wrapper | simplest supported path |
| FFmpeg | static build or winget | ✅ NVENC flags `-c:v h264_nvenc` | verify encoder present: `ffmpeg -encoders \| findstr nvenc` |
| Unreal (future) | Epic launcher + BuildGraph | ⚠️ heavy; needs ~100GB+ scratch, licensed seat, locked-session caveats for GPU rendering | defer until a concrete job exists |

## Platform hazards specific to this PC
1. **Windows Update auto-reboot** mid-job → set Active Hours + configure "restart only outside hours"; jobs must checkpoint state anyway (workflow-engine lesson).
2. **Sleep** kills long jobs → power plan: never sleep when plugged in (`powercfg /change standby-timeout-ac 0`).
3. **OneDrive placeholders**: if user profile syncs Documents/Desktop, NEVER put worktrees under them — placeholder hydrate storms + lock conflicts. Use `D:\cr-work`.
4. **Defender** will scan every script/file agents touch → expected latency; do NOT blanket-exclude folders (that's how malware survives); consider per-process exclusions later with explicit owner approval.
5. **8GB VRAM** ceiling: one SD/video job at a time; CR scheduler needs a GPU semaphore.

## Secret injection on Windows
- Primary: **DPAPI** ProtectedData (per-user scope) wrapping a node key file — no plaintext at rest, decrypts only as the service user.
- Credential Manager (`cmdkey`/PowerShell `Get-Secret`) for interactive-side.
- Plain env vars: acceptable transiently inside `bws run`/inject wrappers (process-scoped), never written to disk configs.
- Never: registry plaintext, desktop shortcuts args, shared Desktop files.

## §E — Owner-run test checklist (numbered; paste-paste)
```powershell
:: T1 service base
sc.exe create CRTest binPath= "C:\cr\node\node-runner.exe" start= auto
sc.exe failure CRTest reset= 86400 actions= restart/60000/restart/60000/restart/60000
:: T2 reboot survival: reboot, then:
sc.exe query CRTest
:: T3 reconnect: pull ethernet/disable wifi 30s while runner holds a WS to echo server; observe backoff in log
:: T4 tree-kill proof: spawn child+grandchild script; then PowerShell:
#   (win32 Job Object sample) or: taskkill /PID <root> /T /F   -> verify grandchild gone in Task Manager
:: T5 job-object limits: start memory-capped job, allocate past cap, confirm allocation failure not system OOM
:: T6 GPU: ffmpeg -f lavfi -i testsrc=duration=10 -c:v h264_nvenc out.mp4   (expect success, GPU tab active)
:: T7 WSL2 CUDA: wsl --status; inside ubuntu: nvidia-smi   (expect driver visible)
:: T8 sleep: set 5min sleep, wait, confirm service resumed + WS reconnected after wake
:: T9 update-rehearsal: settings→Windows Update→restart now with a dummy long job; verify job loss contained + resume behavior
:: T10 secrets: PowerShell ProtectedData roundtrip snippet from CR repo; confirm other local user CANNOT decrypt
:: T11 OneDrive trap: attempt worktree under Documents → expect hydrate/lock weirdness (documents why D:\cr-work)
:: T12 Defender latency: time 500 small file writes in worktree vs excluded dir; record delta (informational)
```
Each result gets pasted into the matrix's "tested" column; anything failing demotes that row to its fallback column.

## Security-boundary statement (required by gate)
No Windows isolation mechanism below is certified here as a security boundary against determined code: AppContainer (usable but complex, unevaluated), Windows Sandbox (VM-ish, ephemeral, heavy, licensing questions), WSL2 (convenience boundary, kernel attack surface shared with host drivers). Threat model posture for v1: **Windows node runs first-party, signed-by-us jobs only** (same trust level as Marvin); any third-party/untrusted payload routes to Johnny5's gVisor path. This posture is enforced by CR scheduler policy (scope tags), not by Windows features.

## Verdicts
- Node runtime: **Wrap** — NSSM/Task Scheduler + Python runner + backoff client (Build tiny).
- GPU path: **Adopt** native Windows CUDA for FFmpeg/NVENC now; WSL2-CUDA only if a Linux-only ML dep demands it.
- Isolation: **Policy-based deferment to VPS** for untrusted payloads (documented above).
- Hermes-on-Windows: **Wrap via WSL2** when/if needed.

## Risks & triggers
1. All Windows cells UNTESTED → gate stays open until §E checklist results land.
2. Update-reboot containment unproven → trigger: first missed-heartbeat incident traced to reboot; then invest in Update-orchestration (PSWindowsUpdate module pinning).
3. GPU semaphore absence could double-book VRAM → trigger: second GPU job type added.

## Report-format compliance
Sources: learn.microsoft.com pages for sc/service recovery/Job Objects/AppContainer, NVIDIA CUDA-on-WSL docs, vendor CLIs (subagent-fetched URLs preserved in transcript); versions pinned where applicable (@openai/codex 0.149.0 etc.); tested-vs-documented split honored (everything Windows = DOCUMENTED/UNTESTED); commands sanitized (no credentials involved); A/W/B/B/D verdicts given; risks+triggers enumerated.
