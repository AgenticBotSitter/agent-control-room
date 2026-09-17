# Project-coordination UI boundary

The coordination workspace (`private-app/app/project-coordination-workspace.tsx`)
is the read-only presentation surface over the backend described in
`project-coordination-backend.md`. It renders saved state and submits
owner-authorised lifecycle calls. It never computes authority: every action
runs against the exact saved revision the page was loaded with, and the page
re-renders only after the server returns an accepted result.

## What the page renders

- **Coordinator head** — who leads the project, the bound executor/adapter for
  agent coordinators, and the head version the page was loaded with.
- **Suggested next step** — the canonical `nextAction` from the page payload,
  rendered as a read-only hint. Lifecycle steps point at the controls below;
  ledger steps point at their section; policy steps name the deferral (below).
  The hint carries no control and grants nothing.
- **Delegation policy** — policy id, state, coordinator version, allowances
  used/of, and the validity window. Read-only.
- **Active work** — adopted tasks with state, proposal digest, and read/write
  scopes. Links route to the task pages.
- **Dependencies** — `from → to` edges, required or soft. Edges never carry a
  recommendation.
- **Resource conflicts** — ledger-accepted conflicts with reason code,
  repository, resource, and resolution (or openly unresolved).
- **Owner attention** — the saved `ownerQuestion` verbatim per item, plus
  severity, category guidance, and the referenced task where one exists.
- **Lifecycle controls** — appoint, replace, and revoke coordinator. Disabled
  controls explain themselves in line; the reason text is the only authority
  for why a control is unavailable.

## Revision and replay contract

Writes carry the page's saved revision (`expected*` versions plus
`observedAt`) and an idempotency key. A stale page is refused with
`stale_revision` and the exact current versions, so the caller can reload and
retry against content it actually saw. Retryable transport failures surface as
`uncertain`; authentication failures surface locally generated recovery copy
that never echoes a server response body.

## Explicitly deferred

Delegation-policy pause, resume, and revoke are not offered: those writes are
not retry-safe yet and land with the follow-on policy package (#220). The page
says so in line wherever a policy step could otherwise look actionable, and
the browser client already ships the calls for that package to pick up.

## Keyboard, focus, and narrow layouts

Every action is a native `<button type="button">`, every field has an
explicit `<label>`, and loading/action feedback uses `role="status"` live
regions, so the page is operable keyboard-first with announced state changes.
Sections are labelled by `aria-labelledby`. The panel carries no fixed pixel
widths and reflows instead of clipping narrow layouts. Component tests pin
all of the above from static markup.
