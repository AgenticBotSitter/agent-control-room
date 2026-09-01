# CR12B Idea Lab and Project Lifecycle Contract

Status: effect-free repository implementation

Date: 2026-08-31

## Purpose

Idea Lab lets the owner give one business idea to a deliberately diverse panel, retain only bounded safe opinions,
derive one advisory synthesis, and explicitly decide whether the idea becomes a Control Room project. Every promoted
project receives the shared Project Workspace navigation and a durable lifecycle instead of becoming another hard-coded
page.

This block does not activate live Hermes Bot Mode. The presentation fixture is injected-only and says so. Live provider
contact belongs to a later authenticated coordinator that must satisfy the accepted Hermes compatibility and filtered
read boundaries.

## Panel contract

- A session has three to six participants and one to three rounds, with fixed message, time, and cost ceilings.
- Participant IDs, identity digests, and perspectives are unique. A skeptic is mandatory.
- Supported lenses are customer, market, skeptic, finance, operations, technology, growth, and risk.
- Each contribution is bound to the exact session digest, participant identity, perspective, and round.
- Safe summaries are retained; raw prompts, raw provider transcripts, credentials, locators, and private infrastructure
  facts are not accepted.
- Synthesis is allowed only after every participant contributed. The overall score and promote/save/reject
  recommendation are derived, not caller-selected.
- Synthesis is advisory. It cannot create a project, approve work, claim a job, dispatch an agent, or execute an effect.

## Owner promotion

An exact owner decision is required. `create_project` requires a complete project specification; `save` and `reject`
forbid one. The project, decision, and initial lifecycle event are inserted in one database transaction. A browser view,
agent recommendation, or successful score cannot stand in for the owner decision.

## Project lifecycle

The authoritative current projection remains in the existing `projects` table. Append-only authenticated lifecycle
events bind every state to the project snapshot and source decision:

```text
active -> paused -> active
active -> completed -> archived -> active
paused -> completed
```

Skipping states, stale versions, backwards time, changed replay, or project/event mismatch fails closed. Archived
projects are hidden from the default registry list but remain recoverable and auditable. Reopening creates a new event;
it never rewrites history.

## Persistence and authority

Migration `0028_cr12b_idea_lab_project_lifecycle.sql` adds append-only PostgreSQL tables for sessions, contributions,
syntheses, decisions, and lifecycle events. The store authenticates every retained artifact with an HMAC and verifies
the latest lifecycle event against the mutable project projection on read. PostgreSQL is the sole production write
authority. PGlite is used only to exercise the same migration and transaction semantics in local tests.

Every contract carries negative-authority facts. The repository implementation contacts no provider and grants no
approval, network, command, lease, dispatch, project-creation automation, or execution authority.

## Interface

`/ideas` presents the panel, individual lenses, derived synthesis, explicit owner promotion, and a link to the promoted
project. `/projects/{projectId}` uses the same nine standard tabs as existing projects and adds an Idea origin tab. The
development route is a deterministic fixture until a protected project registry read is configured; it contains no
mutation control and makes no protected-data claim.
