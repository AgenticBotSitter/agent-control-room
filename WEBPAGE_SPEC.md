# Product webpage specification

This is the public implementation brief for the **application**, not the promotional
landing website. It supplements PUBLIC_BUILD_PLAN.md; neither a private design folder
nor permission to access the maintainer's installation is a prerequisite. Existing
components are the starting point. Screens described here are requirements, not a claim
that they are all connected today. Use roles and configurable display names, never
hardcoded people, domains, machines or personal projects.

## Layout and visual direction

Keep the existing React styling and protected result components. Use a calm, compact
workspace with readable text, restrained borders, consistent spacing and a single
primary action per section. Status uses words/icons as well as color. Do not import
an entire desktop shell or build a terminal multiplexer for this work.

Desktop structure:

```text
App name / project selector                 Connection state · Account
Navigation       Project title · status     New task / primary action
                 Project section tabs
                 Main work or result        Context / review details
```

Global navigation: Home, Projects, Workers, Needs attention, Settings. Optional
Idea Lab and News appear only when enabled. Work, reviews and files are reachable
both from project sections and global attention; do not create two stores for them.
On narrow screens navigation becomes a labeled menu, cards replace wide tables and
the details pane follows the main content. At 360px width core actions remain usable
without page-wide horizontal scrolling. Code/diff tables may scroll within a region.

Project sections: **Overview, Inbox, Work, Agents, Automations, Files, Reviews,
Activity, Settings**. Implement the initial-release paths first; hide or explicitly
label unavailable optional sections rather than fill them with fake live data.
Use links/deep URLs for navigation, not an in-memory-only tab system. Existing route
names can be retained behind these labels; a label change is not an API migration.

## Initial release screens and behavior

| Screen | Required information | Actions and completion |
| --- | --- | --- |
| Home | Running work, needs attention, blocked/offline workers, recent results and project links | Go directly to the affected task or project; unknown counts are unavailable, not zero |
| Projects | Name, summary, lifecycle, recent activity; active/archive filters | Create an ordinary project without an Idea Lab; open multiple project pages; complete, archive and reopen with history intact |
| Project overview | Purpose, active work, reviews, worker availability and recent activity | Create a task; navigate to the same project's work/results/settings; no other project's stale data |
| Task composer | Title, instructions, expected deliverable, eligible capabilities/worker, disclosed limits and review policy | Save draft/propose/submit through existing services; name the actual action. No implicit publishing or provider execution from a preview |
| Work/detail | Queued, running, waiting for input, awaiting review, blocked, failed, uncertain and completed states; attempts and timestamps | Show a safe next action and cause. Lost replies trigger read-only reconciliation, not automatic new execution |
| Results/review | Sanitized Markdown, bounded attachments, evidence, attempt identity, revision lineage and review history | Accept/reject/request revision using existing contracts; preserve draft on recoverable failure; changing task must not submit the previous task's draft |
| Workers | Configurable label, harness/version/platform, online/stale/offline, eligible capabilities, slots and current work | Show why a worker cannot take a task; unsupported cancel/resume and unavailable usage are explicit, never fabricated |
| Needs attention | Questions, approvals, reviews, recovery uncertainty, urgency and blocked work | Open exact item; answer/review only within current authority. Dismissing a notice does not resolve the underlying job |
| Files | Project/run-bound artifact name, type, size and provenance | Protected bounded download/preview; never turn arbitrary agent text or a filesystem path into a download capability |
| Settings | Display name, project templates, enabled optional modules, timezone and documented limits | Same built artifact with two configurations and isolated stores; no credentials/private records in portable configuration export |

Closing a browser tab only closes the view. It does not cancel a task, finish a
project, or archive anything. Archive, completion and cancellation are separate,
clearly described actions with proportional confirmation. An agent's "done" message
is not reviewer acceptance. Browser reconnect refreshes observations, not commands.

## States, safety and accessibility

- Loading, empty, ready, denied, not found, offline/stale, error and uncertain states
  each have plain-English text and a meaningful next action where one is safe.
- Changing project/task immediately hides previous scoped data. Late responses cannot
  overwrite the current route. Reload and browser back/forward preserve correct scope.
- Buttons name their action; busy state prevents duplicate submission. Read-only
  re-check is visibly different from retry. Do not create new idempotency semantics.
- Keyboard users can create, navigate, review and request revision. Use semantic
  elements, visible focus, labeled fields, announced errors and deliberate focus return.
- Render untrusted output through the current protected Markdown path. No raw HTML,
  script execution or implicit approval links. External links are identified.
- Use locale/timezone-aware timestamps with relative age. Unknown cost/token/resource
  data stays unknown. No synthetic activity in a live screen or unsupported percentages.
- Synthetic screenshots and tests contain no login codes, real identities or private data.

## Subsequent modules (same application, not separate products)

Idea Lab: choose a bounded panel and limits → retain distinct contributions → compare
or synthesize → owner decision → promote to a normal project and proposed first task.
Partial/failed participants remain visible; promotion cannot secretly start execution.

News/research: configurable source list → attributed article reader → Research,
Compare, Write guide or Draft request → selected project/task → reviewed result and
revision. Reuse existing collection/extraction. No automatic publishing or remote
setup from an article click. Sources, branding and templates are configuration.

Later views retain the agreed direction: schedules, procedures/knowledge, capability
and resource bottlenecks, incidents, rich media/diffs, optional session observation,
notifications and additional harnesses. These are tracked in the public plan; do not
make placeholder navigation look operational before its backing service exists.

## Code, reuse and acceptance

Implementation reference: public `main`, reconciled through PR #34 at
`37e1baa7618b0f965103e48883b772a52e9a2374`; each issue records its exact newer base.
Relevant existing code: `private-app/app/workspace.tsx`, `task-workspace.tsx`,
`task-results.tsx`, `idea-workspace.tsx`, `news-workspace.tsx`, project routes and
`src/web/v1/browser-client.ts`. Do not start from the older preview and rebuild them.

Reuse DR-11 react-markdown/GFM and current project/result components. If a missing
tab/session feature needs substantial new machinery, first inspect the corresponding
component from [Hermes Desktop](https://github.com/fathah/hermes-desktop) or
[Hermes WebUI](https://github.com/nesquena/hermes-webui): pin source, license, state
dependencies and actual fit. Retain current components when that is simpler. This
brief does not require another research exercise for routine buttons/layout changes.
Copied code must retain notices and an attribution entry; a design inspiration is
not a claim that its code was incorporated.

Start with `pnpm check:demo` and `pnpm test:results`. Browser acceptance must mount
the actual product panels, not just the contributor simulation. Deliver synthetic
wide/narrow screenshots and a concise scenario record covering two projects, route
changes, failure/re-check, review/revision, archive/reopen, keyboard and reload. Test
the same artifact under two configurations without rebuilding. Mark any unwired
backend dependency explicitly; UI evidence cannot establish live harness acceptance.

Frontend contributors own presentation, accessibility and tests on reserved paths.
Shared API, authorization, schema and configuration serialization changes require
the core maintainer's contract. Visual choices within this brief do not need owner
approval; unsupported backend behavior must not be invented to finish the screen.
