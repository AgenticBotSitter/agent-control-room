# F2 independent source-only review

2026-09-08. Reviewer compare_operations did not author F2. Read report,
`f2-codex-sdk-fit.mjs`, `f2-python-rpc-fit.py`, acquisition ledger. No downloads,
runtime/provider/credential calls, upstream rehash or execution performed.

## Findings

### P2 — acquisition/provenance record is still only a plan

At review time `f2-acquisitions.md` ends with planned acquisition text. It lacks
actual source/test/registry URLs, filenames, sizes, hashes, extracted footprint
and current retention/cleanup status. The report links it as exact provenance
and cleanup evidence. The TS harness usefully pins both archive SHA512 and loaded
bundle SHA256, and Python pins its client SHA256, but that does not cover every
source/test/schema/metadata acquisition mentioned in report. Populate actual ledger
before calling this deliverable saved/cleaned or reproducible from its manifest.
This is a record gap, not evidence of bad downloads or executed native calls.

### P3 — registration-before-write assertion does not prove ordering

Python test records pending IDs and sent messages in separate lists then checks
their equality after return. That would also pass if writing preceded registration.
Actual upstream method may have the stated ordering, but this assertion doesn't
discriminate it. In synthetic `_write_message`, assert the message ID is already
present in pending at call time, or retain a single ordered trace. Keep the source
finding separate from executed ordering evidence until corrected.

### P3 — final text digest tested only as a prefix

TS test verifies finalTextDigest matches `^sha256:` rather than exact expected hash
of the fixture text. This establishes presence/shape, not correct text-to-digest
mapping. Add exact expected digest using the existing canonical text-digest rule
if the report continues claiming that mapping was tested. Similarly usage checks
cover input/output, not cached-token mapping; do not expand claim without assertion.

## Scope and comparative conclusions

- No blocking overclaim of full E3/native qualification. TS actual Thread parser
  crosses real CR decoder/result functions, with synthetic execution transport;
  Python executes three actual AST method bodies with synthetic router/model/peer.
  Neither is complete SDK transport acceptance. Dossier states those limitations.
- The report separates published TypeScript0.153.4 bytes from main-source tests and
  Python source pin; it explicitly does not invent a gitHead mapping. Good boundary.
  Root license is not presented as complete dependency/binary notice clearance.
- EOF partial-return finding is fairly attributed to selected SDK seam plus CR's
  stronger terminal requirements, not a whole-SDK bug. AbortSignal forwarding is
  explicitly not process cancellation. Clear distinction should remain.
- Direct App Server and Python SDK remain serious interactive alternatives. The
  report correctly requires router/disconnect/late-message comparisons before a
  universal winner. Language convenience alone does not disqualify Python.
- Proposed deletions are conditional transport/argv conveniences only; current
  decoder, identity, approvals, journals and cleanup remain. Actual deletion is
  zero. No unsound production deletion instruction found.

Independent review is source-only and bounded. Resolve ledger gap and assertion
wording before using this report as closed experiment evidence; decisive F2 runtime
transport/Hermes/host comparisons remain open regardless of these corrections.

## Remediation recheck

2026-09-08. Re-read changed files only; no experiment rerun by this reviewer.

- P2 resolved for provenance/retention: ledger now identifies registry archive URL,
  source URL/pin/path mapping, bundle and source hashes, archive/unpacked size,
 184 KiB retained footprint and explicit **not yet cleaned** status. This fixes the
  previous planning-only contradiction; root must still be cleaned when no longer
  required. Manifest hashes agree executable assertions.
- P3 ordering resolved: synthetic writer now checks the message ID is present in
  pending at write time. An implementation writing first would fail that assertion.
- P3 digest resolved: assertion computes SHA256 of JSON.stringify(fixture text),
  matching the existing canonical digest protocol rather than checking only prefix.
  Initial raw-text expectation was an incorrect harness assumption; evaluator
  reports that failed attempt and subsequent corrected passing run. Keep that
  negative harness evidence in experiment record, not as a product failure.

Evaluator reports Python4/TS8 checks passed after fixes; this reviewer confirms
source corrections, not independent runtime reproduction. No new blocker found in
the narrow experiment claims. Full transport/SDK/native qualification remains open.
