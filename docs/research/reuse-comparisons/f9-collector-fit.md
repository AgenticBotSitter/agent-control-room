# RC10 full-text collector on actual pnpm links

2026-09-08, baseline77dfd3f. Bounded research, no app changes/build, provider, credentials, services or GitHub writes.

## Decision

**Superseding real-application check:** root subsequently ran4.4.2 read-only against
the actual current application with `production:true` and the same custom-format
fields. Exit0 returned only8 records (root plus7 direct packages), with no missing
text reported. It omitted at least entities2.2.0/xml2js0.5.0 under rss-parser and
cron-parser5.10.0/pg8.23.0/serialize-error13.0.1 under pg-boss, all verified installed
and resolvable from their real parent entrypoints. Thus its successful tiny pnpm
fixture does **not** make4.4.2 an acceptable complete application-graph collector as
currently configured. Investigate supported graph input/staging or another existing
tool; do not implement a custom walker merely to hide this failed fit.
Observed elapsed39.062708ms, peakRSS80192KiB; not a complete inventory benchmark.
The root manifest is reported UNLICENSED while a license text is found, another
reason text presence alone is not redistribution clearance. No app files changed.

Do not write a custom generic installed-package license walker. Existing license-checker-rseidelsohn collects full text across the tested **actual pnpm-created symlink graph**, and its checksum-pinned clarification can support staged retained-license exceptions. However, **5.0.1 is not supported on the current Node22 baseline**: package engines require Node>=24/npm>=11. Install warned EBADENGINE. Its successful exploratory execution does not remove that incompatibility. Do not upgrade Control Room's runtime for this tooling test.

Compatible release4.4.2 declares Node>=18/npm>=8 and passed the same fixture. It is an available narrowly scoped build-tool option, not an unqualified final preference: it uses older `read-installed-packages`, and installation warns deprecated read-package-json6.0.4/glob10.5.0. No vulnerability audit was run and warning text is not a finding that this experiment was compromised. For adoption compare retaining a pinned build-only4.4.2 with an isolated supported Node24 packaging job running5.0.1; neither requires changing production Node22. Current E2 evidence supports4.4.2 only on this tested fixture.

## Actual implementation and source identity

Published4.4.2 registry gitHead `e26286663bdc0fafa52e5491cac0f89f6e189e80`;5.0.1 `2f83a3bd92e6bd1c8513b1a8a2234ab5a59a7330`. Actual lib/index.js SHA256 asserted before import:4.4.2 `922d5ffded97d3cd511c549c6f601784744bc23acd2aa7c3f8120b4c3c359ce1`,5.0.1 `78a28c3b9dfd380ec9f86f45a147534b361a247f79e2ff7c106394cce094c261`. Full resolved graph identities, URLs/integrities and lock hashes retained in acquisition receipt. Entry hashes do not alone prove every helper/transitive byte; published source-to-git reproducibility not asserted.

4.4.2 actual code uses read-installed-packages;5.0.1 actual Arborist adapter source/tests were inspected in prior F9 dossier. Both actual index implementations join clarification licenseFile to discovered package path, read text, compute SHA256 and **process.exit(1)** on mismatch. This is a process-level collector, not an API to embed casually inside a long-lived Control Room server. No upstream4.4.2 regression suite run; authored fixture below is the executed evidence.

## Executed comparison

`research/reuse-comparisons/f9-collector-fit.mjs` uses actual installed pnpm11.19.0 `install --offline --ignore-scripts` with explicit owned store and sterile environment to prepare authored local file packages alpha→beta plus root→beta. It asserts node_modules/alpha is a symlink and realpath is under `.pnpm`. Real package-manager output records zero downloaded packages. This is not a manually drawn pnpm-like layout, and not the existing application graph.

Both actual collectors: discover alpha/beta, retrieve alpha full synthetic LICENSE, report beta with absent text, apply explicit retained beta text with matching checksum, then reject changed license bytes in a child process with exit1 and checksum diagnostic. The4.4.2 baseline is supported by its declared engines;5.0.1 result is exploratory unsupported-host evidence. Direct corrected stdout and both prior failures are retained in f9-collector-evidence.json. The separate changed-text child is real, not mocked process.exit; assertions check actual status/diagnostic, but its raw stdout is not separately retained.

Independent review clarified a fixture limitation: beta is also a direct root
dependency, so alpha→beta does not prove traversal to a transitive-only package.
The small fixture establishes symlink/text/clarification behavior, not graph-depth
completeness. The subsequent actual-application omission check is the decisive
counterevidence. See [independent review](f9-collector-review.md).

Two fixture path assumptions failed and are preserved: an absolute clarification path was joined beneath the package; using a realpath-relative escape then normalized incorrectly against the collector's logical path. Corrected fixture stages a synthetic retained text **inside the disposable package** and references its basename. No collector code was patched. This proves staging+checksum, not arbitrary external notice-file resolution; for production use stage copied package records or a packaging directory, never modify application's installed packages casually. Missing full text alone is not an automatic fail; add a completeness gate over collector output.

## Action and alternative map

- Combine the separately tested bundle plugin with a package collector for external/install scope; neither replaces copied-source provenance. Use existing clarification/checksum logic instead of implementing another locator/hash override system.
- Existing npm SBOM fixture gives standardized identifiers/graph but no full text; not an equivalent substitute for this requirement. CycloneDX6.0.1 remains a stronger richer-SBOM/full-text contender from source inspection, not runtime-rejected. Its pnpm-installed-tree/engine/dependency fit is still outstanding if it can replace both npm metadata export and collector. Do not declare all RC10 tool selection closed from this experiment alone.
- Retain CR exact build/lock/artifact mapping, missing-text checks, third-party copied-file map and original license delivery. No production code removed; avoided work is a generic dependency text walker and checksum exception engine. No fork/service/data migration needed for collector use; a separate packaging subprocess, staged notice input and sanitized failure policy are the integration cost.
- Before final current-app use: actual30dependency graph, aliases/peers/optional/workspaces, duplicate versions and symlink escape constraints; separate NOTICE/multiple license file behavior; complete transitive notices and fresh candidate policy. Measurements here are a tiny fixture only, not full-app throughput or memory.

## Acquisition/cleanup

140GiB free before owned `/private/tmp/cr-f9-collector.LrFi53`. Installed5.0.1 first (137packages,41MiB initial cohort), then4.4.2 separately (75packages). Scripts disabled, isolated npm cache/dev-null userconfig, no app/global install. Actual engines warning preserved as compatibility finding; no Node24 provisioning. Local pnpm fixture uses owned cache/store and only authored file packages. Registry-only acquisition metadata and complete resolved package identities retained. No persistent listeners/services.

Root cleanup after author-session interruption: measured52MiB owned tree and139GiB
free; all saved experiment calls and root application check were terminal. The fixture
uses bounded synchronous subprocesses, not background services. A process-list check
was unavailable (`sysmond service not found`), not falsely reported clean. Removed
only the exact inspected owned root above after retaining evidence/graph identities;
`test ! -e` succeeded. Downloaded evaluation packages, cache and synthetic fixtures
are removed and can be reacquired from the retained registry identities. No application
dependencies, other comparison roots or user files were removed.
