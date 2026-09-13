# Claude Code harness — plan

Author: Claude (Opus 5). Date: 2026-09-12. Baseline: `bc0a61a` on `codex/idea-abs-workflows`.

This is a plan only. It authorizes no install, credential, provider call, deployment or
publication. It does not reopen any accepted Codex record.

## 1. What already exists

| Piece | State | Where |
|---|---|---|
| Harness adapter SDK v1 | Built, effect-free, conformance-tested | `src/harness/sdk-v1/`, `docs/CR7D_ADAPTER_SDK_CONTRACT.md` |
| Manifest schema | Built; already allows `steer` and `request_response` approval | `src/harness/v1/schemas.ts:17-21` |
| Codex adapter | Built (manifest, JSONL decoder, compatibility gate) | `src/harness/codex-v1/` |
| Codex execution seam | Factory takes an **injected spawner**; no real spawner supplied yet | `src/harness/codex-v1/isolated-child-factory.ts` |
| Hermes adapters | Built: observation + native-run HTTPS adapter | `src/harness/hermes-v1/`, `hermes-native-v1/` |
| Northbound MCP server | Built, proposal-only, no effect tools | `docs/CR7C_MCP_SECURITY_CONTRACT.md` |
| Claude Code research | Done 2026-08-22, not re-verified since | `docs/research/archive-2026-08-22/control-room_research_claude-code-agent-sdk-deep-dive.md` |
| **Claude Code adapter** | **Does not exist. No file, no manifest, no doc.** | — |

The gap is narrower than it looks. The SDK boundary, the event schema, the compatibility
gate pattern and the conformance harness are generic and already written. A Claude Code
harness is a fourth adapter on an existing boundary, not new architecture.

## 2. The two ways in, and which one to use

**MCP (northbound) — already built, wrong direction.** Today Control Room can expose an MCP
server that Claude Code connects *to*, letting Claude read bounded state and file proposals.
That is Claude looking in at the control room. It grants no authority — proposal receipts
always say `grantsAuthority: false`. Useful, cheap, and it does not make Claude a worker.

**Harness adapter (southbound) — the one that matters.** Control Room starts a Claude Code
process, watches it, meters it, and takes its artifact. That is Claude as a control-room
agent node, the same shape Codex and Hermes have. This plan is mostly about this direction.

Do both, in that order of certainty and reverse order of effort: the adapter is the real
work; the MCP server is a later, smaller add-on for read-back.

## 3. What a Claude Code adapter looks like

Proposed `src/harness/claude-code-v1/`, mirroring `codex-v1/`:

```
manifest.ts        pinned version, cdhash, executable path
decoder.ts         stream-json JSONL -> canonical harness events
compatibility.ts   evidence -> { compatible, reasons }
adapter.ts         the four public SDK members, nothing else
```

Draft manifest, using values the existing schema already permits:

| Field | Codex today | Claude Code proposed | Why it differs |
|---|---|---|---|
| `supportedVerbs` | discover, start, stream, cancel, resume, usage | **+ steer** | SDK `query.send()` supports mid-run steering; the CLI alone does not |
| `approvalMode` | `unsupported` | **`request_response`** | `canUseTool` / permission-prompt-tool is a real approval callback |
| `isolation` | `worktree` | `worktree` | same Git detached-worktree manager (DR-08) |
| `credentialResolution` | `harness_native` | `harness_native` | `~/.claude/` OAuth or `ANTHROPIC_API_KEY`; Control Room holds a reference, never the secret |
| `outputForms` | all four | all four | `stream-json` carries usage per message and a final result event |
| `license` | Apache-2.0 | **proprietary (Anthropic commercial terms)** | affects redistribution, not invocation |
| `distribution` | `invocation_only` | `invocation_only` | we may invoke; we may not ship their code |

Two of those rows are the whole point. **Claude Code is the first harness that can ask
permission and can be steered mid-run.** Codex cannot. Every approval/pause feature in the
Completion Gate that currently has no harness able to exercise it gets a real counterpart.

## 4. CLI or SDK

Research verdict was **wrap the CLI**: `claude -p --output-format stream-json`, subprocess,
metered off the result event, gated by permission rules, resumed via `--resume`.

That verdict still holds for start/stream/cancel/resume/usage, and it is the same subprocess
shape the Codex seam is being built for — one spawner pattern, two harnesses.

It does **not** hold for `steer` and `request_response`. Those need in-process control
(`query.interrupt()`, `query.send()`, `canUseTool`). So:

- **Phase A** wraps the CLI and declares neither `steer` nor `request_response`.
- **Phase B** adds a thin Agent SDK host process, and only then widens the manifest.

Do not declare a verb in Phase A that Phase B implements. Declaring a verb never grants
permission to invoke it, but a manifest that overstates the runtime is a lie the conformance
run cannot catch.

## 5. Sequencing

Each stage exits before the next begins. Nothing here runs a process until Stage C.

| Stage | Work | Depends on | Model / effort |
|---|---|---|---|
| **A0** | Re-verify the Aug-22 research: install `@anthropic-ai/claude-code`, confirm current version, exact flags, exit-code table, stream-json event shapes, transcript path. Record fixtures. The dossier's own caveat is that the binary was never on PATH. | — | Sonnet 5 / medium |
| **A1** | Write `claude-code-v1/manifest.ts` + `compatibility.ts` against the captured evidence. Pin version and macOS cdhash the way Codex does. | A0 | Sonnet 5 / medium |
| **A2** | Write `decoder.ts`: stream-json JSONL → canonical harness events, plus native-session digest and final-text digest. Effect-free, fixture-driven. | A1 | Sonnet 5 / medium |
| **A3** | Write `adapter.ts` (four members) and run the existing SDK conformance suite. Acceptance doc in the house style. | A2 | Sonnet 5 / medium |
| **B** | **Decision point, not code.** Does Claude Code's approval callback map onto Control Room's Completion Gate, or does it compete with it? Two approval authorities in one run is a security boundary question, not an integration detail. Write the boundary before writing the port. | A3, Stage 2 of `BUILD_PLAN.md` | **Opus 5 / high** |
| **C** | Real subprocess execution — supply a real spawner, worktree, sandbox, ceilings, effect-claim marker. Reuses whatever Stage 2 built for Codex. | B, Stage 2 done for real | **Opus 5 / high** |
| **D** | Optional Agent SDK host for `steer` + `request_response`; widen the manifest only after C proves the plain path. | C | Opus 5 / high |
| **E** | Northbound MCP: expose the existing proposal-only server to Claude Code so it can read Control Room state and file proposals. Independent of A–D. | — | Sonnet 5 / medium |

Stage A is genuinely parallel with Codex Stage 2 — it touches no shared file and performs no
effect. Stage C is not: it is gated on the Codex execution line landing first, because the
spawner, worktree manager and effect-claim ledger are shared and Codex is proving them.

## 5a. Owner ruling: who holds authority (resolved 2026-09-12)

The owner has ruled: **the owner holds all authority, exercised exclusively through the
Control Room interface.** The owner starts projects, monitors them, closes them, and
orchestrates the fleet from Control Room — not by talking to Claude Code, Codex, or Hermes
directly in their own chat surfaces. That resolves Stage B's open question below: if Claude
Code's `canUseTool` callback and Control Room's Completion Gate ever appear to disagree,
**Control Room is canonical, full stop** — the `canUseTool` callback is a transport for a
Control Room decision, never an independent approval source. This must be encoded as a hard
rule in the Stage B design, not left as a runtime race: the harness adapter's approval path
should refuse to grant on a local callback answer alone and must wait on the Control Room
decision it is a transport for.

## 6. Open questions — owner or Codex decisions, not mine

1. ~~**Approval authority (Stage B).**~~ **Resolved above (§5a):** Control Room is the sole
   authority; the callback is a transport, never an independent approver.
2. **Licensing posture.** Codex is Apache-2.0; Claude Code is proprietary. `distribution:
   invocation_only` covers us for invocation, but the public package trust contract
   (`CR10B_PUB_000`) should say explicitly that a proprietary harness may be *targeted* and
   never *bundled*. Needs a line added, by whoever owns that contract.
3. **Credential path.** OAuth subscription vs `ANTHROPIC_API_KEY`. The API key gives
   per-node cost accounting the cost-ledger can actually use; OAuth does not meter cleanly.
   Recommendation: API key for fleet nodes. Owner's call on billing.
4. **Who writes it.** Codex owns the harness contracts and is mid-flight on the Codex seam.
   Stage A could be handed to me without colliding with that. Stages C and D must not start
   until Codex's execution line lands.

## 7. What this plan deliberately does not do

No install, no credential, no `--dangerously-skip-permissions` anywhere at any stage, no
process start before Stage C, no manifest verb that the runtime cannot honor, and no
reopening of the Codex adapter contract. The Claude Code adapter is additive.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
