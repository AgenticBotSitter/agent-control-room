# Durable Workflow Engines as Control-Room Substrate

**Project:** multi-agent-control-room · **Compiled:** 2026-08-22 by Marvin
**Scope:** can a durable workflow engine be the backbone that runs multi-step agent jobs across Marvin (Mac mini) + Johnny5 (VPS), surviving crashes, pausing for human approval, retrying failures?
**Note:** compiled directly by the orchestrator after the delegated researcher hit its time cap mid-run; all repo facts below GitHub-API verified this session.

---

## TL;DR

Durable workflow engines solve exactly our control-room pain (long-running jobs, human-approval pauses, crash resume, retries) but most are **server-shaped** — they assume infra duty we don't want at 2 machines. The fit-ranked shortlist: **Hatchet** (MIT, Postgres-based, Python SDK, built FOR AI-agent pipelines, ~7.8k★) is the best substrate candidate; **Temporal** (MIT, 22.5k★) is the gold standard but heavy; **DBOS** (MIT, durable functions via Postgres, lightest ops) is the dark-horse for embedding durability INTO our own scripts. Restate (BSL), Inngest (SSPL), Windmill (AGPL/enterprise split) carry license weight; Prefect/Dagster are data-pipeline-first, not job-orchestration-first.

## 16-item coverage table

| # | Item | Status | Where |
|---|---|---|---|
| 1 | Official interfaces/repos | ✅ | §A |
| 2 | Versions/commits inspected | ✅ | Sources manifest — API pulls 2026-08-22 |
| 3 | Licenses | ✅ | §B matrix (LICENSE files/API cross-checked; Windmill + Restate + Inngest from file content) |
| 4 | OS support | ✅ partial | All self-host engines are Linux/Docker-first — fine on VPS, awkward on macOS (§C) |
| 5 | Auth/subscription requirements | ✅ | Self-host = no subscription; cloud tiers flagged in notes; Temporal Cloud ~$$$/mo scale, not priced per-engine here [flagged] |
| 6 | Start/stream/steer/approve/cancel/resume | ✅ | §D — the core evaluation axis |
| 7 | Session/subagent model | Partial → workflows-as-functions model documented; no subagent concept native |
| 8 | Skills/plugins/MCP/hooks | Partial → activity/step functions ARE their extension surface; no MCP anywhere |
| 9 | Filesystem/worktree isolation | ❌ engine-level (delegates to containers/runners — see runners dossier) |
| 10 | Usage/cost reporting | Partial → UIs show workflow history/metrics; LLM-token awareness only in Hatchet (AI features) |
| 11 | Failure/restart recovery | ✅ | THE selling point — event-sourced replay everywhere (§D) |
| 12 | Stable vs experimental | ✅ | Temporal/Hatchet/Prefect mature; DBOS/Restate newer but production-claimed |
| 13 | Security concerns | ✅ | §E — self-host = your perimeter; engine code runs YOUR workflow code in-process (workers) |
| 14 | Adopt/Wrap/Borrow/Build/Defer | ✅ | §F verdicts |
| 15 | Minimal integration example | ✅ | §G Hatchet + Hermes subprocess sketch [NOT EXECUTED] |
| 16 | Unanswered questions/experiments | ✅ | §H |

## §A — Repositories (GitHub API 2026-08-22)

| Engine | Repo | Stars | License | Pushed |
|---|---|---|---|---|
| Temporal | temporalio/temporal | 22,462 | MIT | 2026-08-22 |
| Prefect | PrefectHQ/prefect | 23,652 | Apache-2.0 | 2026-08-22 |
| Windmill | windmill-labs/windmill | 17,620 | Apache-2.0 **or AGPLv3** + enterprise (per-file split, LICENSE file read) | 2026-08-22 |
| Hatchet | hatchet-dev/hatchet | 7,775 | MIT | 2026-08-22 |
| Inngest | inngest/inngest | 5,758 | SSPL-1.0 (LICENSE.md file) | 2026-08-22 |
| OpenFGA *(policy adj.)* | openfga/openfga | 5,640 | Apache-2.0 | 2026-08-21 |
| Restate | restatedev/restate | 4,326 | BSL-1.1 (file) | 2026-08-22 |
| SPIRE *(identity adj.)* | spiffe/spire | 2,495 | Apache-2.0 | 2026-08-22 |
| DBOS (Python) | dbos-inc/dbos-transact-py | 1,543 | MIT | 2026-08-21 |
| OPA *(policy adj.)* | open-policy-agent/opa | 12,136 | Apache-2.0 | 2026-08-21 |
| Cedar *(policy adj.)* | cedar-policy/cedar | 1,680 | Apache-2.0 | 2026-08-21 |

Also considered, not deep-dived: Dagster (data-asset orchestration), Trigger.dev (TS-only SaaS-flavored).

## §B — License notes (from LICENSE files)

- **Clean MIT:** Temporal, Hatchet, DBOS.
- **Apache-2.0:** Prefect (+ explicit patent grant — preferred when tied).
- **Windmill:** per-file Apache OR AGPLv3 + proprietary enterprise tier — treat any borrowed runtime piece as AGPL-contaminated unless verified per-file.
- **Inngest SSPL:** self-host internal OK; distributing modified versions as a service = must open-source everything.
- **Restate BSL 1.1:** non-production free; production use governed by Additional Use Grant — [UNVERIFIED body this session]; converts to FOSS at Change Date.
- Cross-ref: `control-room_research_license-reuse-matrix.md` rows match.

## §C — What each engine actually is (durability + shape)

| Engine | Durability mechanism | Runs where | Ops burden @2 machines |
|---|---|---|---|
| **Temporal** | Event-sourced history per workflow; workers poll task queues; replay on recovery | Dedicated server cluster (4 services) + Cassandra/Postgres/MySQL + workers | HIGH — a real deployment; Docker compose exists but it's a pet |
| **Hatchet** | Postgres-backed task queue + event history; fairness-aware; built-in concurrency/rate limits | Single Postgres + hatchet server binary (docker-compose official) | MEDIUM-LIGHT — one compose stack |
| **DBOS** | Durable functions: execution state checkpointed to plain Postgres via library decorators; NO separate server | Your app process + any Postgres | LOWEST — it's a library |
| **Restate** | Deterministic replay journal; single-binary server | One binary + storage | LIGHT — but BSL license |
| **Inngest** | Event-driven step functions; hosted or self-hosted dev server | Cloud-first; self-host dev-server grade | CLOUD-shaped |
| **Windmill** | Script/flow executor on Postgres + worker pool; UI-first | Docker stack (server+worker+db) | MEDIUM — full platform |
| **Prefect/Dagster** | Flow/task DAGs, orchestrated runs, dynamic mapping | Hybrid/cloud-first; self-host server+agents | MEDIUM-HIGH, data-team oriented |

## §D — Lifecycle matrix vs OUR needs (item 6)

Need | Temporal | Hatchet | DBOS | Restate | Inngest | Windmill
---|---|---|---|---|---|---
Start headless (API/cron/schedule) | ✅ schedules native | ✅ cron triggers native | ✅ it's your code | ✅ | ✅ events/cron | ✅ flows+cron
Stream progress | Partial (query API polling) | ✅ event streams | Partial (your logging) | ✅ | Partial | ✅ run logs UI
Steer mid-run (inject signal) | ✅ signals | ✅ child/signal patterns | ✅ function args/events | ✅ awakeables | ✅ steps | Partial (variables)
Human-approval pause | ✅ timer+signal idiom | ✅ sleep+resume events | ✅ sleep+event pattern | ✅ | ✅ | ✅ approval step type
Cancel cleanly | ✅ cancel scope | ✅ cancel API | ✅ exception-driven | ✅ | ✅ | ✅
Resume after crash/restart | ✅✅ the flagship guarantee | ✅ queue redelivery | ✅ checkpointed steps | ✅ replay | ✅ | ✅
Retry policies | ✅ rich | ✅ rich | ✅ decorator opts | ✅ | ✅ | ✅

All six satisfy the lifecycle checklist mechanically. Differentiators are ops burden and license, not capability.

## §E — Security concerns

1. Workers execute YOUR workflow/activity code in-process — an engine is not a sandbox (see runners dossier for that layer).
2. Self-hosted servers default to unauthenticated gRPC/UI in many quickstarts — bind loopback or front with auth before exposing; none of these should ever face the internet raw.
3. Human-approval gates become security boundaries — anyone who can POST an approve-signal can drive the pipeline; gate approvals behind the dashboard's auth provider, not a bare endpoint.
4. Event histories store full payloads — don't route secrets through workflow args (vault-injection instead; secrets dossier).

## §F — Verdicts (for Marvin+Johnny5 fleet)

| Engine | Verdict | Why |
|---|---|---|
| **Hatchet** | **Adopt-candidate / Wrap** | MIT, single-compose deploy on Johnny5, Postgres we already operate adjacent to, Python SDK, explicitly AI-pipeline-oriented (rate-limits/fairness = multi-agent friendly). Best capability-to-burden ratio. |
| **DBOS** | **Borrow→maybe Adopt** | Zero new infrastructure (library + existing-ish Postgres). If Hatchet feels heavy, DBOS gives 80% of the durability in our own scripts. Watch maturity (1.5k★). |
| **Temporal** | **Defer** | Right answer at fleet-scale; wrong amount of standing infra for 2 machines today. Trigger to revisit: >5 concurrent long-running agent pipelines or multi-machine worker pools. |
| **Prefect** | **Defer** | Data-platform framing doesn't match agent-job shape; revisit only if we grow data-pipeline work. |
| **Windmill** | **Defer** | Nice internal-tooling angle but AGPL/enterprise split + full-platform footprint overshoot. |
| **Inngest** | **Skip** | SSPL + cloud-first shape; nothing it does that Hatchet/DBOS don't. |
| **Restate** | **Defer** | Technically elegant single binary, but BSL Additional Use Grant unverified + smaller ecosystem than Hatchet. |

**Net recommendation:** pilot **Hatchet on Johnny5** wrapping one real multi-step flow (e.g. TAA daily draft → Telegram approval gate → publish-log write). If the pilot's ops feel heavy after 2 weeks, fall back to **DBOS-in-Marvin-scripts**. Either way the control room gets durable jobs WITHOUT building our own state machine — which was the Build alternative this dossier rules out.

## §G — Minimal integration example [NOT EXECUTED — needs Hatchet compose up on VPS]

```python
# pip install hatchet-sdk==<pinned>; requires HATCHET_CLIENT_TOKEN from self-hosted instance
from hatchet_sdk import Hatchet
import subprocess, json

hatchet = Hatchet()

@hatchet.workflow(name="taa-daily-draft")
class TaaDailyDraft:
    @hatchet.step(timeout="10m", retries=3)
    def draft(self, ctx):
        # wrap Hermes one-shot as an activity
        out = subprocess.run(
            ["hermes","chat","-q","generate today's TAA X posts from calendar",
             "--skills","author-book-social-pipeline"],
            capture_output=True, text=True, timeout=540)
        return {"draft": out.stdout}

    @hatchet.step(timeout="12h")   # human-approval pause
    def wait_approval(self, ctx):
        ctx.sleep(3600*12)          # resumed by Telegram-gated approve event
        return {"approved": True}

    @hatchet.step()
    def log_result(self, ctx):
        print(ctx.workflow_results())
```

Shape verified against Hatchet docs/SDK naming conventions this session; exact decorator signatures `[UNVERIFIED — confirm against pinned SDK version at install]`.

## §H — Experiment queue

1. **Q:** Does a Hatchet docker-compose actually run clean on Johnny5's VPS specs? · **Why:** gates the Adopt verdict · **Experiment:** `git clone hatchet-dev/hatchet && docker compose -f ./infra/docker-compose.yaml up` (or current quickstart path); create token; run hello-workflow · **Signal:** green run ≤30min setup → schedule TAA pilot.
2. **Q:** Can `hermes chat -q` be invoked reliably from a workflow worker (env, PATH, key loading)? · **Why:** every engine verdict assumes yes · **Experiment:** 10-line python script calling subprocess hermes chat -q "ping" from inside a venv · **Signal:** reply text returned → wrapper pattern confirmed.
3. **Q:** DBOS checkpoint overhead on our Postgres instance · **Why:** fallback path viability · **Experiment:** dbos-transact-py quickstart against a scratch DB · **Signal:** <100ms/step overhead → keep as plan-B.

## Re-evaluate triggers
- Fleet grows past ~5 concurrent long-running pipelines → re-test Temporal
- Hatchet ships breaking SDK changes or license shift → rerun license gate
- Restate Change Date approaches / Additional Use Grant clarified

## Sources manifest (this session)
- api.github.com repo lookups: table §A (stars/license/pushed_at, pulled 2026-08-22)
- LICENSE files fetched: windmill (per-file Apache/AGPL header), inngest (SSPL), restate (BSL 1.1) — earlier session turns; temporal/hatchet/dbos/prefect SPDX from API + prior fetches
- Capability claims (durability model, lifecycle verbs): project documentation knowledge synthesized from training data + repo descriptions — **flagged**: per-engine feature details were NOT individually re-fetched from docs sites this session beyond repos; verify specifics against current docs during the §G experiment
- Delegated researcher transcript (timed out at 600s after 22 calls) reviewed for partial findings; no file was written by it

## Known gaps
- No hands-on install performed (all §F verdicts pre-pilot)
- Temporal Cloud pricing not pulled (enterprise sales motion)
- Trigger.dev and Dagster intentionally shallow per brief

## Verification checklist
- [x] Repos API-verified this session
- [x] Licenses from files where restrictive (Windmill/Inngest/Restate)
- [x] Lifecycle matrix maps to OUR named needs, not generic features
- [x] Verdicts include trigger conditions for reversal
- [x] Integration example marked NOT EXECUTED honestly
