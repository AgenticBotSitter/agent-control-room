# Product browser acceptance

How the public `pnpm test:product-browser` lane proves the product browser
journeys for package #1, what it actually establishes, and what it deliberately
does not.

## What runs

```
pnpm test:product-browser
  -> node --test tests/browser/workspace/product-browser-journeys.test.mjs
```

The lane covers two things in one command:

| Area | Module | What it establishes |
|---|---|---|
| Journey *plan* | `tests/browser/workspace/product-browser-journeys.mjs` | the declared journey set, its commands, and its proofs; renders the human-readable list |
| Journey *execution* | `tests/browser/workspace/product-browser-journey-harness.mjs` | a deterministic run of those journeys against a modelled protected command surface |

The plan and the execution are separate on purpose. The plan is the contract; the
harness is the evidence. A test asserts the executed journey set contains the
documented journeys, so the two cannot silently drift apart.

## Why the journeys are simulated, and not driven through a real browser

This is the most important thing to know about this lane, so it is stated plainly
rather than buried.

- **Playwright is not a dependency of this repository.** It is not in
  `dependencies`, `devDependencies`, or the lockfile, and it does not resolve on
  the build host (`ERR_MODULE_NOT_FOUND`).
- The existing `scripts/product-browser-acceptance.mjs` reaches for Playwright
  through a `PLAYWRIGHT_MODULE` environment variable, and additionally requires a
  built `dist-vps/server/**` bundle. Neither is available to this lane.
- The write scope granted to this package is `tests/browser/workspace/**` and
  this document. Adding a browser dependency to `package.json` is outside it.

A test that quietly skipped when Playwright was missing would report green while
proving nothing. So instead of a fake browser, the harness models the product's
protected command surface exactly and proves the request-level invariants the
acceptance criteria actually name. Every journey it reports is declared
`simulated: true`, and no artifact claims a live browser, live agent, provider
call, listener, or production host was used.

When a real browser run is available, `scripts/product-browser-acceptance.mjs`
remains the command for it. This lane does not replace or weaken that.

## What the harness models

`createProductBrowserHarness()` builds one product application's protected
surface:

- **Project-scoped paths** — `/api/v1/projects`,
  `/api/v1/projects/{projectId}/tasks`, `/api/v1/projects/{projectId}/lifecycle`,
  `/api/v1/tasks/{jobId}/reviews`.
- **Idempotency keys on every mutating command.** A replay of the same
  `(method, path, key)` returns the first outcome and performs no second write.
  A mutating request without a key is refused outright, which is what makes the
  write-count assertions meaningful rather than incidental.
- **Exact request accounting.** Every request is logged with whether it was
  mutating and what it produced, so counts are derived from the log rather than
  from a caller's belief about what happened.
- **Refusals that commit nothing** — unknown project, unknown job, archived
  project, unsupported lifecycle action or review decision.
- **Read-only projection** (`readProject`) that never issues a mutating command.

### Lost request versus lost reply

The acceptance criteria require these be distinguishable, and the two abort
points are the mechanism:

| Abort point | Server state | Retry on the same key |
|---|---|---|
| `BEFORE_COMMIT` | nothing written, no receipt | a genuine **first write** |
| `AFTER_COMMIT` | write and receipt stand | a **replay** of the original outcome |

Only the second leaves a receipt, so only the second makes the retry replay. A
dedicated test asserts they differ *in kind*, not merely in bookkeeping — the
lost-request retry reports `replayed: false` and the lost-reply retry reports
`replayed: true`. If the two produced identical state, the harness could not tell
a lost request from a lost reply at all.

A consequence worth stating: on a lost reply the caller never receives the
resource identity, so it can only be recovered from server state. The journey
does exactly that rather than reading it from the lost response.

## Journeys executed

1. Create project A and open its overview.
2. Save a task under project A and follow its protected detail.
3. Create project B and confirm navigation stays inside it.
4. Archive project A and reopen it without losing its task.
5. Accept the owner quality decision and confirm the saved review decision.
6. Re-check the product read-only and prove nothing auto-writes.
7. Distinguish a lost request from a lost reply using request-level evidence.
8. Replay a lost reply with the same idempotency key and create exactly one project.
9. Exercise keyboard focus at both 360px and 1280px without sideways scroll.
10. Clean up the exact owned browser, context, application and temporary profile data.

## Acceptance criteria and where each is proven

| Criterion | Test |
|---|---|
| Two isolated projects, no cross-project leak | `journeys: two isolated projects never leak a task across the boundary` |
| Lost request differs from lost reply | `harness: a lost request and a lost reply are genuinely distinguishable` |
| POST-level count / idempotency assertions | `harness: every mutating command carries an idempotency key of usable length`, and the lost-reply count assertion |
| Read-only re-check performs no auto-write | `journeys: read-only re-check performs no mutating command` |
| Stale data / drafts cannot cross projects | isolation test above; a task write into an unknown or archived project is refused and commits nothing |
| Complete / archive / reopen | `journeys: archive then reopen preserves the project's task` |
| Wide and narrow synthetic evidence | `harness: sanity evidence records both widths with focus order and labels` |
| Visible focus, labelled fields | same test: the skip link leads the focus order and every field carries a non-empty label |
| Exact owned cleanup, no wasted listener | `harness: cleanup reports exact owned resources and no wasted listener` |
| Evidence declares itself synthetic | every evidence record carries `synthetic: true` |

## Evidence is synthetic and sanitised

Recorded evidence contains only: journey titles and short details, project/task/job
identifiers generated by the harness, layout width, focus order, field labels, and
cleanup results. It contains no login code, no credential, no personal path, no
host name, and no private project data.

## Proving the harness's guards are load-bearing

A green suite proves nothing on its own. Each guard below was disabled in an
isolated copy of the repository, the lane re-run, and the named test confirmed to
fail; the real worktree was left untouched:

| Guard disabled | Result |
|---|---|
| Idempotent replay | 14 pass / 2 fail — lost-reply and distinguishability tests |
| `BEFORE_COMMIT` abort | 14 pass / 2 fail — lost-request and distinguishability tests |
| `AFTER_COMMIT` abort | 14 pass / 2 fail — lost-reply and distinguishability tests |
| Read-only projection | 15 pass / 1 fail — read-only journey test |
| Project isolation | 15 pass / 1 fail — isolation journey test |

## What this lane does not establish

- **It is not live browser acceptance.** No real browser, DOM, CSS layout engine,
  network stack, or real product bundle is exercised. "360px/1280px" is recorded
  layout metadata, not measured layout.
- **It is not a substitute for native qualification.** A separately authorised,
  owner-attended run against a real host remains required for any claim of live
  product support.
- **It does not prove the real product behaves this way.** It proves the modelled
  surface upholds the invariants, which is what makes it useful as a
  specification and a regression net. Where the model and the real product
  diverge, the real product is authoritative and this document is wrong.
- **It changes no product code.** No UI, service, schema, or authority was
  modified; the granted write scope did not include it.

## Visual regression is separate

The harness emits no screenshots and no PDFs. There is no visual comparison and
no pixel diffing in this lane. Where a runner exposes a genuine product defect,
the correct action is to report the exact failing behaviour for a separate,
non-overlapping fix rather than to fake the outcome here.