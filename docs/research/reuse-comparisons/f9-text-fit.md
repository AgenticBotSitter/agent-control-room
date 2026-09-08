# RC10 maintained per-package full-text collector comparison

2026-09-08; baseline c437014. Research only, no app graph reinstall, app changes, providers, credentials, services or GitHub writes. **Propose CycloneDX library's public LicenseEvidenceGatherer for multiple original text attachments, paired with already-selected pnpm graph and bundle-plugin module discovery.** This is a bounded recommendation for independent review, not whole-RC10 selection or distribution clearance.

## Actual candidates and source

`@cyclonedx/cyclonedx-library@10.2.0`, registry gitHead ed0336526d23c3476eb74b77b525436321f6b276 in CycloneDX/cyclonedx-javascript-library. Root Apache2+NOTICE, declared Node>=20.18 fits Node22. Public package export `@cyclonedx/cyclonedx-library/Contrib/License` exposes `Utils.LicenseEvidenceGatherer`; no internal deep import or npm-ls graph is required. Actual published `dist.node/contrib/license/utils.node.js` hash10a3bc2b7855dcfe85e8f3943d8bd2c512875d2cded34bc7df9ab51544891b36 checked before import. Shipped source/utils.node.ts was read too. Constructor explicitly accepts fs/path implementations; default uses real node fs/path.

Actual generator reads matching root filenames, stat-checks files, reads bytes and base64-encodes Attachment values with MIME types. Filename matcher accepts LICENSE-prefixed and exact NOTICE, but not NOTICE.md/COPYING. It has no built-in completeness, identity, duplicate or checksum-exception gate. Source comment suggests avoiding symlinks, but actual `statSync` follows a file symlink; our real owned-sibling fixture confirms that. Do not rely on the comment as enforcement.

Competing `rollup-plugin-license@3.7.1`, exact published hash4b9b0a5b186701f7eb0e56edf993dcb337cd1aa2a3b671ebcd7859e9ea517e25 checked. Its `readFile` uses fdir.withSymlinks and returns the first matching file for license then notice. Actual prior Vite tests established module selection. This new test exercises actual hooks with a supplied synthetic module map, **not** another actual Vite build. It cannot be the sole multiple-license collector when first-match information loss matters.

Prior checker4.4.2 can retrieve/clarify individual text but whole pnpm graph traversal failed;5.0.1 is unsupported on production Node22. CycloneDX's public per-path library sidesteps those graph/engine problems without a custom generic package walker. Original maintained library source/tests read in earlier CLI study do not imply its whole upstream suite ran here; current authored fixtures are the executed evidence.

## Direct executed cases

`node research/reuse-comparisons/f9-text-fit.mjs /private/tmp/cr-f9-text.czpauf` exited0 on first run. No fixture repairs. f9-text-evidence.json retains actual output/status.

- Two full LICENSE variants and exact NOTICE produce three byte-identical decoded attachments, preserving leading spaces and CRLF in the MIT fixture. Actual plugin returns only one of the license texts plus NOTICE.
- NOTICE.md and COPYING are omitted by default, as source predicts. They are not silently accepted as covered.
- Repeated gather calls return duplicate attachments:6 total, no implicit dedup. Caller must bind/dedup exact package+file+digest appropriately.
- Missing directory contents return an empty collection, not failure. Caller completeness policy must reject required missing text.
- A LICENSE-LINK points only to an owned sibling fixture. Default gatherer reads it; supported fs option mapping statSync to real lstatSync skips it. This proves the configured filesystem port behavior, not general root-containment/TOCTOU security.
- Explicit reviewed NOTICE.md exception is staged under an owned canonical NOTICE filename. Actual gatherer returns original bytes. Changed bytes fail a SHA256 assertion **in research adapter**, not native library checksum functionality. Only this named exception path is exercised, not automatic filename discovery or actual entities retained text integration.

Fixtures use synthetic license strings, not legal grants or real application notices. Actual library/plugin and dependencies execute; application modules are not run. No caller-provided private paths or symlinks outside owned research data used.

## Concrete adaptation and removal cost

Use maintained pnpm for identity/path graph; library generator for full raw attachments; plugin for rendered module scope. Avoid writing filesystem filename matching, attachment encoding, MIME handling, npm traversal or bundled-module detection anew. Library optional dependencies were omitted and no npm graph subprocess needed for public gatherer; isolated install combined17packages with plugin. Whole app runtime need not gain these build-only tools.

Keep a small project-specific orchestration layer: verify package path/identity before collection, use symlink-rejecting bounded read port, retain original source filename when staging explicitly reviewed exceptions, aggregate multiple files without losing originals, reject empty required texts, verify retained-file digests and join bundle/external/copyleft/file-level attribution scope. This layer uses existing evidence/index hashes; it is not permission to invent a generic license engine. No current production code deleted; duplicated future scanner work avoided. No database migration or persistent service.

Before final integration, test this configuration on the39prepared package paths or a retained exact-path index, plus separate NOTICE variants/nested notices/real missing-text exceptions, duplicate versions, byte caps and manifest mutation. No new full app install is necessary solely to reprove graph selection. Whether explicit exception scope is small enough must be checked against actual text inventory, not assumed from these fixtures. Source/gitHead does not prove reproducible build equivalence and root Apache/MIT does not clear tool transitive licenses.

## Resource/acquisition/cleanup

139GiB free checked; exact owned `/private/tmp/cr-f9-text.czpauf`,22MiB combined dependencies/cache/fixtures under80MiB cap. Isolated npm install exact top-level pins with ignore-scripts/no-audit/no-fund/omit optional/legacy-peer-deps, own cache/dev-null config. Complete resolved lock identities/URLs/integrities and sorted whole-file manifest digest retained in f9-text-acquisitions.json. No source downloads beyond registry packages/metadata. No listeners/background process started; all commands terminal. Exact owned22MiBroot removed after evidence retention and absence checked.
