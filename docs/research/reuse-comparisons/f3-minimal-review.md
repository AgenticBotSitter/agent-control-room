# Independent minimal Markdown fit review

2026-09-08, base `bc0a61a` plus local research. Source/receipt review only; no
rerun, acquisition, browser, services or application changes. Root retains final
presentation/security selection. Reviewed the harness, fit/evidence/acquisition
records, actual `private-app/app/task-results.tsx`, actual byte checker, and prior
Desktop/WebUI renderer findings.

## Finding and disposition

No blocking defect found in the **narrow conditional direction**: use maintained
Markdown/GFM primitives inside the existing protected result panel, rather than
import either whole candidate renderer. Eleven recorded checks support this actual
representative presentation seam. They do not establish all RC3, authorization,
streaming, attachments, accessibility or production rendering safety.

One nonblocking reporting precision: the harness hashes current source after the
run; it does not assert an expected source hash before evaluation. I independently
computed the current application SHA256 and it matches the receipt exactly:
`59113ba094fa61be716ae75f88573c3d07658e2cdb9eb1d784e871edcbf9ab4b`.
Thus the recorded comparison is attributable now, but this is a source-recorded
fixture, not a future fail-closed source-pin runner. Preserve that distinction if
reusing the script. No unchanged rerun is needed to choose the narrow direction.

## Fidelity and limitations

- The extracted actual `TaskResultsPanel` has exactly one textarea replacement;
  surrounding warnings, ID/fingerprint rendering, empty handling and conditional
  review structure remain actual source. Its parent `PrivateTaskResults`, HTTP
  client, generation counter and live/revoked access behavior do **not** execute.
  The report correctly separates earlier protected API evidence.
- Actual installed react-markdown/GFM execute, not fake Markdown. The image/link
  component policy is authored glue. VM evaluation is not a security sandbox;
  JSDOM without resource loading or script execution narrows effects, not parser
  correctness or browser CSP qualification.
- Synthetic `page.items` and `reviews` are empty, review commands disconnected,
  review helpers throw and the review-label map is empty. Consequently this does
  not test a simultaneously visible matching/mismatched review, enabled review
  control, real result lookup or complete valid wire object. It does establish
  that the tested prose cannot create the panel's review buttons.
- The real `checkedResultBytes` runs with self-consistent generated claims before
  rendering. It checks size/hash/UTF-8 and existing secret-material policy, but no
  tampered claim, stored artifact or independently supplied digest is tested here.
  The fixture passes its original string, not a fetched/verified wire response.
- Link assertion counts one anchor and verifies `rel`; it does not assert that
  anchor's exact href/target, nor execute navigation. Source clearly supplies an
  HTTPS-prefix policy. Do not turn this chosen four-link corpus into general URL
  safety or external-site trust. Image syntax becomes text; this avoids tested
  resource elements but does not satisfy attachment/media requirements.
- Content switching is sequential rerender, not a held-response race. Close
  increments only the supplied callback; clearing happens in the subsequent
  parent-prop test. The callback alone does not test actual parent close logic.
- The large case is 57,000 UTF-8 bytes (3,000 × 19), below 65,536; it is not the
  exact limit, a refusal boundary, worst-case nested Markdown or a memory bound.
  The reported 610.4ms covers the whole run and cannot be compared directly with
  different Desktop/WebUI workloads as a benchmark.
- The textarea's `Agent result text` accessible label is removed by the proposed
  substitution. The surrounding named protected-content section remains, but
  heading/table/checklist semantics, focus/keyboard, selection, layout and long
  content navigation need implementation/browser acceptance. This does not demand
  another primitive contest before implementation.

## Fair alternatives and cost

The chosen narrow composition has visibly fewer host adapters: no Electron ports,
global expansion set, session-relative media resolver or second settled parser.
That is concrete coupling evidence, not a quantified engineering-cost or bundle
winner. Existing plain text remains the reversible fallback and lowest added
dependency option, but lacks rich formatting. Desktop's tested code/diff/media
features remain viable optional donors after message-scoped adaptation; WebUI's
incremental parser remains a distinct candidate with preserved negative/partial
results. Passing this smaller display scope does not delete those requirements or
prove the richer candidates generally worse.

No schema migration, authority deletion or measured production byte savings are
established. Complete imported dependency/file license notices, actual TypeScript/
Vite wiring, bounded worst-case display, protected caller regressions and accessible
browser presentation remain implementation/release gates. MIT root texts and lock
metadata are not complete downstream clearance. Test jsdom need not ship. The
acquisition receipt preserves the failed npm config attempt and corrected terminal
installation; its 83,940KiB cohort is disk, not server RAM. This review did not
independently rehash the installed package tree or observe cohort cleanup.

Root can choose this baseline on the evidenced scope without inventing numerical
scores or requiring complete media/history implementation first. Final dossier
and rubric should explicitly keep unmeasured costs and remaining responsibilities.
