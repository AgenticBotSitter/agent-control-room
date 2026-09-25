# Marvin M1 — Agent Control Room: `mac-local` Website Route Inventory (re-run)

Status: COMPLETE
Branch: `hermes/mac-w5-m1-inventory`
Base commit: `e9bac6e4` (integration head at time of run)
Method source: `docs/claude/assignments/MARVIN_H2_WEBSITE_ROUTE_INVENTORY.md` (prior inventory — repeated as method, not trusted as current truth)
Owner: Marvin, lane M1

This document contains no real hostnames, IP addresses, certificates, credentials,
owner codes, or private filesystem paths. Hosts and services are named by role only.

## 1. Method

Every journey step from the prior inventory is listed. For each, I read the route
table that the `mac-local` host **actually mounts** and traced it to the service
function it calls. Documentation and plans were not treated as evidence.

The mounted route table for `mac-local` is **not** `private-process.ts`. `mac-local`
is a separate, smaller composition:

- `src/web/v1/mac-local-host.ts` — protected host composition
- `src/web/v1/mac-local-serving.ts` — listener + installed-application forwarder
- `src/web/v1/mac-local-web-process.ts` — **the actual `mac-local` route table**
- `src/web/v1/task-http.ts`, `src/web/v1/project-http.ts` — sub-handlers it delegates to
- `scripts/mac-local/up.mjs` -> `stack.mjs` -> `start-task-host.mjs` — startup path

`private-process.ts` mounts a far larger route set, but `mac-local` does not use it.

## 2. Result summary

| Count | Value |
| --- | --- |
| Journey steps examined | 13 |
| Journey steps with an installed route reachable in `mac-local` | 5 |
| Journey steps with NO installed route | 8 |
| Journey steps whose route is installed but unreachable as shipped | 3 (see 4.1) |
| Preview / fake panels reachable in `mac-local` | 0 |

### 2.1 The blocking finding (read this before the table)

**`pnpm mac:up` cannot start, because the module it requires does not exist in this
branch.**

- `scripts/mac-local/up.mjs:13` requires `dist-vps/server/macLocalDefaultTaskProvider.js`.
- `vite.vps.config.ts` builds no entry for it (entries are enumerated at
  `vite.vps.config.ts:13-35`; the mac-local entries are `macLocalHost` and
  `macLocalTaskProvider` only).
- No file matching `*default-task-provider*` is tracked in git, exists on disk, or
  appears in any branch's history. Verified by `git ls-files` and
  `git log --all -- '*default-task-provider*'` (both empty).
- `docs/claude/DEFAULT_TASK_PROVIDER_PLAN.md:3` states status
  "research complete, implementation in progress"; its step 7 says to write
  `mac-local-default-task-provider.ts` and add the `vite.vps.config.ts` entry.
  That work has not landed on this branch.

Consequence: `up.mjs:115` fails with `<module> missing: run pnpm build`, so
`createTaskApplication` is never reached. In `mac:up`, therefore, **no** task
lifecycle operations are ever installed.

This is a SOURCE-level fact, not an inference. I could not run the stack (forbidden),
so I cannot state the exact runtime error text; the build-input check is what I read.

## 3. Journey step table (method from the prior inventory)

"Reachable" = a route exists in the mounted `mac-local` table AND its backing
operation is supplied by the composition that `mac:up` starts.

| # | Journey step | Route in `mac-local` table | Service function | Data source | Reachable as shipped |
| --- | --- | --- | --- | --- | --- |
| 1 | sign in | `GET /session`, `POST /api/v1/local-owner-session` | `LocalOwnerSessionServiceV1.issue` / `readLocalOwnerCodeV1` (`mac-local-web-process.ts:122-132`) | installed | **yes** |
| 2 | project list | `GET /api/v1/projects`, `GET /projects` | `WebProjectService.listPage` (`project-http.ts:35-41`) | installed | **yes** |
| 3 | create project | `POST /api/v1/projects` | `WebProjectService.create` (`project-http.ts:43-47`) | installed | **yes** |
| 4 | create task | `POST /api/v1/projects/{id}/tasks` | `WebTaskService.propose` (`task-http.ts:240-246`) | installed | **yes** |
| 5 | assign worker | `GET/POST .../tasks/{job}/assignment` | `TaskAssignmentOperation.assign` / `.expire` (`task-http.ts:139-166`) | installed | no — needs `assignment` |
| 6 | approve | `GET/POST .../tasks/{job}/approval` | `TaskApprovalOperation.prepare` / `.store` (`task-approval-http.ts:16-52`) | installed | no — needs `approvals` |
| 7 | status / run | `GET .../tasks/{job}` | `WebTaskService.detail` (`task-http.ts:231-239`) | installed | **yes** (read-only) |
| 8 | result review | `GET .../tasks/{job}/results[/{artifact}]` | `WebTaskService.results` (`task-http.ts:226-230`) | installed | **yes** (read-only) |
| 9 | accept | `GET/POST .../tasks/{job}/results/{artifact}/reviews/{target}` | `WebTaskReviewService.options` / `.record` (`task-http.ts:213-225`) | installed | no — needs `ownerReviews` |
| 10 | request changes | `POST .../tasks/{job}/revisions` | `TaskRevisionOperation.plan` (`task-http.ts:89-110`) | installed | no — needs `revisions` |
| 11 | cancel | none | — | — | **no route exists anywhere** |
| 12 | worker status | `GET /api/v1/local-workers` | `workerReadiness.read` (`mac-local-web-process.ts:133-137`) | installed | **yes** (read-only) |
| 13 | plan a task (W3 prerequisite for 5/6) | `GET/POST .../tasks/{job}/plan` | `TaskPlanningOperation.plan` (`task-http.ts:167-200`) | installed | no — needs `planning` |

Notes on rows 5, 6, 9, 10, 13: the **route** is installed and correct; only the
injected operation is absent. `task-http.ts` throws
`<name>_not_configured` (e.g. `assignment_not_configured`, line 149) rather than
404, so the route is mounted but unusable. I record these as gaps because the
plan's P2 acceptance ("owner creates a project and task") is the floor, and
P4 ("one harmless task per agent returns three distinct saved results") cannot
happen without plan -> assign -> approve -> submit.

Row 7/8/12 are genuinely reachable: they need no injected operation.

**Row 11 (cancel) is a different kind of gap.** There is no `cancel` route in
`task-http.ts`, `project-http.ts`, `mac-local-web-process.ts`, or
`private-process.ts`. The only browser-visible cancel in the product is the Idea
Lab `POST /api/v1/ideas/{id}/stop`, which lives in `private-process.ts` and is
therefore **not mounted in `mac-local` at all**. `task-assignment-coordinator.ts:1672-1674`
states in its own comment that `expire` "does not confirm a process stopped or
make the one-attempt task retryable... No timer or native cancellation is
installed." So cancelling a task in flight is not modelled, not merely unrouted.

## 4. Missing routes, by operation and file

Security-relevant column: **yes** means the file is sign-in, host startup, the
protected loader, or the database route. Those are Codex-only files and I did not
write them.

| Journey step | Operation needed | File that would need to change | Security-relevant |
| --- | --- | --- | --- |
| 5 assign | install `assignment` | `mac-local-task-application.ts:71` (supply the operation) | no |
| 6 approve | install `approvals` | `mac-local-task-application.ts:72` | no |
| 9 accept | install `ownerReviews` | `mac-local-task-application.ts:75` | no |
| 10 request changes | install `revisions` | `mac-local-task-application.ts:74` | no |
| 13 plan | install `planning` | `mac-local-task-application.ts:70` | no |
| 11 cancel | **new route + operation** | new route in `task-http.ts`; operation in `task-coordinator-lifecycle.ts` | no |
| 2.1 blocking | build the default provider | new `src/web/v1/mac-local-default-task-provider.ts` + `vite.vps.config.ts` entry + `scripts/mac-local/up.mjs` | no |

`mac-local-task-application.ts:69-77` already assembles all five operations from
`lifecycle`; they are absent only because `createTaskApplication` is never
reached. Note that `ownerReviews` and `ownerVerifications` are additionally
gated on `web.tasks.ownerReviews` / `manualVerificationScenarios` plus
`harnessIntegrityKey` and `results` (`mac-local-task-application.ts:49-52`), so
closing rows 9 and 13 needs protected keys configured, not just a provider.

### 4.1 Security-relevant files (Codex-only; I wrote none of these)

| File | Why |
| --- | --- |
| `src/web/v1/mac-local-host.ts` | host startup; chooses whether operations exist |
| `src/web/v1/mac-local-protected-loader.ts` | protected configuration + database-role loader |
| `src/web/v1/local-owner-session.ts` | sign-in (owner code, session cookie) |
| `src/web/v1/mac-local-web-process.ts` | the mounted `mac-local` route table |
| `src/web/v1/mac-local-serving.ts` | installs the process-wide application forwarder |
| `scripts/mac-local/up.mjs`, `start-web-host.mjs`, `stack.mjs` | startup path |
| `scripts/mac-local/provision-database.mjs` | database route / roles |

`mac-local-web-process.ts` is listed because it is the mounted route table: any
new `mac-local` journey route lands there. It is the one place a reviewer should
check a proposed cancel route first.

## 5. Preview and fake panels

The plan requires these are NOT reachable in `mac-local`. Result: **none reachable.**

| Panel | Location | Reachable in `mac-local`? | Basis |
| --- | --- | --- | --- |
| `/local-preview` workspace | `app/local-preview/workspace.tsx` | **no** | No `page.tsx` exists for it; `app/local-preview/` contains only two components. It is not a route in any table. |
| Local Control Room workboard | `app/local-preview/control-room-workboard.tsx` | **no** | Rendered only by the preview workspace above. Its client posts to `/api/v1/local-pilot/workspace`, which is not mounted by `mac-local`. |
| Local pilot owner session | `app/components/local-pilot-owner-session.tsx` | **no** | Posts to `/api/v1/local-pilot/session`; that route exists only in `src/contributor-demo/http.ts`, a separate demo server. |
| Contributor demo | `contributor-demo/view.tsx` | **no** | Built only by `vite.contributor.config.ts` (`build:demo`); not in the VPS build. |
| `ContributorSimulation` | `app/components/contributor-simulation.tsx` | **no** | Imported only by the preview workspace. |

Two supporting points from source, not from the demo tests:

- `mac-local-web-process.ts:77-116` defines `renderProductRoute` and throws
  `not_found` for any path outside `/`, `/projects`, `/projects/{id}`,
  `/projects/{id}/tasks`, `/projects/{id}/tasks/{job}`. `private-process.ts:804`
  has the same behaviour for unknown paths. A preview path cannot fall through.
- `task-http.ts:201` and the `mac-local` sub-handler dispatch are anchored on
  `/api/v1/projects/...`; the local-pilot transport path is never matched.

One honest caveat: I verified reachability by reading the route tables, not by
issuing live requests, which are forbidden here. `tests/local-preview-panels.test.tsx`
exercises these panels as components against a stub transport, which confirms
they are test fixtures, not installed routes.

## 6. Ranked gaps for Phase 3

Ordered by what unblocks the most, cheapest work first.

1. **Build `mac-local-default-task-provider.ts` and add its build entry.**
   Blocks everything. `mac:up` cannot start without it, and it is the single
   reason rows 5, 6, 9, 10, 13 have no operations. Also the precondition for P2's
   acceptance criterion at all.
2. **Install the five operations into the mac-local composition.**
   The code at `mac-local-task-application.ts:69-77` is already written; it needs
   a provider that reaches it. Rows 13 -> 5 -> 6 -> 10 -> 9 in that order, because
   planning produces the input the other four consume.
3. **Configure the protected keys `ownerReviews` and `harnessIntegrityKey`/`results`.**
   Row 9 (`accept`) stays closed even after step 2 without these
   (`mac-local-task-application.ts:49-52`). Cheap to miss, easy to misdiagnose as a
   routing gap.
4. **Decide the cancel story (row 11).** Not a route to add; a product decision.
   No cancel operation exists. Cheapest honest close is to state in the UI that a
   task cannot be cancelled locally, or scope a bounded `expire`-only correction
   path. A full cancel needs a new operation and touches task state semantics.
5. **Third-party iteration and support affordances.**
   `src/third_party/` has a repository guard (visible via
   `test:release-licenses` in `package.json`), but the site exposes no owner-facing
   third-party notices page in the `mac-local` mounted routes. This is a
   likely release-review blocker, so it sits just under the functional work.

## 7. What I could not determine from source alone

- Whether the built `dist-vps/server/` would contain the missing provider. No
  `dist-vps` exists in this worktree and I did not build. The conclusion in 2.1
  rests on the tracked build-input list in `vite.vps.config.ts` and on the file
  being absent from git, not on a build.
- Runtime behaviour of any route. No service was started, by instruction.
- The exact error text `up.mjs:115` would print, for the same reason.
- Whether the owner intends `mac:host` (website only) or `mac:up` (full stack) to
  be the P2 acceptance path. They differ: `pnpm mac:host` ->
  `startMacLocalWebHost` supplies **no** operations
  (`start-web-host.mjs:46-51`), so under `mac:host` rows 5, 6, 9, 10, 13 are absent
  by design, not by defect. This is the single most important question for Phase 3,
  and it is a documentation question I cannot answer from source.
- Whether `ownerVerifications` will be supplied by the eventual provider, so
  I have not scored an "owner verification" journey step either way.

## 8. Verification performed

- Worktree on `hermes/mac-w5-m1-inventory` at `e9bac6e4`, clean before and after.
- No TypeScript was changed; the only file written is this report.
- `git diff --check` clean.
