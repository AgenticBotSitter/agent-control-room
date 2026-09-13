# Claude Code real execution — Stage C design

Author: Claude (Opus 5). Date: 2026-09-13.
Status: **design proposal only.** No code, no spawner, no credential, no spend. Every
operation in `src/harness/claude-code-v1/connector-profile.ts` stays `unsupported`. This
document exists to be reviewed *before* anyone writes a line of process-spawning code,
per the owner's standing rule that spawning real OS processes is a materially more
consequential act than docs and metadata and needs a security pass first.

Inputs read on real `origin/main`: `docs/SHARED_CONNECTOR_CONTRACT.md`,
`src/harness/v1/{connector-profile,lifecycle,native-run-contracts}.ts`,
`src/node-policy/v1/{effect-claim,effect-claim-store,native-key-stores}.ts`,
`src/harness/hermes-native-v1/start-authority.ts`,
`src/harness/codex-v1/{workspace,git-workspace-port}.ts`,
`src/web/v1/herdr-pane-port.ts`, `src/scheduler/v1/budget-store.ts`.
Inputs still on unmerged branches: `docs/claude/CLAUDE_CODE_A0_VERIFICATION.md` and its
verified CLI flag facts (`claude/claude-code-harness-a0`),
`docs/claude/CLAUDE_CODE_APPROVAL_AUTHORITY_DESIGN.md`
(`claude/claude-code-approval-authority-design`), and the four-point Claude Code admission
checklist added to `docs/SHARED_CONNECTOR_CONTRACT.md`
(`claude/claude-code-admission-checklist`).

## 1. Scope and non-goals

**In scope:** one turn. Control Room submits a single prompt to a Claude Code process,
streams its JSON-lines output, and settles exactly one canonical result. That is the whole
first execution capability: `submit` → `events` → `result`, plus `cancel`.

**Explicitly out of scope, and not to be smuggled in:**

- Mid-run approval / `canUseTool` relay — that is
  `docs/claude/CLAUDE_CODE_APPROVAL_AUTHORITY_DESIGN.md`, a separate later capability. This
  design assumes authority bound *ahead* of the run and treats any mid-run ask as a **deny**.
- Steering, interrupt-and-continue, `messaging_socket_path`, the SDK host.
- `resume` and multi-turn threads. `--session-id` is pinned here for identity binding only.
- Background sessions (`--bg`, `attach`, `logs`, `stop`, `rm`, `agents`) — deferred, see §4.
- Artifacts beyond the contract's single UTF-8 result of at most 65,536 bytes.
- Any relaxation of `--permission-mode`. `bypassPermissions`, `dontAsk`, `auto` and both
  spellings of `--dangerously-skip-permissions` are disqualified outright for fleet jobs.

**No code from this document may be written before it has been reviewed.**

## 2. Process lifecycle

### 2.1 What gets spawned

A single `spawn` of the operator-installed Claude Code binary, `shell: false`, fixed argv,
no inherited environment:

```
<pinned-claude-executable>
  -p <prompt-from-stdin-preferred>
  --output-format stream-json
  --verbose
  --session-id <uuid derived from the Control Room run identity>
  --max-budget-usd <ceiling from the attempt's budget reservation>
  --permission-mode manual
  --restricted            # evaluate as the default posture; see §4
```

`cwd` is the run's own prepared workspace (§4), never the repository root and never the
Control Room process's cwd. `env` is constructed explicitly — `herdr-pane-port.ts` on `main`
builds a minimal `{ NODE_ENV, PATH, … }` and inherits nothing; do the same, plus at most one
credential variable (§5). Deliver the prompt on stdin rather than argv wherever the CLI
allows, so it never lands in a process table, a crash log or `ps` output.

### 2.2 Mapping onto canonical run state

`src/harness/v1/lifecycle.ts` owns the canonical state machine
(`discovered → starting → running → … → succeeded | failed | cancelled`, with
`waiting_input`, `waiting_approval`, `cancelling`, `disconnected` between). For one turn:

| Control Room state | Enters on |
|---|---|
| `starting` | pre-effect marker durably committed, spawn attempted, nothing read yet |
| `running` | the **`system`/`init`** frame is read *and* its `session_id` equals the pinned `--session-id` |
| `cancelling` | a cancel decision is durably recorded, before any signal is sent |
| `succeeded` | a `result` frame with `is_error: false`, then a clean process exit |
| `failed` | `result.is_error === true`, or a non-JSON failure path, or exit without a `result` frame |
| `cancelled` | cancellation completed and the process is confirmed reaped |

Classification keys off `result.is_error` / `result.terminal_reason`, **never**
`result.subtype` — Stage A0 captured a real frame with `subtype: "success"` and
`is_error: true`. `waiting_approval` is unreachable here: a mid-run ask is a deny, not a
state transition, and observing one is a design violation that fails the run.

### 2.3 How we know it actually started

A `spawn()` that resolves is not evidence of a started agent. Three separable outcomes must
be distinguished, because they have different effect-claim consequences:

1. **Never spawned** — `child.on("error")` fires (ENOENT, EACCES, EPERM) with no pid. This
   is a *pre-effect* failure: nothing ran, nothing was spent. Safe to fail the claim
   without non-execution evidence.
2. **Spawned but never confirmed** — a pid exists but no `system`/`init` frame arrives
   within a bounded window, or the process exits before one. This is **ambiguous**, not
   failed: a process existed and may have done something. It raises `ambiguity_raised` on
   the claim (`classifyEffectClaimRecovery` → `mark_ambiguous`) and must never be collapsed
   into "it failed, retry."
3. **Confirmed running** — `system`/`init` read, `session_id` matching the pin. Only this
   outcome is a start.

### 2.4 Identity binding via `--session-id`

Control Room derives the session UUID from its own run identity (a deterministic function
of tenant/project/job/attempt/run, recorded in the marker before spawn) and passes it in.
The first frame, `system`/`init`, carries `session_id`; if it does not equal the pin the run
fails immediately and the process is killed — that is the wrong binary, the wrong process,
or a session we do not own. Correlation is thus established on frame one from a value
Control Room chose, rather than by trusting a `session_id` the process later asserts. Every
later frame is checked against the same pin; a mid-stream mismatch ends the run.

### 2.5 Cancel

Claude Code spawns tool subprocesses (Bash, git, test runners). Killing the parent pid
leaves those orphaned and still spending. Therefore:

- Spawn with `detached: true` so the child leads its **own process group**, and signal the
  negated pid (`process.kill(-pid, …)`) so the whole group receives it.
- Escalate: record the cancel decision durably → `SIGTERM` the group → bounded grace window
  → `SIGKILL` the group → confirm reaping.
- `kill()` returning is not an acknowledgement — `herdr-pane-port.ts` is explicit that
  "neither `kill()` nor an error is an exit acknowledgement." The run is `cancelled` only
  after `close` is observed; a cancel that cannot confirm reaping is **ambiguous**.
- Cancel while in `starting` — after the marker, before `system`/`init` — is the worst case
  and must be handled explicitly rather than discovered in production.

## 3. Effect-claim ordering

**This infrastructure already exists on `main` and must be reused, not reinvented.**
`src/node-policy/v1/effect-claim.ts` defines `EffectClaimSnapshotV1`
(`claimed → executing → confirmed | failed | cancelled | ambiguous`) and
`PreEffectMarkerV1`; `src/node-policy/v1/effect-claim-store.ts` is a durable SQLite store
(WAL, `synchronous=FULL`, `UNIQUE(execution_id, operation_digest)`, tombstones on
compaction). `src/harness/hermes-native-v1/start-authority.ts` is the working precedent for
guarding a *start* with it, and `src/harness/v1/native-run-contracts.ts` already states the
rule: `markStart` must durably commit the pre-effect marker **before returning**.

Required ordering for a Claude Code spawn:

1. Authority is evaluated and an execution claimed — `createEffectClaimSnapshot` with
   identity `{tenantId, nodeId, projectId, jobId, attemptId, operationDigest}`. State
   `claimed`. Nothing has run.
2. `createPreEffectMarker` with a **`payloadDigest` of the exact prompt and argv**, then
   `commitPreEffectMarker` — durable, fsynced, before the spawn call. State becomes
   `executing`.
3. Only now does the OS spawn happen.
4. `system`/`init` with a matching `session_id` → the run is confirmed started.
5. Terminal `result` frame + clean exit → `confirmed` with a receipt digest over the result
   bytes; error/non-execution → `failed` with non-execution evidence; §2.3 outcome 2 →
   `ambiguous`.

Crash semantics fall out of the existing `classifyEffectClaimRecovery`: a claim with no
marker is safe to re-evaluate (nothing spawned); a claim with a marker is `mark_ambiguous`
(a process may exist and may have spent tokens and edited files) and needs evidence, never
a blind respawn. That is the lost-job-vs-duplicate-spawn property, already built.

**One extension is needed, and only one.** `createPreEffectMarker` hard-codes its
payload-commitment requirement to `operationId === "harness.hermes.native.start"`. A second
id — proposed `harness.claude-code.cli.start` — must be added to that requirement so a
Claude Code start cannot be marked without committing its prompt digest. Add the id; do not
generalize the rule into a registry.

Open for review: whether `destinationIdempotencyKey` (currently the claim key) means
anything for a local process, where there is no remote destination to deduplicate against.

## 4. Isolation

**Be blunt: there is no sandbox on `main`.** The only two process spawns that exist
(`src/node-policy/v1/native-key-stores.ts`, a keychain helper bounded to ≤60 s and ≤1 MiB;
`src/web/v1/herdr-pane-port.ts`, a 2-second `pane list` read) are short, non-streaming,
output-bounded reads — no model for a long-lived agent process that writes files. **There is
no real Codex spawner on `main` to copy either**: the harness plan's "Codex execution seam
with an injected spawner" describes an old unmerged branch. This would be the codebase's
first genuine execution path.

What *does* exist and should be reused rather than diverged from is the Codex **workspace**
pattern: `src/harness/codex-v1/workspace.ts` and `git-workspace-port.ts` create a detached
Git worktree per run under a workspace root proven disjoint from the repository root, with
canonical `realpath`/device/inode identity checks, a derived child name
(`codex-<24 hex of the run id digest>`), refusal of non-canonical or symlinked paths, and an
`uncertainCreates` set so a half-happened create is reconciled rather than retried. A Claude
Code run gets the same treatment under a `claude-<24 hex>` name.

Honest statement of the achievable initial level:

- **Achieved:** own detached worktree, own process group, explicit minimal environment, no
  shell, fixed argv, `--permission-mode manual`, and `--restricted` under evaluation (it
  strips Bash/PowerShell/REPL and WebFetch, confines file tools to the working directory,
  refuses `bypassPermissions`, and ignores project/user settings files — so a repo-local
  `CLAUDE.md` cannot alter the run).
- **Not achieved, and must not be claimed:** the process runs as the same OS user on the
  same host with the same filesystem and network reach as Control Room. A worktree is a
  *convention*, not a boundary; `--restricted` is enforced by the agent, not the kernel.
  No container, no seccomp/sandbox-exec profile, no network namespace, no user separation.
  `isolation: "adapter_process"` in the profile is the truthful value and must not be
  upgraded to `"container"` or `"worktree"` on the strength of this design.

Real containment is a separate infrastructure decision (dedicated OS user at minimum;
container or VM properly). It must be made before Claude Code runs untrusted prompts, not
necessarily before owner-authored ones — but that difference belongs in the admission
record, not in an assumption.

The native `--bg` session lifecycle is deferred for the same reason: a detached session
Control Room did not spawn and cannot reap is harder to reason about than a child in a
process group we own. Revisit only after the foreground path is qualified.

## 5. Credential handling

The CLI needs an OAuth session or `ANTHROPIC_API_KEY`. `docs/SHARED_CONNECTOR_CONTRACT.md`
is already categorical — no credential value, executable path or private endpoint belongs in
the public profile — and the profile records `credentialResolution: "harness_native"`: the
harness owns authentication and Control Room does not mediate it. Rules, stated so an
implementer cannot read them two ways:

- No credential value is ever written into a connector profile, effect claim, pre-effect
  marker, run journal, event record, log line, database row or error message.
- The pre-effect marker's existing `credentialRefs: string[]` holds **safe identifiers**,
  never values, and is the only credential-shaped thing that may be persisted.
- If an API key is used it is supplied as one environment variable on the child's explicitly
  constructed `env`, read from host configuration at spawn time, held in no long-lived
  application object, never echoed. `apiKeySource` on the `system`/`init` frame confirms
  which credential path is active without reading the secret — record that, not the key.
- OAuth (`claude auth login` on the host, credentials in Claude Code's own store) keeps the
  secret entirely outside Control Room's address space and is the recommended default for a
  single-node deployment. An API key becomes preferable for multi-node fleets where per-node
  OAuth is impractical. Owner decision, not a connector one.

**Do not build a credential broker.** There is no provider-credential broker on `main`
today; `src/security/host-value.ts` is a host-value/Proxy-rejection utility, and the
`host_broker` custody mode in `src/idea-lab/v1/` is a different subsystem's enum value, not
an implementation available here. Inventing one for this path would be unreviewed
security-critical surface built for a single consumer.

## 6. Cost and usage ceiling

What exists on `main` is `src/scheduler/v1/budget-store.ts`: `ProjectBudgetStore`, a
per-`(tenant, project)` ceiling in **microusd** with `reserve`/`release` of estimated
amounts under `SELECT … FOR UPDATE`, idempotent by reservation id. Its own comment is the
important part: *"Atomic accounting reservation only; it does not charge a provider or
authorize execution."* `PreEffectMarkerV1` also carries an optional `estimatedCostUsd`.

**There is no actual-spend ledger on `main`.** Nothing records what a run really cost, and
this document does not design one — that is separate work. Concretely, then:

- Before the marker, reserve `estimatedMicrousd` against the project ceiling. A
  `budget_exhausted` refusal prevents the spawn outright — the cheapest enforcement point.
- `--max-budget-usd` carries the same reserved amount, so the CLI enforces the ceiling
  in-process rather than Control Room discovering an overrun afterwards. Two independent
  ceilings agreeing is the desired posture.
- On the terminal `result` frame, `total_cost_usd` and `usage` are the metering source. With
  no spend ledger the only correct behaviour is: record them as run evidence, release the
  reservation, and **surface any reserved-vs-actual divergence rather than absorbing it**.
- `--max-budget-usd` has so far only been *accepted as a flag*, never observed to halt a
  run. That is admission checklist item (2), and it gates calling it enforcement.

## 7. What must be true before this becomes code

Concrete and unsoftened. Each item is a named file or a named decision.

1. **An owner decision on the credential path** — OAuth-on-host vs `ANTHROPIC_API_KEY`, and
   who owns Anthropic billing for fleet nodes (open question 3 in
   `docs/claude/CLAUDE_CODE_HARNESS_PLAN.md`). No authenticated run may happen before this.
2. **The four-point admission checklist in `docs/SHARED_CONNECTOR_CONTRACT.md`'s Claude Code
   section must be merged to `main` and satisfiable**: (1) a full authenticated turn
   including a real `tool_use`/`tool_result` pair; (2) `--max-budget-usd` actually halting a
   run at its ceiling; (3) a `--session-id`-pinned run resumed with identity intact; (4)
   `--resume` against an exited session failing cleanly and non-silently. It lives only on
   `claude/claude-code-admission-checklist` today.
3. **`docs/claude/CLAUDE_CODE_A0_VERIFICATION.md` and
   `docs/claude/CLAUDE_CODE_APPROVAL_AUTHORITY_DESIGN.md` must land on `main`** (branches
   `claude/claude-code-harness-a0`, `claude/claude-code-approval-authority-design`); this
   design cites both as load-bearing, and **`src/harness/claude-code-v1/connector-profile.ts`
   must be on `main`** (PR #72) before anything is built against it.
4. **`createPreEffectMarker` in `src/node-policy/v1/effect-claim.ts` must accept
   `harness.claude-code.cli.start` under the same payload-commitment requirement as
   `harness.hermes.native.start`**, with tests, before any spawner exists.
5. **A start-authority equivalent to `src/harness/hermes-native-v1/start-authority.ts` must
   exist for this path**, or an explicit owner decision that the existing one generalizes.
   No spawner may call `SqliteEffectClaimStore` directly.
6. **A workspace port modelled on `src/harness/codex-v1/workspace.ts` must exist**, with the
   same disjoint-root, canonical-identity and uncertain-create reconciliation properties.
7. **An owner ruling on isolation posture** — whether same-user-same-host with
   `--restricted` is acceptable for the first runs given §4's limits, and what prompt
   provenance is permitted under it.
8. **A `--permission-mode` decision recorded in the contract**, not left to a call site:
   `manual` or `plan`, with `bypassPermissions` / `dontAsk` / `auto` /
   `--dangerously-skip-permissions` refused by construction — ideally by a type that cannot
   express them.
9. **A named reviewer sign-off on this document.** It proposes the codebase's first real
   agent-process spawn; per the owner's rule that does not proceed on one agent's judgement.

Until every item is true, `submit`, `events`, `result` and `cancel` stay `unsupported` in
the connector profile, and `connectorOperationAdmissibleV1` keeps refusing them regardless
of evidence level.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
