# Independent F3 source-only review

2026-09-08. Reviewer: compare_operations (did not author F3). Reviewed
`f3-ui-fit.md`, `f3-acquisitions.md`, and `f3-exercise.mjs`. No downloads,
candidate execution, browser mount or upstream source reinspection performed.
The acquisition root has been cleaned; source authenticity is evaluated against
the retained manifest and harness, not independently rehashed downloaded bytes.

## Disposition

No blocking defect found in the **claimed partial E2** scope. This is not acceptance
of the proposed UI integration or a completed F3 winner comparison.

- The three full-source hashes in the executable match the acquisition manifest.
  Read function verifies each hash before transpilation/extraction. WebUI extraction
  uses actual top-level AST function nodes, not handwritten look-alike functions.
  Node/TypeScript/React and dependency substitutions remain part of the harness.
- Static rendering and manually invoking the selected close callback are plainly
  narrower than browser interaction. Dossier correctly states no protected API,
  reconnect, mobile, keyboard interaction or real logout proof. Removing labels
  after empty controlled props does not qualify clearing every cache.
- Negative duplicate/raw-ID observations are attributed to the selected seam and
  potential upstream caller assumptions, not reported as whole-product defects.
  The supplied close callback intentionally does not stop work; its result proves
  the component delegates behavior, not that Desktop's actual close is view-only.
- Six WebUI functions are loaded but the dossier explicitly does not claim the
  profile functions were asserted. The checks array counts scenario descriptions,
  not six independently qualified upstream functions.
- Line-count/effort estimates are labeled estimates, no resources-based weighted
  winner is invented, and production removal remains zero. Retaining catalog
  authority does not preclude adopting presentation code. Herdr is correctly
  separated from React catalog competition.

## Nonblocking test hardening before E3

1. The test claims project labels render, but positive HTML assertions only count
   `role="tab"` and missing tabindex. Add explicit positive Project A/Project B
   label assertions before relying on the empty-props negative label assertion.
   Current documentation's narrow UI-label statement is slightly stronger than
   the visible assertion coverage, though exact component static render occurs.
2. `moduleFrom` allows ordinary `require` for dependencies not explicitly replaced;
   it is not a module sandbox. The source is pinned/reviewed research input, so this
   is not a demonstrated security defect, but future source upgrades need dependency
   review rather than treating VM timeout/hash as isolation. The timeout guards
   module evaluation, not all later callback invocations.
3. Direct `bar.type(props)` and child-position indexing are brittle to upstream
   markup changes. Acceptable for this pinned probe; the next browser-mounted
   comparison should target actual accessible controls and inspect handler effects
   through normal events, not perpetuate positional assumptions.

Required next test is unchanged: mount narrow actual Desktop and WebUI adaptations
against the same protected project read boundary, composite identities and delayed
responses; exercise logout, offline/reconnect, view close, keyboard and viewport.
Do not count this review or existing baseline tests as that missing E3 evidence.
