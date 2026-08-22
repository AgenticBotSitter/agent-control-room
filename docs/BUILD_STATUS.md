# Control Room build status

**Updated:** 2026-08-22  
**Purpose:** Single human-readable handoff showing what finished and which Codex model/effort to select next.  
**Authority:** Detailed acceptance remains in `CR3_BUILD_PLAN.md`; this file is the current summary.

## Current position

| Milestone | Status | Evidence |
|---|---|---|
| CR-0 founding contract | Complete | Founding contract and versioned project-adapter contract |
| CR-1 responsive read-only prototype | Complete | Portfolio, project, and worker fixture surfaces |
| CR-2 persistence and simulator | Complete | PostgreSQL-compatible migrations, projection store, scheduler tests |
| Research gates | Complete for architecture | Research synthesis; live acceptance checks carried into implementation |
| CR-3 architecture package | Draft complete; owner acceptance pending | CR-3 index and decision package |
| CR-4 through CR-10 | Not started | Phased build plan |

## Active block

```text
Block: CR-3-R — Final owner review of architecture package
Recommended model: gpt-5.6-sol
Recommended reasoning effort: high
Completion signal: owner accepts the CR-3 direction or records requested changes
Authorized actions: documentation review/change only
Live integrations: not authorized
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block after CR-3 acceptance

```text
Block: CR-4A — Canonical domain contracts and state machines
Set model: gpt-5.6-sol
Set reasoning effort: xhigh
Why: these schemas and transition rules constrain every later database, node, adapter, UI, and security module
Expected output: versioned types/schemas, transition specifications, and contract tests
Stop before: PostgreSQL implementation in CR-4B
```

## Update rule

At the end of every completed or blocked build block:

1. update the phase table;
2. record delivered modules and validation evidence;
3. retain open risks and decision-log changes;
4. set exactly one active/next block;
5. name its exact model and reasoning effort;
6. state any owner input or external permission required;
7. do not advance when the completion gate failed.

The model recommendation is revalidated at each phase boundary because available Codex models may change during the build.
