# Idea Lab canonical lifecycle decision

**Status:** accepted source decision, September 20, 2026.

## The decision in plain English

Idea Lab is a way to ask several agents for different perspectives. It is not
a separate agent system. Each participant response will become a normal
Control Room task, delivered to one chosen eligible worker and returned through
the usual result, review, and correction process.

This keeps one source of truth for work. It also means a local Hermes Agent,
Codex, Claude Code, or a later remote worker can take part without Idea Lab
needing its own runner, queue, retry system, or database.

## What changes

1. A discussion belongs to an ordinary Control Room project. A standalone
   discussion may create a normal, clearly labelled Idea Lab workspace project.
   That workspace is distinct from a later implementation project created by
   an owner decision.
2. Every participant in every round is one canonical task. Its immutable
   provenance includes the discussion, participant, round, and frozen input
   digest. A single umbrella task must not secretly run several workers.
3. The current coordinator becomes a planner and progress projector. It may
   create dependency-ready tasks idempotently and show their saved state. It
   may not directly contact a provider, own a competing attempt record, grant
   a lease, decide retries, or mark work complete.
4. A later round receives only a frozen, scoped snapshot of earlier saved
   contributions. Those contributions are discussion material, not approval
   or execution authority.
5. Contributions and synthesis are saved as canonical result/evidence records.
   Idea cards are views of that evidence, not a second completion ledger.
6. Owner follow-up and correction use the existing review and revision path.
   Promotion remains a separate owner action. It references the reviewed
   synthesis, creates an ordinary project and proposed first task, and starts
   no work by itself.

## What stays deliberately separate

The existing direct fake discussion driver is retained only as a legacy test
fixture while the canonical path is built. It is not a production delivery
route. Existing completed Idea Lab records remain readable as legacy evidence;
they are not rewritten or presented as canonical worker executions. An
unfinished legacy discussion requires a new linked canonical run and never
silently replays a prior provider call.

The filtered Hermes panel behavior may remain as an adapter-level result parser
and eligibility check. It cannot bypass the shared signed delivery packet,
worker policy, result receipt, or review process.

## Why this is the right reuse decision

News/research and schedules already create ordinary proposed Control Room
tasks. The existing Control Room task, delivery, result, review, correction,
PostgreSQL, and pg-boss services solve the authority and recovery problem.
No reviewed external project replaces that product-specific glue without
adding another queue, credential path, session store, or worker authority.
The narrow new code is therefore integration code, not a replacement agent
framework.

## Proof required before the new path is called complete

- Three participants over two rounds create six distinct canonical tasks,
  assignments, deliveries, results, and review targets.
- Duplicate start, redelivery, and restart create no duplicate task,
  contribution, delivery start, or completion.
- A changed discussion, participant, project, worker, prompt snapshot, or
  acceptance profile is refused before worker contact.
- Cancellation, revocation, partial failure, stale review, and a missing
  participant remain visible and cannot produce a false complete synthesis.
- Round limits and the aggregate time, message, and cost budget are reserved
  atomically through the existing authority database and queue.
- A correction uses ordinary revision lineage; a promotion is idempotent and
  starts zero workers.
- Local and remote test routes produce the same lifecycle and provenance
  shape. Application composition proves production Idea Lab has no direct
  provider-driver entry point.

## Build sequence

First define the canonical participant-round task plan and its input/result
mapping. Then connect that plan to the existing task proposal, assignment, and
review services. Finally retire the direct production start composition while
leaving a clearly isolated fake fixture for old tests. No live provider,
database provisioning, worker activation, or credential access is part of this
source decision.
