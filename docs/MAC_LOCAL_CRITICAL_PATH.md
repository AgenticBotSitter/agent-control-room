# Mac local critical path: website plus three agents on one Mac

**Status:** authoritative execution plan, September 24, 2026. Claude is the lead.
**Supersedes for execution order and scope:** `LOCAL_TO_MULTI_SYSTEM_EXECUTION_PLAN.md`,
`SINGLE_MACHINE_CLAUDE_COMPLETION_PLAN.md`, `REAL_WORLD_THREE_WORKER_ACTIVATION_PLAN.md`.
Those remain architecture and history. Where they conflict with this file, this file wins.

## Outcome

On this Mac, the owner opens the Control Room website. They create a project and
task and assign it to Hermes Agent, Claude Code or Codex. They watch it run, read
the saved result, and then accept it or ask for a correction. The existing VPS
PostgreSQL database is the only authority. The website, controller, pg-boss
queue worker and all three agents run on the Mac. More worker machines come later.

## What was verified at takeover (not inferred from earlier chats)

- The active Codex checkout matched the handoff: same branch, same HEAD, the same 242/12 diff, and the untracked runner test.
  That work is preserved on branch `claude/mac-local-integration` as commit `4bd0c6ca`, byte-identical to the original.
- **None of the 615 local commits on that line are on GitHub.** `origin/main` is at PR #330.
  The work exists only in the local repository object store.
- The protected Application Support directory has empty `config/`, `runtime/` and `logs/` folders.
  There is no operator configuration, no install and no service. The only earlier local run was the fake-repository pilot.
- CLIs present:
  - Hermes (`hermes`)
  - Claude Code 2.1.281. It is installed under Hermes's private Node prefix, so it is not on a stable launch path.
  - Codex CLI 0.155 inside the ChatGPT desktop app. It supports `exec --json --sandbox read-only --ephemeral`.
  - The old standalone Codex CLI symlink is broken.
- `cloudflared`, `tailscale` and `psql` are installed. Database reachability and roles were not tested (they need the owner).

## Why nothing runs yet

The shared pipeline already exists in source:

1. planning
2. approval
3. pg-boss queue
4. the queue worker calls a local worker `deliver`
5. results
6. review and correction

Every live entry into it is gated on native custody evidence that nobody can produce yet:

- installation plan and topology digests
- post-install admission receipts
- the journal custody blocker `native_journal_operation_custody_missing`
- the sealed Hermes runtime
- Cloudflare-hosted VPS web mode, which also requires remote native HTTPS, evidence and session components

The work went into making those gates stronger instead of opening one honest path through them.

## Decisions (these correct the older plans)

1. **Codex runs as a managed worker on the Mac.** It uses the Codex CLI in the ChatGPT app with `codex exec --json` and a read-only sandbox.
   Linux is not required and not in scope. Codex Desktop acting as a chat lead is a different thing and does not count as a worker.
2. **The database is the existing VPS PostgreSQL, reached over Tailscale.** No database on the Mac and no migration project.
   Existing `deploy/postgres` provisioning, migration and backup scripts are reused against it.
3. **Explicit local trust model: "owner-trusted local CLI".**
   - The three agents run as the owner's macOS user and use the owner's existing logins.
   - Control Room pins each CLI's absolute path and records its version.
   - Each task gets:
     - an empty working directory
     - a small allowlist of environment variables
     - fixed arguments
     - a deadline
     - TERM→KILL on the process group
   - This does **not** defend against a malicious process running as the same user. That risk is accepted for this Mac.
   - No sealed runtimes, Mach-O closure checks or native journal custody are required for this path. They are deferred, not deleted.
4. **First capability is text only for all three agents.** Claude runs with all tools off (`--tools ""`), MCP config limited to an empty set, no setting sources and no session persistence. Codex runs with a read-only sandbox and an ephemeral session. Hermes runs its current profile with toolsets disabled.
   A write/build capability is a later, separately approved step that uses the existing workspace and approval machinery.
5. **One new host mode, `mac-local`.**
   - It requires queue, approvals, quality, results and at least one local worker.
   - It does not require remote-native HTTPS, evidence or session components.
   - An owner-held enablement record in the protected config replaces the admission receipts that cannot be obtained today.
   - It reuses `private-task-host`, `private-serving` and the existing launcher.
   - The installer and operator composition path (`private-local-installation-operator`) is deferred.
6. **Website sign-in.**
   - **Preferred:** the existing Cloudflare Access verification through a `cloudflared` tunnel from the Mac. This needs no new auth code.
   - **Fallback:** a loopback owner session reusing the local-pilot session code, if no Access application exists.
   - The owner answers which one applies.

## Critical path

| Step | Work | Owner action? | Done when |
| --- | --- | --- | --- |
| P0 | Preserve source and supersede older plans (this file). Scan the 615 commits for secrets and private paths, then push the branch. | Approve push | Branch is on GitHub. The scan report is clean or fixed. |
| P1 | Database reach: confirm the Tailscale Serve TCP route and TLS, provision component roles with `deploy/postgres/provision-database.sql`, apply migrations, run a read-only check from the Mac. | **Yes, one window on the VPS** | The Mac passes the read-only database check using the restricted roles. |
| P2 | `mac-local` host mode plus protected operator config template. The website starts against the VPS database with no workers. | Fill in secrets locally | Owner signs in, creates a project and task, and sees them after a restart. |
| P3 | One generic owner-trusted local CLI `deliver` port on top of the existing `local-delivery-composition` (receipt, recheck, publish), with three adapters: Hermes, Claude and Codex. Includes independent security review. | No | Fake-executable tests cover the items listed after this table. Review has no blockers. |
| P4 | Enable the three workers in the host. The status panel follows real readiness and recent work. | Start the host | One harmless task per agent returns three distinct saved results. |
| P5 | Journeys: accept one result, request one correction, cancel mid-run, kill a worker, restart the controller. | Watch | Every checklist item is recorded in `docs/MAC_LOCAL_EVIDENCE.md`. |
| P6 | Install as a launchd user service, verify a backup and restore of the VPS database, write owner docs. | Approve service install | The host restarts on login and the evidence record is complete. |

P3 fake-executable tests cover:

- no spawn after revocation or a changed task
- no second run after replay or restart
- one task publishes exactly one result
- cancel and deadline kill the process group

P1 and P3 run in parallel. P2 needs P1. P4 needs P2 and P3.

## Deferred (do not work on these until P6 passes)

- Additional worker machines, Linux Codex and remote-native HTTPS
- Sealed Hermes runtime, Mach-O inspection and native journal custody
- Installer wizard polish
- Idea Lab, schedules and news
- Donor UI reuse

The existing source for these stays in place.

## Work split

- **Claude (lead, integrator):** P2 host mode, P3 generic port plus the Hermes and Claude adapters, integration, final review. Claude is the only editor of shared composer and startup files.
- **Codex (bounded, file-disjoint):** the P3 Codex adapter and its tests, and the P1 read-only database check script. Packets are in `docs/claude/assignments/`.
- **Marvin / Hermes (bounded, read-only reports):** the P0 commit scan, the website route inventory for P2 and P4, and a flag cross-check for the adapters. Packets are in `docs/claude/assignments/`.

Worker output is evidence, not authority. Claude reviews and integrates everything.
