# RC10 actual application graph: CycloneDX and pnpm inventory

2026-09-08, baseline fbac95b. Bounded local read-only application-graph test. **Neither as-configured command produced an acceptable complete report.** Preserve these failures rather than accepting an empty SBOM or disabling graph errors. No app install/change/build, credentials, GitHub, provider or persistent service.

## Exact comparison and result

The independent diagnostic recursively resolves installed package manifests through actual parent-relative node_modules paths, following symlinks. Seven root runtime dependencies plus required/installed optional edges yield **39 unique name@version identities**, with no unresolved required/optional names. This is the runtime manifest closure, not all development packages, target-platform optional packages, lock-only inventory or peer-resolution certification. It includes the RSS/XML/pg-boss transitives omitted by4.4.2. All39 are retained in `f9-next-evidence.json` alongside candidate results; no selected five-item spot check masquerades as completeness.

| Candidate | Actual current checkout result | Decision |
|---|---|---|
| license-checker-rseidelsohn4.4.2 prior root check | Exit0 but only seven direct packages plus root; omitted transitives | Existing negative evidence reused, not rerun. Cannot accept its apparent full-text completeness |
| @cyclonedx/cyclonedx-npm6.0.1 with --omit dev --gather-license-texts | Exit254 after actual npm ls exits1/ELSPROBLEMS. No SBOM produced, no39identity coverage | Not usable as configured on this checkout. This is acquisition/graph-reader failure, **not** proven general pnpm incompatibility or silent omission. Do not use ignore-npm-errors to call it complete |
| Installed pnpm11.19.0 licenses list --prod --json | Exit1 ERR_PNPM_MISSING_PACKAGE_INDEX_FILE for fast-xml-parser | Native graph+text contender blocked by missing local package-store index. Do not reinstall/repair current application for research. Need isolated frozen-lock preparation with complete store metadata |

CycloneDX's npm reader claimed all seven direct packages missing and an extraneous node_modules/node_modules entry, while the separate filesystem resolution found all39. No application directory was modified to satisfy npm. This proves a mismatch with that reader/configuration, not broken application behavior. The harness's omitted list for the failed command means **no usable output**, not a successfully generated graph with39 silent omissions.

## Actual source and engine fit

CycloneDX6.0.1 declares Node>=20.18/npm>=9, compatible with installed Node22.22.3/npm10.9.8, unlike collector5.x. Published CLI hash `aab47b20d4aca2b45ee7b040d16be14b2e1b9a64d071afdce20620855e9b7b15` and builders hash `2033a203db34da359d39673405371b83603e39bb354dde2ad59fe2de7d8a6ee5` enforced before execution. Prior gitHead3dbc1f2cc4689d9f0729e3930778a054a346b677/test inspection reused. Full exact resolved dependency identities/integrities and lock hash in acquisitions. Root Apache2+NOTICE does not clear graph dependencies; installed optional/native-related packages had scripts disabled and were not independently qualified.

Actual `dist/builders.js` fetchNpmLs invokes npm ls --json --long --all, propagates omit flags and refuses nonzero by default. fetchLicenseEvidence uses library attachment reader and makeComponentFromPackagePath adds evidence texts when gatherLicenseTexts enabled. Actual `dist/cli.js` accepts existing node_modules without a package-lock; lock-only mode disables gathering full text. Thus missing npm lock alone is not the observed failure, and synthesizing one is not a valid fix by assumption.

Installed pnpm `dist/pnpm.mjs` around239727–239747 loads a package-store index and exposes `licenseContents`; it throws the exact index error observed. Its native implementation can provide text in addition to labels—earlier metadata-only assumptions would be wrong. Upstream pnpm tests were not fetched/run; this source scope is installed implementation plus actual failed command.

## Next bounded decision and avoided custom work

First test pnpm's existing native license command after **isolated** frozen-lock, scripts-disabled preparation, never repairing the current app/store. Compare all39 runtime identities, text presence, NOTICE/multiple texts, duplicate versions and peer/optional scopes; its built-in graph logic could avoid both a custom walker and a third-party collector. Account offline cache availability/download budget before preparation. If pnpm's output misses required full text/NOTICE, test a narrow export from its supported inventory into the already-qualified bundle plugin/retained text mechanism before writing a new graph parser.

CycloneDX remains a standardized serialization/full-text alternative if fed a correctly supported prepared graph; do not reject it just because current npm ls cannot read this layout. Reproducing compatible preparation costs more than an installed-native command; require a decision-changing need before building a custom npm-ls replacement. Existing diagnostic recursive traversal is a comparator, **not** a proposed production replacement for maintained package-manager resolution.

Keep bundle-plugin discovery for bundled code, separate runtime/external inventory, original Apache text, copied Control Center provenance and retained entities exception. No generic collector or SBOM implementation is justified yet; no production code deleted. RC10 tooling selection remains locally open with a precise preparation/test next step, not dependent on owner credentials or production deployment.

## Execution, data and cleanup

`node research/reuse-comparisons/f9-next-fit.mjs /private/tmp/cr-f9-next.3R5ALx` completed, harness exit0 while explicitly preserving both candidate nonzero statuses. Exact expected/observed identity sets and direct child stdout/stderr are retained. Explicit offline env, npm_execpath prevents npm discovery script, owned HOME/TMPDIR/cache; no ambient full environment copied. Reads only root lock/manifest and installed package metadata via runtime closure; candidate observes package graph/license files. No source secret scan or user profiles inspected. Package graph paths in errors are local research evidence, not public-export clearance.

139GiB free before owned root. Isolated CycloneDX installation176packages, scripts disabled, private cache/dev-null config; final70MiB below global4GiB and20GiB free floor. Install emitted deprecation notices for glob/prebuild-install; these are not an independent security audit. No live handles/background services started; synchronous candidate calls returned with null signals. After receipts the exact owned root was removed and absence checked. No unchanged4.4.2 rerun and no error-suppression repair attempted.
