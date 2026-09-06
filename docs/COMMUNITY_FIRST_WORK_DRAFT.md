# First community work — local maintainer draft

2026-09-06. Not dispatched, not public-safe by default, and not a claim that contributors
can clone this private checkout. Titles and scopes below are intended for the future
public issue queue. Do not publish private baseline hashes or internal review links.

## Release prerequisites for these jobs

Every issue is currently **draft: waiting for reviewed public source**. Before marking
one ready, insert the exact public commit SHA, verify its listed paths/commands in that
public checkout, and identify the maintainer who will review it. No contributor should
need the private repository, internal historical documents, operator keys or live agents.
The current path references below are integration planning aids; revalidate after export.

Use standard-work mode for these four jobs. They do not require the private GitHub
jobber controller, native qualifications or special effect contracts. A maintainer
assigns a ready issue before work begins. A contributor uses their own fork/branch and
may take another independent ready issue while a PR awaits review. Dependent PRs must
declare their base and wait for compatible integration.

Common exclusions: no authentication/protocol/schema/migration changes, no relaxed
checks, no provider/native calls, no credentials, no private machines, no deployment
or self-hosted PR runner. Package preparation is a separate, documented prerequisite;
no surprise installs or network fallback during a test. No self-merge.

## COMMUNITY-001 — [Any OS][UI] Make project lists usable with long names and narrow screens

**Outcome:** A project list remains readable and navigable with long synthetic names,
empty summaries, archived projects and enough records to require pagination. Preserve
existing separate-tab links and distinguish unavailable data from an empty list.

**Scope:** `app/components/project-catalog.tsx`, `project-catalog-navigation.tsx`,
`private-app/app/private.css`, `tests/project-catalog.test.tsx`. No project-service changes.
**Branch:** `community/project-list-readability` in contributor's fork.
**Dependencies:** Public source base, frozen dependencies; no other community job.
**Acceptance:** Existing catalog tests plus new long-content/archived/pagination cases;
keyboard and 320px-width inspection in an explicitly documented disposable demo.
No horizontal page overflow or hidden focus; new-tab navigation must not mutate projects.
Test command: `node --import tsx --test tests/project-catalog.test.tsx`.
**Not claimed:** The current UI has been visually proven defective. This is a concrete
usability/coverage improvement; report existing behavior before choosing CSS changes.

## COMMUNITY-002 — [Any OS][Docs] Write a reproducible contributor setup guide

**Outcome:** A new contributor can prepare, build and run the agreed offline verification
from a fresh public checkout, with no private service, credential or maintainer path.

**Scope:** Proposed public `docs/contributing/setup.md` and `README.md` setup section only.
**Branch:** `community/contributor-setup`.
**Dependencies:** Published source/build/test scope; maintainer-provided exact command list.
**Acceptance:** Record OS, Node/package-manager versions, frozen preparation result,
build/test commands and exit codes. Distinguish installing dependencies, running offline
tests, launching a disposable demo and configuring a real installation. Never advertise
the test-injected launcher as a ready operator template. Report missing prerequisites
instead of inventing secrets or weakening a check.
**Verification:** Maintainer-selected public `test:build:vps` lane and documented focused
tests, after scoped dependency preparation. One successful OS does not establish all-OS
support; add honest platform notes and a reproduction checklist for the other platforms.

## COMMUNITY-003 — [Any OS][UI] Explain offline and unconfigured agent connections clearly

**Outcome:** The connection page explains whether data is loading, unavailable,
unconfigured or recorded, with the next non-destructive action stated plainly. Avoid
implying that an enrolled agent is online or that a reviewed version was tested here.

**Scope:** `app/components/connection-center.tsx`, `tests/web-connection-browser.test.tsx`.
No enrollment logic, network operations or runtime version selection.
**Branch:** `community/connection-state-copy`.
**Dependencies:** Public source base; independent of COMMUNITY-001/002.
**Acceptance:** Preserve all existing read-only calls and trust checks. Add presentation
assertions for empty, unavailable, stale and recorded states. No raw internal error
details, connect buttons or automatic retries. Text should be understandable without
the internal milestone names.
Test command: `node --import tsx --test tests/web-connection-browser.test.tsx`.

## COMMUNITY-004 — [Any OS][UI] Make result-to-review matching easier to understand

**Outcome:** A person inspecting a returned file can tell which review belongs to it,
what checks remain and whether displayed information is historical. Preserve the
distinction between reviewing work quality and authorizing an external action.

**Scope:** `private-app/app/task-results.tsx` and a proposed focused presentation test
`tests/task-results-presentation.test.tsx`. No review-store or result-service edits.
**Branch:** `community/result-review-readability`.
**Dependencies:** Public result-view types and fixtures confirmed by maintainer.
**Acceptance:** Render synthetic cases for no open file, matching/mismatched file,
superseded review, missing checks and findings. Keep existing fingerprint/ID matching
decisions intact; reorganize presentation only. No fabricated acceptance or automatic
approval. Include the existing regression command:
`node --import tsx --test tests/web-task-results.test.ts` plus the new presentation test.

## Handoff, failure and review

PR summary: outcome, changed paths, screenshots only from authorized synthetic demos,
commands/exit codes, known limitations, upstream code/license notices and dependencies.
For ordinary code/docs work, prefer one focused repair after feedback; if it exposes a
larger issue, discuss a revised scope instead of an unlimited hidden rewrite. A failed
test is useful evidence, not a reason to erase work or pretend the task passed.

If blocked, leave a reproducible explanation, preserve useful changes in the draft PR
and release the assignment if unable to continue. Never retry a consequential action
under these standard-work tickets: none is authorized in the first place.

Maintainer review: verify scope first, then behavior and tests; require genuine evidence
for platform claims; integrate in dependency order. Security defects discovered during
ordinary work should use the future private reporting route, not public secret dumps.

## What stays with the lead build

We retain export/privacy/license decisions; public-source policy; owner signing and
checkpoint/storage decisions; authentication/permission rules; SQL migrations; actual
PostgreSQL/fleet rehearsal; and final integration. Native installation/qualification
jobs can follow later with exact environments and separate scoped authorization.

These first issues are not the complete remaining build. The visible roadmap must also
include multi-agent Idea Lab, generic news-to-task workflows, ongoing eligible pickup,
artifact handoff and update/restore reliability. Do not label the public demo as the
finished product simply because the first contribution queue is small.
