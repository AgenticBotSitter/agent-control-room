# Disposable workspace browser check

Run from the checkout root with prepared dependencies:

```sh
pnpm exec vite --config vite.workspace-preview.config.ts
```

Open loopback port 4175. Stop the preview with Ctrl+C afterward. It uses
synthetic project / task / result / review data, intercepts application fetch
calls, and does not require login, provider credentials or a database. This
is not a production entry point.

The fixture mounts `PrivateTaskWorkspace` against two synthetic projects
(`project:alpha` and `project:beta`), each with one task, one result file
and one recorded quality review. Use the **Switch synthetic project**
button in the panel above the workspace to swap which project the fixture
is rendering.

## What to verify

Cover the full task → progress → result → review → revision cycle. For each
step, record pass / fail / unverified in this README before claiming the
gate passes; do not erase earlier entries.

### Two projects, one task each

- [ ] On load, the workspace panel shows the Alpha project task
      `job:alpha-001`. Result file `artifact:alpha-001-r2` is in the list.
- [ ] Switch to Beta; the workspace panel now shows `job:beta-001`. Result
      file `artifact:beta-001-r2` is in the list. The previous Alpha
      result must not be visible.
- [ ] Switch back to Alpha; the Alpha result is visible again.

### Read result + recorded review

- [ ] On Alpha, open the result. The page reads `artifact:alpha-001-r2`
      and displays the synthetic body. The recorded review
      `review:alpha-001-r2` shows status `Changes requested` with one
      open finding.
- [ ] On Beta, opening the result must show a notice that your access
      permits metadata only (Beta is configured to deny `canReadContent`).
      The recorded review shows status `Quality review complete`.

### Deep link and reload

- [ ] Deep-link the page to `/projects/project:alpha/tasks/job:alpha-001`
      using the in-app navigation. The workspace loads the Alpha detail.
- [ ] Reload the tab. The same detail is shown (the fixture is in-memory
      only; reload reuses the same synthetic fetch responses). No "lost
      request" or "lost reply" notice should appear.

### Keyboard and mobile

- [ ] Tab through the page from the switch button to the Read Result
      button. Every focusable element shows a visible focus ring.
- [ ] Resize the viewport to ≤ 480 px wide. The workspace remains usable;
      no element overflows the viewport, no horizontal scroll appears.
- [ ] Open the page with a screen reader. The result panel and review
      panel are labeled correctly; the switch button announces its
      current state.

### Safe uncertain-save recovery

- [ ] On Alpha, edit the task draft (a textarea) and immediately try to
      navigate away. The "save was still unconfirmed" notice appears.
      Stay on the page; the notice clears after the synthetic save
      completes.

## Pre-push validation

```sh
pnpm check:demo              # tsc --noEmit must pass
pnpm test:demo               # underlying component tests must pass
pnpm test:results            # task-results lifecycle tests must pass
pnpm test:workspace-fixture  # synthetic fixture responses match wire schemas
```

`pnpm test:demo` exercises the underlying components the fixture renders.
`pnpm test:workspace-fixture` validates that the synthetic responses
the fixture serves match the Zod wire schemas from
`src/web/v1/{task,task-result}-wire.ts`. This test is the empirical
guard for the fixture's contract with the workspace component.

## Visual pass record

The first run was made on a Windows host without a local Chromium /
Edge / Firefox binary available to the agent. Source rendering and
fake-DOM tests above pass; **no visual pass is recorded**. The README
checklist above is filled in by the next reviewer on a host with a
real browser. Until then, treat the fixture as type-checked and
buildable but not visually proven.

## Cleanup

Stop the preview server with Ctrl+C. The fixture uses no persistent
network, no real port binding outside loopback, and no temporary files.
No cleanup is required after the browser check.
