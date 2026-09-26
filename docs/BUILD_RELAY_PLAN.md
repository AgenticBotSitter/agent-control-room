# Build Relay: three bots building Control Room while the owner is away

**Status:** plan, September 24, 2026. Owner decisions recorded below.
**Companion:** `MAC_LOCAL_CRITICAL_PATH.md` covers what gets built. This file covers how the bots coordinate while building it.

## Owner decisions (September 24)

- The integration branch `claude/mac-local-integration` is pushed to GitHub. The secret scan was clean.
- Autonomy is **deputy merges**:
  - Bots push `relay/*` branches and open PRs.
  - A *different* bot reviews each PR.
  - An approved PR with passing checks merges into the integration branch automatically.
  - Only the owner or Claude merges to `main`.
- **Claude usage:** runs as often as hourly on Sonnet, within the plan's 5-hour limits. Opus is used only for architecture and security checkpoints. Codex and Hermes do most of the building.
- **Cloudflare Access:** built but not finished. Mac sign-in uses the loopback owner session first. Cloudflare is finished as part of the multi-machine work.

## Design: GitHub issues are the task bus

This is already multi-machine by construction. The GitHub API is reachable from the Mac, the VPS, a Windows PC and cloud bots alike.

**Tasks.** A task is an issue labelled:

- `relay`
- `agent:codex`, `agent:hermes` or `agent:claude`
- `machine:mac` (later also `vps`, `windows`, `cloud`)
- `state:ready`

A hidden `relay-packet` JSON block in the issue body holds:

- base branch
- owned paths
- checks
- timeout

**Relay process.** There is one small relay per machine, run by launchd on the Mac (later by systemd or Task Scheduler). For each agent it:

1. Claims the oldest ready issue: `state:ready` becomes `state:working`, and it posts a claim comment.
2. Creates a fresh worktree from the base branch on `relay/<agent>/<issue>`.
3. Runs the agent headless with a deadline, killing its whole process group on timeout:
   - Codex: `codex exec`, with a workspace-write sandbox (read-only for reviews)
   - Hermes: `hermes -z`, in the worktree
   - Claude: `claude -p --model sonnet`, with a tool allowlist
4. Commits the result itself. Agents never commit, push or touch GitHub.
5. Refuses any change outside the owned paths or inside protected paths:
   - the relay code itself
   - `.github/`
   - `AGENTS.md`
6. Runs the listed checks, pushes the branch and opens a PR against the integration branch.
7. Opens a `kind:review` issue for the reviewer bot:
   - Codex's work is reviewed by Hermes.
   - Hermes's and Claude's work is reviewed by Codex.
   - Security-sensitive packets name Claude as reviewer.

**Review.** It reads the diff read-only and ends with `VERDICT: APPROVE` or `VERDICT: CHANGES`.

- On CHANGES, the build issue returns to ready with the findings attached.
- After 3 rounds without approval, it becomes `state:blocked` and goes to the lead.

**Merge.** This step has no AI in it. It merges only when all of the following hold:

- the PR was authored by the owner account
- the branch is `relay/*`
- the base is the integration branch
- the approval is for the exact current head
- no protected path is touched

It squash-merges, closes the issue, and flags conflicts for the lead.

**Lead.** Claude, on Sonnet, runs hourly. It:

- reads the plan and the queue
- writes the next task issues, with a maximum of 2 ready per agent
- unblocks stuck work
- opens `kind:owner` issues for things only the owner can do: VPS, Cloudflare, credentials, service installs

**Codex as deputy lead.** When no lead run is available, Codex can take a `kind:lead` issue to break a plan step into tasks. Claude checks those tasks at its next run.

## Safety, given the repository is PUBLIC

- The relay acts only on issues and PRs authored by the owner account with the `relay` label. Outsiders' issues and fork PRs are ignored.
- Everything posted is redacted before posting:
  - keys and tokens
  - database URLs
  - home paths
  - tailnet hosts and IPs
- Posted text is also truncated.
- Agents are told their final message is public.
- Agents never receive credentials. VPS, Cloudflare and credential work is always a `kind:owner` issue.
- `main` is never merged by a bot, and the relay cannot change its own code through a bot PR.
- There is one lock per agent and one merge lock, so no job runs twice at once (the lead-cycle overlap risk seen earlier).
- **Known risk accepted by the owner:** Hermes runs with automatic command approval inside its worktree, and it is not sandboxed. Codex runs in its own sandbox. Claude runs with a tool allowlist.
- `pnpm install --offline` in each worktree reuses the local store. The relay does not install anything globally.

## Why this is also the Control Room transition design

The relay is deliberately shaped like Control Room's own multi-machine model, so the lessons carry over:

| Relay | Control Room equivalent (to build later) |
| --- | --- |
| Issue with `machine:*` and `agent:*` labels | Task routed to a worker enrolled on a node |
| Claim by label change and comment | Durable lease/claim in PostgreSQL (pg-boss) |
| Relay polls outbound, no inbound port | Remote workers pull over outbound HTTPS (existing `remoteControllerWorker`), so no inbound port is needed on Windows or cloud |
| Reviewer ≠ author, verdict bound to head SHA | Review bound to the exact result digest |
| Deterministic merge gate | Owner acceptance / correction lifecycle |

Design rules added to the Mac build now so the multi-machine step is an extension, not a rewrite:

1. Every worker record carries a `nodeId`. The Mac is simply node 1. Nothing in the task lifecycle may assume "same machine".
2. Agent adapters (Hermes, Claude, Codex) are per harness, not per machine. The local `deliver` port and the future remote pull worker use the same task/result contract.
3. The database stays on the VPS. It is already reachable over Tailscale from any node, so the database never moves.
4. No Mac-only paths in shared records. Store paths relative to a node-local workspace root.
5. Website authentication moves to Cloudflare Access when a second node or phone access is needed. The loopback sign-in is an interim step for Mac-local use.

After the Mac proof (plan step P6), the next steps are:

- Hermes on the VPS as node 2, pulling tasks
- the Windows PC as node 3
- cloud bots as node 4

## Open item: who writes the relay program

The design above is fixed. Claude's attempt to write the relay program in this session was **blocked by Claude Code's auto-mode safety check**. The owner must choose:

- **(a)** Allow it: approve the write in Claude Code, or add a permission rule. Claude then writes it (~350 lines), tests it on one harmless issue, and installs the launchd jobs.
- **(b)** Have Codex write it from this plan, in Codex's own session. The owner reviews the one PR and installs the launchd jobs.
- **(c)** Smaller start: no auto-merge and no Hermes auto-approval. Bots only open PRs, and Claude or the owner merges. This is lower risk, but slower overnight.
