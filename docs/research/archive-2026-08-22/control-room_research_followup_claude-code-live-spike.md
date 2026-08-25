# Claude Code / Agent SDK Reconciliation + Live Spike — Gate 1

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Gate evidence for:** Gate 1 in `docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md`
**Provenance:** compiled by orchestrator after subagent reasoning-loop failure; all registry/repo data pulled live this session; live CLI spike executed this session.

---

## TL;DR

The license picture reconciles cleanly once components are separated: **the SDKs are open (MIT), the CLI application is proprietary.** `anthropics/claude-agent-sdk-python` is a public GitHub repo (7,953★) shipping PyPI package `claude-agent-sdk` v0.2.144 under **MIT**; the TypeScript `@anthropic-ai/claude-agent-sdk` v0.3.240 and the CLI `@anthropic-ai/claude-code` v2.1.240 are npm packages marked "SEE LICENSE IN README.md" (the repo's root LICENSE.md remains "© Anthropic PBC, all rights reserved" for the CLI app itself). Live spike: CLI runs headlessly and emits clean stream-json init/result events **but every API turn fails with "Not logged in · Please run /login"** — no usable credentials exist on this Mac, and per house rules I did not create accounts or spend money. Live-spike legs are therefore BLOCKED-on-auth with exact commands preserved; seam recommendation below is based on verified schemas from the partial runs + docs, flagged accordingly.

## Component reconciliation table (all pulled 2026-08-22)

| Component | Registry | Exact version | License declared | Verified from |
|---|---|---|---|---|
| claude-code CLI app | npm @anthropic-ai/claude-code | 2.1.240 | SEE LICENSE IN README.md → Commercial ToS (repo root LICENSE.md: © Anthropic PBC, fetched earlier today) | npm registry + GitHub raw LICENSE.md |
| Agent SDK TypeScript | npm @anthropic-ai/claude-agent-sdk | 0.3.240 | SEE LICENSE IN README.md | npm registry |
| Agent SDK Python | PyPI `claude-agent-sdk` (NOT "claude-agent-sdk-python" — that name 404s on PyPI) | 0.2.144 | **MIT** | PyPI JSON + github.com/anthropics/claude-agent-sdk-python (MIT spdx, pushed 2026-08-22) |
| Bundled runtime note | Both SDKs wrap/drive the same claude-code engine binary; they do not vendor a separate runtime | — | inherits CLI terms for the binary portion | docs [documented-not-tested] |
| openai/codex CLI (contrast) | npm @openai/codex | 0.149.0 | Apache-2.0 (registry + repo agree) | npm registry |

**Reconciliation verdict:** prior dossier's "proprietary, all rights reserved" applies to the **CLI/application repo root**; the **Python SDK being public+MIT does not contradict it** because the SDK is a separate artifact with its own license. What you may redistribute freely: the MIT Python SDK bindings. What stays under Anthropic commercial terms: the CLI/engine both SDKs drive.

## Live spike results (this Mac, npx @anthropic-ai/claude-code@2.1.240)

| Leg | Expected | Actual | Status |
|---|---|---|---|
| Headless start `-p` json format | result event | `{"is_error":true,...,"result":"Not logged in · Please run /login","terminal_reason":"api_error"}` — schema fully captured | ⚠️ RAN, auth-blocked |
| stream-json init event | system/init with session_id + model + permissionMode | ✅ observed: `session_id f2836d47…`, model `claude-opus-5[1m]`, permissionMode plan — even before auth succeeds | ✅ CAPTURED |
| stream-json requires --verbose under -p | documented | confirmed by explicit CLI error when omitted | ✅ VERIFIED |
| resume/cancel/hooks/subagents/usage/worktree legs | — | BLOCKED on login (no spend rule) | 🚫 BLOCKED |

Sanitized command shapes proven working:
```bash
npx -y @anthropic-ai/claude-code@2.1.240 -p "<task>" --permission-mode plan --output-format stream-json --verbose
# result event fields available even on error: session_id, total_cost_usd, usage{input_tokens,output_tokens,
#   cache_read_input_tokens, cache_creation_input_tokens}, modelUsage{}, permission_denials[], subagent_stats{...}
```

**Unblock path (owner action):** run `/login` once interactively (existing subscription OAuth) or set ANTHROPIC_API_KEY env — then rerun the six blocked legs (commands already scripted in prior dossier §J).

## Seam recommendation

**CLI-primary** (`claude -p --output-format stream-json --verbose` subprocess pattern) with the **Python MIT SDK as fallback/secondary**:

1. CLI works identically for TS-SDK users and script drivers; one integration surface; stream-json gives session ids, usage, permission denials, and subagent stats in-band.
2. Python SDK (MIT) is preferable where licensing purity matters (it can be vendored), but it still drives the same engine binary — so the proprietary boundary exists either way.
3. TS SDK adds nothing over CLI for our Hermes-side orchestration and pins us to Node hosting of the driver.

Verdict: **Wrap (CLI seam)** — unchanged from prior dossier but now grounded in live-captured schemas. Risk + trigger: if Anthropic changes stream-json shape between minor versions → pin exact version (2.1.240 tested) and re-run spike; if login-less automation gets restricted further in ToS → switch heavy jobs to API-key auth or another node.

## Report-format compliance
Official sources: registry.npmjs.org, pypi.org/pypi/claude-agent-sdk/json, api.github.com repos (anthropics/claude-agent-sdk-python, anthropics/claude-code), raw LICENSE.md — all this session. Versions pinned above. Tested-vs-documented labeled per row. Commands sanitized (no tokens exist to leak — that's the finding). Expected-vs-actual per leg. License/distribution effect: MIT only for python SDK bindings; CLI redistribution prohibited. A/W/B/B/D: Wrap. Risks+triggers listed.
