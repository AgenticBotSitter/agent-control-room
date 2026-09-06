# E04 — Hermes Desktop presentation fit

2026-09-06. Source inspection only, not an installed application or UI acceptance.
Revision: `fathah/hermes-desktop@3f744975f818bbb40ed029e6b3022cd0c5ad7a24`.
The exact MIT license was read (Copyright 2026 github.com/fathah). All four raw
source/license files match the upstream Git blob hashes. See the download ledger.

## Decisions tied to our actual gaps

| Source | Useful reuse | Integration decision |
|---|---|---|
| `src/renderer/src/screens/Layout/ActiveSessionsBar.tsx` | Small controlled React component: selected session chips, status, new and close callbacks | Best presentation candidate for future in-app project tabs. Adapt this component when the authorized project-navigation state is connected. Do not import its profile avatars, Electron drag region or run ownership. Not copied yet. |
| `src/renderer/src/screens/Layout/SidebarRecentSessions.tsx` | Grouped project/session navigation, pagination, throttled reads and disclosure state | Its complete sidebar is not a portable module: it calls `window.hermesAPI` for caches, folders, rename and deletion. Retain our protected project catalog and cursor API. Revisit the small grouping/rendering subset when a real conversation catalog exists. |
| `src/renderer/src/components/settings/ConnectionPane.tsx` | Named connection selection, separate local/remote/SSH choices, explicit status refresh | Useful onboarding layout, not a connection implementation. Depends on a large settings context, Electron APIs, credential/key generation and connection tests. Defer adaptation until our installer/identity enrollment flow supplies real operations. Do not add controls that imply it is connected today. |

Exact source links:
[active sessions](https://github.com/fathah/hermes-desktop/blob/3f744975f818bbb40ed029e6b3022cd0c5ad7a24/src/renderer/src/screens/Layout/ActiveSessionsBar.tsx),
[sidebar](https://github.com/fathah/hermes-desktop/blob/3f744975f818bbb40ed029e6b3022cd0c5ad7a24/src/renderer/src/screens/Layout/SidebarRecentSessions.tsx),
[connections](https://github.com/fathah/hermes-desktop/blob/3f744975f818bbb40ed029e6b3022cd0c5ad7a24/src/renderer/src/components/settings/ConnectionPane.tsx).

## Specific adaptation requirements, not generic objections

- The active bar's `onClose` contract explicitly includes stopping a running conversation.
  Control Room's owner requirement is different: close a **view**, never cancel work or
  archive a project. Reuse the visual component with a view-only callback and a separate
  explicit cancellation command. The source component alone does not implement cancellation.
- Its clickable `div role=tab` does not itself implement keyboard tab navigation.
  Adapt to ordinary navigation links/buttons or supply complete tab keyboard behavior;
  do not copy the appearance and claim accessible tabs were proven.
- Sidebar grouping uses a local folder path as project identity. Our authoritative
  project ID must remain the grouping key; identical titles/folder basenames on two
  hosts are not one project. Do not import raw host paths into the private catalog.
- Sidebar pins/disclosure settings use global localStorage keys, while data operations
  depend on connection/profile context. A Control Room adaptation must not retain
  protected project titles/content across logout or use a previous account's cache as
  evidence. Prefer current authorized catalog data; any view preference is not authority.
- Connection mode changes invoke settings operations, and key generation invokes
  `window.hermesAPI.generateApiServerKey`. Do not transplant those callbacks into a web
  app with different credential custody or claim SSH reachability authorizes jobs.

## Current product comparison and next step

`private-app/app/workspace.tsx` already mounts the protected project catalog, individual
project pages, overview/tasks/settings and lifecycle controls, with explicit browser-tab
semantics. `private-app/app/task-workspace.tsx` reads recorded progress without dispatch
on refresh. `private-app/app/connections/workspace.tsx` truthfully labels the saved
enrollment inventory as not a live fleet. None of these is a native conversation catalog.

Do not replace these working APIs with the Desktop cache merely to borrow navigation.
Keep E04's active-bar component as the preferred next presentation source when that
feature is built. In the meantime prioritize block B's protected dispatch/runtime
composition and block C's runnable host packages, using the already selected pg-boss
and supported native interfaces. This closes the source-fit question without adding a
second scheduler, cache, credential UI, or an unconnected cosmetic screen.

No source was adopted in E04, no extra package installed, and no native/provider/UI
test ran. This report is not a claim that Hermes WebUI was re-evaluated completely:
its GitHub root was readable, but attempted pinned subdirectory views missed the web
cache. The prior specific WebUI stream/RFC findings remain the bounded evidence.
