# Issue #11 follow-up package plan

## Lead's review verdict (PR #141)

> Lead review: accepted as a substantial partial delivery. This improves
> Control Room by deriving the shipped-file inventory from the actual
> artifact and detecting stale, mismatched, missing and undisclosed notice
> evidence. It must not close #11 because the generated evidence still
> reports incomplete distribution clearance; the remaining attribution
> and final notice generation stay as one real follow-up package.

Posted by MarvinAi5 (lead account) on PR #141 at 2026-09-13T16:43:30Z.

## What this follow-up must add

The artifact inventory in PR #141 carries `completeDistributionClearance: false`
with scope `artifact-derived: installed packages + bound third_party + declared
src/vendor; not release-wide clearance`. The remaining work closes the gap by
adding two pieces:

### 1. Attribution: human-authored PROVENANCE.json for every third_party package

19 markdown PROVENANCE files (`third_party/<name>/PROVENANCE.md` or
`third_party/<name>/PROVENANCE.upstream.md`) still need to be converted to
PROVENANCE.json with `sourceCommit` + `installedVersion` + `qualification:
pinned_upstream_release` + `files[]` (sha256 + bytes for each pinned file).

Sources for each conversion come ONLY from:
- The package's existing PROVENANCE.md / PROVENANCE.upstream.md text
- The vendored source files (sha256 + bytes are computed at conversion time)
- The upstream project's known release notes / tags (read-only web fetch,
  never stored)

No fabrication rule still applies: a conversion whose source text doesn't
provide `sourceCommit` MUST set it to `null` + `qualification:
synthesized_from_text_only; upstream revision not verified`.

### 2. Final notice generation: a script that emits a structured NOTICES.md

`scripts/runtime-license-notices-md.mjs` (new) reads the artifact-inventory +
report + exceptions and emits `research/NOTICES.md`. The doc is structured:
- Per-package section with attribution (name, version, sourceCommit or null,
  qualification, license, license URL or file path)
- Per-package bundled evidence vs discovered files (so readers see what's
  pinned and what was walked)
- Aggregate digest block (the same canonical inventoryDigest)
- A "Distribution clearance" footer that's literally `"NO — see
  artifact-inventory scope"` until full clearance is established by a
  subsequent issue

### 3. Test coverage for the new pieces

- `tests/runtime-license-notices-md.test.mjs`: round-trips a fixture
  artifact-inventory through the generator, asserts the structure
  deterministically, asserts the digest appears in the output.
- `tests/runtime-license-provenance-conversion.test.mjs` (new): takes the
  19 existing markdown files, exercises the converter, asserts each
  output has valid sha256/bytes (no fabricated commits), and asserts that
  if `sourceCommit` can't be derived the output is `null` +
  `qualification: synthesized_from_text_only` — never a guess.

### 4. Lane wiring

Add both new test files to `test:release-licenses` in `package.json`.

## Acceptance criteria (matching the lead's reservation language)

1. Artifact inventory re-run produces `completeDistributionClearance: true`
   (the underlying entries are real PROVENANCE.json or
   `synthesized_from_text_only` — never fabricated).
2. `pnpm test:release-licenses` reports the new test files included and
   passing.
3. `pnpm check:demo` clean.
4. `node scripts/check-test-lane-coverage.mjs` reports all test files
   reachable.
5. The generated `NOTICES.md` is byte-stable (deterministic) and includes
   the same canonical digest.
6. Independent subagent reviewer verdict: ACCEPT.

## Out of scope (still)

- Web fetch of upstream release tags (would be a separate read-only
  enrichment pass; touches external network).
- Carrying PROVENANCE.json conversion into the bundle itself (this
  follow-up produces the json on disk; bundling into the released
  artifact is a packaging issue, not a content issue).

## Suggested follow-up issue body (for next worker)

```
Title: [Follow-up] Issue #11: attribution + final notice generation

Builds on PR #141. Closes #11.

Adds:
- Human-authored PROVENANCE.json for the 19 third_party packages that
  currently have only markdown PROVENANCE files. No fabrication: a
  conversion whose source text doesn't provide sourceCommit sets it to
  null + qualification=synthesized_from_text_only.
- scripts/runtime-license-notices-md.mjs: emits research/NOTICES.md from
  the artifact-inventory + report + exceptions. Byte-stable output.
- Test coverage for both. Lane wiring to test:release-licenses.

Acceptance:
- artifact-inventory completeDistributionClearance becomes true on re-run.
- All release-licenses tests pass.
- Type check + lane coverage clean.
- NOTICES.md is byte-stable and carries the canonical digest.
- Independent reviewer: ACCEPT.

Out of scope:
- Web fetch of upstream release tags (separate read-only enrichment).
- PROVENANCE.json bundling into the released artifact (packaging issue).
```

## Files this follow-up will add

NEW scripts:
- `scripts/runtime-license-provenance-convert.mjs`
- `scripts/runtime-license-notices-md.mjs`

NEW research (modified):
- `third_party/<name>/PROVENANCE.json` for the 19 packages that lack one
- `research/NOTICES.md` (byte-stable)

NEW tests:
- `tests/runtime-license-provenance-convert.test.mjs`
- `tests/runtime-license-notices-md.test.mjs`

MODIFIED:
- `package.json` (lane wiring)
