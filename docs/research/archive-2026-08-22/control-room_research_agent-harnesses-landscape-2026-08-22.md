# Agent Harness Landscape — the OpenClaw Class

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Companion to:** `research/orchestration-landscape-2026-08-22.md` (same folder)
**Scope:** all major personal AI agent harnesses — self-hosted agents that run on your machine, act autonomously, and reach you through chat apps. Repos verified via GitHub API on 2026-08-22.

---

## TL;DR

The category has one runaway leader — **OpenClaw at 387k stars** — plus DeepSeek's new plugin-composable **Harness** (184.7k★), AutoGPT (186.8k★), Goose (53.2k★), Open Interpreter (68.1k★), Khoj (36.7k★), Letta (24.4k★), and a long tail. Hermes sits squarely in this class; its differentiators are the self-improving skills/memory loop, the built-in kanban/peer orchestration layer, and Nous Portal. Two of the names you asked about resolved differently than expected: there is **no major harness called "Runkbot"** (three probes negative — likely a misheard name), and "DeepSeekbot" almost certainly means **DeepSeek Harness**, their open-source agent runtime released Aug 2026.

---

## Name-resolution notes (your two specific asks)

### "Runkbot" — does not exist [UNVERIFIED NAME]
Three independent GitHub probes returned nothing resembling an AI agent harness by that name (repo-name search: only Odoo's unrelated CI-preview "runbot," a 2021 Uniswap bot, SLAM robotics). Possibilities: misheard/mistranscribed name. Closest real candidates if you meant something else:
- If you heard it in an AI-tools context, you may mean **Runloop** (commercial agent-infra startup) or simply "run bot" phrasing from a video. Say the word and I'll chase a specific spelling.

### "DeepSeekbot" = DeepSeek Harness
DeepSeek's entry into the harness space, developer-preview announced Aug 2026:
- **Repo:** https://github.com/deepseek-ai/deepseek-harness — 184,706★, **MIT**, pushed 2026-08-21
- **Docs:** https://deepseek.com/harness/en/ (HTTP 200)
- **What makes it different:** "Everything is a plugin." Tools, skills, sessions — and even *entire foreign harnesses* like Claude Code or Codex — are compose-with-config plugins without touching source. InfoQ framed it as the unbundling of agent infrastructure. It's positioned as a runtime you assemble, not a product you adopt.
- Announcement X post: x.com/deepseek_ai/status/2087887408440164663 (via InfoQ)

### OpenClaw naming history (confirmed)
One repo, three names: launched Nov 2025 as **Clawdbot** by Peter Steinberger → renamed **Moltbot** → renamed **OpenClaw**. Verified mechanically: `github.com/moltbot/moltbot` HTTP-redirects to `openclaw/openclaw`. Coverage: CNBC Feb 2026; Medium retrospective "From Clawdbot to Moltbot to OpenClaw."

---

## The verified roster (GitHub API, 2026-08-22)

| Harness | Repo | Stars | License | Last push | One-liner |
|---|---|---|---|---|---|
| **OpenClaw** 🦞 | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 387,131 | NOASSERTION¹ | 2026-08-22 | Personal AI assistant, any OS/platform; the category king |
| **AutoGPT** | [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | 186,764 | NOASSERTION¹ | 2026-08-22 | The OG autonomous-agent platform; still active |
| **DeepSeek Harness** | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 184,706 | MIT | 2026-08-21 | Plugin-composable agent runtime (dev preview) |
| **Open Interpreter** | [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter) | 68,112 | Apache-2.0 | 2026-08-20 | Started as code-executing assistant; now "coding agent for open models like Kimi K3" |
| **Cline**² | [cline/cline](https://github.com/cline/cline) | 66,666 | Apache-2.0 | 2026-08-22 | Autonomous coding agent as SDK / IDE extension / CLI |
| **Goose** | [aaif-goose/goose](https://github.com/aaif-goose/goose)³ | 53,249 | Apache-2.0 | 2026-08-22 | Block's extensible local agent; "beyond code suggestions" |
| **Aider**² | [Aider-AI/aider](https://github.com/Aider-AI/aider) | 48,403 | Apache-2.0 | 2026-05-22 | Terminal AI pair-programmer |
| **Khoj** | [khoj-ai/khoj](https://github.com/khoj-ai/khoj) | 36,656 | AGPL-3.0 | 2026-08-02 | Self-hosted AI second brain + custom agents |
| **Letta** | [letta-ai/letta](https://github.com/letta-ai/letta) | 24,350 | Apache-2.0 | 2026-08-16 | Stateful agents w/ advanced memory (MemGPT lineage) |
| **OpenHands**² | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 84,789 | MIT | 2026-08-22 | AI-driven development (formerly All-Hands-AI) |
| **SuperAGI** ⚠️ | [TransformerOptimus/SuperAGI](https://github.com/TransformerOptimus/SuperAGI) | 17,660 | MIT | **2025-01-22** | Dormant ~19 months — do not adopt |

¹ NOASSERTION = GitHub's license-detector hasn't classified the LICENSE file (or custom license). Per prior verification (external-project-research pitfall 24 worked example), OpenClaw's LICENSE file was read as **MIT verbatim** in the 2026-07-04 dossier session; re-check before legal reliance. AutoGPT has historically shipped under Polyform Shield terms.
² Coding-agent class rather than personal-assistant class — included because they're the names people mean when they say "agent harness."
³ `block/goose` now redirects to `aaif-goose/goose` — Block moved the repo orgs; old links keep working.

### Where each one documents itself

| Harness | Docs URL | Status |
|---|---|---|
| OpenClaw | https://docs.openclaw.ai/ | 200 OK |
| DeepSeek Harness | https://deepseek.com/harness/en/ | 200 OK |
| Goose | https://block.github.io/goose/ | 200 OK |
| OpenHands | https://docs.all-hands.dev/ | 308 redirect (alive, moved) |
| Khoj | https://khoj.dev/ | 200 OK |
| Letta | https://docs.letta.com/ | 200 OK |

### OpenClaw ecosystem (org enumeration, top items)

| Repo | Stars | What |
|---|---|---|
| clawhub | 9,331 | Official skill + plugin registry for OpenClaw |
| Peekaboo | 5,028 | macOS CLI/MCP server letting agents see the screen |
| openclaw-windows-node | 2,064 | Windows companion suite (tray app + shared lib) |
| Crabbox | 1,326 | Warm-box/diff-sync/suite runner |
| ClawSweeper | 1,966 | Issue/PR triage sweeper |
| docs | 75 | Official docs + translations |

Community satellites worth knowing: `hesamsheikh/awesome-openclaw-usecases` (31.7k★), `miaoxworld/OpenClawInstaller` (3.4k★), `m1heng/clawdbot-feishu` (4.25k★ Feishu bridge).

---

## How this class relates to Hermes (positioning)

Same species: local-first autonomous agent, chat-app front door, tool/skill ecosystem. Differences that matter:

| Dimension | Hermes Agent | OpenClaw | DeepSeek Harness | Goose |
|---|---|---|---|---|
| License | MIT | MIT (file)¹ | MIT | Apache-2.0 |
| Front doors | Telegram/Discord/Slack +20 platforms, TUI, desktop, web dashboard | Chat apps (WhatsApp/Discord/etc.) | Plugin/composable runtime (bring your own UI) | Desktop app + CLI |
| Orchestration built in | ✅ kanban swarms + peer mesh + cron + subagents | Community patterns (Trello-style claws etc.) | Compose multiple harnesses as plugins | Extensions |
| Memory/skills growth loop | Core pitch (self-improving) | Skills via ClawHub registry | Config composition | Extensions |
| Backing | Nous Research | Peter Steinberger + community | DeepSeek | Block (Square) |

Takeaway for our stack: we're not missing out on a capability by staying on Hermes — the unique bits are the orchestration primitives (Part 2 of the main dossier) and Portal economics. The one worth *watching* structurally is DeepSeek Harness: if "wrap any harness as a plugin" works as advertised, a control room that treats Marvin/Johnny5/Claude Code/Codex as interchangeable plugins becomes much cheaper to build.

## Re-evaluate triggers
- DeepSeek Harness exits dev preview → reassess as control-plane substrate
- OpenClaw LICENSE file changes from MIT → revisit any integration assumptions
- Any "Runkbot"-like name surfaces with >10k stars → add here
- SuperAGI resumes commits → re-classify from dormant

## Sources manifest (all checked 2026-08-22)
- GitHub API: repos/{openclaw, Significant-Gravitas/AutoGPT, deepseek-ai/deepseek-harness, openinterpreter, cline, aaif-goose/goose, Aider-AI/aider, khoj-ai/khoj, letta-ai/letta, OpenHands/OpenHands, TransformerOptimus/SuperAGI}, orgs/openclaw, users/steipete, redirect behavior of moltbot/moltbot + block/goose (raw outputs archived in session)
- Docs-site HTTP probes: table above
- https://deepseek.com/harness/en/ (primary, fetched)
- https://www.infoq.com/news/2026/08/deep-seek-harness/ (corroboration)
- https://www.cnbc.com/2026/02/02/openclaw-open-source-ai-agent-rise-controversy-clawdbot-moltbot-moltbook.html (naming history)
- Medium: From Clawdbot to Moltbot to OpenClaw (naming history corroboration)
- Negative-result probes for "Runkbot": GitHub search API ×2 + web search (documented above)

## Verification checklist
- [x] Every repo star/license/push value from live API this session, not memory
- [x] Renames traced via actual HTTP redirects, not hearsay
- [x] Dormant projects flagged (SuperAGI); resting ones excluded or marked
- [x] Unverifiable name ("Runkbot") reported honestly with probe evidence, not guessed
