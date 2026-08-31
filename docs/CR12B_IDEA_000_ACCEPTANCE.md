# CR12B-IDEA-000/010/020 Acceptance Record

Status: complete locally for the effect-free contract, durable registry, and presentation snapshot

Date: 2026-08-31

## Result

Control Room now has a real Idea Lab foundation rather than a hard-coded mockup alone. A bounded multi-agent panel can
be represented safely, its advice is synthesized deterministically, and only an explicit owner decision can promote the
idea. Promotion creates a durable project with the same monitoring tabs as every other project. Projects can be paused,
resumed, completed, archived, and reopened without deleting history.

## Accepted evidence

- strict exact schemas for sessions, participants, contributions, synthesis, owner decisions, project creation, lifecycle
  events, and project projections;
- three-to-six-member diversity, unique identity/perspective checks, mandatory skeptic, and fixed round/message/time/cost
  ceilings;
- deterministic score and recommendation calculation after every participant contributes;
- an explicit owner-decision boundary and atomic project/decision/origin-event persistence;
- HMAC-authenticated append-only evidence plus event-bound current project projection verification;
- optimistic lifecycle versions, legal transition graph, archive hiding, and recoverable reopening;
- shared Project Workspace composition for a promoted project, including all nine core tabs and Idea origin;
- visible injected-only/no-provider/no-dispatch truth in the Idea Lab and promoted project pages; and
- hostile tests for re-digested tampering, secret-shaped data, incomplete panels, duplicate identities, invalid chronology,
  accessors, Proxies, stale transitions, SQL evidence mutation, and project projection tampering.

## Verification

- CR12B focused gate: 14/14 passing;
- registered pretests: 769/769 passing;
- core suite: 414/416 passing with zero failures and two intentional platform skips;
- public, CR12A, and CR12B posttests: 93/93 passing;
- TypeScript, full lint, and whitespace validation: passing;
- production build and rendered-route verification: 3/3 passing, including `/ideas` and its promoted project; and
- database migration verification: all 28 migrations and 102 PostgreSQL tables.

## Retained limits

- The current screen uses deterministic injected fixture summaries. No live Hermes, Codex, or local-model session was
  started, read, resumed, steered, or contacted.
- The repository has no live Idea Lab write API, provider coordinator, browser mutation control, or configured protected
  project-registry read in this block.
- The low-level durable store assumes a trusted server caller. CR12B-IDEA-030 must authenticate an active owner and bind
  that policy decision before exposing promotion through an API.
- A recommendation never creates a project automatically. The durable owner decision boundary remains mandatory.
- No credential, production database, VPS, deployment, DNS, Cloudflare, or external effect was touched.

## Next gate

CR12B-IDEA-030 is the authenticated panel coordinator and protected owner-promotion API. It must consume only a Hermes
runtime/version that passes the accepted compatibility boundary and provides a safe filtered read path. Provider contact
requires separate scoped authority. Until then, the runtime stays disabled and the current interface remains honest.
