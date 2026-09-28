# Demo parity map: contributor demo vs. the real owner website

Status: gap map only. No behaviour, data or backend change is proposed by this
document. Every status below was established by **running both applications** on
this checkout (`pnpm demo` on `127.0.0.1:3000`, and the real owner website from
a disposable local rehearsal cluster on `127.0.0.1:3217`) and by reading the
source, not by guessing from file names.

Terms used in the "status" column:

- **real** — the real owner website shows this, with real saved data.
- **partly real** — the real website shows it, but degraded relative to the demo.
- **demo-only** — the demo has it; the real owner website has no equivalent.

## The headline finding (read this before the table)

The task was framed as "port the demo's look into the real app". Measured on
this checkout, that framing does not hold, and the reason changes what is worth
doing.

**The demo and the real owner website are already the same design.**

- Both import the same two stylesheets, from the same two files:
  `contributor-demo/main.tsx` imports `../styles/control-room.css` and
  `../private-app/app/private.css`; `private-app/app/layout.tsx` imports
  `../../styles/control-room.css` and `./private.css`.
- They also share React components. `app/local-preview/workspace.tsx` (the demo
  page) imports `../components/project-catalog`,
  `../components/project-create-form`, and `TaskCatalogPanel`,
  `TaskDetailPanel`, `TaskProposalForm`, `TaskResultsPanel` from
  `private-app/app/task-panels` and `private-app/app/task-results` — which are
  the real app's own components.

So "the demo look" is not a separate design language waiting to be ported. It is
the current production stylesheet. Any CSS change reaches both surfaces at once.

What is actually true is more interesting, and it is what the ranked work below
is based on: **the repository already contains a considerably richer, darker,
sidebar-based design language that no page in either application renders.** It
is dead CSS. Bringing the real app up to the design the owner remembers liking
is mostly a matter of *switching the owner UI onto the vocabulary that already
exists in this repository*, not of inventing a new one.

### Evidence for the dead-CSS claim

`styles/control-room.css` defines 298 class selectors. Intersecting those with
every class token in a `className`/`class` attribute in `private-app/`, `app/`
and `contributor-demo/` (98 files, 510 attributes, counting the tokens inside
template-literal interpolations and ternary branches, because those are rendered
too), **28 of those 298 appear in rendered markup**; the other 270 are dead. The
following named groups are defined in the stylesheet and are referenced by **no**
`.tsx`, `.ts`, `.html` or `.mjs` file anywhere in the repository:

| Group | Examples | Where defined |
| --- | --- | --- |
| App shell / sidebar navigation | `.app-shell`, `.sidebar`, `.side-nav`, `.brand`, `.brand-mark`, `.topbar`, `.main-content`, `.sidebar-foot`, `.scope-control` | `styles/control-room.css:99-192` |
| Status and state chips | `.status-dot`, `.state-busy`, `.state-degraded`, `.state-offline`, `.health-at_risk`, `.health-blocked`, `.count-pill`, `.count-pill.critical` | `styles/control-room.css:271-312`, `443-445` |
| Card / panel / button vocabulary | `.panel`, `.primary-button`, `.text-button`, `.card-actions`, `.empty-state` | `styles/control-room.css:271-404` |
| Health and risk vocabulary | `.risk-critical`, `.risk-high`, `.risk-medium`, `.critical`, `.planned`, `.available`, `.unavailable` | throughout |
| Task / agent card grids | `.agent-card`, `.agent-grid`, `.project-card`, `.project-grid`, `.project-monogram`, `.project-stats` | throughout |

Three classes that a reader would reasonably assume are in the table above are
in fact **already live** and must not be counted as dead: `.health-healthy`,
`.health-watch` and `.section-heading`. All three are rendered by
`ConnectionCenterPanel` (`app/components/connection-center.tsx:31,33,37`), which
the owner reaches at `/workers` and `/connections` — so they are not dead CSS,
they are an already-shipped health/card vocabulary inside a single panel. Item 4
below should read that as "the health vocabulary is half-adopted in one panel",
not "unused".

`.mobile-nav` is genuinely dead, like the rest of the sidebar group, but it is
not at `styles/control-room.css:99-208`: it is defined at
`styles/control-room.css:468`, with its narrow-width rules at `866` and
`879-880`. The sidebar range above stops at `192` for that reason.

The single exception among the dead set is
`tests/mac-local-accessibility.test.tsx`, which parses `.sidebar` and the dark
token block out of the stylesheet to assert contrast maths. That is a test
reading the file, not a page rendering the class.

## Dark mode: the palette exists, is contrast-checked, and is unreachable

`styles/control-room.css:35-60` defines a complete dark theme under
`:root[data-theme="dark"]` — background `#10130f`, surface `#171b15`, a lightened
`--faint` (`#8b9487`) that a source comment records as being solved in HLS to
clear 4.5:1 on `--surface-3`/`--surface-2`/`--sidebar`, plus dark `--green`,
`--amber`, `--red`, `--blue`, `--violet` and their `-soft` variants.

**Nothing in the repository ever sets `data-theme`.** Observed in a live browser
against the running demo:

```
document.documentElement.getAttribute("data-theme")  ->  null
getComputedStyle(document.body).backgroundColor       ->  rgb(241, 240, 234)   /* light token */
getComputedStyle(document.body).color                 ->  rgb(32, 36, 30)      /* light token */
matchMedia("(prefers-color-scheme: dark)").matches   ->  true
```

That last line is the important one. This machine is in dark mode, and the demo
still renders light, because the theme is opt-in through an attribute nobody sets
rather than defaulting to the OS preference. The dark palette is currently dead
CSS in a stricter sense than the sidebar: it is dead and its own accessibility
test only proves the values are *arithmetically* correct, not that they are ever
painted.

Note this is a statement about the current state of the repository, not a
criticism of the demo. `pnpm demo` is a light-mode surface that shares the
stylesheet. The dark palette looks like groundwork that was written and never
switched on.

## Ranked list — what to do, highest owner value first

Sizes: **S** ~ half a day, **M** ~ 1-2 days, **L** ~ a week or more.

| # | Item | Status now | Backend needed | Size | Owner value |
| --- | --- | --- | --- | --- | --- |
| 1 | **Sign-in page has no stylesheet at all** | demo-only | none | S | Very high — it is the first thing the owner sees |
| 2 | **Dark theme unreachable** (`data-theme` never set) | demo-only | none | S | High — brief's stated goal; tokens already exist |
| 3 | **Owner UI has no sidebar shell** — `.app-shell`/`.sidebar`/`.side-nav`/`.topbar` all unused | demo-only | none | M | High — the strongest visual difference in the repo |
| 4 | **Status chips not used** — `.status-dot`, `.state-*`, `.count-pill` unused; the `.health-*` pair is adopted in one panel only; states render as bare text like `proposed` | partly real | none | S | High — task state is the main thing the owner scans |
| 5 | **Emptiness vs. unavailability look identical** | partly real | none | M | High — a correctness signal disguised as a style problem |
| 6 | **390px phone width** is handled by two breakpoints but the shell is desktop-first | partly real | none | M | Medium-high |
| 7 | `.panel` / `.primary-button` / `.card-actions` / `.empty-state` vocabulary unused (`.section-heading` already in use in one panel) | demo-only | none | S | Medium — quick win once the shell lands |
| 8 | Metrics/`.metric-grid` used by 1 component only | partly real | varies per metric | M | Medium |
| 9 | Idea Lab, News, Connections, Voice screens have a design but sit outside the owner journey | partly real | varies | L | Medium — separate surface, separate work |
| 10 | No light/dark preference control for the owner | demo-only | none (localStorage) | S | Low-medium — follows from #2 |

## Item-by-item map

### 1. Sign-in — `status: demo-only` — size S — value: very high

`src/web/v1/local-owner-session.ts:153-156`, `renderLocalOwnerSignInPageV1()`,
returns a hand-written HTML string. It has no `<link rel=stylesheet>`, no class
names, and no `--*` token usage. It renders in browser-default serif, with the
default button and input styling, and none of the app's spacing, colour or focus
treatment.

This is the **only** owner-facing page in the application with no design at all,
and it is the first one the owner sees. The Playwright owner journey
(`tests/browser/mac-local-owner-journey.spec.ts:188-189`) drives it:

```ts
await page.getByLabel("Owner code").fill(ownerCode);
await page.getByRole("button", { name: "Sign in" }).click();
```

The accessible names `Owner code` and `Sign in` come from the inline `<label>`
and `<button>`, so styling this page must **not** change that text or the
element/label relationship.

Backend needed: none. This is presentation only.

### 2. Dark theme — `status: demo-only` — size S — value: high

Fully specified above. Tokens exist and are contrast-checked; the selector is
never applied.

Backend needed: none. The choice of default (follow the OS, or force dark) is a
product decision for the owner, not a technical dependency.

Constraint: `tests/mac-local-accessibility.test.tsx:54` reads
`:root[data-theme="dark"] {` out of the stylesheet and asserts contrast on the
token values. If dark becomes the default, that block must stop being an
attribute-scoped override or the test loses the thing it is testing. This is a
real, known consequence and is called out in the design-system PR.

### 3. Owner UI shell — `status: demo-only` — size M — value: high

The real owner website renders a plain top bar: `.private-header` with a brand
link, a "Private workspace" label, and a horizontal nav
(`private-app/app/private-header.tsx`). The stylesheet separately defines a fixed
sidebar with a brand mark, grouped nav, a sticky topbar, a connection dot, and a
mobile nav — none of it rendered.

The real header already has the phone-width behaviour the demo does not (a
`Menu` disclosure with `aria-expanded` and Escape-to-close), so this is a case
where the **real app is already better than the design being ported**. The port
has to keep that.

Note also that the demo and the real app have *different navigation sets*:
`private-header.tsx` filters to `/`, `/projects`, `/workers`, `/needs-me` outside
hosted mode, while the demo has no nav at all. A shared shell must therefore be
driven by the real app's nav model, not the demo's.

Backend needed: none.

### 4. Status chips — `status: partly real` — size S — value: high

Task and project state currently render as a text pill, `.private-state`
(`private-app/app/private.css`), or as bare text. `home-workspace.tsx` does
`task.state.replaceAll("_", " ")`; the project page renders
`{project.lifecycle} · {origin}`. The stylesheet's richer vocabulary —
`.status-dot`, `.state-busy`, `.state-degraded`, `.state-offline`,
`.health-at_risk`, `.count-pill` — is unused.

The `.health-healthy` / `.health-watch` pair is the one exception, and it is
already shipped inside `ConnectionCenterPanel`
(`app/components/connection-center.tsx:31,37`) for connection signal freshness.
It is a *signal* vocabulary applied to one panel, not a task-state chip
vocabulary, so it does not yet serve the scan this item is about: no task or
project state anywhere renders as a chip. Whoever picks this up should extend
the existing `.health-*` treatment rather than invent a parallel one, and should
read it as a precedent for the naming, not as item 4 already half-done.

Backend needed: none. This is a mapping from the state strings the real app
already receives to class names that already exist. The Playwright journey
asserts on the *text* form (`await expect(page.getByRole("status")).toContainText("Prepared task status: proposed")` and `page.getByText(/^paused ·/)`), so a chip must keep the same rendered text while changing its presentation.

### 5. Empty vs. unavailable — `status: partly real` — size M — value: high

This is the one item on this list that is a correctness signal wearing a
styling hat, so it is worth being precise.

The real app is already careful in its **wording**: `home-workspace.tsx` has an
`Unavailable` component that renders "… No zero count or all-clear is
inferred.", and the empty states say things like "No matching task attention
items were found in this checked page. This is not a fleet-wide all-clear."

But visually, an empty state and an unavailable state are the same grey text on
the same card, and `.private-notice` (amber) is used for some unavailability and
some for warnings. To an owner scanning the page, "we checked and found nothing"
and "we could not check" are the same picture.

Backend needed: none for the visual part. The real app already models the three
states it renders (`loading` / `ready` / `unavailable` are literal in the
`ReadState<T>` types). The honest fix is to give the three states three distinct
treatments using tokens that already exist (`.empty-state` for empty,
`.private-notice` amber for unavailable, existing `role="status"` for loading) —
and to not invent a "0 tasks" count that the app currently refuses to infer.

### 6. 390px — `status: partly real` — size M — value: medium-high

`private-app/app/private.css` already collapses to one column at `800px` and
switches the nav to a disclosure at `560px`. The brief's requirement is 390px,
which is below both. The existing rules are written for a top-bar layout; a
sidebar shell (item 3) needs its own 390px treatment.

Backend needed: none.

### 7. Component vocabulary — `status: demo-only` — size S — value: medium

`.panel`, `.primary-button`, `.text-button`, `.card-actions`, `.empty-state` are
all defined and all unused. Adopting them is mostly mechanical once #3 and #4
land, and it is how the shell gets consistent without new CSS.

`.section-heading` is the exception: it is already in use by
`ConnectionCenterPanel` (`app/components/connection-center.tsx:33`), so it is a
worked example of the intended flex-row treatment rather than a new adoption
target. The remaining five are genuinely unrendered.

Backend needed: none.

### 8. Metrics — `status: partly real` — size M — value: medium

`.metric-grid`, `.metric-card`, `.metric-icon` exist and are used by exactly one
component. The home dashboard shows counts and byte sizes as plain list rows.

Backend needed: **yes, for any new metric.** The home dashboard already states it
will not infer a count it did not read ("No zero count or all-clear is
inferred."). A metric tile is only honest if a real aggregate endpoint backs
it. That is a backend change, so it is recorded here and not built.

### 9. Out-of-journey surfaces — `status: partly real` — size L — value: medium

Idea Lab (`.idea-lab-*`), News (`.news-*`), Connections, Voice, Calendar,
Packages and the Frontier views all have design in the stylesheet and pages in
`private-app/app/`. None are in the owner journey the Playwright spec drives
(`/`, `/projects`, `/workers`, `/needs-me` and the project sections). They are a
separate surface with their own data questions, and are out of scope for a
look-and-feel pass.

Backend needed: varies per screen.

### 10. Owner theme control — `status: demo-only` — size S — value: low-medium

There is no owner-facing light/dark switch. If dark is made real, a small
control (or at minimum an honoured OS preference) is the natural follow-up.

Backend needed: none. `localStorage` is a client concern.

## What this map does not claim

- I did not measure contrast ratios by eye. Where a map row says "tokens are
  contrast-checked", that is because `tests/mac-local-accessibility.test.tsx`
  asserts them, not because I re-derived the maths.
- I did not run the adversarial browser suite Codex is building, so I have no
  view of what it constrains. Every page PR will need to survive it.
- "real / partly real / demo-only" describes what renders, not whether the
  underlying behaviour is correct. Several of these pages have real, carefully
  worded behaviour behind a plain-looking surface.

## Sequencing recommendation

Items 1, 2, 4 and 7 are independent, low-risk, and each is visible to the owner
on its own. Item 3 is the largest visual change and is the natural centrepiece;
items 5 and 6 are better judged once a real shell exists to judge them against.
Item 8 is a backend dependency and should not start until that dependency is
scheduled.
