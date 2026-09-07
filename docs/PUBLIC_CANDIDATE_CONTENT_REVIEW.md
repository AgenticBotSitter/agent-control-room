# Bounded independent content review

2026-09-06. `candidate_content_review` inspected root contributor/status/setup docs,
architecture, attribution, configuration, selected fixtures and targeted source
searches in the 518-file staged source. Excluded dependencies/build outputs and the
work-packages document being edited concurrently. No source execution, network,
credential access, browser use or publication. Not exhaustive legal/security review.

Findings and maintainer responses:

- Shared CSS retained consumer-specific names in selectors/comments. Candidate-only
  transformations generalize the media/news selectors, including responsive rules.
  Private original CSS is unchanged. The candidate demo rebuild and both compiled
  tests pass; this does not prove browser layout acceptance.
- The retained upstream attribution narrative mentioned a consumer-specific selector.
  Candidate narrative now uses generic news terms; upstream copyright, MIT LICENSE,
  source revision and provenance hashes are preserved.
- CONTRIBUTING incorrectly said no demo startup existed. Candidate and durable guide
  now distinguish the implemented command from still-pending browser acceptance.

No additional concrete host/account leakage was identified in the inspected subset;
this is not a claim that all 518 files have been manually cleared. The finalization
delta preserves transformations and updated contributor/work-package document bodies.

Work packages now define two substantial independent initial tracks: complete browser
journey/accessibility/recovery and OS-specific clean setup/cleanup. They remain draft
until the exact public base and reviewer are assigned; no GitHub issues were created.
