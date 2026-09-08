# F3 mounted protected-project fit experiment

2026-09-08. Follow-up to [source/helper comparison](f3-ui-fit.md).
**E3 for the selected small presentation seams**, not E4 agent/production acceptance
or full qualification of either upstream application.

## What actually crossed Control Room's boundary

Actual Chrome browser -> actual `createProjectBrowserClient().list()` -> disposable
loopback transport -> actual `createProjectHttpHandler` -> actual Access signature
verification -> actual `WebSessionAuthority` and `WebProjectService.listPage` ->
one disposable PGlite database with current migrations and two synthetic projects.

Only transport adaptation replaces the external deployment: the fixture server
constructs requests for the real handler using the existing test helper's disposable
RSA signed assertions and example.invalid trust. No real browser cookie, Access
account, credential or network gateway was used. Expiry is a genuinely expired signed
test assertion, not a mocked handler status. Offline is a fixture HTTP 503; a delayed
reply is a real protected read response held in the transport then released.

All three displayed variants share the same authorized project rows:

1. Actual Desktop `ActiveSessionsBar` React component body, with only imports and
   decorative dependencies replaced. Real mounted browser DOM, not server rendering.
2. Actual WebUI `_buildSessionAction` DOM factory for open/close row actions, plus
   actual `_isSessionEffectivelyStreaming` and its two helper functions. A small
   research wrapper supplies rows, project identity and explicit scoped S state.
   This does **not** mount the full 9,520-line WebUI session list or its CSS.
3. Existing Control Room `ProjectCatalog` React component as baseline.

SHA-checked source pins are unchanged from the first acquisition. Project-to-machine
assignment is disposable fixture mapping, not authoritative native session binding.
Both synthetic sessions intentionally share the raw ID `same`. Composite project /
machine / session keys, view-close callbacks, freshness-generation fencing and
authentication cache clearing are **new research adapter glue**, not capabilities
magically provided by either upstream component. All rendering comes from actual
candidate code or the explicitly identified narrow wrapper; no look-alike candidate
was substituted for the real component or real DOM factory.

## Results

[Latest deterministic-race receipt](f3-mounted-race-evidence.json): **17 browser checks
passed**, including acknowledged delayed-200 / expired-401 / exact-request release.
The [earlier receipt](f3-mounted-evidence.json) is retained below as historical evidence,
not proof of the ordering repaired in F3-MR-01.

[Earlier sanitized receipt](f3-mounted-evidence.json): **14 browser checks passed**,
including explicit negative keyboard evidence. Seven protected read attempts; zero
`control_jobs` rows; two synthetic projects; zero providers. Development bundle
1,635,685 bytes contains React, Zod, the browser client, current catalog and both
candidate fragments together; it is **not** production payload or comparative RAM.

- Positive Project A and Project B labels displayed in all three variants.
- Two machine/session records stayed separate despite identical native session IDs.
- Actual mounted Desktop close and actual WebUI DOM action click removed a view,
  without changing the other session or marking synthetic work stopped.
- Offline removed project presentation, reconnect restored it without duplicates.
- Expired signed authentication removed labels, session identity map, closed-view
  selection and scoped WebUI state. This tests our narrow adapter cache, **not all
  caches in upstream applications**.
- Held pre-expiry read released after the denial could not resurrect labels.
- A new valid signed assertion restored the authorized rows.
- Desktop's unmodified `role=tab` div could not be focused; WebUI's real action button
  could. This is a necessary Desktop adaptation, not a reason to import WebUI's full
  shell. Complete keyboard interaction, menu navigation and accessible tab semantics
  are still unqualified.

The first mounted run passed 13 checks but left the adapter's session-ID map alive
after expired authentication. Inspection caught that missing clearing behavior even
though labels disappeared. The research adapter was corrected to clear that map and
selection state, then a fresh sequential database/server run passed all 14 checks.
No upstream source or product code was changed to manufacture a pass.

Post-run code hygiene removed an unused React import, supplied explicit project
types and captured the mounted host element for effect cleanup (no new behavior
scenario claimed). Focused ESLint, project TypeScript check and diff check pass.

The separate original eight-check source harness was also rerun at the same pins;
the newly added explicit positive-label assertions now pass. This closes the narrow
test-coverage issue in [independent review](f3-independent-review.md), not its broader
future-browser acceptance requirements.

### F3-MR-01: deterministic successful-response race repaired

[Independent review](f3-mounted-independent-review.md) correctly found that the
earlier 40 ms pause did not prove which response had been held. It could have held
a 401 and falsely passed the no-resurrection case. That earlier race evidence is
therefore superseded, not retroactively accepted.

The fixture now captures hold ownership at request arrival, assigns monotonic request
IDs, and acknowledges held status/project count only after the real protected handler
finishes. Browser polls a bounded acknowledgement (5-second deadline, per-request
1-second timeout) and refuses to continue unless status is 200 with two projects.
The subsequent expired read must have the exact next ID and status 401. Release
requires the exact held ID and returns its status/count plus preceding denial ID.
There is no elapsed-sleep assumption in this adversarial ordering anymore.

Actual new run: request **4** held **200 / 2 projects**; request **5** completed
**401 / 0 projects**; request **4** was then released with **afterRequestId 5,
afterStatus 401**. Neither Project A nor Project B reappeared in any mounted variant.
All **17** checks pass in actual Chrome; the server receipt retains the full seven-read
sanitized history and exact held/released metadata. Bundle 1,637,398 bytes, still a
combined development fixture rather than a production comparison. Focused lint and
TypeScript pass. One new bounded server/database run, clean exit 0; browser tab closed.
This resolves the named test-fidelity defect subject to independent source recheck,
without promoting the remaining F3 gaps to completed work.

## Reproducibility, bounded services and rejection

```sh
node research/reuse-comparisons/f3-exercise.mjs /private/tmp/control-room-f3.REACQUIRED
node --import tsx research/reuse-comparisons/f3-mounted-server.mjs /private/tmp/control-room-f3.REACQUIRED
```

Reacquire the three exact source files/hashes from [acquisitions](f3-acquisitions.md).
The server builds in memory with already-installed esbuild/React/TypeScript, creates
one disposable current-schema database, binds only `127.0.0.1` on an assigned port,
prints F3_URL, and self-closes at four minutes. Open only that fixture URL in a new
browser tab. The page automatically runs deterministic test scenarios and displays
its receipt. SIGINT/SIGTERM closes the server and database. No installer scripts,
provider calls, personal profile, SSH, production data or GitHub writes occur.

An isolated `npm install jsdom@26.1.0 --ignore-scripts` request was rejected by
auto-review as insufficiently explicit install authority. **No package was installed,
and no alternative installer/workaround was attempted.** Existing browser and existing
bundle dependencies supplied the representative fit test without new installation.

Two runs were sequential, never concurrent. Both server process handles returned
exit 0 with explicit database-close output; the one disposable Chrome tab was closed.
Acquisition cleanup is recorded separately. Fixture endpoints affect only synthetic
test control flags; they are not an implementation of production auth or session APIs.

## Decision and work avoided

The comparison supports **combining** narrow pieces, not selecting one whole app:

- Retain the actual Control Room project client, auth clearing, catalog and service.
- Adapt Desktop's 108-line controlled strip for optional open session/project views;
  add accessible buttons/tab behavior and stale-state presentation, bind close solely
  to view state. Do not import Electron cache, connection settings or stop handlers.
- Adapt WebUI's approximately 25-line action factory only where a DOM/menu action
  surface is wanted; for the existing React UI, its native-button structure is useful
  but offers little advantage over our own existing controls. Its narrow status
  helpers and anti-stuck-stream scenarios are the more valuable complementary reuse.
- Shared research adapter is 90-plus lines, server 74 lines; these include test
  orchestration and are **not** measured production adaptation sizes. Earlier
  100–250-line Desktop/40–120-line WebUI estimates remain estimates. No schema
  migration or new service is required for these small presentation pieces.
- Existing production lines deleted: zero. Keep current URLs working if the optional
  strip is removed. No user session must be cancelled to roll back a view component.

Actual E3 seam evidence eliminates the claim that these pieces are merely attractive
README ideas. It does not settle the rest of F3: full conversation transcript widgets,
list grouping/lineage, mobile/CSS, render scaling, page reload/persistence, and actual
native session registration remain their own candidate-responsibility comparisons.
Do not promote this narrow result into a blanket winner or completed F3 family.
