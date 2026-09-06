# Native automatic checks and canonical completion

2026-09-05. Independently reviewed repository integration; not deployed operation.

## What changed

Successful native work no longer has to remain permanently leased in the internal lifecycle. The new
trusted completion operation validates the actual returned bytes, original authenticated run and review
plan, ready Completion Gate and exact current job/attempt/lease binding. In one SQL transaction it
records legal job/attempt success transitions, releases the lease, and appends transition/outbox/audit
evidence. A failed transaction leaves all three states unchanged. It does not insert another artifact,
fabricate legacy signed events, repeat native execution or grant permission for another effect.

For an execution first observed only through native evidence, the required leased-to-running steps are
recorded as projections before success in that same transaction. Attempt start/finish timestamps come
from authenticated native observations; they are not claims to know the unobserved physical start.
Existing running attempts can finish without another running projection. Exact replay returns the
original authenticated completion receipt rather than releasing capacity or writing events twice.

The automatic document verifier performs real configured UTF-8 size, required-heading and forbidden
literal checks. It uses a conservative Markdown subset: fenced examples cannot supply required
headings, ATX closing hashes are normalized, and unsupported raw markup fails rather than counting
hidden headings. This proves structure only, not factual accuracy or semantic quality. Rules are pinned
to exact profile/scenario digests; there are no default checks or arbitrary executable validators.
Required independent reviews and all other verification scenarios still govern gate readiness.

Automatic evidence records rule/content/verdict digests, never copied raw document text in audit.
Multi-scenario batches use explicitly bounded checkpoint staging (maximum50); existing users keep
their previous default limit2. Uncertain checkpoint flushes are not repaired or retried implicitly.
Both new services retain observed clock high-water, validate evidence timestamps, and check the
supplied current-operation guard at the database-owned precommit boundary. Lost replies remain
uncertain until an explicit exact reconciliation; they never authorize another native attempt.

Completion records already-performed work. A terminal observation must precede the bound native,
lease and job-authority deadlines. Review may arrive later and release an active unreplaced lease;
it cannot renew it. An expiry, cancellation, orphaning or replacement already recorded canonically
prevents completion of the old attempt. Indexed SQL lineage must match canonical payloads.

## Independent review and corrected evidence

Reviewed product `194aa08c8617ca6f43dae5fbeec767e307d56ce9`, tree
`077c7786f6a0a189feadde6ae7ad252836e2c504`, has no remaining actionable review findings. Later backend
regressions at `bf1f3e3` and suite registration change tests only, not this production product.

The separate reviewer verified19 final verifier/checkpoint tests,33 earlier combined lifecycle/submission
regressions, and a final-product disposable lifecycle probe: job/attempt succeeded, lease released,
exact receipt replayed and native effect count remained one.

Corrections retained rather than reclassified as initial passes:

- The original default checkpoint stage supported only two writes; a third configured scenario would
  reject the batch. Explicit bounded staging now supports the configured maximum, tested both with
  three real verification records and a50-advance boundary without widening existing defaults.
- Clock checks initially compared only against invocation start. They now retain high-water within
  and across service calls; even a reconstructed verifier rejects replay from future-dated evidence.
- Hidden HTML/comment headings could falsely satisfy a required heading. The supported-format
  restriction and parser corrections now fail these inputs. Independent re-review caught a further
  processing-instruction opener; that case also has a failed-verdict regression.
- Root replaced a lint-rejected control-character regex with equivalent explicit character validation.

The independent backend test author encountered fixture-only failures: missing terminal timestamps,
missing supersession finding metadata, an unsorted new scenario list, SQL parameter type ambiguity,
and payload-mirror triggers correctly rejecting attempted corruption. Corrected corruption tests first
assert those database protections, then simulate privileged corruption in their disposable database.
The final agent run reported31 passed/four fixture failures; all four corrected cases subsequently
passed in a focused rerun. Root runs the full combined suite after integration; no failed run is hidden.

## Verification

- Stage zero: ready_for_runtime_check with existing dependencies and frozen lockfile.
- Independent final product:19 tests plus actual disposable completion/replay probe passed.
- Pure verifier lane:13 passed before the additional processing-instruction regression.
- Both production builds passed; private compiled18 and rendered4 passed.
- Migrations remain0053/138 tables; no schema or SQL role grants change in this block.
- Preparation770, main1136 with two existing platform skips, post-suite392 passed.
- Root final combined CR14C:641 passed, including every corrected backend fixture and all new
  verifier/staging regressions. Post-integration no-incremental TypeScript, test-file ESLint and diff
  checks passed; the complete build verification also passed repository-wide ESLint. All test/build
  processes finished; no running or failed check is counted as a pass.

No provider/native credential call, host installation, real PostgreSQL service, physical listener,
DNS change or deployment occurred. All execution/transport evidence uses the existing synthetic
native lifecycle fixture and disposable PGlite. GitHub publication transfers repository work only.

## Still required

These are internal supplied-database operations, not a mounted public API or a running fleet scheduler.
The current restricted coordinator SQL profile deliberately lacks some native harness/result access;
production mounting must define and verify the exact resources and privileges, not substitute a broad
login. Next connect this accepted path through that coordinator and implement bounded revision
submission plus workflow/request completion. Runtime registration, physical artifact transport,
reconnect/recovery, owner-signing custody, host setup and first real tasks remain gated work.

Keep Astra Medium for the lead. Bounded implementation and tests can continue in parallel with
independent review; no model change is needed for the immediate integration follow-up.
