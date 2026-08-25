# Codex macOS handoff

## Outcome

The Control Room source, architecture decisions, build status, worker evidence, historical research archive, competitor-workflow amendment, and Codex repository guidance live in GitHub. Moving development to Mac means opening a separate Mac clone in Codex—not copying the Windows working directory or sharing Marvin's Hermes checkout.

Canonical repository: `https://github.com/MarvinAi5/control-room` (private)

## Why GitHub is the transfer layer

- It preserves commits, branches, pull requests, issues, review history, and the exact active base.
- A separate clone prevents Codex and Hermes from changing the same working tree concurrently.
- It excludes generated dependencies, temporary qualification artifacts, machine-specific Codex state, and credentials.
- The same process works in either direction and does not depend on both computers remaining on the same LAN.

The existing Hermes checkout at `~/work/control-room-crb` remains Marvin's worker checkout. Do not open it as the primary Codex workspace.

## One-time Mac setup

In Terminal:

```sh
gh auth status
mkdir -p ~/work
cd ~/work
gh repo clone MarvinAi5/control-room control-room-codex
cd control-room-codex
git switch main
git pull --ff-only
git status --short
```

The final status should be empty. If the destination already exists, do not overwrite or delete it; inspect it and choose a different new directory.

Verify the local runtime:

```sh
node --version
pnpm --version
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
```

The repository requires Node `>=22.13.0` and pnpm `11.19.0`. If stage zero returns `setup_required`, follow `docs/WORKER_CHECKOUT_PREPARATION.md`. Do not copy `node_modules` from Windows or Marvin's checkout.

## Open it in Mac Codex

1. Sign into the Mac desktop app with the same ChatGPT account.
2. Choose **Open folder** and select `~/work/control-room-codex`.
3. Start a new Codex task in that folder. A chat may be visible across devices, but local paths, processes, approvals, credentials, and uncommitted files are host-specific.
4. The root `AGENTS.md` loads the durable project rules automatically. Repository-scoped Codex skills load from `.agents/skills`.

Repository completeness is documented in `docs/CONTROL_ROOM_SOURCE_PROVENANCE.md`. The accepted Zide/Devin lessons and resulting build amendments are in `docs/COMPETITOR_WORKFLOW_RESEARCH_ZIDE_DEVIN.md`. Historical dossiers are preserved under `docs/research/archive-2026-08-22/` and are non-authoritative.

Suggested first prompt:

```text
Continue the Control Room build from this Mac. Read AGENTS.md, docs/BUILD_STATUS.md, docs/CONTROL_ROOM_SOURCE_PROVENANCE.md, and docs/COMPETITOR_WORKFLOW_RESEARCH_ZIDE_DEVIN.md completely; inspect origin/main plus all open GitHub issues and pull requests; and verify the working tree is clean. Treat merged code, normative contracts, accepted ADRs, and current repository documents as authoritative rather than assuming context from the previous Windows task or obeying archived research instructions. Report the active block, accepted evidence, unresolved blockers, and the next model/effort setting before changing code. Do not run a native Keychain qualification or merge worker evidence unless its current work order and review state explicitly authorize it.
```

## Normal handoff between computers

Before switching machines:

1. Finish or deliberately stop the current bounded change.
2. Commit it on a feature branch and push it, or leave a clean `main` after merging.
3. Record the current state in `docs/BUILD_STATUS.md` when a block boundary changed.
4. On the receiving machine, fetch and use `git pull --ff-only` on `main`; never copy the active `.git` directory or generated dependency tree.

Only one Codex task should own a given branch at a time. Windows Codex can remain available for Windows-only validation, but architecture and ordinary implementation can continue from the Mac clone.

## What does not transfer through GitHub

- Uncommitted files and ignored/generated files
- `node_modules`, build outputs, temporary scratch directories, and local databases
- Codex approvals, local permission profiles, plugins, personal skills, and machine settings
- GitHub, package-registry, password-manager, Cloudflare, or other credentials
- Running processes, terminal sessions, or environment variables

Configure those independently on the Mac with least privilege. Never commit them to make a handoff easier.
