# Component direction handoff

2026-09-08. Current owner goal: finish the remaining component decisions efficiently.
All six previously open areas now have an independently challenged, root-selected
implementation direction. There are 17 DR entries total. Several are conditional;
no claim that exhaustive candidate evaluation, implementation or deployment is done.

| Previously open area | Choice | Decision and supporting detail |
| --- | --- | --- |
| Session observation | Optional operator-managed Herdr | DR-12; remaining-decision-closeout.md |
| Work engine | Retain pg-boss | DR-13; f1-engine-direction.md |
| Monitoring | Kuma; optional, initially disabled Beszel | DR-14; f8-monitoring-direction.md |
| Integrity checkpoint | Retain etcd adapter | DR-15; f5-checkpoint-direction.md |
| Owner signing | Dedicated owner-controlled agent, ssh2 protocol | DR-16; f5-signing-direction.md |
| Native clients/files | Hermes APIs; Codex App Server/bounded TS; separate attachment admission | DR-17; f2-native-direction.md |

## Completion audit for decisions, not qualification

Each entry names the selected responsibility, meaningful alternatives, evidence
and limitations, integration boundary, unresolved acceptance tests and reopening
conditions. Independent compare_ui challenges were received and dispositioned by
root in the register. Material findings retained: executable pin binding; optional
Beszel; etcd deletion versus independent custody; signer-owned cancellation; and
Codex read-only reconciliation distinct from resume/new turn.

Actual new shared queue experiments observed both libraries crossing canonical
review on native PostgreSQL, freeing queue capacity while owner review remains
pending, and reading exact saved results from a new read-only process. Neither is
claimed a recovery/performance winner. Failed setup attempts and scope limitations
are retained. Other directions reuse existing evidence instead of repeated runs.

Decisions do not authorize installs, credential access, native runs or deployment.
Full worker crash/uncertainty, Hatchet and OpenBao comparative gaps, custody/platform,
monitoring daemon and connector recovery tests remain open exactly where recorded.
The older all-outcomes comparison goal is not completed by this handoff.

## Next implementation order

1. Finish sanitized-source release checks and final publication review; the public
   candidate's component roadmap is updated locally, not yet pushed in this block.
2. First useful task: selected database/queue integration and exact native recovery,
   result/review flow; fail any missing required safety acceptance.
3. Owner-signing and independent-checkpoint qualification before enabling effects
   that depend on them. Preserve owner/host operation gates.
4. Productive multi-agent pickup and Idea Lab/news attachment workflows with the
   already selected libraries; avoid duplicate transport and queue frameworks.
5. Optional observations/metrics, protected health, backup/restore and deployment
   acceptance. No healthy dashboard status substitutes for task evidence.

All current artifacts remain local. The previously published roadmap must not be
described as containing these latest directions until a verified GitHub update.
