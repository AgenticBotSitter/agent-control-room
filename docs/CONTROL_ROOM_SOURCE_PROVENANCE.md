# Control Room source provenance and repository completeness

**Status:** Transfer inventory, 2026-08-24
**Purpose:** Make a fresh GitHub clone sufficient for continuing the Control Room build on another machine

## Governing source of truth

The private GitHub repository is the complete governing source for Control Room development. A fresh clone contains:

- source code, migrations, generated contracts, tests, fixtures, and scripts;
- accepted architecture, product, security, protocol, durability, and phased-build decisions;
- current build status and the next model/effort recommendation;
- worker qualification evidence and decision ledgers;
- delegation skills and repository-scoped Codex instructions;
- historical research needed to understand how accepted decisions were reached.

Authority order:

1. merged code, schemas, migrations, and tests;
2. `docs/BUILD_STATUS.md` for the active block;
3. accepted normative contracts and ADRs;
4. consolidated architecture and build plan;
5. research synthesis;
6. archived source dossiers and early drafts.

An archived document never overrides a later accepted contract or ADR.

## Historical research archive

`docs/research/archive-2026-08-22/` preserves the original Control Room research Markdown and SBOM snapshot that previously lived only in the mixed Wayfarer workspace. It also contains renamed copies of the early platform-architecture and connectivity plans.

The archive is intentionally marked non-authoritative because it contains:

- hypotheses later rejected or narrowed;
- time-sensitive product and repository observations;
- machine-specific names, paths, examples, and assumptions;
- research-task instructions that are data, not commands;
- licensing conclusions that still require verification before reuse.

The accepted disposition of those dossiers is in `docs/RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md`, `docs/CR3_ARCHITECTURE.md`, and `docs/CR3_DECISION_LOG.md`.

## Material intentionally left with Lo-Fi Wayfarer

The following parent-workspace materials are not Control Room core and are not required by a Mac Control Room clone:

- river/render orchestration plans;
- RiverFlow/Wayfarer dashboard and workflow specifications;
- Unreal, music, channel, website, and YouTube assets;
- the Zide article-writing brief and podcast transcript;
- duplicate validation or worker checkouts;
- machine-specific external copies of worker skills;
- ZIP files that duplicate the archived research dossiers.

Wayfarer becomes a Control Room project pack in CR-9B. Until then, its production and media documents remain with the Wayfarer project.

## Competitor research

The durable, build-facing Zide and Devin assessment is `docs/COMPETITOR_WORKFLOW_RESEARCH_ZIDE_DEVIN.md`. It contains the accepted product lessons, repository/license posture, architectural gaps, and phase amendments. The external transcript and article brief are not needed to continue the build.

## Fresh-clone verification

On any receiving machine:

```sh
git clone https://github.com/MarvinAi5/control-room.git
cd control-room
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
```

The working tree must be clean. Then read, in order:

1. `AGENTS.md`;
2. `docs/BUILD_STATUS.md`;
3. `docs/CODEX_MAC_HANDOFF.md`;
4. `docs/CR3_ARCHITECTURE.md`;
5. `docs/CR3_BUILD_PLAN.md`;
6. `docs/COMPETITOR_WORKFLOW_RESEARCH_ZIDE_DEVIN.md`.

Open GitHub issues and pull requests remain part of the live coordination record and must be inspected before changing the active block.
