# First public contribution batch

Local preparation only. No issues have been created. Publish these after the reviewed
source upload, replacing `PUBLIC_SOURCE_COMMIT` with the verified public commit hash.
Never mark an issue ready with that placeholder. Confirm assignment in its issue before
a contributor begins. No private branch, checkout or historical review is a prerequisite.

Maintaining owner: Alastair Fraser. Codex provides technical review and integration
assistance; it is not an additional independent human GitHub approver. The owner
controls repository permissions and merges. All packages use forks and local checks;
GitHub Actions stays disabled. One cohesive PR per package or platform assignment.

## Issue 1 — [Any OS][MVP][No live agents] Complete browser journey and accessibility

Base: `PUBLIC_SOURCE_COMMIT`. Work package: `WORK_PACKAGES.md` / DEMO-UX.

Outcome: a new contributor can complete a two-project task, sample-result, feedback,
revision and archive journey using keyboard or a narrow-screen browser, with clear
recovery when a request or response is lost. Fix existing interaction defects and
deliver repeatable browser tests; do not build a new design system or fake live agents.

Allowed implementation paths:

- `contributor-demo/`
- `app/components/contributor-simulation.tsx`
- `app/local-preview/workspace.tsx`
- `styles/control-room.css`
- New focused demo browser tests under `tests/`
- `SETUP.md` for the delivered browser-test command

Discuss other paths or new dependencies first. Reuse maintained browser-test tooling
with documented license/provenance; no custom browser automation framework. Server
authentication, protocol rules, schemas, credentials and live integrations are outside scope.

Acceptance:

1. Follow SETUP from a clean checkout; record OS, Node and pnpm versions.
2. Pass `pnpm check:demo`, `pnpm test:demo`, `pnpm test:build:demo` locally.
3. Demonstrate two distinct project tabs, task creation, sample generation, feedback,
   linked revision, refresh/history, project isolation and archive.
4. Test a POST lost before delivery separately from a response lost after acceptance.
   Preserve actionable feedback; do not automatically repeat uncertain work.
5. Verify keyboard focus, labels, narrow-screen layout and escaped sample content.
6. Supply and document a repeatable browser acceptance command, including normal
   shutdown and temporary-data cleanup. Do not capture login codes in test artifacts.

Submit one PR with code, tests, exact base/head, commands/results, screenshots with
synthetic content where useful, and limitations. A reviewer checks the actual workflow,
not just screenshots. While waiting, request a separate independent assignment.

## Issue 2 — [Windows][MVP][No live agents] Reproduce setup, demo and cleanup

Base: `PUBLIC_SOURCE_COMMIT`. Work package: `WORK_PACKAGES.md` / SETUP-OS.

Outcome: verify and fix contributor setup on a stated Windows version with no maintainer
files or credentials. Cover pinned dependency preparation, both build profiles, demo
interaction and shutdown. Do not infer Windows compatibility from macOS results.

Allowed paths: `SETUP.md`, `scripts/contributor-demo.mjs`,
`src/contributor-demo/launcher.ts`, and new Windows-focused smoke tests under `tests/`.
Coordinate edits to shared setup/launcher files with the Linux assignee before changing
them. Keep fixes narrowly platform-related; schema, dependency, authentication or
protocol changes need separate discussion.

Acceptance:

1. Document Windows, shell, Node and pnpm versions; use the documented PowerShell
   environment-variable syntax and frozen lockfile. Record downloads separately.
2. Run `pnpm check`, `pnpm check:demo`, `pnpm test`, `pnpm test:demo`, and
   `pnpm test:build:demo`. Report exact failures rather than relabeling them.
3. Start `pnpm demo`; complete login, project/task/sample/revision/refresh/archive.
4. Verify occupied-port failure without terminating another service, normal Windows
   interrupt/shutdown, process exit and cleanup of the demo's temporary data.
5. Submit reproducible commands, sanitized evidence and necessary portability fixes
   in one PR. State which browser behavior was manual versus automated.

No live agent, production database, credential store, service installation or deployment.
Do not upload raw logs containing login codes or machine-specific private data. If the
platform is unavailable, request reassignment before starting; do not substitute another OS.

## Issue 3 — [Linux][MVP][No live agents] Reproduce setup, demo and cleanup

Base: `PUBLIC_SOURCE_COMMIT`. Work package: `WORK_PACKAGES.md` / SETUP-OS.

Outcome: verify and fix contributor setup on a stated Linux distribution/version with
no maintainer access. This is a disposable contributor demo, not VPS production deployment.

Allowed paths: `SETUP.md`, `scripts/contributor-demo.mjs`,
`src/contributor-demo/launcher.ts`, and new Linux-focused smoke tests under `tests/`.
Coordinate shared edits with the Windows assignee. No schema, protocol, authentication
or dependency changes without separate discussion.

Acceptance:

1. Record distribution, architecture, shell, Node and pnpm; prepare pinned dependencies
   using SETUP and the frozen lockfile, recording downloads separately.
2. Run `pnpm check`, `pnpm check:demo`, `pnpm test`, `pnpm test:demo`, and
   `pnpm test:build:demo` locally.
3. Complete the disposable browser journey and distinguish manual from automated checks.
4. Verify occupied-port failure, normal interrupt/shutdown, process exit and temporary
   data cleanup without altering another application or persistent installation.
5. Submit one cohesive PR with exact revisions, commands/results, limitations and
   portability fixes. A headless build alone is not browser-journey acceptance.

No native/provider calls, production database, credentials, persistent service or deployment.
If blocked, retain useful work in a draft PR, describe the precise prerequisite and ask
for release/reassignment. Ordinary in-scope test/fix retries are allowed; uncertain
external actions are not authorized by this assignment.

## Publication checks for the maintaining owner

- Replace all three base placeholders after verifying the actual public source commit.
- Confirm each listed path and command exists at that commit.
- Create three issues, not an issue per small edit; name the reviewing maintainer.
- Confirm the three scopes do not authorize live effects or enable Actions.
- Leave issues unassigned until a contributor confirms platform and availability.
- Keep larger controller/connector/recovery work visible in WORK_PACKAGES, but do not
  mark it ready before its documented prerequisites and acceptance scenarios exist.
