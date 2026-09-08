# RC10 actual application multi-environment preflight

2026-09-08. Initial source preflight, followed by the explicitly approved owned
staging experiment below. **Initial attempt stopped before acquisition:** an
outDir-only override with the checkout as Vite root does not contain all writes
from installed vinext. No new pass count or license-selection result is earned.

## Exact inspected boundary

Read `f9-plugin-fit.md`, `f9-distribution-fit.md`, their existing research harness
boundary, `vite.vps.config.ts`, `scripts/build-vps.mjs`, and the relevant installed
vinext implementation. Installed package identity is `vinext@1.0.0-beta.2`.

| Local source | SHA256 |
| --- | --- |
| node_modules/vinext/dist/index.js | f17b6ef12f2f7341c7a07f92274d38bca70fb623c1af2691604405a92da67ff5 |
| vite.vps.config.ts | 0be17b2445d91721648500143d66b373796c1a5fec65380fece856641858f289 |
| scripts/build-vps.mjs | 0aa8746ae262eba1703eef667d0cf5483a440eb8a4dcc841d8f5b05ee32d12ae |

The application configuration explicitly builds client plus RSC/SSR, retains its
additional real runtime entrypoints, externalizes pg-boss and emits favicon.svg.
The build script uses Vite `createBuilder` and `buildApp`, not the vinext CLI or a
prerender listener. The earlier six-group miniature is not repeated here.

## Decisive preflight findings

1. **Hard-coded root-relative write.** `vinext/dist/index.js:2836–2852` installs
   `vinext:build-id` for builds. Its writeBundle handler unconditionally selects
   `path.join(root, "dist", "server")` and writes BUILD_ID once. It does not use
   client outDir, rscOutDir, ssrOutDir or Rollup output options. With the checkout as
   root, overriding the three advertised output directories still writes into the
   checkout's `dist/server`. No build was run to demonstrate a forbidden write.
2. **envFile:false alone is insufficient.** The config hook sets root at969 and
   directly calls `loadEnv(mode, config.envDir ?? root, "")` at975, then copies
   returned entries into process.env at976. It does not test Vite envFile there.
   A future isolated fixture must explicitly direct envDir to an owned empty
   directory as well as use envFile:false and a reviewed child environment. No
   dotenv file or credential was opened by this review.
3. **Possible dependency-adjacent write.** `vinext:og-font-patch` at3118–3129 has a
   transform filter for @vercel/og index.edge.js; when its expected embedded Yoga
   payload matches and yoga.wasm is absent, it writes beside the resolved module.
   Redirecting only build/cache directories does not contain that path. This is a
   conditional source finding, **not** evidence the actual app traverses this
   transform or that its current package is missing that file. A writable staging
   design must account for resolved dependency paths rather than assuming a
   symlink to the live node_modules is isolated.

Other inspected paths use actual output options for image assets and manifests;
their existence does not cancel the hard-coded write above. This is not a claim
that all vinext/transitive effects have been audited or that no public-API staging
approach can work. No plugin hook was removed or source patched to force a build.

## Consequence and next legitimate experiment

Do not run the existing build script, or a repository-root builder with merely
temporary outDirs, for this research packet. Root should select a bounded **owned
application staging root**, retain the same real application inputs and entrypoints,
and prove the resolved source/dependency/cache/output paths cannot write back to the
checkout. Setting Vite root to that staging directory also redirects the observed
BUILD_ID write without modifying upstream code. Explicit empty envDir and disabled
config-file loading must be reconciled with the required actual app configuration.
This is proposed follow-up work, not an executed fixture or completed proof.

Once containment is demonstrated, use separate actual rollup-plugin-license3.7.1
instances for client/RSC/SSR and its public output callbacks; do not create a new
generic graph scanner. Retain the outstanding checks from the prior packet:
full-text missing records, exact identity/text collisions across environments,
externals and their separate installation closure, copied Control Center code,
virtual/embedded code, emitted favicon/CSS/assets, and original project notices.
None was newly measured by this stopped preflight. There is still no legal or
redistribution clearance, and no evidence the real multi-environment plugin build
passes or fails.

## Resource/acquisition record

`df -k /private/tmp` reported 145,474,168 KiB available, above the 20 GiB floor.
No owned directory, download, dependency installation, compiled output, listener,
prerender run or other service was created. Zero acquired bytes and zero new
temporary files require cleanup. No global allocation measurement is claimed:
no acquisition/build proceeded to consume the authorized shared budget. Existing
distribution, dependency directories and other agents' roots were not modified.
Only this scoped research report was added at that initial preflight.

## Superseding actual owned-staging build

Root authorized an independent physical dependency/source staging cohort after
the preflight. Actual Vite8.0.13 plus vinext1.0.0-beta.2 and
rollup-plugin-license3.7.1 **completed the real staged application build**:
terminal exit0, 2,751.62325 ms, no timeout or output-limit trigger. This was not a
miniature re-run, application runtime, prerender, listener or native-provider test.
Vite/plugin/native build dependencies execute; application output is compiled, not
started. Root retains adoption/release/license decisions.

| Environment | Notice callback record counts | Observed chunk-module IDs |
| --- | --- | ---: |
| client | 8 | 213 |
| rsc | 0, then 20 | 660 |
| ssr | 0, then 5 | 169 |

Actual Vite `perEnvironmentPlugin` supplied independent license-plugin instances.
The two server environments call the plugin with an initial empty output before
their populated output. The harness preserves all callback records; a production
aggregation step must not interpret the first empty callback as completion.
Records total **21 distinct name@version identities**. Existing identities shared
between environments have equal captured full-text hashes; no conflict was
observed. This is not a deliberate identity-collision negative test, and records
do not prove nested files with different copyrights are completely covered.

The full real build reported four identities without licenseText:
`control-room@0.1.0`, `@vitejs/plugin-rsc@0.5.26`,
`@nodable/entities@3.0.0`, `postgres@3.4.7`. This run intentionally observes records
without enabling a fail-on-null full-text policy, so **build success is not notice
completeness**. In particular the explicit staging input list excluded project
and third_party notices: the self null is not a new claim that no project Apache
text exists anywhere in the real repository. Root must reuse prior retained texts,
including the already resolved entities exception, rather than reacquire them.
The staged plugin-rsc and postgres package roots contain no license-named file;
the root metadata's MIT/Unlicense strings do not themselves supply their texts.

Observed copied Control Center IDs include client freshness/industry and server
feed-discovery/freshness/industry-curation. There is no independent Control Center
package record, so exact copied-file provenance remains necessary. Emitted CSS and
favicon have artifact hashes but no independent license-plugin attribution. The
plugin does not replace CSS/asset/embedded-code provenance or external dependency
inventory. Its module inventory includes virtual identifiers; those are not
proof that their underlying code has a separate complete notice.

**Receipt caveat:** `environments.*.externals` currently records non-dot-prefixed
chunk import strings, which include internal output filenames as well as real
external imports. Do not treat that unfortunately named field as a verified
external-package set. Recognizable pg-boss/React specifiers agree with the earlier
distribution inspection; resolving the complete external closure remains separate.
No new generic import/graph scanner was built to conceal this limitation.

The output inventory hashes 113 physical files / 3,110,491 bytes across owned
dist-vps and the observed vinext dist/server/BUILD_ID. The 120 generateBundle
entries are hook observations, not 120 distinct physical files. Outputs do not
have expected byte equality with the old unverified dist-vps; build timestamps,
IDs and different staging-relative inputs are not a reproducibility proof.

## Exact staging, failures and bounds

`f9-staging-prepare.mjs` copied src/private-app, the required favicon, seven
configuration/manifest files, then the five explicit tracked additions below.
There were 779 hashed source inputs. It never copied .env, .git, credentials,
private research notes, profiles, artwork or an entire app root. Existing
node_modules was copied as 19,800 independent regular files / 428,314,059 bytes
plus 1,466 internal links; files have different inodes from the original and all
symlink realpaths were checked within owned node_modules. It is reuse of the
existing frozen-lock-linked installed tree, not a fresh dependency install or
independent per-file registry-integrity audit of every app dependency.

Preserved deviations and repairs, separately authorized by root:

1. Initial copy refused an absolute self-symlink node_modules/node_modules pointing
   at the original node_modules. `f9-staging-initial-failure.json` preserves the
   partial copy. The entire first owned root was removed and absence checked.
   One narrow correction relocates only verified in-tree absolute links to owned
   relative links; no original checkout link survives.
2. Plugin npm ci initially rejected /dev/null used as both user and global config,
   before resolving config or downloading. Distinct owned empty config files
   corrected this. Sandbox DNS then returned ENOTFOUND; reviewed network permission
   allowed the same frozen scripts-disabled request. It installed 16 packages
   using the prior exact package-lock/integrities, no audit/fund or peer install,
   dedicated cache and zero fetch retries. No app/global package install occurred.
3. First real build failed code7 at a missing staged
   styles/control-room.css, not a candidate failure. Preserved terminal/partial
   receipts show that failure. The requested static relative-import inventory
   found four more direct required inputs before retry:
   app/components/{connection-center,project-catalog,project-catalog-navigation,
   project-create-form}.tsx. All five paths were verified tracked, copied unchanged
   and hashed. CSS imports only tailwindcss; the four components depend on React
   and already staged src. No broader app tree copy or upstream patch followed.

The corrected launch uses staging as cwd/root; envFile:false plus an owned empty
envDir; configFile:false; owned Vite cache; a sterile explicit child environment.
The copied actual vite.vps.config.ts is transpiled with staged TypeScript solely
to load its configuration and add per-environment reporting plugins. Its original
entrypoints, pg-boss external rule, vinext options and favicon hook are retained.
No app/upstream code or license-policy outcome is patched. Root-relative hidden
vinext output is now inside staging, and dependency-adjacent writes cannot reach
original dependencies. This is not an OS filesystem/network sandbox certification.

Build child bounds: 60-second timer, 262,144-character output bound, 1,024 MiB Node
old-space ceiling. These are not whole-process RSS or descendant-tree containment;
this successful child exited naturally. Go comparison work was serialized before
the Vite run. Observed cohort 536,204 KiB, available disk 144,617,928 KiB near the
run; even including root's reported 579 MiB retained baseline and the other bounded
400 MiB cohort, retained allocation remained below the shared 4 GiB limit.

Direct receipts: `f9-multienvironment-terminal.json`,
`f9-multienvironment-evidence.json`, `f9-multienvironment-artifacts.json` (full
output hashes and frozen plugin lock), plus `f9-staging-acquisitions.json` and the
two initial-build failure/partial files. Temporary notice files contain actual
plugin-extracted text but are not a new approved shipped notice artifact.

Next implementation boundary: reuse this working per-environment plugin API,
existing retained texts and copied-source index; add exact artifact-specific
full-text/completeness and collision checks, and reconcile separate external/asset
provenance. Do not introduce another generic dependency scanner. Independent
review is now [complete](f9-multienvironment-review.md), with no blocker for the
bounded build observations. This does not close RC10 release readiness.

**Cleanup completed:** root briefly retained the stage for notice resolution and
independent artifact/source/link review. Root then removed exact
`/private/tmp/cr-f9-staging.ITLsVE` (last measured536,204KiB) and verified ENOENT.
Reports, source/acquisition hashes, artifact hashes and failures remain. Initial failed staging root
`/private/tmp/cr-f9-staging.eHbf9c` was removed and absence observed. Both actual
build execution sessions are terminal (initial7, corrected0); no additional build
or install was performed for cleanup. Acquisition status records zero retained
bytes in this cohort; original checkout/dependencies were not removed.
