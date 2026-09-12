# Idea Lab browser fixture (issue #27 slice)

Synthetic browser validation for the bounded Idea Lab journey. Mounts the
real `PrivateIdeaWorkspace` component against two generic lab configurations
served by a `window.fetch` interceptor. No live providers, no credentials,
no production effects. This entry is not included in the production build.

## Labs

- `idea:lab:completed-synthesis` — completed run (6/6 attempts), five
  retained contributions (participant 3 has no round-2 turn — the panel
  renders "No contribution saved for this round"), synthesis saved, owner
  decision available (`canDecide`, `canPromote`).
- `idea:lab:running-gap` — running run (1 settled turn + 1 provider-marked
  turn with no settled result), no synthesis yet, stoppable (`canStop`).

Partial-participant failure stays visible in both labs; promotion never
executes here.

## Run it

```sh
pnpm exec vite --config vite.idealab-preview.config.ts
```

Open http://127.0.0.1:4176/ — loopback only. Use the fixture controls to
switch between the session list and each lab detail.

## Acceptance checklist (fill in with a real browser)

- [ ] Session list shows both labs with participant/round counts
- [ ] Lab A detail shows the round-2 gap for participant 3 as visible text
- [ ] Lab A detail shows the synthesis recap and the owner decision form
- [ ] Lab B detail shows "A turn was started but has no settled result yet"
- [ ] Lab B detail offers the stop control, no synthesis section
- [ ] Refresh / reload keeps the same synthetic content
- [ ] No network request leaves 127.0.0.1 (unknown paths fail)

## Pre-push validation

```sh
pnpm check:demo              # tsc --noEmit must pass
pnpm test:ideas               # existing Idea Lab tests must pass
pnpm test:articles             # existing article tests must pass
pnpm test:idealab              # fixture Zod-parse test (new)
```

## Visual pass record

No visual pass recorded on the building host (Windows, no local browser
binary available to the agent). All wire shapes are validated by
`tests/idealab-fixture.test.mjs` against `src/web/v1/idea-wire.ts`.
