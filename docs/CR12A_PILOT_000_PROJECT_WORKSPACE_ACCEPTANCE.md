# CR12A-PILOT-000 Project Workspace Acceptance Record

Status: complete locally for the presentation-only operator-pilot snapshot

Date: 2026-08-31

## Result

Every registered Control Room project now opens inside one coherent Project Workspace instead of one long project page
or a collection of dead navigation labels. The nine shared sections have real stable URLs, project-specific extensions
remain available, and all displayed information stays scoped to the selected project.

This is a read-only local pilot surface. It does not create approval, command, lease, dispatch, execution, network, or
external-effect authority.

## Implemented surface

- one reusable Project Workspace shell with project identity, health, source status, summary counts, and current section;
- working deep links for Overview, Inbox, Work, Agents, Automations, Files and artifacts, Reviews, Activity, and Settings;
- exact section validation and not-found behavior for unknown projects or sections;
- project-filtered synthetic work, blocker, attention, agent, worker, and activity projections;
- existing Agent Team and automatic ready-frontier views in their dedicated sections;
- existing ABS AI and Tech News and Lo-Fi Wayfarer extension views retained within the shared shell;
- an honest empty artifact state because no authenticated project artifact index is connected;
- one visible negative-authority statement on every Project Workspace route; and
- responsive summary, work, source, and scrollable-navigation layouts.

## Verification

- dedicated CR12A gate: 19/19 passing;
- registered pretests: 769/769 passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public post-tests: 52/52 passing;
- TypeScript check and full lint: passing;
- production build: passing with both project route families emitted;
- rendered-route checks: 2/2 passing across overview, extension, agents, and worker routes;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`;
- desktop browser inspection: passing;
- 390-by-844 browser inspection: passing, with 390-pixel document width and no page overflow; and
- whitespace validation: passing.

## Boundaries retained

- Fixture data is labeled synthetic and does not masquerade as authenticated production truth.
- Extension views cannot widen the shared Project Workspace authority.
- A missing authenticated artifact index produces an explicit unavailable state, not a fabricated listing.
- Navigation and displayed buttons inside existing synthetic extensions do not grant approval or execute work.
- No persistence schema, live collector, external source, credential, provider, host, or production system changed.

## Next block

CR12A-PILOT-010 will define one protected project-scoped read composition over existing Control Room read services,
including tenant/workspace/project isolation, stale and unavailable states, and an explicit development-fixture boundary.
It will not add project writes or operational effects.
