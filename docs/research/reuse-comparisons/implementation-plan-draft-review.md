# Independent review of the working implementation-plan draft

2026-09-08; requested baseaf6bcb4 plus root's uncommitted
`docs/REUSE_IMPLEMENTATION_PLAN.md`. Compared its complete draft with the outcome
map, comparison closure checklist and DR-01–DR-04. Source-only; no tests, network,
downloads, application changes or final acceptance.

## Actionable findings

### IP-D1 — B7 has no explicit build-batch home (P2)

The outcome ledger includes B7 team/workspace coordination, but the numbered
execution sequence lists B1–B4/B6/B9, B5 alongside, then C1–C4/B8. B7 is never
assigned to a batch. The following prose mentions parallel isolated-workspace
integration, but does not give it an accountable completion boundary. This makes
it possible to finish every numbered batch while leaving canonical workspace
ownership/review-routing unfinished.

Assign required B7 coordination/workspace acceptance to the productive-fleet batch
or a clearly named parallel packet with an integration dependency. Keep optional
terminal features distinct; no need to add a new workspace implementation or
preselect Maestro/AO before RC4 is decided.

### IP-D2 — A7 drops its explicit RC9 dependency (P2)

The closure checklist expressly requires A7 result/attention to include retained
artifact/native work **and readiness/operations**, not only presentation. Its RC9
row includes A7. The draft A7 decision column lists only RC2/RC3, with missing/late/
held/reviewable outcomes but no explicit RC9 connection. D2/D4 elsewhere do not
automatically establish that an operational outage/unknown readiness becomes an
actionable Needs Me state without granting completion authority.

Add RC9 to A7's dependency/accounting and connect its selected health/readiness
observation to the existing attention outcome acceptance. This is preservation of
an existing cross-family requirement, not permission to design a new health system.

### IP-D3 — first-task runtime prerequisites are implicit (P3)

Batch2 promises a real approved task/result/revision; batch3 says first qualify one
runtime/host and includes all B3/B4/B6/B9 work. A5 already implies runtime/profile/
transport, so this is an ambiguous handoff rather than a proven architectural
contradiction. A contributor could nevertheless read the sequence as postponing
the first supported runtime until after the first real result milestone.

Distinguish the minimum single-host/runtime installation, capability and reconnect
prerequisites needed by batch2 from fleet-wide/harness-wide expansion in batch3.
Keep both Hermes and Codex required for the final product, but do not imply all
host/runtime qualifications are necessary before the first usable task.

## Coverage and claims that are sound

- All26 original IDs appear exactly once in the ledger. No wholesale outcome is
  declared operational from a synthetic module or family-level test.
- DR-01 retains only fixed-panel selection, not all custom runtime infrastructure.
  DR-02 retains both maintained parsers without reopening the completed contest.
  DR-03 selects pnpm identity discovery, not text extraction. DR-04 correctly limits
  the CycloneDX gatherer to build-time original-text attachments plus named retained
  exceptions; full output/asset/license closure remains open.
- PostgreSQL sole write authority, PGlite local-only scope, chosen Access provider,
  exact approval/attempt relationships, ambiguity holds and versioned rollback are
  consistent with the compared records. No pending SDK/queue/anchor/UI winner is
  falsely presented as adopted.
- Required Idea Lab and ABS workflows remain in the completion contract; optional
  consumer/media/additional-harness modules receive accounting without being
  mislabeled working or silently made prerequisites for the first task.
- Full-source/change/deletion lists, cost/rubric, final prompt and final review are
  explicitly unfinished. The draft candidly is not build-ready; those acknowledged
  omissions are not reported here as surprising new findings.
- One writer, no dual real-task execution for shadow tests, authority-preserving
  rollback and substantive contributor packets are sound sequencing constraints.

## Before promoting the draft

Disposition the findings above, then fill each selected batch's exact files,
dependencies, acceptance commands, owner/live inputs, migration and rollback as the
remaining RC decisions close. Preserve the distinction between minimum first-task
prerequisites and later fleet expansion. A consolidated live-input/permission list
and a copy-ready goal remain required final-plan deliverables, not implied by this
draft review. Root retains architecture, security and final acceptance authority.
