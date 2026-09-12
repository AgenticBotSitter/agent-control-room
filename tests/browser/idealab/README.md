# Idea Lab browser fixture (issue #27 slice)

Synthetic browser validation for the bounded Idea Lab journey. Mounts the
real `PrivateIdeaWorkspace` component against three generic lab
configurations served by a `window.fetch` interceptor installed at module
scope, before the child component mounts. Unknown requests fail closed
with a synthetic 503 — nothing falls through to the real network. No live
providers, no credentials, no production effects. This entry is not
included in the production build.

## Labs

- `idea:lab:completed-synthesis` — complete six-turn panel, saved
  synthesis, owner decision available (`canDecide`, `canPromote`).
  Decision POSTs echo the sent draft with `startsWork:false`.
- `idea:lab:running-gap` — running run (1 settled turn + 1
  provider-marked turn with no settled result), no synthesis yet,
  stoppable (`canStop`). Stop POST cancels the run.
- `idea:lab:partial-failure` — failed-definite run (5 settled + 1 failed
  turn), the missing contribution stays visible, no synthesis and no
  decision offered.

Partial-participant failure stays visible; promotion never executes
(every receipt carries `startsWork:false`).

## POST behaviors (served synthetically, asserted by the test)

- `POST /api/v1/ideas` echoes the `idempotency-key` header; a repeated
  key replays the original receipt.
- `POST /api/v1/ideas/{id}/decision` requires saved synthesis (409
  otherwise), echoes the draft, tracks repeats as replayed.
- `POST /api/v1/ideas/{id}/stop` succeeds once for the running lab with
  matching runId + digest (409 otherwise).
- `POST .../start` and `POST .../synthesis` conflict (no fixture lab is
  startable; synthesis exists or the run is not completed).
- Unknown sessions are 404; unknown paths are 503 fail-closed.

## Run it

```sh
pnpm preview:idealab
```

Open http://127.0.0.1:4176/ — loopback only. Use the fixture controls to
switch between the session list and each lab detail. Stop with Ctrl+C.

Repeatable smoke check with process/port/worktree cleanup evidence:

```sh
pnpm test:idealab-preview
```

## Acceptance checklist (fill in with a real browser)

- [ ] Session list shows all three labs with participant/round counts
- [ ] Lab A detail shows the synthesis recap and the owner decision form;
      submitting save/create_project shows the receipt without executing
- [ ] Lab B detail shows "A turn was started but has no settled result
      yet"; the stop control cancels the run
- [ ] Lab C detail shows the failed turn and the missing contribution with
      no synthesis or decision offered
- [ ] Refresh / reload keeps the same synthetic content
- [ ] No request leaves 127.0.0.1 (unknown paths get synthetic 503)

## Pre-push validation

```sh
pnpm check:demo              # tsc --noEmit must pass
pnpm test:ideas               # existing Idea Lab tests must pass
pnpm test:articles             # existing article tests must pass
pnpm test:idealab              # fixture + real-client behavior tests (new)
pnpm test:idealab-preview      # preview serve + cleanup evidence (new)
```

`test:idealab` and `test:idealab-preview` are wired into the
`test:components` CI lane.

## Visual pass record

No visual pass recorded on the building host (Windows, no local browser
binary available to the agent). Wire shapes, client echo/idempotency
behavior, preview serving, and cleanup are validated by
`tests/idealab-fixture.test.mjs` and
`scripts/idealab-preview-smoke.mjs`.
