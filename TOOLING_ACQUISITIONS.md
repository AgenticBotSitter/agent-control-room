# Local tooling acquisition log

## saxes 6.0.0 original notice — 2026-09-09

Downloaded only LICENSE (3011 bytes) and package.json from public commit
`211fa0ebec9b628affc09219199639887174bfc3`, after resolving the v6.0.0 annotated
tag. Retained under third_party/saxes; exact URLs and evidence are in PROVENANCE.md.
No archive, package installation or executable code was downloaded in this step.
These two files are retained as required attribution evidence; remove only if
the dependency is removed and the affected distribution no longer includes it.
Available storage remains approximately 137 GiB. No temporary download files remain.

## CycloneDX runtime notice assembly — 2026-09-09

- Requested package: `@cyclonedx/cyclonedx-library@10.2.0`, selected DR-04 library.
- Purpose: build-time original-license attachment collection, not application runtime.
- Free space before attempt: approximately 137 GiB on the local data volume.
- Final operation: pinned dev dependency, install scripts disabled, original
  project peer-resolution policy preserved. Optional AJV reuses the existing pin.
- Status: installed successfully. Package and lock add only the selected library;
  final lock diff is 34 added lines, with no previous package entries changed.
- Actual collector implementation SHA256:
  `10a3bc2b7855dcfe85e8f3943d8bd2c512875d2cded34bc7df9ab51544891b36`, matching evaluated source.
- Attempt history: default store selection refused; offline original-store access
  failed; scoped original-store installation succeeded (1 downloaded package).
  Disabling automatic peers caused unrelated removals. Restoring default resolution
  then fetched 4 transient packages and selected incidental webpack/minifier upgrades.
  Restoring the original lock with a targeted patch and repeating the add retained
  all original dependency pins, with zero further downloads. Transient shared-cache
  objects were not deleted; their exact cache inventory still requires reconciliation
  before cleanup. This is not a claim that all acquisition cleanup is finished.
- Retention: while notice assembly uses this selected library. If rejected, remove
  the explicit dev dependency through pnpm and regenerate the lockfile; do not
  delete the shared package cache or unrelated dependencies. Record outcome here.
- Do not treat this log as a complete historical inventory of earlier research
  downloads. Earlier research retains its own acquisition/cleanup receipts.
