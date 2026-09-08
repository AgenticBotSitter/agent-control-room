# Independent RC7 narrow parser-selection review

2026-09-08. Source/receipt review only: selection harness/report/evidence, prior corrected adapter and pins, current dependency edges and relevant existing decoder tests. No rerun, download, service or product edit.

**No blocking finding for retaining both maintained parser packages in the present MVP.** This conclusion is narrowly justified by existing semantic/identity compatibility and measured removal scope, not by sunk implementation cost or a presumption that reused code must exactly reproduce every historical imperfection forever.

## Evidence fidelity

- The prior inventory verifier runs before selected candidate/decoder imports. The extraction additionally refuses a changed exact prior adapter hash and extracts only adapter declarations, not its18case workload. The adapter's compatibility mode is enabled unchanged. Real full decoder policy, canonicalization and digest generation remain around the substituted parser import.
- The borrowed contender actually calls `parseFeed` and maps its output into the same decoder. That is a credible minimal reuse alternative, not a fake parser. It cannot reconstruct fields already normalized/discarded upstream without additional raw parsing or accepted policy changes. The report correctly distinguishes its lower parity from a defect in the collector's different discovery contract.
- Retained actual stdout has18cases,11adapter matches and4borrowed matches, with seven/14mismatch names matching the source assertions. Whole-output parity is calculated before compacting retained fields/hashes. The receipt is author-executed evidence, not an independent reviewer run.
- Byte/item caps directly correspond to existing decoder tests. Atom links and feed formats are already in scope. Repeated/mixed fields, date fallback and content precedence are additional synthetic compatibility probes, not newly mandated business features. Because replacing normalization can change persisted evidence digests, they are legitimate decision probes; the report does not make universal feed parity a release prerequisite.

## Alternatives and cost

Keeping both reuses an upstream feed-specific normalizer and an upstream general XML parser already used for sitemap/collector duties. Consolidating to fast-XML avoids a small package stack but adds local feed normalization/compatibility code. The candidate is not rejected merely for missing test counts: concrete mixed-content/date/field semantics differ, and several translated outputs have already lost information. Intentional new normalization remains a valid future alternative with versioned evidence migration.

Lock inspection confirms rss-parser's xml2js edge and xml2js's sax/xmlbuilder edges at the stated versions, with entities explicitly retained for the candidate. The four reported allocations sum to2288KiB (2.234375MiB). Those are operator-recorded installed allocations, not fresh review measurements, physical exclusive-byte savings, network size or runtime RAM. Clean-lock uninstall verification remains required and is expressly not claimed done. No current product lines were removed; decoder/ingestion provenance responsibilities remain either way.

The raw adapter's30dense research lines understate production maintenance if treated as a finished implementation; report flags that explicitly. No throughput or resource advantage was fabricated. The small possible allocation saving versus ownership of normalization behavior supports narrow retention without inventing an arbitrary all-formats support requirement.

## Disposition and bounds

Accept this comparison's narrow retain-both recommendation for planning. Do not interpret it as whole-F7 completion, universal RSS correctness, permanent prohibition on consolidation, or full shipping-license closure. Reopen for a named normalization migration, maintained compatible adapter, material measured resource need or security/maintenance change. The selected graph still needs full notice delivery under RC10.
