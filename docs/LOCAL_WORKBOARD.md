# Local Mac workboard

The local workboard lets Codex, Qwen and Claude exchange bounded jobs on the Mac
without using GitHub for every intermediate handoff. GitHub remains the public
source, review and recovery record for completed or meaningfully blocked packages.

Runtime files live under `.local-workboard/` and are ignored by Git. Do not put
credentials, raw private logs, production data or personal records in a packet or
result.

## Layout

```text
.local-workboard/
  inbox/{qwen,claude}/     queued jobs
  working/{qwen,claude}/   atomically claimed jobs
  outbox/{qwen,claude}/    completed results awaiting Codex
  failed/{qwen,claude}/    explicit failures awaiting triage
  archive/{qwen,claude}/   claimed packets and acknowledged results
  material/                sanitized, immutable review inputs when needed
  logs/                    temporary machine-readable results
```

Moving a packet from `inbox` to `working` is the claim. A worker never edits the
packet in place. If a process stops, its packet remains visible in `working`; it
is not silently reassigned.

Completion is ordered so a result cannot become visible before the claimed packet
is archived. A crash during completion leaves a staged result in `working`; rerun
the same `finish` command to complete that transition. `status` lists job IDs and
any staged results instead of returning counts alone.

## Packet

Create a JSON file outside the inbox and enqueue it through the controller:

```json
{
  "schema": "agent-control-room.local-job/v1",
  "id": "review-pr-340-01",
  "worker": "qwen",
  "objective": "Review the supplied change for concrete correctness defects. Return only actionable findings.",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "inputs": [".local-workboard/material/pr-340.diff"],
  "ownedPaths": [],
  "acceptanceChecks": ["cite exact changed file and failure path"],
  "effects": "read-only",
  "mode": "deliberate",
  "numPredict": 4096,
  "timeoutMinutes": 15
}
```

`baseCommit` is mandatory even for review. `inputs` are repository-relative
regular files and are limited to 128 KiB combined. Credential/configuration paths,
private keys and paths escaping the repository are refused.

Qwen packets may use `mode: "direct"` for routine work or `mode: "deliberate"`
for difficult reviews. Deliberate mode makes two bounded visible-answer passes; it
does not enable the model's unreliable unbounded hidden-thinking route.

## Commands

```bash
node local-tools/local-workboard.mjs init
node local-tools/local-workboard.mjs enqueue --packet /path/to/packet.json
node local-tools/local-workboard.mjs status
node local-tools/qwen-workboard-once.mjs
node local-tools/qwen-workboard-watch.mjs
node local-tools/local-workboard.mjs ack --worker qwen --id review-pr-340-01
```

The Qwen consumer performs one job and exits. This is deliberate: a foreground
Codex run, a bounded scheduler or a later filesystem trigger can invoke it without
installing an always-running service. Qwen receives only the declared material
and has no tools, credentials or write access.

`qwen-workboard-watch.mjs` is the optional foreground event watcher. It processes
queued Qwen jobs serially as files arrive and writes a bounded machine-readable
log. It does not install itself, survive a restart or become a background service.
Installing a persistent launcher remains a separately reviewed action.

## Claude

Claude uses the same packet and state transitions, but no Claude command is
currently available in Codex's terminal. Do not pretend the folder alone wakes
Claude. Activate one of these routes separately:

1. Claude's own scheduled task checks `inbox/claude`, atomically moves one packet
   into `working/claude`, works only in its separately named Git worktree, and
   writes a structured result to `outbox/claude`; or
2. install and qualify the Claude Code command, then add a bounded consumer using
   its documented non-interactive JSON interface.

The one-time scheduled-worker instruction is saved at
`docs/claude/LOCAL_WORKBOARD_SCHEDULER_PROMPT.md`.

A blind 30-minute model poll spends Claude usage when there is no job. Prefer a
scheduled task only during an active Claude package, or a filesystem-triggered
CLI consumer after that interface is qualified.

## Review and publication

Codex reads the outbox, verifies concrete findings, runs the required checks and
makes the integration decision. Qwen or Claude output is evidence, not authority.
After acknowledgement, the result moves to `archive`.

Local work may use multiple commits in isolated worktrees. Push one cohesive
package when it is review-ready, meaningfully blocked, or at the end of the
working day. Never self-merge authored work or convert a failed/uncertain result
into a pass.
