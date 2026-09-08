# F8 HTTP independent source/receipt review

Reviewer: independent comparison agent, 2026-09-08. Read-only inspection; no
downloads, installs, runtime, listener or external-service calls by this reviewer.

## Disposition

The narrowed experiment and proposed observation-only integration are reasonable.
The report does not confuse a mounted HTTP probe with complete Kuma acceptance.
One evidence-retention item must be resolved before calling the recorded 11-case
run independently receipt-checked. No request here to repeat real-service tests.

### F8-IR-01 — retain the successful transport run output (P2)

At review time `f8-http-fit.md` reports11cases/11requests/exit0, but the available
`f8-http-acquisition-receipt.json` records source/dependencies/cleanup, not execution
outcomes. `f8-http-live-fit.ts` prints result JSON, yet no `f8-http-*` runtime evidence
file is present. Save the existing successful output with its exit status (if
available), rather than reclassifying source as observed execution. This is a
receipt gap, not a claim the run failed or a need to rerun after uncertainty.

### F8-IR-02 — explicitly bind successful adapter state to upstream bean (P3)

`observe` initializes state to pass and treats any nonthrowing probe as pass,
without checking `bean.status===UP`. Inspected upstream line references show the
selected HTTP, keyword and JSON-query branches set statusUP on success, so this
does not demonstrate a false result in this pinned run. Still, expose/assert the
actual bean status in a future harness revision to bind the evidence directly to
upstream classification. Likewise assert exact timeout/reset error codes in the
regression harness, not only genericunknown; the printed codes can support the
specific observed claim once the run receipt is retained.

## What was checked

- Three hardcoded source hashes match the acquisition receipt and are enforced
  before AST extraction/execution. Actual branch and helper selections each demand
  exactly one AST node; the harness does not replace Axios with a fake response.
- Real pinned dependencies are loaded from an isolated root. Proxy=false,
  maxredirects0, synthetic loopback URLs and configured0.15s timeout are visible.
  Dependency receipt is selected-package evidence, not whole upstream lock install
  or complete license clearance; report says so.
- `f8-http-response-fit.ts` is clearly marked synthetic classifier-only. Its fake
  status/error port is not used as proof of real timeout/reset/restart behavior.
- The live harness excludes surrounding ORM, scheduler, retry persistence and
  notification service rather than presenting fake versions as full integration.
  Config getter methods and log sink are explicit research ports. TLS/auth branches
  are not exercised or claimed complete.
- Actual `src/operations/v1/health.ts` builder validates digest/time/state inputs
  and returns false service/deployment authority. Only one dependency-connectivity
  probe is mapped; full11-probe service readiness is not demonstrated or claimed.
- Timestamp staleness is an explicit research input, not parsed from the actual
  response timestamp. The report correctly distinguishes it from upstream JSONata
  freshness validation; stronger query remains a fair configuration alternative.
- Server destroy/no-response fixtures are real socket conditions in the harness.
  Endpoint close/reopen is not daemon restart, and repeated digest is not alert
  deduplication; both exclusions are prominent in report and code.
- No custom-code deletion is claimed. Keeping the CR authority schema and testing
  full-service restart/persistence/destination restrictions before adoption is
  consistent with the narrow transport result.

## Review limits and cleanup

The temporary upstream source was available for a line-reference inspection but
removed by its owning worker before full body rereading; this reviewer inspected
the retained extraction harness and receipt, not an independent second complete
upstream-body comparison. Cleanup changed from pending to completed during review;
the exact root was then absent on read, consistent with recorded removal. No
persistent service absence scan was performed by this source-only reviewer.

Do not upgrade this review to full package, production, notification delivery,
security or licensing acceptance. The observed upstream run remains author-reported
until F8-IR-01 is disposed with its saved execution evidence.

## Follow-up disposition — both findings resolved

Source/receipt-only recheck, same date. No new execution or download by reviewer.

- **F8-IR-01 resolved:** `f8-http-run-evidence.json` now retains an explicitly
  labeled sanitized transcription of the original successful result. More strongly,
  `f8-http-recheck-evidence.json` retains actual stdout, exitCode0 and elapsed time
  from the corrected harness: eleven cases, eleven requests, matching pinned
  source hashes, expected classifications and deterministic repeated digest.
  The prior receipt gap no longer blocks narrow transport evidence acceptance.
- **F8-IR-02 resolved:** corrected `observe` derives pass only from actual
  `bean.status===1`; a nonthrowing unclassified outcome becomes unknown. Expired
  overrides apply only to a successful classification. The harness now asserts
  exact ERR_BAD_RESPONSE, ECONNRESET and ECONNABORTED codes; each appears in the
  recheck stdout with the corresponding failed/unknown state. No claim here that
  previously recorded results were false.
- Re-acquisition receipt records the same three execution source hashes and
  bounded temporary dependency tree, with exact-root cleanup/absence recorded.
  This reviewer did not run a service/process scan or repeat source downloads.

**Final disposition:** accept the independently source/receipt-reviewed, bounded
HTTP-to-CR-health-probe experiment. No outstanding findings within that narrow
scope. Full-service persistence, daemon restart, notification behavior, destination
policy, TLS/auth, packaging and production readiness remain unqualified exactly as
the report states; the initial upstream-body rereading limitation remains noted.
