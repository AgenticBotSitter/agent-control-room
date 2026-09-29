# I5 — PR-claims fence-aware evidence parser

## Outcome

Fixed the blocking fence-blind parser finding in `scripts/ci/check-pr-claims.mjs`.
Evidence references are now collected only from bullet lines outside fenced code
blocks.  Matching backtick and tilde fences, language tags, indentation, and
unclosed fences are handled.  An unclosed fence treats the remainder of that
bullet as fenced and produces an `unclosed evidence fence(s)` warning.

The existing security controls and CI rules were retained.

## Tests and checks

- `node --test tests/check-pr-claims.test.mjs` — 16 passing tests.
- `pnpm check` — passed.
- `pnpm run check:demo` — passed.
- `node scripts/check-test-lane-coverage.mjs` — passed; 507 test files are
  reachable from GitHub Actions.
- Replayed reviewer PR bodies against their actual changed paths:
  - #405: pass, 1 absolute-claim warning.
  - #398: pass, 2 absolute-claim warnings.
  - #401: expected `evidence_section_missing` only (historical source change
    without the now-required section), 4 absolute-claim warnings.
  - #399: expected `evidence_section_missing` only (historical source change
    without the now-required section), 5 absolute-claim warnings.

## Mutation checks

- Replaced `if (fence) {` with `if (false) {` in an isolated checker copy.
  The regression body then produced `test_reference_unresolved`; the dedicated
  `fence tracking is required to ignore command output references` test passes
  only when fence tracking remains enabled.

## Self-review

Independent read-only review initially found that bullet segmentation remained
fence-blind: a top-level bullet-looking output line could start a new evidence
block.  This was fixed by making `bulletBlocks()` track fences across the full
Evidence section; the adversarial and mutation tests now cover it.  Re-run
focused suite: 16/16 passing.  No remaining findings.

DB-VERIFIED: no (no port block)
